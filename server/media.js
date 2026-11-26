// Media pipeline. When a file is imported, the original is never modified or
// uploaded anywhere. FFmpeg produces small derived files next to it:
//
//   proxy.mp4 / proxy.m4a   low-res, short-GOP copy for smooth scrubbing
//   thumbs/NNNN.jpg         filmstrip thumbnails for the timeline
//   waveform.json           audio peaks for the timeline
//   keyframes/NNNN.jpg      one frame per scene, sent to Claude as images
//   analysis.json           scene cuts, silences, and (optionally) a transcript
//
// These derived files are what Claude reasons about, so a 50 GB source costs
// the same to "show" Claude as a 50 MB one.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { FFMPEG, ffmpeg, probe, run } from "./ffmpeg.js";
import { mediaDir, updateProject, readJson } from "./store.js";
import { createJob } from "./jobs.js";
import { uid } from "../shared/timeline.js";

export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|m2ts|ts|flv|wmv|mpg|mpeg|3gp|ogv)$/i;
export const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg|opus|aif|aiff|wma)$/i;

const PROXY_HEIGHT = Number(process.env.PROXY_HEIGHT || 540);
const WAVE_RATE = 20; // peaks per second
// One keyframe every 2s for short videos (a 3-minute video gets 90, enough to
// catch quick moments like an item being held up), spreading out past 5 minutes.
const MIN_KEYFRAMES = 12;
const MAX_KEYFRAMES = 150;
const KEYFRAME_EVERY = 2;
const KEYFRAME_HEIGHT = 432; // tall enough for Claude to read cards held up to the camera

export async function registerMedia(projectId, { filePath, name, mediaId = uid("m"), extra = {} }) {
  const info = await probe(filePath);
  if (!info.hasVideo && !info.hasAudio) throw new Error("No audio or video streams found in this file");
  if (info.isImage) throw new Error("Still images aren't supported yet. Import video or audio files.");
  if (!info.duration) throw new Error("Could not determine the file's duration");
  const media = {
    id: mediaId,
    name: name || path.basename(filePath),
    path: path.resolve(filePath),
    ...info,
    status: "processing",
    progress: 0,
    proxy: null,
    thumbInterval: null,
    thumbCount: 0,
    analysis: null,
    addedAt: Date.now(),
    ...extra,
  };
  await fsp.mkdir(mediaDir(mediaId), { recursive: true });
  await updateProject(projectId, (p) => {
    p.media.push(media);
    // First video sets the timeline format, like most NLEs.
    if (info.hasVideo && !p.media.some((m) => m.id !== mediaId && m.hasVideo) && p.clips.length === 0) {
      const even = (n) => Math.max(2, Math.round(n / 2) * 2);
      p.settings.width = even(info.width);
      p.settings.height = even(info.height);
      if (info.fps > 1 && info.fps < 121) p.settings.fps = Math.round(info.fps * 1000) / 1000;
    }
  });
  queuePrepare(projectId, media);
  return media;
}

function setMedia(projectId, mediaId, fields) {
  return updateProject(projectId, (p) => {
    const m = p.media.find((x) => x.id === mediaId);
    if (m) Object.assign(m, fields);
  });
}

export function queuePrepare(projectId, media) {
  return createJob(
    "prepare",
    `Preparing ${media.name}`,
    async (ctx) => {
      const dir = mediaDir(media.id);
      let lastSave = 0;
      const step = (base, span, label) => (p) => {
        const total = base + span * p;
        ctx.progress(total, label);
        if (Date.now() - lastSave > 1500) {
          lastSave = Date.now();
          setMedia(projectId, media.id, { progress: total, progressLabel: label }).catch(() => {});
        }
      };
      try {
        const proxy = await makeProxy(media, dir, step(0, 0.6, "Building proxy"), ctx.signal);
        await setMedia(projectId, media.id, { proxy, progress: 0.6 });

        const proxyPath = path.join(dir, proxy);
        let thumbs = { thumbInterval: null, thumbCount: 0 };
        if (media.hasVideo) thumbs = await makeThumbs(media, proxyPath, dir, step(0.6, 0.1, "Thumbnails"), ctx.signal);
        await setMedia(projectId, media.id, thumbs);

        let peaks = null;
        if (media.hasAudio) {
          ctx.progress(0.72, "Waveform");
          peaks = await makeWaveform(media, proxyPath, dir, ctx.signal);
        }

        const analysis = { scenes: [], silences: [], keyframes: [], loud: peaks ? loudMoments(peaks) : [], transcript: null };
        if (media.hasVideo) {
          ctx.progress(0.75, "Detecting scenes");
          analysis.scenes = await detectScenes(media, proxyPath, step(0.75, 0.1, "Detecting scenes"), ctx.signal);
          ctx.progress(0.86, "Keyframes");
          analysis.keyframes = await makeKeyframes(media, proxyPath, dir, analysis.scenes, ctx.signal);
        }
        if (media.hasAudio) {
          ctx.progress(0.9, "Detecting silences");
          analysis.silences = await detectSilences(media, proxyPath, ctx.signal);
        }
        await fsp.writeFile(path.join(dir, "analysis.json"), JSON.stringify(analysis));
        await setMedia(projectId, media.id, {
          status: "ready",
          progress: 1,
          progressLabel: null,
          analysis: summarize(analysis),
        });

        if (media.hasAudio && !media.sfx && whisperAvailable()) queueTranscribe(projectId, media);
      } catch (err) {
        await setMedia(projectId, media.id, { status: "error", error: err.message, progressLabel: null });
        throw err;
      }
    },
    { refId: media.id }
  );
}

function summarize(a) {
  return {
    scenes: a.scenes.length,
    silences: a.silences.length,
    keyframes: a.keyframes.length,
    loud: a.loud?.length ?? 0,
    transcript: a.transcript ? a.transcript.segments.length : null,
  };
}

async function makeProxy(media, dir, onProgress, signal) {
  if (!media.hasVideo) {
    await ffmpeg(["-i", media.path, "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", path.join(dir, "proxy.m4a")], {
      duration: media.duration,
      onProgress,
      signal,
    });
    return "proxy.m4a";
  }
  const fps = media.fps > 0 && media.fps <= 60 ? media.fps : 30;
  const args = [
    "-i", media.path,
    "-map", "0:v:0",
    ...(media.hasAudio ? ["-map", "0:a:0"] : []),
    "-vf", `scale=-2:'min(${PROXY_HEIGHT},ih)',format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    // Short GOP so seeking anywhere in the proxy is fast.
    "-g", String(Math.max(1, Math.round(fps / 2))), "-keyint_min", "1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    path.join(dir, "proxy.mp4"),
  ];
  await ffmpeg(args, { duration: media.duration, onProgress, signal });
  return "proxy.mp4";
}

async function makeThumbs(media, proxyPath, dir, onProgress, signal) {
  const tdir = path.join(dir, "thumbs");
  await fsp.rm(tdir, { recursive: true, force: true });
  await fsp.mkdir(tdir, { recursive: true });
  // About 1 thumb per second for short clips, capped at ~300 for long ones.
  const interval = Math.max(1, media.duration / 300);
  await ffmpeg(
    ["-i", proxyPath, "-an", "-vf", `fps=1/${interval.toFixed(4)},scale=-2:90`, "-q:v", "6", path.join(tdir, "%04d.jpg")],
    { duration: media.duration, onProgress, signal }
  );
  const count = (await fsp.readdir(tdir)).filter((f) => f.endsWith(".jpg")).length;
  return { thumbInterval: interval, thumbCount: count };
}

async function makeWaveform(media, proxyPath, dir, signal) {
  const sampleRate = 8000;
  const perPeak = sampleRate / WAVE_RATE;
  const peaks = [];
  let carry = Buffer.alloc(0);
  let max = 0;
  let n = 0;
  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-i", proxyPath, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    child.stdout.on("data", (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n >= perPeak) {
          peaks.push(max);
          max = 0;
          n = 0;
        }
      }
      carry = buf.subarray(usable);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("waveform extraction failed"))));
  });
  if (n) peaks.push(max);
  const bytes = Buffer.from(peaks.map((v) => Math.min(255, Math.round((v / 32768) * 255))));
  await fsp.writeFile(path.join(dir, "waveform.json"), JSON.stringify({ rate: WAVE_RATE, peaks: bytes.toString("base64") }));
  return bytes;
}

// The loudest stretches of audio: reactions, cheering, impacts. Often the
// moments worth emphasizing. Returns up to 40, in time order.
export function loudMoments(peaks, rate = WAVE_RATE) {
  const win = Math.max(1, Math.round(rate / 2)); // 0.5s windows
  const levels = [];
  for (let i = 0; i < peaks.length; i += win) {
    let sum = 0;
    let n = 0;
    for (let j = i; j < Math.min(peaks.length, i + win); j++) (sum += peaks[j]), n++;
    levels.push(sum / Math.max(1, n));
  }
  if (levels.length < 4) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const max = sorted[sorted.length - 1] || 1;
  const threshold = Math.max(p90, median * 1.6, 8);
  const out = [];
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] < threshold) continue;
    const start = (i * win) / rate;
    const last = out[out.length - 1];
    if (last && start - last.end < 0.6) {
      last.end = start + win / rate;
      last.level = Math.max(last.level, levels[i] / max);
    } else out.push({ start, end: start + win / rate, level: levels[i] / max });
  }
  return out
    .sort((a, b) => b.level - a.level)
    .slice(0, 40)
    .sort((a, b) => a.start - b.start)
    .map((m) => ({ start: round(m.start), end: round(m.end), level: Math.round(m.level * 100) / 100 }));
}


async function detectScenes(media, proxyPath, onProgress, signal) {
  const scenes = [];
  await run(
    FFMPEG,
    ["-hide_banner", "-nostdin", "-i", proxyPath, "-an", "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"],
    {
      signal,
      onStderr: (s) => {
        for (const m of s.matchAll(/pts_time:([\d.]+)/g)) {
          const t = Number(m[1]);
          scenes.push(t);
          if (media.duration) onProgress(t / media.duration);
        }
      },
    }
  );
  // Drop cuts closer than 0.5s apart (flashes, strobes).
  return scenes.filter((t, i) => i === 0 || t - scenes[i - 1] > 0.5).map((t) => Math.round(t * 1000) / 1000);
}

async function makeKeyframes(media, proxyPath, dir, scenes, signal) {
  const kdir = path.join(dir, "keyframes");
  await fsp.rm(kdir, { recursive: true, force: true });
  await fsp.mkdir(kdir, { recursive: true });
  // One frame shortly into each scene, plus evenly spaced frames when there are
  // few cuts. The count scales with length so long videos stay well covered.
  const target = Math.min(MAX_KEYFRAMES, Math.max(MIN_KEYFRAMES, Math.round(media.duration / KEYFRAME_EVERY)));
  // (beyond 5 minutes the cap spreads frames out evenly)
  const spacing = Math.max(1, media.duration / target);
  let times = [0.5, ...scenes.map((t) => t + 0.3)];
  for (let t = spacing / 2; t < media.duration; t += spacing) {
    if (!times.some((x) => Math.abs(x - t) < spacing / 2)) times.push(t);
  }
  times = times.filter((t) => t < media.duration - 0.1).sort((a, b) => a - b);
  // Too many (lots of scene cuts): keep the ones closest to an even grid.
  if (times.length > target) {
    const picked = new Set();
    for (let i = 0; i < target; i++) {
      const ideal = (i + 0.5) * (media.duration / target);
      let best = -1;
      for (let j = 0; j < times.length; j++) {
        if (!picked.has(j) && (best < 0 || Math.abs(times[j] - ideal) < Math.abs(times[best] - ideal))) best = j;
      }
      picked.add(best);
    }
    times = [...picked].sort((a, b) => a - b).map((j) => times[j]);
  }
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const file = `${String(i + 1).padStart(4, "0")}.jpg`;
    await run(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-ss", times[i].toFixed(3), "-i", proxyPath, "-frames:v", "1", "-vf", `scale=-2:'min(${KEYFRAME_HEIGHT},ih)'`, "-q:v", "4", path.join(kdir, file)], { signal });
    out.push({ time: Math.round(times[i] * 100) / 100, file });
  }
  return out;
}

async function detectSilences(media, proxyPath, signal) {
  const { stderr } = await run(
    FFMPEG,
    ["-hide_banner", "-nostdin", "-i", proxyPath, "-vn", "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"],
    { signal }
  );
  const silences = [];
  let start = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/);
    if (e && start != null) {
      silences.push({ start: round(start), end: round(Number(e[1])) });
      start = null;
    }
  }
  if (start != null) silences.push({ start: round(start), end: round(media.duration) });
  return silences;
}

const round = (t) => Math.round(t * 1000) / 1000;

// ---- optional transcription (OpenAI Whisper CLI, runs locally) -------------

let whisperChecked = null;
export function whisperAvailable() {
  if (whisperChecked === null) {
    const cmd = process.env.WHISPER_CMD || "whisper";
    whisperChecked = spawnSync(cmd, ["--help"], { stdio: "ignore" }).status === 0;
  }
  return whisperChecked;
}

export function queueTranscribe(projectId, media) {
  return createJob(
    "transcribe",
    `Transcribing ${media.name}`,
    async (ctx) => {
      const dir = mediaDir(media.id);
      const tdir = path.join(dir, "whisper");
      await fsp.mkdir(tdir, { recursive: true });
      const audio = path.join(tdir, "audio.wav");
      await ffmpeg(["-i", media.path, "-vn", "-ac", "1", "-ar", "16000", audio], {
        duration: media.duration,
        onProgress: (p) => ctx.progress(p * 0.1, "Extracting audio"),
        signal: ctx.signal,
      });
      ctx.progress(0.1, "Running Whisper (this can take a while)");
      await run(
        process.env.WHISPER_CMD || "whisper",
        [audio, "--model", process.env.WHISPER_MODEL || "base", "--output_format", "json", "--output_dir", tdir, "--verbose", "False"],
        {
          signal: ctx.signal,
          onStderr: (s) => {
            const m = s.match(/(\d+)%\|/);
            if (m) ctx.progress(0.1 + 0.9 * (Number(m[1]) / 100));
          },
        }
      );
      const raw = await readJson(path.join(tdir, "audio.json"));
      const segments = (raw?.segments || []).map((s) => ({ start: round(s.start), end: round(s.end), text: s.text.trim() }));
      const analysisFile = path.join(dir, "analysis.json");
      const analysis = (await readJson(analysisFile)) || {};
      analysis.transcript = { language: raw?.language ?? null, segments };
      await fsp.writeFile(analysisFile, JSON.stringify(analysis));
      await fsp.rm(audio, { force: true });
      await setMedia(projectId, media.id, { analysis: summarize({ scenes: [], silences: [], keyframes: [], ...analysis }) });
    },
    { refId: media.id }
  );
}

export async function getAnalysis(mediaId) {
  return (await readJson(path.join(mediaDir(mediaId), "analysis.json"))) || { scenes: [], silences: [], keyframes: [], transcript: null };
}

export async function removeMediaFiles(media) {
  // Only delete derived files and uploaded copies; never the user's original
  // file when it was imported by path.
  const dir = mediaDir(media.id);
  if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
}
