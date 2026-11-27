// Renders still frames of graphics so the assistant can check its own
// animation designs (layout, contrast, clipping) before the user sees them.
// Frames are drawn over the real video frame at that moment when available.

import fsp from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { loadGraphicImages } from "./render.js"; // also registers the fonts
import { mediaDir } from "./store.js";
import { getAnalysis } from "./media.js";
import { drawGraphic } from "../shared/graphics.js";
import { videoClipAt, srcAt, clipEnd } from "../shared/timeline.js";

async function backgroundAt(project, t, W, H) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#4a5a66");
  g.addColorStop(1, "#1d242b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const clip = videoClipAt(project, t);
  if (clip?.mediaId) {
    try {
      const src = srcAt(clip, t);
      const kfs = (await getAnalysis(clip.mediaId)).keyframes || [];
      if (kfs.length) {
        const k = kfs.reduce((best, x) => (Math.abs(x.time - src) < Math.abs(best.time - src) ? x : best));
        const img = await loadImage(await fsp.readFile(path.join(mediaDir(clip.mediaId), "keyframes", k.file)));
        const s = clip.fit === "fill" ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      }
    } catch {}
  }
  return c;
}

// A 2x2 contact sheet (JPEG) of a graphic clip at 4 moments.
export async function graphicContactSheet(project, clip, fractions = [0.12, 0.35, 0.65, 0.92]) {
  const { width: W, height: H } = project.settings;
  const images = await loadGraphicImages(clip);
  const d = clipEnd(clip) - clip.start;
  const tileW = 640;
  const tileH = Math.round((tileW * H) / W);
  const sheet = createCanvas(tileW * 2, tileH * 2);
  const sx = sheet.getContext("2d");
  const times = [];
  for (const [i, f] of fractions.entries()) {
    const local = Math.max(0, Math.min(d, d * f));
    times.push(Math.round(local * 100) / 100);
    const frame = await backgroundAt(project, clip.start + local, W, H);
    const ctx = frame.getContext("2d");
    drawGraphic(ctx, clip, local, W, H, { images, makeCanvas: (w, h) => createCanvas(w, h) });
    const x = (i % 2) * tileW;
    const y = Math.floor(i / 2) * tileH;
    sx.drawImage(frame, x, y, tileW, tileH);
    sx.fillStyle = "rgba(0,0,0,0.6)";
    sx.fillRect(x, y, 120, 30);
    sx.fillStyle = "#fff";
    sx.font = "18px sans-serif";
    sx.fillText(`t=${times[i]}s`, x + 10, y + 21);
  }
  return { jpeg: await sheet.encode("jpeg", 85), times };
}
