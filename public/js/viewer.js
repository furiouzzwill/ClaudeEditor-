// Timeline playback using the proxies. Each video/audio track gets its own
// <video> element; a wall-clock drives the playhead and each element is kept
// in sync with whichever clip sits under the playhead on its track.

import { store } from "./state.js";
import { clipEnd, mediaById, formatTimecode, videoTracksBottomUp, srcAt, speedOf } from "/shared/timeline.js";

const stageWrap = document.getElementById("stageWrap");
const stage = document.getElementById("stage");
const layers = document.getElementById("stageLayers");
const textLayer = document.getElementById("stageText");
const empty = document.getElementById("stageEmpty");
const tcCurrent = document.getElementById("tcCurrent");
const tcDuration = document.getElementById("tcDuration");
const btnPlay = document.getElementById("btnPlay");
const formatLabel = document.getElementById("formatLabel");

const players = new Map(); // trackId -> { el, clipId, mediaId }

// Effect preview layers (the export uses FFmpeg filters that match these).
const flashEl = document.createElement("div");
flashEl.style.cssText = "position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:40";
const spotEl = document.createElement("div");
spotEl.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:39;opacity:0;background:radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.92) 100%)";
stage.append(spotEl, flashEl);

function applyEffects(t) {
  const p = store.project;
  const active = p.clips.filter((c) => c.effect && t >= c.start && t < clipEnd(c));
  let zoom = 1;
  let dx = 0;
  let dy = 0;
  const filters = [];
  let flash = 0;
  let spot = 0;
  for (const c of active) {
    const k = c.effect.intensity ?? 0.5;
    const a = c.start;
    const b = clipEnd(c);
    const r = Math.max(0.04, Math.min(0.15, (b - a) / 3));
    const env = Math.min(1, Math.max(0, (t - a) / r)) * Math.min(1, Math.max(0, (b - t) / r));
    switch (c.effect.type) {
      case "zoom":
        zoom += k * env;
        break;
      case "shake":
        zoom += 0.1 * k * env;
        dx += 3.5 * k * Math.sin(t * 53) * env;
        dy += 3.5 * k * Math.cos(t * 41) * env;
        break;
      case "flash":
        flash = Math.max(flash, k * Math.max(0, 1 - (t - a) / Math.max(0.05, b - a)));
        break;
      case "rainbow":
        filters.push(`hue-rotate(${(t - a) * (150 + 250 * k)}deg) saturate(${1 + 0.9 * k})`);
        break;
      case "blur":
        filters.push(`blur(${((4 + 36 * k) * Number(stage.dataset.scale || 1)).toFixed(1)}px)`);
        break;
      case "black_white":
        filters.push("grayscale(1)");
        break;
      case "spotlight":
        spot = Math.max(spot, 0.35 + 0.65 * k);
        break;
    }
  }
  layers.style.transform = zoom !== 1 || dx || dy ? `translate(${dx}%, ${dy}%) scale(${zoom})` : "";
  layers.style.filter = filters.join(" ");
  flashEl.style.opacity = flash.toFixed(3);
  spotEl.style.opacity = spot.toFixed(3);
}
let clock = null; // { t0: performance.now(), p0: playhead }
let raf = null;

function layoutStage() {
  if (!store.project) return;
  const { width: W, height: H } = store.project.settings;
  const bw = stageWrap.clientWidth - 24;
  const bh = stageWrap.clientHeight - 24;
  const scale = Math.min(bw / W, bh / H);
  stage.style.width = Math.max(10, Math.floor(W * scale)) + "px";
  stage.style.height = Math.max(10, Math.floor(H * scale)) + "px";
  stage.dataset.scale = scale;
  formatLabel.textContent = `${W}×${H} · ${Number(store.project.settings.fps.toFixed(3))} fps`;
  renderText();
}
new ResizeObserver(layoutStage).observe(stageWrap);

function ensurePlayers() {
  const p = store.project;
  const wanted = [...videoTracksBottomUp(p), ...p.tracks.filter((t) => t.kind === "audio")];
  for (const [id, pl] of players) {
    if (!wanted.some((t) => t.id === id)) {
      pl.el.remove();
      players.delete(id);
    }
  }
  wanted.forEach((t, i) => {
    let pl = players.get(t.id);
    if (!pl) {
      const el = document.createElement("video");
      el.playsInline = true;
      el.preload = "auto";
      el.dataset.track = t.id;
      pl = { el, clipId: null, mediaId: null, kind: t.kind };
      players.set(t.id, pl);
    }
    pl.el.className = t.kind === "video" && i === 0 ? "base" : "";
    pl.el.style.zIndex = String(i);
    if (t.kind === "audio") pl.el.style.visibility = "hidden";
    // Re-appending a media element pauses it, so only attach new ones.
    if (pl.el.parentNode !== layers) {
      pl.el.style.display = "none";
      layers.appendChild(pl.el);
    }
  });
}

function clipAtTime(trackId, t) {
  return store.project.clips.find((c) => c.trackId === trackId && t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6);
}

// Sync every track's element to time t. When playing, small drift is
// tolerated to avoid stutter; when paused, seek exactly.
function syncTo(t, playing) {
  const p = store.project;
  let anyVideo = false;
  for (const [trackId, pl] of players) {
    const clip = clipAtTime(trackId, t);
    const el = pl.el;
    const media = clip?.mediaId ? mediaById(p, clip.mediaId) : null;
    const usable = media && media.proxy && (media.status === "ready" || media.progress >= 0.6);
    if (!clip || !usable) {
      if (!el.paused) el.pause();
      el.style.display = "none";
      pl.clipId = null;
      continue;
    }
    if (pl.mediaId !== media.id) {
      el.src = `/media/${media.id}/proxy`;
      pl.mediaId = media.id;
    }
    pl.clipId = clip.id;
    if (pl.kind === "video") {
      el.style.display = "block";
      el.classList.toggle("fill", clip.fit === "fill");
      anyVideo = true;
    }
    const vol = Math.max(0, Math.min(1, clip.volume ?? 1));
    el.muted = vol === 0 || !media.hasAudio;
    el.volume = vol;
    const target = srcAt(clip, t);
    const rate = speedOf(clip);
    if (el.playbackRate !== rate) el.playbackRate = rate;
    if (clip.hold) {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.01 && !el.seeking) el.currentTime = target;
    } else if (playing) {
      if (Math.abs(el.currentTime - target) > 0.25 && !el.seeking) el.currentTime = target;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.01) {
        if (el.seeking) el.dataset.pending = target;
        else el.currentTime = target;
      }
    }
  }
  empty.hidden = anyVideo || store.project.clips.length > 0;
  applyEffects(t);
  renderText();
}

function renderText() {
  const p = store.project;
  if (!p) return;
  const t = store.playhead;
  const scale = Number(stage.dataset.scale || 1);
  const active = p.clips.filter((c) => c.text && p.tracks.find((tr) => tr.id === c.trackId)?.kind === "text" && t >= c.start && t < clipEnd(c));
  const key = active.map((c) => c.id + JSON.stringify(c.style) + c.text).join("|") + scale;
  if (textLayer.dataset.key === key) return;
  textLayer.dataset.key = key;
  textLayer.innerHTML = "";
  for (const c of active) {
    const st = c.style || {};
    const div = document.createElement("div");
    div.className = "title" + (st.box === false ? "" : " box") + (st.outline ? " outline" : "");
    div.textContent = c.text;
    const size = (st.size || 56) * (p.settings.height / 1080) * scale;
    div.style.fontSize = size + "px";
    div.style.color = st.color || "#fff";
    div.style.padding = st.box === false ? "0" : `${18 * (p.settings.height / 1080) * scale}px`;
    const h = p.settings.height * scale;
    if (st.position === "top") div.style.top = h * 0.08 + "px";
    else if (st.position === "center") {
      div.style.top = "50%";
      div.style.transform = "translate(-50%, -50%)";
    } else div.style.bottom = h * 0.12 + "px";
    textLayer.appendChild(div);
  }
}

// Apply a pending seek once the previous one completes (smooth scrubbing).
layers.addEventListener(
  "seeked",
  (e) => {
    const el = e.target;
    if (el.dataset.pending) {
      const t = Number(el.dataset.pending);
      delete el.dataset.pending;
      if (Math.abs(el.currentTime - t) > 0.01) el.currentTime = t;
    }
  },
  true
);

function tick() {
  if (!clock) return;
  const t = clock.p0 + (performance.now() - clock.t0) / 1000;
  const end = store.duration;
  if (t >= end) {
    store.setPlayhead(end, { fromPlayback: true });
    pause();
    return;
  }
  store.setPlayhead(t, { fromPlayback: true });
  raf = requestAnimationFrame(tick);
}

export function play() {
  if (!store.project || clock) return;
  if (store.playhead >= store.duration - 0.05) store.setPlayhead(0);
  clock = { t0: performance.now(), p0: store.playhead };
  store.playing = true;
  btnPlay.textContent = "⏸";
  syncTo(store.playhead, true);
  raf = requestAnimationFrame(tick);
}

export function pause() {
  clock = null;
  store.playing = false;
  cancelAnimationFrame(raf);
  btnPlay.textContent = "▶";
  syncTo(store.playhead, false);
}

export function togglePlay() {
  clock ? pause() : play();
}

export function step(frames) {
  pause();
  const f = 1 / (store.project?.settings.fps || 30);
  store.setPlayhead(Math.round((store.playhead + frames * f) / f) * f);
}

store.on("playhead", ({ fromPlayback }) => {
  const fps = store.project?.settings.fps || 30;
  tcCurrent.textContent = formatTimecode(store.playhead, fps);
  if (!fromPlayback && clock) clock = { t0: performance.now(), p0: store.playhead };
  syncTo(store.playhead, !!clock);
});

store.on("change", () => {
  if (!store.project) return;
  tcDuration.textContent = formatTimecode(store.duration, store.project.settings.fps);
  ensurePlayers();
  layoutStage();
  textLayer.dataset.key = "";
  syncTo(store.playhead, !!clock);
});
store.on("media", () => syncTo(store.playhead, !!clock));
store.on("project", () => {
  pause();
  for (const pl of players.values()) {
    pl.el.removeAttribute("src");
    pl.mediaId = null;
  }
});

document.getElementById("btnPlay").onclick = togglePlay;
document.getElementById("btnBack").onclick = () => step(-1);
document.getElementById("btnFwd").onclick = () => step(1);
document.getElementById("btnStart").onclick = () => {
  pause();
  store.setPlayhead(0);
};
document.getElementById("btnEnd").onclick = () => {
  pause();
  store.setPlayhead(store.duration);
};
