// Timeline model and edit operations.
// Pure functions shared by the browser UI and the Node server. Every operation
// takes a project and returns a new project; nothing is mutated in place, which
// is what makes undo/redo a simple snapshot stack.
//
// Units: all times are seconds (floats). Timeline positions snap to frames.
//
// Clip shape:
//   { id, trackId, start, in, out, mediaId?, volume?, fit?, text?, style? }
//   start    = position on the timeline
//   in/out   = range in the source media (for text clips: in = 0, out = length)
//   duration = out - in

export const TRACK_KINDS = ["video", "audio", "text"];

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

export const clipDuration = (c) => c.out - c.in;
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
    const offset = t - c.start;
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
  const m = c.mediaId ? mediaById(p, c.mediaId) : null;
  const maxOut = m?.duration ?? Infinity;
  newIn = Math.max(0, newIn);
  newOut = Math.min(maxOut, newOut);
  if (newOut - newIn < 0.04) return p;
  const end = clipEnd(c);
  c.in = newIn;
  c.out = newOut;
  if (keepEnd) c.start = Math.max(0, end - (newOut - newIn));
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
        style: {
          position: op.position || "bottom",
          size: Number(op.size) || 56,
          color: op.color || "#ffffff",
          box: op.box !== false,
        },
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
    if (c.mediaId !== mediaId) continue;
    for (const iv of intervals) {
      const a = Math.max(iv.start, c.in);
      const b = Math.min(iv.end, c.out);
      if (b - a > EPS) out.push({ ...iv, clipId: c.id, start: c.start + (a - c.in), end: c.start + (b - c.in) });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export function mapSourcePoint(project, mediaId, t) {
  const hits = [];
  for (const c of project.clips) {
    if (c.mediaId === mediaId && t >= c.in - EPS && t <= c.out + EPS) hits.push(c.start + (t - c.in));
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
