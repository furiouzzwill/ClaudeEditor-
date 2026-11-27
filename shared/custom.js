// Custom animations: a small, declarative motion-graphics format.
//
// The assistant designs new animations as data (layers + keyframes), never as
// code, so nothing it produces can run on your machine. The same renderer
// draws them in the browser preview and in the export.
//
// spec = {
//   name: "Short label",
//   duration: 4,                    // seconds
//   width: 1920, height: 1080,      // design canvas; scaled to fit the project
//   layers: [ layer, ... ]          // drawn in order, first = bottom
// }
//
// layer = {
//   type: "rect" | "circle" | "text" | "image" | "icon" | "line",
//   start, end,                     // visible window in seconds (default: whole)
//   x, y,                           // anchor position (design px)
//   anchor: "center" | "top-left" | "top" | "top-right" | "left" | "right" |
//           "bottom-left" | "bottom" | "bottom-right",
//   width, height, radius,          // rect / image size, corner or circle radius
//   fill, stroke, strokeWidth,      // "#rrggbb", "rgba(...)" or
//                                   // { from, to, angle } linear gradient
//   opacity, rotation (deg), scale, scaleX, scaleY,
//   shadow: { color, blur, x, y },
//   text, size, weight (400|600|700|800), align, maxWidth, lineHeight, uppercase,
//   textAnimation: { type: "typewriter"|"words"|"letters"|"fade", start, duration, stagger },
//   image: "<image media id>", fit: "contain" | "cover", circle: true,
//   icon: one of ICON_NAMES,
//   x2, y2, draw,                   // line end point and draw progress 0..1
//   reveal, revealFrom,             // wipe mask 0..1 from left/right/top/bottom/center
//   spin (deg/s), float: { amount, speed }, pulse: { amount, speed },
//   keyframes: { <prop>: [ { t, v, ease }, ... ] }
// }
// Animatable props: x y opacity rotation scale scaleX scaleY width height radius
// reveal size x2 y2 draw fill color stroke strokeWidth.
// Eases: linear, in, out, inOut, back, elastic, bounce (applied on the way
// into that keyframe).

export const LAYER_TYPES = ["rect", "circle", "text", "image", "icon", "line"];
export const ICON_NAMES = ["bell", "like", "comment", "check", "play", "star", "heart", "arrow", "share", "plus", "sparkle"];
export const EASES = ["linear", "in", "out", "inOut", "back", "elastic", "bounce"];
const ANCHORS = ["center", "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
const ANIMATABLE = ["x", "y", "opacity", "rotation", "scale", "scaleX", "scaleY", "width", "height", "radius", "reveal", "size", "x2", "y2", "draw", "fill", "color", "stroke", "strokeWidth"];
const COLOR_PROPS = new Set(["fill", "color", "stroke"]);
const WEIGHTS = [400, 600, 700, 800];

const LIMITS = { layers: 80, keyframes: 40, text: 300, duration: 30 };

// ---- easing ----------------------------------------------------------------

const EASE_FN = {
  linear: (x) => x,
  in: (x) => x * x * x,
  out: (x) => 1 - Math.pow(1 - x, 3),
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: (x) => 1 + 2.55 * Math.pow(x - 1, 3) + 1.55 * Math.pow(x - 1, 2),
  elastic: (x) => (x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounce: (x) => {
    const n = 7.5625;
    const d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  },
};

// ---- validation ------------------------------------------------------------

const num = (v, def, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)|transparent|white|black)$/i;
function color(v, def) {
  if (v && typeof v === "object" && COLOR_RE.test(String(v.from)) && COLOR_RE.test(String(v.to))) {
    return { from: String(v.from), to: String(v.to), angle: num(v.angle, 90) };
  }
  return typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : def;
}

// Clean up a spec: clamp numbers, drop unknown things, fill defaults.
// Returns { spec, warnings }. Never throws on content (only on a non-object).
export function normalizeSpec(raw, { width = 1920, height = 1080, imageIds = null } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("Animation spec must be an object");
  const warnings = [];
  const spec = {
    name: String(raw.name || "Custom animation").slice(0, 60),
    duration: num(raw.duration, 4, 0.3, LIMITS.duration),
    width: num(raw.width, width, 100, 8000),
    height: num(raw.height, height, 100, 8000),
    layers: [],
  };
  const layers = Array.isArray(raw.layers) ? raw.layers : [];
  if (layers.length > LIMITS.layers) warnings.push(`Only the first ${LIMITS.layers} layers are used.`);
  for (const [i, l] of layers.slice(0, LIMITS.layers).entries()) {
    if (!l || !LAYER_TYPES.includes(l.type)) {
      warnings.push(`Layer ${i + 1}: unknown type "${l?.type}" (use ${LAYER_TYPES.join(", ")}).`);
      continue;
    }
    const o = { type: l.type };
    o.start = num(l.start, 0, 0, spec.duration);
    o.end = num(l.end, spec.duration, o.start, spec.duration);
    o.x = num(l.x, spec.width / 2);
    o.y = num(l.y, spec.height / 2);
    o.anchor = ANCHORS.includes(l.anchor) ? l.anchor : l.type === "text" && l.align === "left" ? "left" : "center";
    o.width = num(l.width, l.type === "line" ? 0 : 200, 0, 20000);
    o.height = num(l.height, 200, 0, 20000);
    o.radius = num(l.radius, l.type === "circle" ? 50 : 0, 0, 10000);
    o.fill = color(l.fill ?? l.color, l.type === "text" || l.type === "icon" ? "#ffffff" : l.type === "line" ? null : "#ffffff");
    o.stroke = color(l.stroke, null);
    o.strokeWidth = num(l.strokeWidth, l.type === "line" ? 6 : 0, 0, 500);
    o.opacity = num(l.opacity, 1, 0, 1);
    o.rotation = num(l.rotation, 0);
    o.scale = num(l.scale, 1, 0, 50);
    o.scaleX = num(l.scaleX, 1, -50, 50);
    o.scaleY = num(l.scaleY, 1, -50, 50);
    o.reveal = num(l.reveal, 1, 0, 1);
    o.revealFrom = ["left", "right", "top", "bottom", "center"].includes(l.revealFrom) ? l.revealFrom : "left";
    if (l.shadow && typeof l.shadow === "object") {
      o.shadow = { color: color(l.shadow.color, "rgba(0,0,0,0.4)"), blur: num(l.shadow.blur, 20, 0, 300), x: num(l.shadow.x, 0, -500, 500), y: num(l.shadow.y, 8, -500, 500) };
    }
    if (l.type === "text") {
      o.text = String(l.text ?? "").slice(0, LIMITS.text);
      if (l.uppercase) o.text = o.text.toUpperCase();
      o.size = num(l.size, 64, 4, 1000);
      o.weight = WEIGHTS.includes(Number(l.weight)) ? Number(l.weight) : 700;
      o.align = ["left", "center", "right"].includes(l.align) ? l.align : "center";
      o.maxWidth = num(l.maxWidth, 0, 0, 20000);
      o.lineHeight = num(l.lineHeight, 1.15, 0.5, 4);
      const ta = l.textAnimation;
      if (ta && ["typewriter", "words", "letters", "fade"].includes(ta.type)) {
        o.textAnimation = { type: ta.type, start: num(ta.start, o.start, 0, spec.duration), duration: num(ta.duration, 0.5, 0.05, 10), stagger: num(ta.stagger, 0.06, 0, 2) };
      }
    }
    if (l.type === "image") {
      const id = String(l.image || "");
      if (!id || (imageIds && !imageIds.includes(id))) {
        warnings.push(`Layer ${i + 1}: image "${id}" isn't an imported image; layer skipped.`);
        continue;
      }
      o.image = id;
      o.fit = l.fit === "cover" ? "cover" : "contain";
      o.circle = !!l.circle;
    }
    if (l.type === "icon") {
      if (!ICON_NAMES.includes(l.icon)) {
        warnings.push(`Layer ${i + 1}: unknown icon "${l.icon}" (use ${ICON_NAMES.join(", ")}).`);
        continue;
      }
      o.icon = l.icon;
      o.width = num(l.width ?? l.size, 64, 1, 5000);
      o.height = o.width;
    }
    if (l.type === "line") {
      o.x2 = num(l.x2, o.x + 300);
      o.y2 = num(l.y2, o.y);
      o.draw = num(l.draw, 1, 0, 1);
      o.fill = null;
      o.stroke = color(l.stroke ?? l.color ?? l.fill, "#ffffff");
    }
    o.spin = num(l.spin, 0, -3600, 3600);
    if (l.float) o.float = { amount: num(l.float.amount, 10, 0, 1000), speed: num(l.float.speed, 1, 0, 20) };
    if (l.pulse) o.pulse = { amount: num(l.pulse.amount, 0.05, 0, 2), speed: num(l.pulse.speed, 1, 0, 20) };

    if (l.keyframes && typeof l.keyframes === "object") {
      o.keyframes = {};
      for (const [prop, list] of Object.entries(l.keyframes)) {
        if (!ANIMATABLE.includes(prop) || !Array.isArray(list)) {
          warnings.push(`Layer ${i + 1}: can't animate "${prop}".`);
          continue;
        }
        const kfs = list
          .slice(0, LIMITS.keyframes)
          .map((k) => ({
            t: num(k?.t, NaN, 0, spec.duration),
            v: COLOR_PROPS.has(prop) ? color(k?.v, null) : num(k?.v, NaN),
            ease: EASES.includes(k?.ease) ? k.ease : "out",
          }))
          .filter((k) => Number.isFinite(k.t) && (COLOR_PROPS.has(prop) ? typeof k.v === "string" : Number.isFinite(k.v)))
          .sort((a, b) => a.t - b.t);
        if (kfs.length) o.keyframes[prop] = kfs;
      }
    }
    spec.layers.push(o);
  }
  if (!spec.layers.length) warnings.push("The animation has no usable layers.");
  return { spec, warnings };
}

export function specImageIds(spec) {
  return [...new Set((spec?.layers || []).filter((l) => l.type === "image").map((l) => l.image))];
}

// ---- rendering --------------------------------------------------------------

function hexToRgba(c) {
  const m = String(c).trim().match(/^#([0-9a-f]{3,8})$/i);
  if (!m) {
    const r = String(c).match(/rgba?\(([^)]+)\)/i);
    if (r) {
      const p = r[1].split(",").map((s) => parseFloat(s));
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    return c === "black" ? [0, 0, 0, 1] : c === "transparent" ? [0, 0, 0, 0] : [255, 255, 255, 1];
  }
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return [...v, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}
function mixColor(a, b, k) {
  const A = hexToRgba(a);
  const B = hexToRgba(b);
  const c = A.map((v, i) => v + (B[i] - v) * k);
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
}

function valueAt(layer, prop, t) {
  const kfs = layer.keyframes?.[prop];
  if (!kfs || !kfs.length) return layer[prop];
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i];
    if (t <= b.t) {
      const a = kfs[i - 1];
      const k = (EASE_FN[b.ease] || EASE_FN.out)((t - a.t) / Math.max(1e-6, b.t - a.t));
      if (COLOR_PROPS.has(prop)) return typeof a.v === "string" && typeof b.v === "string" ? mixColor(a.v, b.v, Math.max(0, Math.min(1, k))) : b.v;
      return a.v + (b.v - a.v) * k;
    }
  }
  return last.v;
}

function paint(ctx, fill, x, y, w, h) {
  if (!fill) return null;
  if (typeof fill === "string") return fill;
  const a = ((fill.angle ?? 90) * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = (Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) / 2;
  const g = ctx.createLinearGradient(cx - Math.sin(a) * r, cy + Math.cos(a) * r, cx + Math.sin(a) * r, cy - Math.cos(a) * r);
  g.addColorStop(0, fill.from);
  g.addColorStop(1, fill.to);
  return g;
}

function anchorOffset(anchor, w, h) {
  const ax = anchor.includes("left") ? 0 : anchor.includes("right") ? -w : -w / 2;
  const ay = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? -h : -h / 2;
  return [ax, ay];
}

function rrPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!maxWidth) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

// Draws one frame. `fontFor(weight, px)` returns a CSS font string, `icon`
// draws a named icon, `images` maps image ids to loaded images.
export function drawCustom({ ctx, t, W, H, spec, images = {}, makeCanvas, fontFor, icon }) {
  // Fit the design canvas into the project frame (contain), centered.
  const s = Math.min(W / spec.width, H / spec.height);
  ctx.save();
  ctx.translate((W - spec.width * s) / 2, (H - spec.height * s) / 2);
  ctx.scale(s, s);
  for (const L of spec.layers) {
    if (t < L.start || t > L.end) continue;
    const v = (p) => valueAt(L, p, t);
    let opacity = v("opacity");
    if (opacity <= 0) continue;
    let x = v("x");
    let y = v("y");
    let rot = v("rotation") + L.spin * (t - L.start);
    let sc = v("scale");
    if (L.float) y += Math.sin((t - L.start) * L.float.speed * Math.PI * 2) * L.float.amount;
    if (L.pulse) sc *= 1 + Math.sin((t - L.start) * L.pulse.speed * Math.PI * 2) * L.pulse.amount;
    const sx = sc * v("scaleX");
    const sy = sc * v("scaleY");
    if (sx === 0 || sy === 0) continue;

    ctx.save();
    ctx.globalAlpha *= opacity;
    ctx.translate(x, y);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(sx, sy);
    if (L.shadow) {
      ctx.shadowColor = L.shadow.color;
      ctx.shadowBlur = L.shadow.blur;
      ctx.shadowOffsetX = L.shadow.x;
      ctx.shadowOffsetY = L.shadow.y;
    }

    // Local box (for anchor and reveal masks)
    let w = v("width");
    let h = v("height");
    let lines = null;
    let size = 0;
    if (L.type === "text") {
      size = v("size");
      ctx.font = fontFor(L.weight, size);
      lines = wrapLines(ctx, L.text, L.maxWidth);
      w = Math.max(1, ...lines.map((ln) => ctx.measureText(ln).width));
      h = lines.length * size * L.lineHeight;
    } else if (L.type === "circle") {
      w = h = v("radius") * 2;
    }
    const [ox, oy] = L.type === "line" ? [0, 0] : anchorOffset(L.anchor, w, h);

    const reveal = v("reveal");
    if (reveal < 1 && L.type !== "line") {
      if (reveal <= 0) {
        ctx.restore();
        continue;
      }
      ctx.beginPath();
      const pad = Math.max(w, h) * 0.2 + 20;
      if (L.revealFrom === "left") ctx.rect(ox - pad, oy - pad, (w + pad) * reveal + pad * reveal, h + pad * 2);
      else if (L.revealFrom === "right") ctx.rect(ox + w - (w + pad) * reveal, oy - pad, (w + pad * 2) * reveal, h + pad * 2);
      else if (L.revealFrom === "top") ctx.rect(ox - pad, oy - pad, w + pad * 2, (h + pad) * reveal + pad * reveal);
      else if (L.revealFrom === "bottom") ctx.rect(ox - pad, oy + h - (h + pad) * reveal, w + pad * 2, (h + pad * 2) * reveal);
      else ctx.rect(ox + (w / 2) * (1 - reveal) - pad * reveal, oy - pad, w * reveal + pad * 2 * reveal, h + pad * 2);
      ctx.clip();
    }

    const fill = v("fill");
    const stroke = v("stroke");
    const strokeWidth = v("strokeWidth");

    if (L.type === "rect" || L.type === "circle") {
      if (L.type === "circle") {
        ctx.beginPath();
        ctx.arc(ox + w / 2, oy + h / 2, w / 2, 0, Math.PI * 2);
      } else rrPath(ctx, ox, oy, w, h, v("radius"));
      const f = paint(ctx, fill, ox, oy, w, h);
      if (f) {
        ctx.fillStyle = f;
        ctx.fill();
      }
      if (stroke && strokeWidth > 0) {
        ctx.shadowColor = "rgba(0,0,0,0)";
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = paint(ctx, stroke, ox, oy, w, h);
        ctx.stroke();
      }
    } else if (L.type === "text") {
      ctx.fillStyle = paint(ctx, fill, ox, oy, w, h) || "#ffffff";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const ta = L.textAnimation;
      lines.forEach((line, li) => {
        const lw = ctx.measureText(line).width;
        const lx = ox + (L.align === "left" ? 0 : L.align === "right" ? w - lw : (w - lw) / 2);
        const ly = oy + size * (0.86 + li * L.lineHeight);
        if (!ta || ta.type === "fade") {
          if (ta) ctx.globalAlpha *= Math.max(0, Math.min(1, (t - ta.start) / ta.duration));
          if (stroke && strokeWidth > 0) {
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = paint(ctx, stroke, ox, oy, w, h);
            ctx.lineJoin = "round";
            ctx.strokeText(line, lx, ly);
          }
          ctx.fillText(line, lx, ly);
          return;
        }
        // Per-unit animation (typewriter / words / letters), counted across lines.
        const prior = lines.slice(0, li).join(" ");
        const units = ta.type === "words" ? line.split(/(\s+)/) : line.split("");
        let cx = lx;
        let idx = ta.type === "words" ? prior.split(/\s+/).filter(Boolean).length : prior.replace(/\s/g, "").length;
        for (const u of units) {
          const uw = ctx.measureText(u).width;
          if (!u.trim()) {
            cx += uw;
            continue;
          }
          const k0 = (t - ta.start - idx * ta.stagger) / ta.duration;
          const k = Math.max(0, Math.min(1, k0));
          idx++;
          if (ta.type === "typewriter") {
            if (k0 >= 0) ctx.fillText(u, cx, ly);
          } else if (k > 0) {
            const e = EASE_FN.out(k);
            ctx.save();
            ctx.globalAlpha *= e;
            ctx.fillText(u, cx, ly + (1 - e) * size * 0.5);
            ctx.restore();
          }
          cx += uw;
        }
      });
    } else if (L.type === "image") {
      const img = images[L.image];
      if (img) {
        const iw = img.width || img.naturalWidth;
        const ih = img.height || img.naturalHeight;
        const k = L.fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
        ctx.save();
        if (L.circle) {
          ctx.beginPath();
          ctx.arc(ox + w / 2, oy + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
          ctx.clip();
        } else if (L.fit === "cover") {
          ctx.beginPath();
          ctx.rect(ox, oy, w, h);
          ctx.clip();
        }
        ctx.drawImage(img, ox + (w - iw * k) / 2, oy + (h - ih * k) / 2, iw * k, ih * k);
        ctx.restore();
      }
    } else if (L.type === "icon") {
      icon(ctx, L.icon, ox, oy, w, typeof fill === "string" ? fill : "#ffffff");
    } else if (L.type === "line") {
      const draw = v("draw");
      if (draw > 0) {
        const x2 = v("x2") - x;
        const y2 = v("y2") - y;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x2 * draw, y2 * draw);
        ctx.lineCap = "round";
        ctx.lineWidth = strokeWidth || 6;
        ctx.strokeStyle = paint(ctx, stroke, 0, 0, x2, y2) || "#ffffff";
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
