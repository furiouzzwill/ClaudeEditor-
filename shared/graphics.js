// Animated graphics templates (motion graphics).
//
// Each template draws one frame for a time t into a 2D canvas context, using
// project pixel coordinates (W x H). Nothing here depends on the browser or
// Node: the viewer draws them on a <canvas> for preview, and the export draws
// them with @napi-rs/canvas, so preview and export match frame for frame.
//
// draw({ ctx, t, d, W, H, p, logo, makeCanvas })
//   t           seconds since the graphic started (0..d)
//   d           duration in seconds
//   p           props (defaults merged in)
//   logo        a loaded image or null
//   makeCanvas  (w, h) => offscreen canvas (for masked effects)
//
// Fonts: Inter, registered under one family name per weight (see FONT_FILES)
// so every machine renders identical text.

export const FONT_FILES = {
  400: "Inter_400Regular.ttf",
  600: "Inter_600SemiBold.ttf",
  700: "Inter_700Bold.ttf",
  800: "Inter_800ExtraBold.ttf",
};
export const fontFamily = (w) => `EdInter${w}`;
const F = (w, px) => `${Math.round(px)}px ${fontFamily(w)}`;

// ---- easing & helpers ------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lin = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const inCubic = (x) => x * x * x;
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outBack = (x) => {
  const c1 = 1.55;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const ease = (t, a, b, fn = outCubic) => fn(lin(t, a, b));
const mix = (a, b, k) => a + (b - a) * k;

function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgb(hex) {
  const m = String(hex || "").replace("#", "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return [255, 255, 255];
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
// Pick readable text (dark or white) for a background color.
const onColor = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? "#111114" : "#ffffff";
};

function shadow(ctx, blur, alpha, dy) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = dy;
}
function noShadow(ctx) {
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

// Logo (or a letter badge) clipped to a circle.
function drawAvatar(ctx, logo, cx, cy, r, accent, letter) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  if (logo) {
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.clip();
    const iw = logo.width || logo.naturalWidth;
    const ih = logo.height || logo.naturalHeight;
    // Roughly square logos fill the circle; wide or tall ones (wordmarks) are
    // fitted inside it with some padding.
    const square = iw / ih > 0.8 && iw / ih < 1.25;
    const s = square ? Math.max((2 * r) / iw, (2 * r) / ih) : Math.min((2 * r * 0.8) / iw, (2 * r * 0.8) / ih);
    ctx.drawImage(logo, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
  } else {
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.fillStyle = onColor(accent);
    ctx.font = F(800, r * 1.0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((letter || "★").slice(0, 1).toUpperCase(), cx, cy + r * 0.04);
  }
  ctx.restore();
}

// Logo drawn as-is (not clipped), fitted into a box.
function drawLogoFit(ctx, logo, cx, cy, maxW, maxH) {
  const iw = logo.width || logo.naturalWidth;
  const ih = logo.height || logo.naturalHeight;
  const s = Math.min(maxW / iw, maxH / ih);
  ctx.drawImage(logo, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
  return { w: iw * s, h: ih * s };
}

// ---- small vector icons (drawn in a 24x24 box) -----------------------------

function icon(ctx, name, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  if (name === "bell") {
    ctx.moveTo(12, 2.5);
    ctx.bezierCurveTo(8, 2.5, 6, 5.5, 6, 9);
    ctx.lineTo(6, 14);
    ctx.lineTo(4, 17);
    ctx.lineTo(20, 17);
    ctx.lineTo(18, 14);
    ctx.lineTo(18, 9);
    ctx.bezierCurveTo(18, 5.5, 16, 2.5, 12, 2.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(12, 19.5, 2.4, 0, Math.PI);
    ctx.fill();
  } else if (name === "check") {
    ctx.moveTo(4.5, 12.5);
    ctx.lineTo(9.5, 17.5);
    ctx.lineTo(19.5, 6.5);
    ctx.lineWidth = 3.2;
    ctx.stroke();
  } else if (name === "like") {
    ctx.moveTo(2.5, 10);
    ctx.lineTo(6.5, 10);
    ctx.lineTo(6.5, 21);
    ctx.lineTo(2.5, 21);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(8.5, 10);
    ctx.lineTo(12.5, 2.5);
    ctx.bezierCurveTo(14.5, 2.5, 15.5, 4, 15, 6);
    ctx.lineTo(14, 9.5);
    ctx.lineTo(19.5, 9.5);
    ctx.bezierCurveTo(21, 9.5, 22, 11, 21.6, 12.5);
    ctx.lineTo(19.6, 19.5);
    ctx.bezierCurveTo(19.2, 20.5, 18.4, 21, 17.4, 21);
    ctx.lineTo(8.5, 21);
    ctx.closePath();
    ctx.fill();
  } else if (name === "comment") {
    ctx.moveTo(4, 4);
    ctx.lineTo(20, 4);
    ctx.quadraticCurveTo(22, 4, 22, 6);
    ctx.lineTo(22, 15);
    ctx.quadraticCurveTo(22, 17, 20, 17);
    ctx.lineTo(9, 17);
    ctx.lineTo(4.5, 21);
    ctx.lineTo(4.5, 17);
    ctx.quadraticCurveTo(2, 17, 2, 15);
    ctx.lineTo(2, 6);
    ctx.quadraticCurveTo(2, 4, 4, 4);
    ctx.closePath();
    ctx.fill();
  } else if (name === "play") {
    ctx.moveTo(8, 5);
    ctx.lineTo(19, 12);
    ctx.lineTo(8, 19);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function cursor(ctx, x, y, size, pressed) {
  ctx.save();
  ctx.translate(x, y);
  const s = (size / 24) * (pressed ? 0.86 : 1);
  ctx.scale(s, s);
  shadow(ctx, 8, 0.35, 2);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 20);
  ctx.lineTo(5, 15.5);
  ctx.lineTo(8.5, 23);
  ctx.lineTo(12, 21.5);
  ctx.lineTo(8.6, 14.2);
  ctx.lineTo(15, 14.2);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  noShadow(ctx);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#111";
  ctx.stroke();
  ctx.restore();
}

// Wrap text into lines that fit maxWidth.
function wrap(ctx, text, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Largest font size (<= start) at which text fits in maxLines within maxWidth.
function fitFont(ctx, text, weight, start, min, maxWidth, maxLines = 2) {
  for (let px = start; px >= min; px -= 2) {
    ctx.font = F(weight, px);
    if (wrap(ctx, text, maxWidth).length <= maxLines) return px;
  }
  return min;
}

// ---- templates -------------------------------------------------------------

const POS = ["bottom-left", "bottom-center", "bottom-right"];

export const GRAPHICS = {
  subscribe: {
    label: "Subscribe / comment reminder",
    description: "A clean card pops up, a cursor clicks Subscribe and rings the bell, with a like & comment line.",
    duration: 4.5,
    fields: [
      { key: "headline", label: "Headline", type: "text", default: "Enjoying the video?" },
      { key: "note", label: "Second line", type: "text", default: "Like & comment below" },
      { key: "button", label: "Button", type: "text", default: "SUBSCRIBE" },
      { key: "accent", label: "Button color", type: "color", default: "#ff2d3d" },
      { key: "position", label: "Position", type: "select", options: POS, default: "bottom-left" },
      { key: "logo", label: "Logo / avatar", type: "image", default: "" },
    ],
    draw({ ctx, t, d, W, H, p, logo }) {
      const S = Math.min(W, H) / 1080;
      const pad = 26 * S;
      const avatarR = 46 * S;
      ctx.font = F(700, 33 * S);
      const headW = ctx.measureText(p.headline).width;
      ctx.font = F(400, 25 * S);
      const noteW = ctx.measureText(p.note).width + 74 * S;
      ctx.font = F(800, 26 * S);
      const subscribed = t > 1.66;
      const btnLabel = subscribed ? "SUBSCRIBED" : p.button;
      const btnW = Math.max(ctx.measureText(p.button).width, ctx.measureText("SUBSCRIBED").width) + 92 * S;
      const btnH = 62 * S;
      const bellSize = 40 * S;
      const textX = pad + avatarR * 2 + 22 * S;
      const textW = Math.max(headW, noteW);
      const cardW = textX + textW + 34 * S + btnW + 20 * S + bellSize + pad + 10 * S;
      const cardH = 140 * S;
      const margin = 64 * S;
      const cx =
        p.position === "bottom-right" ? W - margin - cardW : p.position === "bottom-center" ? (W - cardW) / 2 : margin;
      const cy = H - margin - cardH - (W < H ? 220 * S : 0);

      // Enter / exit
      const inK = ease(t, 0, 0.55, outBack);
      const outK = ease(t, d - 0.45, d, inCubic);
      const alpha = clamp(lin(t, 0, 0.3)) * (1 - outK);
      if (alpha <= 0) return;
      const dy = (1 - inK) * 70 * S + outK * 60 * S;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(0, dy);

      // Card
      shadow(ctx, 40 * S, 0.45, 14 * S);
      rr(ctx, cx, cy, cardW, cardH, 28 * S);
      ctx.fillStyle = "rgba(18,18,24,0.92)";
      ctx.fill();
      noShadow(ctx);
      ctx.lineWidth = 1.5 * S;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.stroke();

      // Avatar
      const aK = ease(t, 0.12, 0.6, outBack);
      if (aK > 0) {
        ctx.save();
        const ax = cx + pad + avatarR;
        const ay = cy + cardH / 2;
        ctx.translate(ax, ay);
        ctx.scale(aK, aK);
        drawAvatar(ctx, logo, 0, 0, avatarR, p.accent, p.headline);
        ctx.restore();
      }

      // Text
      const hK = ease(t, 0.22, 0.65);
      ctx.globalAlpha = alpha * hK;
      ctx.fillStyle = "#ffffff";
      ctx.font = F(700, 33 * S);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(p.headline, cx + textX + (1 - hK) * 18 * S, cy + 62 * S);
      const nK = ease(t, 0.32, 0.78);
      ctx.globalAlpha = alpha * nK;
      const nx = cx + textX + (1 - nK) * 18 * S;
      const ny = cy + 102 * S;
      const likeK = ease(t, 0.5, 0.9, outBack);
      const comK = ease(t, 0.62, 1.02, outBack);
      ctx.save();
      ctx.translate(nx + 13 * S, ny - 9 * S);
      ctx.scale(likeK, likeK);
      icon(ctx, "like", -13 * S, -13 * S, 26 * S, "rgba(255,255,255,0.85)");
      ctx.restore();
      ctx.save();
      ctx.translate(nx + 47 * S, ny - 9 * S);
      ctx.scale(comK, comK);
      icon(ctx, "comment", -13 * S, -13 * S, 26 * S, "rgba(255,255,255,0.85)");
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.font = F(400, 25 * S);
      ctx.fillText(p.note, nx + 74 * S, ny);
      ctx.globalAlpha = alpha;

      // Button
      const bx = cx + textX + textW + 34 * S;
      const by = cy + (cardH - btnH) / 2;
      const bK = ease(t, 0.38, 0.85, outBack);
      const press = t > 1.55 && t < 1.78 ? 0.94 : 1;
      if (bK > 0) {
        ctx.save();
        ctx.translate(bx + btnW / 2, by + btnH / 2);
        ctx.scale(bK * press, bK * press);
        rr(ctx, -btnW / 2, -btnH / 2, btnW, btnH, btnH / 2);
        ctx.fillStyle = subscribed ? "#3a3a44" : p.accent;
        ctx.fill();
        // click ripple
        const rip = lin(t, 1.58, 2.15);
        if (rip > 0 && rip < 1) {
          ctx.save();
          rr(ctx, -btnW / 2, -btnH / 2, btnW, btnH, btnH / 2);
          ctx.clip();
          ctx.beginPath();
          ctx.arc(0, 0, btnW * 0.9 * outCubic(rip), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - rip)})`;
          ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = subscribed ? "rgba(255,255,255,0.9)" : onColor(p.accent);
        ctx.font = F(800, 26 * S);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lw = ctx.measureText(btnLabel).width;
        if (subscribed) {
          const ck = ease(t, 1.66, 1.95, outBack);
          icon(ctx, "check", -lw / 2 - 30 * S, -12 * S, 24 * S * ck, "rgba(255,255,255,0.9)");
          ctx.fillText(btnLabel, 14 * S, 2 * S);
        } else ctx.fillText(btnLabel, 0, 2 * S);
        ctx.restore();
      }

      // Bell (rings after the click)
      const bellX = bx + btnW + 20 * S;
      const bellY = cy + (cardH - bellSize) / 2;
      const belK = ease(t, 0.5, 0.95, outBack);
      if (belK > 0) {
        const ring = lin(t, 2.35, 3.25);
        const ang = ring > 0 && ring < 1 ? Math.sin(ring * Math.PI * 7) * 0.45 * (1 - ring) : 0;
        ctx.save();
        ctx.translate(bellX + bellSize / 2, bellY + 4 * S);
        ctx.rotate(ang);
        ctx.scale(belK, belK);
        icon(ctx, "bell", -bellSize / 2, -4 * S, bellSize, t > 2.3 ? p.accent : "rgba(255,255,255,0.85)");
        ctx.restore();
      }

      // Cursor: comes in, clicks the button, then the bell, then leaves.
      const cIn = ease(t, 0.85, 1.5, inOutCubic);
      const cBell = ease(t, 1.9, 2.3, inOutCubic);
      const cOut = ease(t, 2.9, 3.3, inCubic);
      const cAlpha = lin(t, 0.85, 1.05) * (1 - cOut);
      if (cAlpha > 0) {
        const startX = bx + btnW * 0.9 + 140 * S;
        const startY = cy + cardH + 120 * S;
        const btnTX = bx + btnW * 0.62;
        const btnTY = by + btnH * 0.62;
        const bellTX = bellX + bellSize * 0.55;
        const bellTY = bellY + bellSize * 0.7;
        let x = mix(startX, btnTX, cIn);
        let y = mix(startY, btnTY, cIn);
        x = mix(x, bellTX, cBell);
        y = mix(y, bellTY, cBell);
        x += cOut * 120 * S;
        y += cOut * 90 * S;
        const pressed = (t > 1.55 && t < 1.75) || (t > 2.32 && t < 2.5);
        ctx.globalAlpha = alpha * cAlpha;
        cursor(ctx, x, y, 34 * S, pressed);
      }
      ctx.restore();
    },
  },

  outro: {
    label: "Outro / end screen",
    description: "Full-screen end card: logo with an animated ring, thank-you text, subscribe button and spaces for next-video cards.",
    duration: 10,
    fields: [
      { key: "title", label: "Title", type: "text", default: "Thanks for watching!" },
      { key: "subtitle", label: "Subtitle", type: "text", default: "New videos every week" },
      { key: "button", label: "Button", type: "text", default: "SUBSCRIBE" },
      { key: "accent", label: "Accent color", type: "color", default: "#7c5cff" },
      { key: "background", label: "Background", type: "select", options: ["dark", "gradient", "dim video"], default: "dark" },
      { key: "slots", label: "Video slots", type: "select", options: ["2", "1", "0"], default: "2" },
      { key: "logo", label: "Logo", type: "image", default: "" },
    ],
    draw({ ctx, t, d, W, H, p, logo }) {
      const S = Math.min(W, H) / 1080;
      const portrait = H > W;
      const bgK = ease(t, 0, 0.5);
      if (bgK <= 0) return;

      // Background
      ctx.save();
      ctx.globalAlpha = bgK;
      if (p.background === "dim video") {
        ctx.fillStyle = "rgba(6,6,10,0.72)";
        ctx.fillRect(0, 0, W, H);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        if (p.background === "gradient") {
          g.addColorStop(0, rgba(p.accent, 1));
          g.addColorStop(1, "#0b0b12");
        } else {
          g.addColorStop(0, "#111118");
          g.addColorStop(1, "#08080c");
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      // Slowly drifting soft glows
      for (let i = 0; i < 3; i++) {
        const gx = W * (0.2 + 0.3 * i) + Math.sin(t * 0.35 + i * 2.1) * W * 0.06;
        const gy = H * (0.35 + 0.2 * (i % 2)) + Math.cos(t * 0.3 + i) * H * 0.06;
        const gr = Math.max(W, H) * 0.35;
        const rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        rg.addColorStop(0, rgba(p.accent, 0.22));
        rg.addColorStop(1, rgba(p.accent, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();

      const nSlots = Number(p.slots) || 0;
      // Layout
      const lx = portrait || nSlots === 0 ? W / 2 : W * 0.3;
      const ly = portrait ? H * 0.27 : H * 0.4;
      const R = (portrait ? 150 : 150) * S;

      // Logo + ring
      const ringK = ease(t, 0.3, 1.3, inOutCubic);
      const logoK = ease(t, 0.25, 0.95, outBack);
      ctx.save();
      ctx.lineWidth = 7 * S;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(lx, ly, R + 18 * S, 0, Math.PI * 2);
      ctx.stroke();
      if (ringK > 0) {
        const spin = t * 0.25;
        ctx.strokeStyle = p.accent;
        ctx.beginPath();
        ctx.arc(lx, ly, R + 18 * S, -Math.PI / 2 + spin, -Math.PI / 2 + spin + Math.PI * 2 * ringK);
        ctx.stroke();
      }
      if (logoK > 0) {
        ctx.translate(lx, ly);
        ctx.scale(logoK, logoK);
        shadow(ctx, 40 * S, 0.5, 10 * S);
        drawAvatar(ctx, logo, 0, 0, R, p.accent, p.title);
      }
      ctx.restore();

      // Text
      const textMax = portrait || nSlots === 0 ? W * 0.84 : W * 0.46;
      const ty = ly + R + 100 * S;
      const tK = ease(t, 0.65, 1.2);
      const titlePx = fitFont(ctx, p.title, 800, 66 * S, 36 * S, textMax, 2);
      ctx.save();
      ctx.font = F(800, titlePx);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = tK;
      const tl = wrap(ctx, p.title, textMax);
      tl.forEach((line, i) => ctx.fillText(line, lx, ty + i * titlePx * 1.12 + (1 - tK) * 24 * S));
      const subY = ty + (tl.length - 1) * titlePx * 1.12 + 52 * S;
      const sK = ease(t, 0.8, 1.35);
      ctx.globalAlpha = sK;
      ctx.font = F(400, 32 * S);
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      if (p.subtitle) ctx.fillText(p.subtitle, lx, subY + (1 - sK) * 20 * S);

      // Subscribe pill with a gentle pulse
      if (p.button) {
        const bK = ease(t, 1.0, 1.5, outBack);
        const pulse = 1 + 0.025 * Math.sin(Math.max(0, t - 1.6) * 3.2);
        ctx.font = F(800, 28 * S);
        const bw = ctx.measureText(p.button).width + 110 * S;
        const bh = 70 * S;
        const by = subY + (p.subtitle ? 50 : 10) * S;
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.translate(lx, by + bh / 2);
        ctx.scale(bK * pulse, bK * pulse);
        shadow(ctx, 30 * S, 0.4, 8 * S);
        rr(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
        ctx.fillStyle = p.accent;
        ctx.fill();
        noShadow(ctx);
        icon(ctx, "bell", -bw / 2 + 30 * S, -13 * S, 26 * S, onColor(p.accent));
        ctx.fillStyle = onColor(p.accent);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.button, 18 * S, 2 * S);
        ctx.restore();
      }
      ctx.restore();

      // "Watch next" slots: where the platform's end-screen cards go.
      if (nSlots > 0) {
        const sw = portrait ? W * 0.74 : W * 0.38;
        const sh = (sw * 9) / 16;
        const gap = 44 * S;
        const total = nSlots * sh + (nSlots - 1) * gap;
        const sx = portrait ? (W - sw) / 2 : W * 0.56;
        const sy0 = portrait ? H * 0.62 : (H - total) / 2 + 20 * S;
        for (let i = 0; i < nSlots; i++) {
          const k = ease(t, 0.7 + i * 0.18, 1.3 + i * 0.18, outCubic);
          if (k <= 0) continue;
          const y = sy0 + i * (sh + gap);
          const x = sx + (1 - k) * 80 * S;
          ctx.save();
          ctx.globalAlpha = k;
          rr(ctx, x, y, sw, sh, 22 * S);
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.fill();
          ctx.lineWidth = 2.5 * S;
          ctx.strokeStyle = "rgba(255,255,255,0.28)";
          ctx.setLineDash([14 * S, 10 * S]);
          ctx.stroke();
          ctx.setLineDash([]);
          // shimmer sweep
          ctx.save();
          rr(ctx, x, y, sw, sh, 22 * S);
          ctx.clip();
          const sp = ((t * 0.45 + i * 0.3) % 1.6) - 0.3;
          const gx = x + sp * sw;
          const sg = ctx.createLinearGradient(gx - sw * 0.25, y, gx + sw * 0.25, y + sh);
          sg.addColorStop(0, "rgba(255,255,255,0)");
          sg.addColorStop(0.5, "rgba(255,255,255,0.07)");
          sg.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = sg;
          ctx.fillRect(x, y, sw, sh);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(x + sw / 2, y + sh / 2, 38 * S, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255,0.14)";
          ctx.fill();
          icon(ctx, "play", x + sw / 2 - 17 * S, y + sh / 2 - 20 * S, 40 * S, "rgba(255,255,255,0.8)");
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.font = F(600, 22 * S);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(i === 0 ? "WATCH NEXT" : "MORE VIDEOS", x + 4 * S, y - 14 * S);
          ctx.restore();
        }
      }
    },
  },

  logo_reveal: {
    label: "Logo reveal",
    description: "Your logo scales in with a light sweep across it, then your name and tagline appear.",
    duration: 3.5,
    fields: [
      { key: "title", label: "Name", type: "text", default: "" },
      { key: "tagline", label: "Tagline", type: "text", default: "" },
      { key: "accent", label: "Accent color", type: "color", default: "#ffffff" },
      { key: "background", label: "Background", type: "select", options: ["dark", "transparent", "accent"], default: "dark" },
      { key: "logo", label: "Logo", type: "image", default: "" },
    ],
    draw({ ctx, t, d, W, H, p, logo, makeCanvas }) {
      const S = Math.min(W, H) / 1080;
      const outK = ease(t, d - 0.5, d, inCubic);
      const bgK = ease(t, 0, 0.35) * (1 - outK);
      if (bgK <= 0 && t > 0.1) return;
      ctx.save();
      if (p.background !== "transparent") {
        ctx.globalAlpha = bgK;
        if (p.background === "accent") {
          ctx.fillStyle = p.accent;
        } else {
          const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
          g.addColorStop(0, "#1a1a22");
          g.addColorStop(1, "#060608");
          ctx.fillStyle = g;
        }
        ctx.fillRect(0, 0, W, H);
      }
      const hasText = !!(p.title || p.tagline);
      const cy = hasText ? H * 0.43 : H * 0.5;
      const k = ease(t, 0.1, 1.0);
      const scale = mix(1.22, 1, k) * (1 + outK * 0.08);
      const boxW = W * 0.42;
      const boxH = H * (hasText ? 0.34 : 0.42);
      ctx.globalAlpha = k * (1 - outK);
      // Draw the logo into an offscreen canvas so the light sweep can be
      // masked to the logo's own shape.
      const lw = Math.ceil(boxW);
      const lh = Math.ceil(boxH);
      const off = makeCanvas(lw, lh);
      const o = off.getContext("2d");
      if (logo) drawLogoFit(o, logo, lw / 2, lh / 2, lw, lh);
      else drawAvatar(o, null, lw / 2, lh / 2, Math.min(lw, lh) * 0.42, p.background === "accent" ? "#111" : p.accent, p.title);
      const sweep = lin(t, 0.85, 1.55);
      if (sweep > 0 && sweep < 1) {
        o.globalCompositeOperation = "source-atop";
        const sx = mix(-0.4, 1.4, inOutCubic(sweep)) * lw;
        const g = o.createLinearGradient(sx - lw * 0.18, 0, sx + lw * 0.18, lh);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(0.5, "rgba(255,255,255,0.75)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        o.fillStyle = g;
        o.fillRect(0, 0, lw, lh);
        o.globalCompositeOperation = "source-over";
      }
      ctx.save();
      ctx.translate(W / 2, cy);
      ctx.scale(scale, scale);
      shadow(ctx, 50 * S, 0.45, 12 * S);
      ctx.drawImage(off, -lw / 2, -lh / 2, lw, lh);
      ctx.restore();

      // Name: wipes in from the center
      const textColor = p.background === "accent" ? onColor(p.accent) : "#ffffff";
      if (p.title) {
        const nK = ease(t, 0.9, 1.5, inOutCubic);
        const px = fitFont(ctx, p.title, 800, 72 * S, 32 * S, W * 0.8, 1);
        ctx.font = F(800, px);
        const tw = ctx.measureText(p.title).width;
        const ty = cy + boxH / 2 + 40 * S + px;
        ctx.save();
        ctx.beginPath();
        ctx.rect(W / 2 - (tw / 2 + 10) * nK, ty - px * 1.2, (tw + 20) * nK, px * 1.6);
        ctx.clip();
        ctx.fillStyle = textColor;
        ctx.globalAlpha = 1 - outK;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(p.title, W / 2, ty);
        ctx.restore();
        if (p.tagline) {
          const gK = ease(t, 1.3, 1.85);
          ctx.globalAlpha = gK * (1 - outK);
          ctx.font = F(400, 30 * S);
          ctx.fillStyle = p.background === "accent" ? textColor : "rgba(255,255,255,0.7)";
          ctx.textAlign = "center";
          ctx.fillText(p.tagline, W / 2, ty + 56 * S + (1 - gK) * 14 * S);
        }
      }
      ctx.restore();
    },
  },

  lower_third: {
    label: "Name tag (lower third)",
    description: "A clean name and title tag that wipes in at the bottom of the frame.",
    duration: 5,
    fields: [
      { key: "name", label: "Name", type: "text", default: "Your Name" },
      { key: "role", label: "Title / role", type: "text", default: "Creator" },
      { key: "accent", label: "Accent color", type: "color", default: "#22c3ee" },
      { key: "position", label: "Side", type: "select", options: ["left", "right"], default: "left" },
    ],
    draw({ ctx, t, d, W, H, p }) {
      const S = Math.min(W, H) / 1080;
      const inK = ease(t, 0.15, 0.65, inOutCubic);
      const outK = ease(t, d - 0.55, d - 0.05, inOutCubic);
      const barK = ease(t, 0, 0.35) * (1 - ease(t, d - 0.25, d));
      if (barK <= 0) return;
      ctx.font = F(700, 46 * S);
      const nameW = ctx.measureText(p.name).width;
      ctx.font = F(400, 28 * S);
      const roleW = ctx.measureText(p.role).width;
      const panelW = Math.max(nameW, roleW) + 72 * S;
      const panelH = 132 * S;
      const barW = 10 * S;
      const right = p.position === "right";
      const margin = 80 * S;
      const y = H - (W < H ? 360 : 150) * S - panelH;
      const x = right ? W - margin - panelW - barW : margin;
      const wipe = inK * (1 - outK);

      ctx.save();
      // Accent bar grows from the middle
      ctx.fillStyle = p.accent;
      const bh = panelH * barK;
      const barX = right ? x + panelW : x;
      rr(ctx, barX, y + (panelH - bh) / 2, barW, bh, barW / 2);
      ctx.fill();
      // Panel wipes out of the bar
      if (wipe > 0) {
        const pw = panelW * wipe;
        const px = right ? x + panelW - pw : x + barW;
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, y, pw, panelH);
        ctx.clip();
        shadow(ctx, 30 * S, 0.3, 8 * S);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fillRect(right ? x : x + barW, y, panelW, panelH);
        noShadow(ctx);
        const tx = (right ? x : x + barW) + 36 * S;
        const nK = ease(t, 0.4, 0.85) * (1 - outK);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#121216";
        ctx.font = F(700, 46 * S);
        ctx.fillText(p.name, tx, y + 64 * S + (1 - nK) * 40 * S);
        const rK = ease(t, 0.55, 1.0) * (1 - outK);
        ctx.fillStyle = "#5a5a66";
        ctx.font = F(400, 28 * S);
        ctx.fillText(p.role, tx, y + 104 * S + (1 - rK) * 40 * S);
        ctx.restore();
      }
      ctx.restore();
    },
  },

  title_card: {
    label: "Animated title",
    description: "Big words rise into place one by one with an accent underline. Great for chapter titles or key points.",
    duration: 3,
    fields: [
      { key: "text", label: "Text", type: "text", default: "Chapter One" },
      { key: "subtitle", label: "Subtitle", type: "text", default: "" },
      { key: "accent", label: "Accent color", type: "color", default: "#ffd60a" },
      { key: "background", label: "Background", type: "select", options: ["transparent", "dim", "dark"], default: "dim" },
    ],
    draw({ ctx, t, d, W, H, p }) {
      const S = Math.min(W, H) / 1080;
      const outK = ease(t, d - 0.45, d, inCubic);
      const bgK = ease(t, 0, 0.3) * (1 - outK);
      ctx.save();
      if (p.background !== "transparent" && bgK > 0) {
        ctx.globalAlpha = bgK;
        ctx.fillStyle = p.background === "dark" ? "#0b0b10" : "rgba(0,0,0,0.5)";
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      const maxW = W * 0.84;
      const px = fitFont(ctx, p.text, 800, 120 * S, 44 * S, maxW, 3);
      ctx.font = F(800, px);
      const lines = wrap(ctx, p.text, maxW);
      const lineH = px * 1.12;
      const blockH = lines.length * lineH + (p.subtitle ? 70 * S : 0);
      let y0 = (H - blockH) / 2 + px * 0.85;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      let wi = 0;
      let widest = 0;
      lines.forEach((line, li) => {
        ctx.font = F(800, px);
        const lw = ctx.measureText(line).width;
        widest = Math.max(widest, lw);
        let x = (W - lw) / 2;
        const y = y0 + li * lineH;
        for (const word of line.split(" ")) {
          const ww = ctx.measureText(word + " ").width;
          const k = ease(t, 0.08 + wi * 0.07, 0.6 + wi * 0.07, outCubic);
          const ok = ease(t, d - 0.45 + wi * 0.03, d, inCubic);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x - 4, y - px * 1.05, ww + 8, px * 1.35);
          ctx.clip();
          ctx.fillStyle = "#ffffff";
          shadow(ctx, 24 * S, 0.35, 6 * S);
          ctx.fillText(word, x, y + (1 - k) * px * 1.1 - ok * px * 1.1);
          ctx.restore();
          x += ww;
          wi++;
        }
      });
      // Underline
      const uK = ease(t, 0.35, 0.9, inOutCubic) * (1 - outK);
      const uy = y0 + (lines.length - 1) * lineH + 32 * S;
      if (uK > 0) {
        const uw = Math.min(widest, 420 * S) * uK;
        rr(ctx, W / 2 - uw / 2, uy, uw, 10 * S, 5 * S);
        ctx.fillStyle = p.accent;
        ctx.fill();
      }
      if (p.subtitle) {
        const sK = ease(t, 0.6, 1.1) * (1 - outK);
        ctx.globalAlpha = sK;
        ctx.textAlign = "center";
        ctx.font = F(400, 36 * S);
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillText(p.subtitle, W / 2, uy + 70 * S + (1 - sK) * 16 * S);
      }
      ctx.restore();
    },
  },
};

export function graphicProps(c) {
  const g = GRAPHICS[c.graphic?.template];
  if (!g) return {};
  const out = {};
  for (const f of g.fields) out[f.key] = c.graphic.props?.[f.key] ?? f.default;
  return out;
}

// Draw one frame of a graphic clip. `local` is seconds since the clip started.
export function drawGraphic(ctx, c, local, W, H, { logo = null, makeCanvas }) {
  const g = GRAPHICS[c.graphic?.template];
  if (!g) return;
  const d = c.out - c.in;
  ctx.save();
  try {
    g.draw({ ctx, t: Math.max(0, Math.min(d, local)), d, W, H, p: graphicProps(c), logo, makeCanvas });
  } finally {
    ctx.restore();
  }
}
