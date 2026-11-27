// Timeline model and edit operations.
// Pure functions shared by the browser UI and the Node server. Every operation
// takes a project and returns a new project; nothing is mutated in place, which
// is what makes undo/redo a simple snapshot stack.
//
// Units: all times are seconds (floats). Timeline positions snap to frames.
//
// Clip shape:
//   { id, trackId, start, in, out, mediaId?, volume?, fit?, speed?, hold?, holdAt?,
//     text?, style?, effect? }
//   start    = position on the timeline
//   in/out   = range in the source media (for text/effect/hold clips: 0..length)
//   speed    = playback speed (0.5 = half-speed slow motion)
//   duration = (out - in) / speed
//   hold     = freeze frame: shows the source frame at `holdAt` for the duration
//   effect   = { type, intensity } on an effects (fx) track

export const TRACK_KINDS = ["video", "audio", "text", "fx", "graphics"];

import { GRAPHICS } from "./graphics.js";
import { normalizeSpec } from "./custom.js";
export { GRAPHICS };

export const EFFECT_TYPES = {
  zoom: { label: "Zoom punch-in", intensity: 0.35 },
  shake: { label: "Camera shake", intensity: 0.5 },
  flash: { label: "White flash", intensity: 0.8 },
  rainbow: { label: "Rainbow holo shimmer", intensity: 0.7 },
  blur: { label: "Blur (hide a spoiler)", intensity: 0.6 },
  black_white: { label: "Black & white", intensity: 1 },
  spotlight: { label: "Spotlight vignette", intensity: 0.6 },
};

export const SOUND_EFFECTS = {
  whoosh: { label: "Whoosh", duration: 0.9 },
  sparkle: { label: "Sparkle chime", duration: 1.4 },
  pop: { label: "Pop", duration: 0.18 },
  boom: { label: "Bass boom", duration: 1.6 },
  cash: { label: "Ka-ching", duration: 1.0 },
  drumroll: { label: "Drumroll", duration: 2.0 },
  riser: { label: "Tension riser", duration: 2.0 },
  airhorn: { label: "Air horn", duration: 1.1 },
};

// For dry runs: pretend any sound effects a plan uses are already imported.
export function withSoundStubs(project, ops) {
  const need = [...new Set(ops.filter((o) => o.op === "add_sound").map((o) => String(o.sound).toLowerCase()))].filter(
    (snd) => SOUND_EFFECTS[snd] && !project.media.some((m) => m.sfx === snd)
  );
  if (!need.length) return project;
  return {
    ...project,
    media: [
      ...project.media,
      ...need.map((snd) => ({ id: `sfx_${snd}`, name: SOUND_EFFECTS[snd].label, sfx: snd, duration: SOUND_EFFECTS[snd].duration, hasAudio: true, hasVideo: false, status: "ready" })),
    ],
  };
}

export function uid(prefix = "c") {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

export function createProject(name = "Untitled Project") {
  return {
    id: uid("p"),
    name,
    version: 1,
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [
      { id: "G1", kind: "graphics", name: "Graphics" },
      { id: "FX2", kind: "fx", name: "Effects 2" },
      { id: "FX1", kind: "fx", name: "Effects 1" },
      { id: "T1", kind: "text", name: "Titles" },
      { id: "V2", kind: "video", name: "Video 2" },
      { id: "V1", kind: "video", name: "Video 1" },
      { id: "A1", kind: "audio", name: "Audio 1" },
      { id: "A2", kind: "audio", name: "Audio 2" },
    ],
    clips: [],
    markers: [],
    chat: [],
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// Older projects predate the effects and graphics tracks.
export function migrateProject(p) {
  if (!p.tracks.some((t) => t.kind === "fx")) {
    p.tracks.unshift({ id: "FX2", kind: "fx", name: "Effects 2" }, { id: "FX1", kind: "fx", name: "Effects 1" });
  }
  if (!p.tracks.some((t) => t.kind === "graphics")) {
    p.tracks.unshift({ id: "G1", kind: "graphics", name: "Graphics" });
  }
  return p;
}

export const speedOf = (c) => (c.hold || !c.speed ? 1 : c.speed);
export const clipDuration = (c) => (c.out - c.in) / speedOf(c);
// Source-media time shown at timeline time t (for a clip spanning t).
export const srcAt = (c, t) => (c.hold ? c.holdAt : c.in + (t - c.start) * speedOf(c));
export const clipEnd = (c) => c.start + clipDuration(c);

export function snapToFrame(t, fps) {
  return Math.max(0, Math.round(t * fps) / fps);
}

export function timelineDuration(project) {
  let end = 0;
  for (const c of project.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function trackById(project, id) {
  return project.tracks.find((t) => t.id === id);
}

export function mediaById(project, id) {
  return project.media.find((m) => m.id === id);
}

export function clipsOnTrack(project, trackId) {
  return project.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

// Video tracks ordered bottom (drawn first) to top (drawn last).
export function videoTracksBottomUp(project) {
  return project.tracks.filter((t) => t.kind === "video").slice().reverse();
}

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Primitive edits
// ---------------------------------------------------------------------------

// Split every clip (optionally only on one track) that spans time t.
export function splitAt(project, t, trackId = null) {
  const p = clone(project);
  const next = [];
  for (const c of p.clips) {
    const inside = t > c.start + EPS && t < clipEnd(c) - EPS;
    if (!inside || (trackId && c.trackId !== trackId)) {
      next.push(c);
      continue;
    }
    const offset = (t - c.start) * speedOf(c);
    next.push({ ...c, out: c.in + offset });
    next.push({ ...c, id: uid(), start: t, in: c.in + offset });
  }
  p.clips = next;
  return p;
}

// Remove the timeline range [start, end) on the given tracks (all tracks if
// trackIds is null). With ripple=true everything after the range shifts left
// to close the gap.
export function deleteRange(project, start, end, { ripple = true, trackIds = null } = {}) {
  if (end - start <= EPS) return clone(project);
  const affects = (c) => !trackIds || trackIds.includes(c.trackId);
  let p = clone(project);
  for (const tr of trackIds || [null]) {
    p = splitAt(p, start, tr);
    p = splitAt(p, end, tr);
  }
  const len = end - start;
  p.clips = p.clips
    .filter((c) => !(affects(c) && c.start >= start - EPS && clipEnd(c) <= end + EPS))
    .map((c) => (ripple && affects(c) && c.start >= end - EPS ? { ...c, start: c.start - len } : c));
  if (ripple && !trackIds) {
    p.markers = p.markers
      .filter((m) => m.time < start || m.time >= end)
      .map((m) => (m.time >= end ? { ...m, time: m.time - len } : m));
  }
  return p;
}

// Delete several ranges at once. Ranges refer to the timeline as it is now;
// they are merged and removed from last to first so earlier times stay valid.
export function deleteRanges(project, ranges, opts = {}) {
  const sorted = ranges
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let p = clone(project);
  for (let i = merged.length - 1; i >= 0; i--) p = deleteRange(p, merged[i][0], merged[i][1], opts);
  return p;
}

export function removeClip(project, clipId, { ripple = false } = {}) {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c) return clone(project);
  if (ripple) return deleteRange(project, c.start, clipEnd(c), { ripple: true, trackIds: [c.trackId] });
  const p = clone(project);
  p.clips = p.clips.filter((x) => x.id !== clipId);
  return p;
}

// Clear space on a track for [start, end) without shifting anything (overwrite).
function clearSpace(project, trackId, start, end, exceptId = null) {
  let p = splitAt(project, start, trackId);
  p = splitAt(p, end, trackId);
  p.clips = p.clips.filter(
    (c) => c.id === exceptId || c.trackId !== trackId || clipEnd(c) <= start + EPS || c.start >= end - EPS
  );
  return p;
}

// Place a clip on the timeline, overwriting whatever was underneath.
export function placeClip(project, clip) {
  const c = { volume: 1, fit: "fit", ...clip, id: clip.id || uid() };
  const p = clearSpace(project, c.trackId, c.start, c.start + clipDuration(c));
  p.clips.push(c);
  return p;
}

export function moveClip(project, clipId, start, trackId = null) {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c) return clone(project);
  const target = trackId || c.trackId;
  const srcKind = trackById(project, c.trackId)?.kind;
  const dstKind = trackById(project, target)?.kind;
  if (srcKind !== dstKind) throw new Error(`Cannot move a ${srcKind} clip onto ${dstKind} track ${target}`);
  const moved = { ...c, start: Math.max(0, start), trackId: target };
  let p = clone(project);
  p.clips = p.clips.filter((x) => x.id !== clipId);
  p = clearSpace(p, target, moved.start, clipEnd(moved));
  p.clips.push(moved);
  return p;
}

// Change a clip's source in/out. The clip's left edge stays anchored unless
// keepEnd is set (used when dragging the left handle in the UI).
export function trimClip(project, clipId, newIn, newOut, { keepEnd = false } = {}) {
  const p = clone(project);
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return p;
  const m = c.mediaId && !c.hold ? mediaById(p, c.mediaId) : null;
  const maxOut = m?.duration ?? Infinity;
  newIn = Math.max(0, newIn);
  newOut = Math.min(maxOut, newOut);
  if (newOut - newIn < 0.04) return p;
  const end = clipEnd(c);
  c.in = newIn;
  c.out = newOut;
  if (keepEnd) c.start = Math.max(0, end - clipDuration(c));
  return p;
}

export function updateClip(project, clipId, fields) {
  const p = clone(project);
  const c = p.clips.find((x) => x.id === clipId);
  if (c) Object.assign(c, fields);
  return p;
}

// Append a media item to the end of a track.
export function appendMedia(project, mediaId, trackId = null, inPoint = 0, outPoint = null) {
  const m = mediaById(project, mediaId);
  if (!m) throw new Error(`Unknown media ${mediaId}`);
  const track = trackId || (m.hasVideo ? "V1" : "A1");
  const end = clipsOnTrack(project, track).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  return placeClip(project, {
    trackId: track,
    mediaId,
    start: end,
    in: inPoint,
    out: outPoint ?? m.duration,
  });
}

function customSpec(project, raw) {
  const imageIds = project.media.filter((m) => m.isImage).map((m) => m.id);
  const res = normalizeSpec(raw, { width: project.settings.width, height: project.settings.height, imageIds });
  if (!res.spec.layers.length) throw new Error("The animation has no usable layers: " + res.warnings.join(" "));
  return res;
}

// Open a gap of length d at time t on every track (everything after shifts right).
export function insertGap(project, t, d) {
  let p = splitAt(project, t);
  p.clips = p.clips.map((c) => (c.start >= t - EPS ? { ...c, start: c.start + d } : c));
  p.markers = p.markers.map((m) => (m.time >= t - EPS ? { ...m, time: m.time + d } : m));
  return p;
}

// Change a clip's speed, keeping everything after it in sync: slowing down
// pushes later material right; speeding up pulls it left.
export function setClipSpeed(project, clipId, speed) {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c) throw new Error(`No clip with id ${clipId}`);
  if (!c.mediaId || c.hold) throw new Error("Only video or audio clips can change speed");
  speed = Math.max(0.1, Math.min(4, Number(speed) || 1));
  const oldEnd = clipEnd(c);
  const newEnd = c.start + (c.out - c.in) / speed;
  let p = clone(project);
  if (newEnd > oldEnd + EPS) {
    p = insertGap(p, oldEnd, newEnd - oldEnd);
  } else if (newEnd < oldEnd - EPS) {
    p = updateClip(p, clipId, { speed });
    return deleteRange(p, newEnd, oldEnd, { ripple: true });
  }
  return updateClip(p, clipId, { speed });
}

// The video clip showing at time t (top-most video track first).
export function videoClipAt(project, t) {
  for (const tr of project.tracks.filter((x) => x.kind === "video")) {
    const c = project.clips.find((x) => x.trackId === tr.id && t >= x.start - EPS && t < clipEnd(x) - EPS);
    if (c) return c;
  }
  return null;
}

function freeTrack(project, kind, start, end, preferred) {
  const tracks = project.tracks.filter((t) => t.kind === kind).map((t) => t.id).reverse(); // e.g. FX1 before FX2
  const order = preferred ? [preferred, ...tracks.filter((t) => t !== preferred)] : tracks;
  for (const id of order) {
    if (!project.clips.some((c) => c.trackId === id && c.start < end - EPS && clipEnd(c) > start + EPS)) return id;
  }
  return order[0];
}

// ---------------------------------------------------------------------------
// Operation interpreter (used for Claude's edit plans)
// ---------------------------------------------------------------------------
//
// Every operation is a flat object { op, ...fields }. Times are timeline
// seconds as the timeline stands right before that operation runs, except
// inside one `ripple_delete_ranges` op, where all ranges refer to the same
// starting state.

export const OPERATION_TYPES = [
  "ripple_delete_ranges",
  "lift_range",
  "split",
  "delete_clip",
  "move_clip",
  "trim_clip",
  "insert_media",
  "add_text",
  "set_clip_volume",
  "set_clip_fit",
  "set_format",
  "add_marker",
  "clear_timeline",
  "add_effect",
  "slow_motion",
  "set_clip_speed",
  "freeze_frame",
  "add_sound",
  "add_graphic",
  "update_graphic",
];

export function applyOperation(project, op) {
  const fps = project.settings.fps;
  const s = (t) => snapToFrame(Number(t), fps);
  if ("clipId" in op && !project.clips.some((c) => c.id === op.clipId)) {
    throw new Error(`No clip with id ${op.clipId}`);
  }
  for (const k of ["trackId"]) {
    if (op[k] && !trackById(project, op[k])) throw new Error(`No track ${op[k]}`);
  }
  switch (op.op) {
    case "ripple_delete_ranges":
      return deleteRanges(project, (op.ranges || []).map((r) => [s(r.start), s(r.end)]), { ripple: true });
    case "lift_range":
      return deleteRange(project, s(op.start), s(op.end), { ripple: false, trackIds: op.trackIds || null });
    case "split":
      return splitAt(project, s(op.time), op.trackId || null);
    case "delete_clip":
      return removeClip(project, op.clipId, { ripple: !!op.ripple });
    case "move_clip":
      return moveClip(project, op.clipId, s(op.start), op.trackId || null);
    case "trim_clip":
      return trimClip(project, op.clipId, Number(op.sourceIn), Number(op.sourceOut));
    case "insert_media": {
      const m = mediaById(project, op.mediaId);
      if (!m) throw new Error(`Unknown media ${op.mediaId}`);
      const sourceIn = Math.max(0, Number(op.sourceIn ?? 0));
      const sourceOut = Math.min(m.duration, Number(op.sourceOut ?? m.duration));
      const trackId = op.trackId || (m.hasVideo ? "V1" : "A1");
      const start =
        op.start == null
          ? clipsOnTrack(project, trackId).reduce((e, c) => Math.max(e, clipEnd(c)), 0)
          : s(op.start);
      return placeClip(project, { trackId, mediaId: m.id, start, in: sourceIn, out: sourceOut });
    }
    case "add_text": {
      const start = s(op.start);
      const len = Math.max(0.2, s(op.end) - start);
      return placeClip(project, {
        trackId: op.trackId || "T1",
        start,
        in: 0,
        out: len,
        text: String(op.text ?? ""),
        style:
          op.look === "impact"
            ? { position: op.position || "center", size: Number(op.size) || 120, color: op.color || "#ffd400", box: false, outline: true }
            : { position: op.position || "bottom", size: Number(op.size) || 56, color: op.color || "#ffffff", box: op.box !== false },
      });
    }
    case "set_clip_volume":
      return updateClip(project, op.clipId, { volume: Math.max(0, Math.min(4, Number(op.volume))) });
    case "set_clip_fit":
      return updateClip(project, op.clipId, { fit: op.fit === "fill" ? "fill" : "fit" });
    case "set_format": {
      const p = clone(project);
      const even = (n) => Math.max(2, Math.round(Number(n) / 2) * 2);
      if (op.width) p.settings.width = even(op.width);
      if (op.height) p.settings.height = even(op.height);
      if (op.fps) p.settings.fps = Number(op.fps);
      return p;
    }
    case "add_marker": {
      const p = clone(project);
      p.markers.push({ id: uid("m"), time: s(op.time), label: String(op.label ?? ""), color: op.color || "#f5a623" });
      return p;
    }
    case "add_effect": {
      const type = String(op.type || "").toLowerCase();
      if (!EFFECT_TYPES[type]) throw new Error(`Unknown effect ${op.type}`);
      const start = s(op.start);
      const end = Math.max(start + 1 / fps, s(op.end));
      const intensity = Math.max(0.05, Math.min(1, Number(op.intensity) || EFFECT_TYPES[type].intensity));
      const p = clone(project);
      migrateProject(p);
      const trackId = op.trackId || freeTrack(p, "fx", start, end);
      return placeClip(p, { trackId, start, in: 0, out: end - start, effect: { type, intensity } });
    }
    case "set_clip_speed":
      return setClipSpeed(project, op.clipId, op.speed);
    case "slow_motion": {
      // Split the video under [start, end) and change the speed of that piece.
      const start = s(op.start);
      const end = s(op.end);
      const c = videoClipAt(project, start + 0.5 / fps);
      if (!c) throw new Error(`No video at ${start}s to slow down`);
      let p = splitAt(project, start, c.trackId);
      p = splitAt(p, Math.min(end, clipEnd(c)), c.trackId);
      const piece = p.clips.find((x) => x.trackId === c.trackId && Math.abs(x.start - start) < EPS * 10 + 0.5 / fps);
      if (!piece) throw new Error("Could not isolate the slow-motion range");
      return setClipSpeed(p, piece.id, op.speed ?? 0.5);
    }
    case "freeze_frame": {
      const time = s(op.time);
      const d = Math.max(0.1, s(op.duration ?? 1));
      const c = videoClipAt(project, time + 0.5 / fps) || videoClipAt(project, time - 0.5 / fps);
      if (!c) throw new Error(`No video at ${time}s to freeze`);
      const holdAt = Math.max(c.in, Math.min(c.out - 0.001, srcAt(c, Math.min(time, clipEnd(c) - 1 / fps))));
      const p = insertGap(project, time, d);
      p.clips.push({ id: uid(), trackId: c.trackId, mediaId: c.mediaId, start: time, in: 0, out: d, hold: true, holdAt, fit: c.fit || "fit", volume: 0 });
      return p;
    }
    case "add_sound": {
      const sound = String(op.sound || "").toLowerCase();
      const m = project.media.find((x) => x.sfx === sound);
      if (!m) throw new Error(`Sound effect "${sound}" hasn't been added to the project`);
      const start = s(op.time);
      const trackId = op.trackId || freeTrack(project, "audio", start, start + m.duration, "A1");
      return placeClip(project, { trackId, mediaId: m.id, start, in: 0, out: m.duration, volume: op.volume ?? 1 });
    }
    case "add_graphic": {
      const template = String(op.template || "").toLowerCase();
      if (template === "custom") {
        const p = clone(project);
        migrateProject(p);
        const { spec } = customSpec(p, op.spec);
        const start = op.start == null || op.start < 0 ? snapToFrame(timelineDuration(p), fps) : s(op.start);
        const end = op.end != null && op.end > start ? s(op.end) : start + spec.duration;
        spec.duration = end - start;
        const trackId = p.tracks.find((t) => t.kind === "graphics").id;
        return placeClip(p, { trackId, start, in: 0, out: end - start, graphic: { template: "custom", spec } });
      }
      const g = GRAPHICS[template];
      if (!g) throw new Error(`Unknown graphic ${op.template}`);
      const p = clone(project);
      migrateProject(p);
      // Start -1 = right after the end of everything (e.g. an outro).
      const start = op.start == null || op.start < 0 ? snapToFrame(timelineDuration(p), fps) : s(op.start);
      const end = op.end != null && op.end > start ? s(op.end) : start + g.duration;
      const props = {};
      for (const f of g.fields) {
        const v = op.props?.[f.key];
        if (v == null || v === "") continue;
        if (f.type === "image" && !p.media.some((m) => m.id === v && m.isImage)) throw new Error(`No image with id ${v} for ${f.key}`);
        if (f.type === "select" && !f.options.includes(String(v))) continue;
        props[f.key] = typeof v === "number" ? v : String(v);
      }
      const trackId = p.tracks.find((t) => t.kind === "graphics").id;
      return placeClip(p, { trackId, start, in: 0, out: end - start, graphic: { template, props } });
    }
    case "update_graphic": {
      // Replace a graphic's design (custom spec) or change template props.
      const c = project.clips.find((x) => x.id === op.clipId);
      if (!c?.graphic) throw new Error(`Clip ${op.clipId} isn't a graphic`);
      const p = clone(project);
      const target = p.clips.find((x) => x.id === op.clipId);
      if (op.spec) {
        const { spec } = customSpec(p, op.spec);
        target.graphic = { template: "custom", spec };
        target.out = target.in + spec.duration;
      } else if (op.props && GRAPHICS[target.graphic.template]) {
        target.graphic = { ...target.graphic, props: { ...(target.graphic.props || {}), ...op.props } };
      }
      return p;
    }
    case "clear_timeline": {
      const p = clone(project);
      p.clips = op.trackId ? p.clips.filter((c) => c.trackId !== op.trackId) : [];
      if (!op.trackId) p.markers = [];
      return p;
    }
    default:
      throw new Error(`Unknown operation: ${op.op}`);
  }
}

// Apply a list of operations. Stops at the first failure and reports which.
export function applyOperations(project, ops) {
  let p = project;
  const applied = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      p = applyOperation(p, ops[i]);
      applied.push(i);
    } catch (e) {
      return { project: p, applied, error: `Operation ${i + 1} (${ops[i].op}): ${e.message}` };
    }
  }
  return { project: p, applied, error: null };
}

// ---------------------------------------------------------------------------
// Mapping source-media facts onto the timeline
// ---------------------------------------------------------------------------

// For each clip, map source-time intervals (e.g. silences) into timeline time.
export function mapSourceIntervals(project, mediaId, intervals) {
  const out = [];
  for (const c of project.clips) {
    if (c.mediaId !== mediaId || c.hold) continue;
    const sp = speedOf(c);
    for (const iv of intervals) {
      const a = Math.max(iv.start, c.in);
      const b = Math.min(iv.end, c.out);
      if (b - a > EPS) out.push({ ...iv, clipId: c.id, start: c.start + (a - c.in) / sp, end: c.start + (b - c.in) / sp });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export function mapSourcePoint(project, mediaId, t) {
  const hits = [];
  for (const c of project.clips) {
    if (c.mediaId === mediaId && !c.hold && t >= c.in - EPS && t <= c.out + EPS) hits.push(c.start + (t - c.in) / speedOf(c));
  }
  return hits;
}

export function formatTimecode(t, fps = 30) {
  t = Math.max(0, t);
  const frames = Math.round(t * fps);
  const f = frames % Math.round(fps);
  const total = Math.floor(frames / Math.round(fps));
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(f)}`;
}
