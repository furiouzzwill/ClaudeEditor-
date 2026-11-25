// Small UI helpers: element builder, modals, toasts, menus.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(text, { error = false, ms = 3500 } = {}) {
  const el = h("div", { class: "toast" + (error ? " error" : "") }, text);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal(title, body, { footer = [], onClose, width } = {}) {
  const root = document.getElementById("modalRoot");
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const box = h(
    "div",
    { class: "modal", style: width ? { width: `min(${width}px, 100%)` } : null },
    h("header", {}, title, h("button", { class: "btn ghost icon", onclick: () => close(), title: "Close" }, "✕")),
    h("div", { class: "body" }, body),
    footer.length ? h("footer", {}, footer) : null
  );
  const backdrop = h("div", { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() }, box);
  root.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  return { close, box };
}

export function menu(anchor, items) {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const el = h(
    "div",
    { class: "menu", style: { left: r.left + "px", top: r.bottom + 4 + "px" } },
    items.map((it) =>
      it === "-"
        ? h("hr")
        : h("button", { onclick: () => (el.remove(), it.action()) }, h("span", {}, it.label), it.hint ? h("span", { class: "muted small" }, it.hint) : null)
    )
  );
  document.body.append(el);
  setTimeout(() => document.addEventListener("mousedown", function off(e) {
    if (!el.contains(e.target)) {
      el.remove();
      document.removeEventListener("mousedown", off);
    }
  }), 0);
}

export function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}

export function fmtDur(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}
