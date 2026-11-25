import { store } from "./state.js";
import {
  clipDuration, clipEnd, mediaById, trackById, placeClip, splitAt, trimClip,
  formatTimecode, snapToFrame, uid,
} from "/shared/timeline.js";

const HEADER_W = 92;
const RULER_H = 28;
const TRACK_H = { text: 34, video: 66, audio: 50 };
const EDGE = 7; // px grab zone for trimming
const COLORS = {
  video: ["#2d5488", "#3d6fb0", "#5a8ed1"],
  audio: ["#2c6a46", "#3f8f5e", "#5bb37f"],
  text: ["#5a4290", "#7a5bb5", "#9c7fd6"],
};

const canvas = document.getElementById("timeline");
const wrap = document.getElementById("timelineWrap");
const ctx = canvas.getContext("2d");
const zoomInput = document.getElementById("zoom");

let pps = 40; // pixels per second
let scrollX = 0; // seconds at the left edge
let scrollY = 0;
let width = 0;
let height = 0;
let drag = null; // current mouse interaction
let hover = null; // { x, y, t, track, clip, edge }
let dropGhost = null; // media drag preview
let needsDraw = true;

const thumbCache = new Map(); // `${mediaId}/${n}` -> Image
const waveCache = new Map(); // mediaId -> { rate, peaks: Uint8Array } | "loading"

// ---- geometry ----------------------------------------------------------------

const xOf = (t) => HEADER_W + (t - scrollX) * pps;
const tOf = (x) => scrollX + (x - HEADER_W) / pps;

function trackLayout() {
  const out = [];
  let y = RULER_H - scrollY;
  for (const t of store.project?.tracks || []) {
    const h = TRACK_H[t.kind];
    out.push({ track: t, y, h });
    y += h + 1;
  }
  return out;
}
function contentHeight() {
  return (store.project?.tracks || []).reduce((h, t) => h + TRACK_H[t.kind] + 1, RULER_H);
}
function trackAt(y) {
  return trackLayout().find((l) => y >= l.y && y < l.y + l.h) || null;
}
function clipAt(x, y) {
  const lay = trackAt(y);
  if (!lay) return null;
  const t = tOf(x);
  const clip = store.project.clips.find((c) => c.trackId === lay.track.id && t >= c.start && t < clipEnd(c));
  if (!clip) return { lay, clip: null, edge: null };
  const x0 = xOf(clip.start);
  const x1 = xOf(clipEnd(clip));
  let edge = null;
  if (x1 - x0 > EDGE * 3) {
    if (x - x0 < EDGE) edge = "left";
    else if (x1 - x < EDGE) edge = "right";
  }
  return { lay, clip, edge };
}

function snapPoints(excludeIds = new Set()) {
  const pts = [0, store.playhead];
  for (const c of store.project.clips) {
    if (excludeIds.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  for (const m of store.project.markers) pts.push(m.time);
  return pts;
}
function snap(t, points) {
  if (!store.snapping) return t;
  const thr = 8 / pps;
  let best = t;
  let bestD = thr;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
const fps = () => store.project?.settings.fps || 30;
const frameSnap = (t) => snapToFrame(t, fps());

// ---- zoom & scroll ----------------------------------------------------------------

const ZMIN = 1.5;
const ZMAX = 600;
const sliderToPps = (v) => ZMIN * Math.pow(ZMAX / ZMIN, v / 100);
const ppsToSlider = (p) => (100 * Math.log(p / ZMIN)) / Math.log(ZMAX / ZMIN);

export function setZoom(newPps, anchorX = null) {
  newPps = Math.max(ZMIN, Math.min(ZMAX, newPps));
  const ax = anchorX ?? Math.max(HEADER_W, Math.min(width, xOf(store.playhead)));
  const anchorT = tOf(ax);
  pps = newPps;
  scrollX = Math.max(0, anchorT - (ax - HEADER_W) / pps);
  zoomInput.value = ppsToSlider(pps);
  redraw();
}
export function zoomBy(f) {
  setZoom(pps * f);
}
export function zoomToFit() {
  const d = Math.max(store.duration, 10);
  pps = Math.max(ZMIN, Math.min(ZMAX, (width - HEADER_W - 40) / d));
  scrollX = 0;
  zoomInput.value = ppsToSlider(pps);
  redraw();
}
zoomInput.addEventListener("input", () => setZoom(sliderToPps(Number(zoomInput.value))));

function clampScroll() {
  const maxT = Math.max(store.duration + 30, (width - HEADER_W) / pps);
  scrollX = Math.max(0, Math.min(scrollX, maxT));
  scrollY = Math.max(0, Math.min(scrollY, Math.max(0, contentHeight() - height + 10)));
}

// Keep the playhead in view while playing.
export function followPlayhead() {
  const x = xOf(store.playhead);
  if (x > width - 30 || x < HEADER_W) {
    scrollX = Math.max(0, store.playhead - (x > width - 30 ? 0.1 : 0.5) * ((width - HEADER_W) / pps));
  }
}

// ---- assets ------------------------------------------------------------------------

function thumb(media, n) {
  const key = `${media.id}/${n}`;
  let img = thumbCache.get(key);
  if (!img) {
    img = new Image();
    img.onload = redraw;
    img.src = `/media/${media.id}/thumbs/${String(n).padStart(4, "0")}.jpg`;
    thumbCache.set(key, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function wave(media) {
  const w = waveCache.get(media.id);
  if (w && w !== "loading") return w;
  if (!w && media.status === "ready" && media.hasAudio) {
    waveCache.set(media.id, "loading");
    fetch(`/media/${media.id}/waveform`)
      .then((r) => r.json())
      .then((d) => {
        if (!d) return waveCache.delete(media.id);
        const bin = atob(d.peaks);
        const peaks = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) peaks[i] = bin.charCodeAt(i);
        waveCache.set(media.id, { rate: d.rate, peaks });
        redraw();
      })
      .catch(() => waveCache.delete(media.id));
  }
  return null;
}

export function forgetMedia(mediaId) {
  waveCache.delete(mediaId);
  for (const k of thumbCache.keys()) if (k.startsWith(mediaId + "/")) thumbCache.delete(k);
}

// ---- drawing ------------------------------------------------------------------------

export function redraw() {
  needsDraw = true;
}

function frame() {
  if (needsDraw && store.project) {
    needsDraw = false;
    draw();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = wrap.clientWidth;
  height = wrap.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
new ResizeObserver(resize).observe(wrap);

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function niceStep(minSec) {
  const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s >= minSec) || 7200;
}

function fmtRuler(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = Number.isInteger(Math.round(s * 10) / 10) ? String(Math.round(s)).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${ss}`;
}

function draw() {
  clampScroll();
  const p = store.project;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#16171b";
  ctx.fillRect(0, 0, width, height);

  const layout = trackLayout();
  const t0 = tOf(HEADER_W);
  const t1 = tOf(width);

  // Track lanes
  for (const { track, y, h } of layout) {
    ctx.fillStyle = "#1c1d22";
    ctx.fillRect(HEADER_W, y, width - HEADER_W, h);
  }

  // Grid lines
  const major = niceStep(90 / pps);
  ctx.strokeStyle = "#202127";
  ctx.lineWidth = 1;
  for (let t = Math.floor(t0 / major) * major; t <= t1; t += major) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Clips
  ctx.save();
  ctx.beginPath();
  ctx.rect(HEADER_W, RULER_H, width - HEADER_W, height - RULER_H);
  ctx.clip();
  const moving = drag?.type === "move" && drag.moved ? new Set(drag.ids) : new Set();
  for (const { track, y, h } of layout) {
    for (const c of p.clips) {
      if (c.trackId !== track.id) continue;
      if (clipEnd(c) < t0 || c.start > t1) continue;
      drawClip(c, track, y, h, { dim: moving.has(c.id) });
    }
  }
  // Move ghosts
  if (drag?.type === "move" && drag.moved) {
    for (const g of drag.ghosts) {
      const lay = layout.find((l) => l.track.id === g.trackId);
      if (lay) drawClip({ ...g.clip, start: g.start, trackId: g.trackId }, lay.track, lay.y, lay.h, { ghost: true });
    }
  }
  if (dropGhost) {
    const lay = layout.find((l) => l.track.id === dropGhost.trackId);
    if (lay) drawClip(dropGhost.clip, lay.track, lay.y, lay.h, { ghost: true });
  }
  // Razor hover line
  if (store.tool === "razor" && hover?.lay && hover.clip) {
    const x = Math.round(xOf(hover.snapT)) + 0.5;
    ctx.strokeStyle = "#fff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, hover.lay.y);
    ctx.lineTo(x, hover.lay.y + hover.lay.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Snap indicator
  if (drag?.snapLine != null) {
    const x = Math.round(xOf(drag.snapLine)) + 0.5;
    ctx.strokeStyle = "#f5d76e";
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.restore();

  // Track headers
  for (const { track, y, h } of layout) {
    ctx.fillStyle = "#202127";
    ctx.fillRect(0, y, HEADER_W, h);
    ctx.fillStyle = COLORS[track.kind][1];
    ctx.fillRect(0, y, 3, h);
    ctx.fillStyle = "#e6e6ea";
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(track.id, 12, y + h / 2 - (h > 40 ? 7 : 0));
    if (h > 40) {
      ctx.fillStyle = "#8d8f99";
      ctx.font = "11px Inter, system-ui, sans-serif";
      ctx.fillText(track.kind === "video" ? "Video" : track.kind === "audio" ? "Audio" : "Titles", 12, y + h / 2 + 9);
    }
  }
  ctx.strokeStyle = "#2b2c33";
  ctx.beginPath();
  ctx.moveTo(HEADER_W + 0.5, 0);
  ctx.lineTo(HEADER_W + 0.5, height);
  ctx.stroke();

  // Ruler
  ctx.fillStyle = "#1b1c20";
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(HEADER_W, 0, width - HEADER_W, RULER_H);
  ctx.clip();
  const minor = major / 5;
  ctx.strokeStyle = "#4a4b55";
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(xOf(t)) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.beginPath();
    ctx.moveTo(x, isMajor ? 12 : RULER_H - 6);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = "#9a9ca6";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textBaseline = "top";
      ctx.fillText(fmtRuler(Math.max(0, t)), x + 3, 2);
    }
  }
  // Markers
  for (const m of p.markers) {
    const x = xOf(m.time);
    if (x < HEADER_W - 10 || x > width + 10) continue;
    ctx.fillStyle = m.color || "#f5a623";
    ctx.beginPath();
    ctx.moveTo(x - 5, RULER_H - 12);
    ctx.lineTo(x + 5, RULER_H - 12);
    ctx.lineTo(x + 5, RULER_H - 5);
    ctx.lineTo(x, RULER_H);
    ctx.lineTo(x - 5, RULER_H - 5);
    ctx.closePath();
    ctx.fill();
    if (m.label && pps * 4 > ctx.measureText(m.label).width) {
      ctx.font = "10px Inter, sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText(m.label, x + 7, RULER_H - 3);
    }
  }
  ctx.restore();
  ctx.fillStyle = "#1b1c20";
  ctx.fillRect(0, 0, HEADER_W, RULER_H);
  ctx.fillStyle = "#e6e6ea";
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(formatTimecode(store.playhead, fps()), 6, RULER_H / 2);
  ctx.strokeStyle = "#2b2c33";
  ctx.beginPath();
  ctx.moveTo(0, RULER_H + 0.5);
  ctx.lineTo(width, RULER_H + 0.5);
  ctx.stroke();

  // Playhead
  const px = Math.round(xOf(store.playhead)) + 0.5;
  if (px >= HEADER_W) {
    ctx.strokeStyle = "#ff4d4f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H - 8);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillStyle = "#ff4d4f";
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 6, RULER_H - 12);
    ctx.lineTo(px, RULER_H - 6);
    ctx.lineTo(px - 6, RULER_H - 12);
    ctx.closePath();
    ctx.fill();
  }
}

function drawClip(c, track, y, h, { ghost = false, dim = false } = {}) {
  const p = store.project;
  const x0 = xOf(c.start);
  const x1 = xOf(clipEnd(c));
  const w = Math.max(2, x1 - x0);
  const selected = store.selection.has(c.id) && !ghost;
  const [dark, base, light] = COLORS[track.kind];
  const media = c.mediaId ? mediaById(p, c.mediaId) : null;
  const top = y + 1;
  const hh = h - 2;

  ctx.save();
  ctx.globalAlpha = ghost ? 0.6 : dim ? 0.35 : 1;
  roundRect(x0, top, w, hh, 4);
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.save();
  ctx.clip();

  const visX0 = Math.max(x0, HEADER_W);
  const visX1 = Math.min(x0 + w, width);

  if (track.kind === "video" && media) {
    // Filmstrip
    const stripH = hh - 16;
    if (media.thumbCount && stripH > 10) {
      const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
      const tw = Math.max(20, stripH * aspect);
      const startTile = Math.floor((visX0 - x0) / tw);
      for (let tx = x0 + startTile * tw; tx < visX1; tx += tw) {
        const srcT = c.in + (tx - x0) / pps;
        const n = Math.min(media.thumbCount, Math.max(1, Math.floor(srcT / media.thumbInterval) + 1));
        const img = thumb(media, n);
        if (img) ctx.drawImage(img, tx, top + 16, tw, stripH);
      }
    }
    // Waveform at the bottom
    if (media.hasAudio && (c.volume ?? 1) > 0) drawWave(c, media, visX0, visX1, x0, top + hh - 14, 14, "rgba(255,255,255,0.55)");
    ctx.fillStyle = base;
    ctx.fillRect(x0, top, w, 16);
  } else if (track.kind === "audio" && media) {
    ctx.fillStyle = base;
    ctx.fillRect(x0, top, w, 15);
    drawWave(c, media, visX0, visX1, x0, top + 15, hh - 15, light);
  } else if (track.kind === "text") {
    ctx.fillStyle = base;
    ctx.fillRect(x0, top, w, hh);
  }

  // Label
  if (w > 24) {
    ctx.fillStyle = "#fff";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const label = track.kind === "text" ? "T  " + (c.text || "").replace(/\n/g, " ") : media?.name || "Missing media";
    ctx.fillText(label, Math.max(x0, HEADER_W) + 6, top + (track.kind === "text" ? hh / 2 : 8), Math.max(10, visX1 - Math.max(x0, HEADER_W) - 10));
  }
  if ((c.volume ?? 1) !== 1 && w > 60 && track.kind !== "text") {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const txt = c.volume === 0 ? "muted" : `${Math.round(c.volume * 100)}%`;
    ctx.font = "10px Inter, sans-serif";
    const tw = ctx.measureText(txt).width + 8;
    ctx.fillRect(Math.min(x0 + w, width) - tw - 4, top + 2, tw, 12);
    ctx.fillStyle = "#fff";
    ctx.fillText(txt, Math.min(x0 + w, width) - tw, top + 8);
  }
  ctx.restore();

  roundRect(x0 + 0.5, top + 0.5, w - 1, hh - 1, 4);
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? "#ffb86b" : ghost ? "#fff" : light;
  ctx.stroke();
  // Trim handle hint
  if (hover?.clip?.id === c.id && hover.edge && !ghost) {
    ctx.fillStyle = "#ffb86b";
    const hx = hover.edge === "left" ? x0 : x0 + w - 4;
    ctx.fillRect(hx, top, 4, hh);
  }
  ctx.restore();
}

function drawWave(c, media, visX0, visX1, x0, y, h, color) {
  const wv = wave(media);
  if (!wv) return;
  const mid = y + h / 2;
  const vol = Math.min(2, c.volume ?? 1);
  ctx.fillStyle = color;
  for (let x = Math.floor(visX0); x < visX1; x += 2) {
    const sa = c.in + (x - x0) / pps;
    const sb = c.in + (x + 2 - x0) / pps;
    let a = Math.floor(sa * wv.rate);
    const b = Math.max(a + 1, Math.floor(sb * wv.rate));
    let peak = 0;
    for (; a < b && a < wv.peaks.length; a++) if (wv.peaks[a] > peak) peak = wv.peaks[a];
    const amp = Math.min(1, (peak / 255) * vol) * (h / 2 - 1);
    ctx.fillRect(x, mid - amp, 1.5, Math.max(1, amp * 2));
  }
}

// ---- interaction -------------------------------------------------------------------

function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener("mousedown", (e) => {
  if (!store.project || e.button !== 0) return;
  const { x, y } = pointer(e);
  if (x < HEADER_W) return;
  if (y < RULER_H) {
    // Alt+click a marker to remove it.
    const marker = store.project.markers.find((m) => Math.abs(xOf(m.time) - x) < 6);
    if (marker && e.altKey) {
      store.commit({ ...store.project, markers: store.project.markers.filter((m) => m !== marker) });
      return;
    }
    drag = { type: "scrub" };
    store.setPlayhead(frameSnap(Math.max(0, tOf(x))));
    return;
  }
  const hit = clipAt(x, y);
  if (!hit?.clip) {
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) store.select([]);
    drag = { type: "scrub" };
    store.setPlayhead(frameSnap(Math.max(0, tOf(x))));
    return;
  }
  const clip = hit.clip;
  if (store.tool === "razor") {
    const t = frameSnap(snap(tOf(x), snapPoints()));
    store.commit(splitAt(store.project, t, clip.trackId));
    return;
  }
  if (e.shiftKey || e.metaKey || e.ctrlKey) store.select(clip.id, { additive: true });
  else if (!store.selection.has(clip.id)) store.select(clip.id);

  if (hit.edge) {
    drag = { type: "trim", edge: hit.edge, clip: { ...clip }, startX: x, moved: false };
  } else {
    const ids = store.selection.has(clip.id) ? [...store.selection] : [clip.id];
    drag = {
      type: "move",
      clip: { ...clip },
      ids,
      startX: x,
      startY: y,
      moved: false,
      ghosts: [],
      originTrack: clip.trackId,
    };
  }
});

window.addEventListener("mousemove", (e) => {
  if (!store.project) return;
  const { x, y } = pointer(e);
  if (!drag) {
    if (e.target !== canvas) return;
    const hit = x > HEADER_W && y > RULER_H ? clipAt(x, y) : null;
    hover = hit ? { ...hit, snapT: frameSnap(snap(tOf(x), snapPoints())) } : null;
    canvas.style.cursor =
      store.tool === "razor" && hit?.clip ? "crosshair" : hit?.edge ? "ew-resize" : y < RULER_H && x > HEADER_W ? "text" : "default";
    redraw();
    return;
  }
  if (drag.type === "scrub") {
    store.setPlayhead(frameSnap(Math.max(0, tOf(x))));
    autoScroll(x);
    return;
  }
  const dx = x - drag.startX;
  if (!drag.moved && Math.abs(dx) < 3 && (drag.type !== "move" || Math.abs(y - drag.startY) < 3)) return;
  drag.moved = true;
  const p = store.project;

  if (drag.type === "move") {
    const clips = drag.ids.map((id) => p.clips.find((c) => c.id === id)).filter(Boolean);
    const exclude = new Set(drag.ids);
    const pts = snapPoints(exclude);
    let dt = dx / pps;
    // Snap the dragged clip's start or end.
    const s = drag.clip.start + dt;
    const sS = snap(s, pts);
    const sE = snap(s + clipDuration(drag.clip), pts) - clipDuration(drag.clip);
    drag.snapLine = null;
    if (sS !== s) {
      dt = sS - drag.clip.start;
      drag.snapLine = sS;
    } else if (sE !== s) {
      dt = sE - drag.clip.start;
      drag.snapLine = sE + clipDuration(drag.clip);
    }
    const minStart = Math.min(...clips.map((c) => c.start));
    dt = Math.max(dt, -minStart);
    // Vertical: only single-clip drags can change track, to one of the same kind.
    let trackId = null;
    if (clips.length === 1) {
      const lay = trackAt(y);
      const srcKind = trackById(p, drag.clip.trackId).kind;
      if (lay && lay.track.kind === srcKind) trackId = lay.track.id;
    }
    drag.ghosts = clips.map((c) => ({
      clip: c,
      start: frameSnap(c.start + dt),
      trackId: clips.length === 1 && trackId ? trackId : c.trackId,
    }));
    autoScroll(x);
    redraw();
  } else if (drag.type === "trim") {
    const c = drag.clip;
    const media = c.mediaId ? mediaById(p, c.mediaId) : null;
    const neighbors = p.clips.filter((o) => o.trackId === c.trackId && o.id !== c.id);
    let t = snap((drag.edge === "left" ? c.start : clipEnd(c)) + dx / pps, snapPoints(new Set([c.id])));
    drag.snapLine = null;
    let next = { ...c };
    if (drag.edge === "left") {
      const prevEnd = Math.max(0, ...neighbors.filter((o) => clipEnd(o) <= c.start + 1e-6).map(clipEnd));
      const minStart = media ? Math.max(prevEnd, c.start - c.in) : prevEnd;
      t = frameSnap(Math.max(minStart, Math.min(t, clipEnd(c) - 1 / fps())));
      const delta = t - c.start;
      next = media ? { ...c, start: t, in: c.in + delta } : { ...c, start: t, in: 0, out: c.out - delta };
    } else {
      const nextStart = Math.min(Infinity, ...neighbors.filter((o) => o.start >= clipEnd(c) - 1e-6).map((o) => o.start));
      const maxEnd = media ? Math.min(nextStart, c.start + (media.duration - c.in)) : nextStart;
      t = frameSnap(Math.min(maxEnd, Math.max(t, c.start + 1 / fps())));
      next = { ...c, out: c.in + (t - c.start) };
    }
    if (Math.abs(t - (drag.edge === "left" ? next.start : clipEnd(next))) < 1e-6) drag.snapLine = t;
    drag.preview = next;
    // Live preview: draw by swapping into the project without committing.
    store.project = { ...p, clips: p.clips.map((o) => (o.id === c.id ? next : o)) };
    store.emit("change", { reason: "preview" });
  }
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === "move" && d.moved && d.ghosts.length) {
    // Remove the moved clips, then place each one (overwriting what's under it).
    let p = { ...store.project, clips: store.project.clips.filter((c) => !d.ids.includes(c.id)) };
    for (const g of d.ghosts) p = placeClip(p, { ...g.clip, start: g.start, trackId: g.trackId });
    store.commit(p);
  } else if (d.type === "trim" && d.moved && d.preview) {
    // Restore the pre-drag state so the undo snapshot is correct, then commit.
    const before = { ...store.project, clips: store.project.clips.map((o) => (o.id === d.clip.id ? d.clip : o)) };
    store.project = before;
    store.commit({ ...before, clips: before.clips.map((o) => (o.id === d.clip.id ? d.preview : o)) });
  }
  redraw();
});

function autoScroll(x) {
  if (x > width - 20) scrollX += 20 / pps;
  else if (x < HEADER_W + 10 && scrollX > 0) scrollX = Math.max(0, scrollX - 20 / pps);
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const { x } = pointer(e);
    if (e.ctrlKey || e.metaKey) {
      setZoom(pps * Math.exp(-e.deltaY * 0.0025), Math.max(HEADER_W, x));
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      scrollX += (e.shiftKey ? e.deltaY : e.deltaX) / pps;
    } else if (contentHeight() > height) {
      scrollY += e.deltaY;
    } else {
      scrollX += e.deltaY / pps;
    }
    clampScroll();
    redraw();
  },
  { passive: false }
);

canvas.addEventListener("mouseleave", () => {
  hover = null;
  redraw();
});

// ---- drag & drop from the media pool -------------------------------------------------

canvas.addEventListener("dragover", (e) => {
  const id = window.__draggingMedia;
  const media = id && mediaById(store.project, id);
  if (!media) return;
  e.preventDefault();
  const { x, y } = pointer(e);
  let lay = trackAt(y);
  let kind = lay?.track.kind;
  if (!lay || kind === "text" || (kind === "video" && !media.hasVideo)) {
    lay = trackLayout().find((l) => l.track.kind === (media.hasVideo ? "video" : "audio") && l.track.id.endsWith("1"));
  }
  const dur = media.duration;
  const start = frameSnap(Math.max(0, snap(tOf(x), snapPoints())));
  dropGhost = { trackId: lay.track.id, clip: { id: "ghost", trackId: lay.track.id, mediaId: media.id, start, in: 0, out: dur } };
  redraw();
});
canvas.addEventListener("dragleave", () => {
  dropGhost = null;
  redraw();
});
canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  const g = dropGhost;
  dropGhost = null;
  if (!g) return;
  const clip = { ...g.clip, id: uid() };
  store.commit(placeClip(store.project, clip));
  store.select(clip.id);
});

// ---- public -----------------------------------------------------------------------

export function getViewInfo() {
  return { pps, scrollX };
}

store.on("change", redraw);
store.on("selection", redraw);
store.on("tool", redraw);
store.on("media", redraw);
store.on("playhead", ({ fromPlayback }) => {
  if (fromPlayback) followPlayhead();
  redraw();
});
store.on("project", () => {
  scrollX = 0;
  scrollY = 0;
  setTimeout(zoomToFit, 0);
});
