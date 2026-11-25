// Export engine. Renders the timeline from the ORIGINAL full-quality files.
//
// Strategy (chosen so hundreds of cuts on multi-GB sources stay cheap):
//   1. Each clip on the base video track (V1) is cut from its source with a
//      fast seek and normalized to the project's size and frame rate. Gaps
//      become black. Each segment has an exact frame count.
//   2. Base segments are joined losslessly (concat demuxer, stream copy), and
//      their audio, rendered as PCM, is joined sample-accurately.
//   3. If there are overlay clips (V2+), titles, or extra audio tracks, a
//      final compositing pass layers them on top. Otherwise the joined base
//      is muxed directly.
//
// Only a few inputs are open at once, so memory stays flat however long or
// large the sources are.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "./ffmpeg.js";
import { EXPORTS } from "./store.js";
import { clipDuration, clipEnd, mediaById, timelineDuration, trackById } from "../shared/timeline.js";

export const QUALITY = {
  draft: { crf: 28, preset: "veryfast", audio: "128k" },
  standard: { crf: 20, preset: "medium", audio: "192k" },
  high: { crf: 16, preset: "slow", audio: "320k" },
};

const FONT_CANDIDATES = [
  process.env.CLAUDE_EDITOR_FONT,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
].filter(Boolean);

function findFont() {
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
}

// Express common NTSC rates exactly, so long timelines don't drift.
function fpsRational(fps) {
  const known = { 23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001", 47.952: "48000/1001", 119.88: "120000/1001" };
  for (const [k, v] of Object.entries(known)) {
    if (Math.abs(fps - Number(k)) < 0.01) {
      const [n, d] = v.split("/").map(Number);
      return { str: v, value: n / d };
    }
  }
  return { str: String(fps), value: fps };
}

const escFilterPath = (p) => "'" + p.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:") + "'";

function fitFilter(fit, W, H) {
  return fit === "fill"
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export async function renderProject(project, { quality = "standard", fileName, onProgress = () => {}, signal } = {}) {
  const q = QUALITY[quality] || QUALITY.standard;
  const { width: W, height: H } = project.settings;
  const fr = fpsRational(project.settings.fps);
  const frame = 1 / fr.value;
  const toFrames = (t) => Math.round(t * fr.value);

  const total = toFrames(timelineDuration(project));
  if (total <= 0) throw new Error("The timeline is empty");
  const D = total * frame;

  const work = path.join(EXPORTS, `.work_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  await fsp.mkdir(work, { recursive: true });
  const safeName = (fileName || project.name || "export").replace(/[^\w\- ]+/g, "").trim() || "export";
  const outFile = path.join(EXPORTS, `${safeName}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.mp4`);

  try {
    const videoTracks = project.tracks.filter((t) => t.kind === "video");
    const baseTrack = videoTracks[videoTracks.length - 1]; // bottom video track
    const overlayTracks = videoTracks.slice(0, -1).reverse(); // drawn bottom-up
    const clipsOf = (tid) =>
      project.clips.filter((c) => c.trackId === tid && clipDuration(c) > 0).sort((a, b) => a.start - b.start);

    const textClips = project.clips.filter((c) => trackById(project, c.trackId)?.kind === "text" && c.text?.trim());
    const overlayClips = overlayTracks.flatMap((t) => clipsOf(t.id));
    const audioClips = project.tracks.filter((t) => t.kind === "audio").flatMap((t) => clipsOf(t.id));
    const needsComposite = textClips.length + overlayClips.length + audioClips.length > 0;

    // Intermediate segments are near-lossless when a composite pass follows.
    const segQ = needsComposite ? { crf: Math.min(q.crf, 14), preset: "veryfast" } : q;
    const x264 = (qq) => ["-c:v", "libx264", "-preset", qq.preset, "-crf", String(qq.crf), "-pix_fmt", "yuv420p", "-video_track_timescale", "90000"];

    // ---- 1. Build the base lane: clips plus black gaps, frame-exact --------
    const lane = [];
    let cursor = 0; // in frames
    for (const c of clipsOf(baseTrack.id)) {
      const s = toFrames(c.start);
      const e = toFrames(clipEnd(c));
      const from = Math.max(s, cursor);
      if (from > cursor) lane.push({ gap: true, frames: from - cursor });
      if (e > from) lane.push({ clip: c, frames: e - from, skip: (from - s) * frame });
      cursor = Math.max(cursor, e);
    }
    if (cursor < total) lane.push({ gap: true, frames: total - cursor });

    const jobs = [
      ...lane.map((seg, i) => ({ kind: "lane", seg, i })),
      ...overlayClips.map((c, i) => ({ kind: "overlay", clip: c, i })),
      ...audioClips.map((c, i) => ({ kind: "audio", clip: c, i })),
    ];
    const weight = (j) => (j.kind === "lane" ? j.seg.frames * frame : clipDuration(j.clip)) + 0.2;
    const totalWork = jobs.reduce((a, j) => a + weight(j), 0);
    let doneWork = 0;
    const tick = (w) => {
      doneWork += w;
      onProgress((doneWork / totalWork) * (needsComposite ? 0.75 : 0.9), "Rendering segments");
    };

    const segVideo = (j) => path.join(work, `${j.kind}_${j.i}.mp4`);
    const segAudio = (j) => path.join(work, `${j.kind}_${j.i}.wav`);
    const pcm = ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];

    const renderSegment = async (j) => {
      if (j.kind === "lane" && j.seg.gap) {
        const dur = (j.seg.frames * frame).toFixed(6);
        await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fr.str}`, "-frames:v", String(j.seg.frames), ...x264(segQ), segVideo(j)], { signal });
        await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", dur, ...pcm, segAudio(j)], { signal });
        return;
      }
      const c = j.clip || j.seg.clip;
      const m = mediaById(project, c.mediaId);
      if (!m) throw new Error(`Clip ${c.id} refers to missing media`);
      if (!fs.existsSync(m.path)) throw new Error(`Source file is missing: ${m.path}`);
      const skip = j.kind === "lane" ? j.seg.skip : 0;
      const frames = j.kind === "lane" ? j.seg.frames : toFrames(clipDuration(c));
      const durSec = frames * frame;
      const srcIn = (c.in + skip).toFixed(6);

      if (j.kind !== "audio") {
        const vf =
          j.kind === "lane"
            ? `setpts=PTS-STARTPTS,fps=${fr.str},${fitFilter(c.fit, W, H)},setsar=1,tpad=stop_mode=clone:stop_duration=2,format=yuv420p`
            : // Overlays are scaled to fit and placed centered; no black bars.
              `setpts=PTS-STARTPTS,fps=${fr.str},scale=${W}:${H}:force_original_aspect_ratio=${c.fit === "fill" ? "increase" : "decrease"}:flags=lanczos,` +
              (c.fit === "fill" ? `crop=${W}:${H},` : `scale=trunc(iw/2)*2:trunc(ih/2)*2,`) +
              `setsar=1,tpad=stop_mode=clone:stop_duration=2,format=yuv420p`;
        await ffmpeg(["-ss", srcIn, "-i", m.path, "-map", "0:v:0", "-an", "-vf", vf, "-frames:v", String(frames), ...x264(segQ), segVideo(j)], { signal });
      }
      const vol = Number.isFinite(c.volume) ? c.volume : 1;
      if (m.hasAudio && vol > 0) {
        await ffmpeg(
          ["-ss", srcIn, "-i", m.path, "-map", "0:a:0", "-vn", "-af", `aresample=48000,volume=${vol},apad`, "-t", durSec.toFixed(6), ...pcm, segAudio(j)],
          { signal }
        );
      } else if (j.kind === "lane") {
        await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", durSec.toFixed(6), ...pcm, segAudio(j)], { signal });
      }
    };

    const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
    await pool(jobs, workers, async (j) => {
      await renderSegment(j);
      tick(weight(j));
    });

    // ---- 2. Join the base lane ----------------------------------------------
    onProgress(needsComposite ? 0.76 : 0.91, "Joining segments");
    const listV = path.join(work, "lane_v.txt");
    const listA = path.join(work, "lane_a.txt");
    const laneJobs = jobs.filter((j) => j.kind === "lane");
    await fsp.writeFile(listV, laneJobs.map((j) => `file '${segVideo(j).replace(/'/g, "'\\''")}'`).join("\n"));
    await fsp.writeFile(listA, laneJobs.map((j) => `file '${segAudio(j).replace(/'/g, "'\\''")}'`).join("\n"));
    const baseV = path.join(work, "base.mp4");
    const baseA = path.join(work, "base.wav");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listV, "-c", "copy", baseV], { signal });
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listA, "-c", "copy", baseA], { signal });

    if (!needsComposite) {
      onProgress(0.95, "Finishing");
      await ffmpeg(["-i", baseV, "-i", baseA, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", q.audio, "-movflags", "+faststart", "-t", D.toFixed(6), outFile], { signal });
      return outFile;
    }

    // ---- 3. Composite overlays, titles and extra audio ----------------------
    const inputs = ["-i", baseV, "-i", baseA];
    const vChain = [];
    const aLabels = ["[1:a]"];
    let idx = 2;
    let vLabel = "[0:v]";
    let n = 0;
    for (const j of jobs.filter((x) => x.kind === "overlay")) {
      const c = j.clip;
      const t0 = toFrames(c.start) * frame;
      const t1 = t0 + toFrames(clipDuration(c)) * frame;
      inputs.push("-itsoffset", t0.toFixed(6), "-i", segVideo(j));
      const out = `[ov${n++}]`;
      vChain.push(`${vLabel}[${idx}:v]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${t0.toFixed(4)},${t1.toFixed(4)})'${out}`);
      vLabel = out;
      idx++;
    }
    for (const j of jobs.filter((x) => (x.kind === "overlay" || x.kind === "audio") && fs.existsSync(segAudio(x)))) {
      const delayMs = Math.round(toFrames(j.clip.start) * frame * 1000);
      inputs.push("-i", segAudio(j));
      const lbl = `[ad${idx}]`;
      vChain.push(`[${idx}:a]adelay=${delayMs}:all=1${lbl}`);
      aLabels.push(lbl);
      idx++;
    }
    if (textClips.length) {
      const font = findFont();
      if (!font) throw new Error("No font found for titles. Set CLAUDE_EDITOR_FONT to a .ttf file.");
      const scale = H / 1080;
      textClips.forEach((c, i) => {
        const tf = path.join(work, `text_${i}.txt`);
        fs.writeFileSync(tf, c.text);
        const st = c.style || {};
        const size = Math.round((st.size || 56) * scale);
        const y = st.position === "top" ? `h*0.08` : st.position === "center" ? `(h-text_h)/2` : `h*0.88-text_h`;
        const t0 = toFrames(c.start) * frame;
        const t1 = t0 + toFrames(clipDuration(c)) * frame;
        const box = st.box === false ? "" : `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(18 * scale)}`;
        const out = `[tx${i}]`;
        vChain.push(
          `${vLabel}drawtext=fontfile=${escFilterPath(font)}:textfile=${escFilterPath(tf)}:fontsize=${size}:fontcolor=${(st.color || "#ffffff").replace("#", "0x")}` +
            `${box}:line_spacing=${Math.round(8 * scale)}:x=(w-text_w)/2:y=${y}:enable='between(t,${t0.toFixed(4)},${t1.toFixed(4)})'${out}`
        );
        vLabel = out;
      });
    }
    vChain.push(`${vLabel}format=yuv420p[vout]`);
    vChain.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.98[aout]`);
    const script = path.join(work, "graph.txt");
    await fsp.writeFile(script, vChain.join(";\n"));

    await ffmpeg(
      [
        ...inputs,
        "-filter_complex_script", script,
        "-map", "[vout]", "-map", "[aout]",
        "-r", fr.str,
        "-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", q.audio,
        "-t", D.toFixed(6),
        "-movflags", "+faststart",
        outFile,
      ],
      { duration: D, signal, onProgress: (p) => onProgress(0.78 + 0.22 * p, "Compositing") }
    );
    return outFile;
  } catch (err) {
    await fsp.rm(outFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
