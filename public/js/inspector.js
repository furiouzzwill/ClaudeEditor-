import { store } from "./state.js";
import { h } from "./ui.js";
import { clipDuration, clipEnd, mediaById, trackById, updateClip, trimClip, moveClip, formatTimecode, removeClip } from "/shared/timeline.js";

const root = document.getElementById("tab-inspector");

const FORMATS = [
  ["1920x1080", "1080p HD (16:9)"],
  ["3840x2160", "4K UHD (16:9)"],
  ["1280x720", "720p (16:9)"],
  ["1080x1920", "Vertical 1080×1920 (9:16)"],
  ["1080x1350", "Portrait 1080×1350 (4:5)"],
  ["1080x1080", "Square 1080×1080 (1:1)"],
  ["2560x1080", "Ultrawide 2560×1080 (21:9)"],
];

function field(label, input) {
  return h("div", { class: "field" }, h("label", {}, label), input);
}

function num(value, onchange, { step = 0.01, min = 0 } = {}) {
  return h("input", { type: "number", step, min, value: Math.round(value * 1000) / 1000, onchange: (e) => onchange(Number(e.target.value)) });
}

const safe = (fn) => {
  try {
    fn();
  } catch (e) {
    store.emit("toast", { text: e.message, error: true });
  }
};

export function render() {
  const p = store.project;
  if (!p || root.hidden) return;
  root.innerHTML = "";
  const sel = [...store.selection].map((id) => p.clips.find((c) => c.id === id)).filter(Boolean);
  const fps = p.settings.fps;

  if (sel.length === 1) {
    const c = sel[0];
    const track = trackById(p, c.trackId);
    const media = c.mediaId ? mediaById(p, c.mediaId) : null;
    const set = (fields) => safe(() => store.commit(updateClip(store.project, c.id, fields)));

    root.append(
      h("div", { class: "section" },
        h("h4", {}, track.kind === "text" ? "Title" : "Clip"),
        media ? field("Source", h("span", { class: "small", title: media.path }, media.name)) : null,
        field("Track", h("span", {}, `${track.id} (${track.kind})`)),
        field("Start", num(c.start, (v) => safe(() => store.commit(moveClip(store.project, c.id, v))))),
        field("Duration", num(clipDuration(c), (v) => safe(() => store.commit(trimClip(store.project, c.id, c.in, c.in + Math.max(1 / fps, v)))))),
        field("Timeline", h("span", { class: "small muted" }, `${formatTimecode(c.start, fps)} → ${formatTimecode(clipEnd(c), fps)}`)),
        media ? field("Source in", num(c.in, (v) => safe(() => store.commit(trimClip(store.project, c.id, v, c.out))))) : null,
        media ? field("Source out", num(c.out, (v) => safe(() => store.commit(trimClip(store.project, c.id, c.in, v))))) : null
      )
    );

    if (media && media.hasAudio) {
      const vol = c.volume ?? 1;
      const label = h("span", { class: "small muted", style: { minWidth: "40px", textAlign: "right" } }, `${Math.round(vol * 100)}%`);
      root.append(
        h("div", { class: "section" },
          h("h4", {}, "Audio"),
          field("Volume", h("div", { class: "row" },
            h("input", { type: "range", min: 0, max: 2, step: 0.01, value: vol, oninput: (e) => (label.textContent = `${Math.round(e.target.value * 100)}%`), onchange: (e) => set({ volume: Number(e.target.value) }) }),
            label
          )),
          field("", h("button", { class: "btn", onclick: () => set({ volume: vol === 0 ? 1 : 0 }) }, vol === 0 ? "Unmute" : "Mute"))
        )
      );
    }
    if (track.kind === "video") {
      root.append(
        h("div", { class: "section" },
          h("h4", {}, "Framing"),
          field("Scaling", h("select", { onchange: (e) => set({ fit: e.target.value }) },
            h("option", { value: "fit", selected: c.fit !== "fill" }, "Fit (letterbox)"),
            h("option", { value: "fill", selected: c.fit === "fill" }, "Fill (crop)")
          ))
        )
      );
    }
    if (track.kind === "text") {
      const st = c.style || {};
      const setStyle = (k, v) => set({ style: { ...st, [k]: v } });
      root.append(
        h("div", { class: "section" },
          h("h4", {}, "Text"),
          field("Text", h("textarea", { rows: 3, onchange: (e) => set({ text: e.target.value }) }, c.text || "")),
          field("Position", h("select", { onchange: (e) => setStyle("position", e.target.value) },
            ...["top", "center", "bottom"].map((v) => h("option", { value: v, selected: (st.position || "bottom") === v }, v[0].toUpperCase() + v.slice(1)))
          )),
          field("Size", num(st.size || 56, (v) => setStyle("size", v), { step: 1, min: 8 })),
          field("Color", h("input", { type: "color", value: st.color || "#ffffff", onchange: (e) => setStyle("color", e.target.value) })),
          field("Background", h("input", { type: "checkbox", checked: st.box !== false, style: { width: "auto" }, onchange: (e) => setStyle("box", e.target.checked) }))
        )
      );
    }
    root.append(
      h("div", { class: "section" },
        h("div", { class: "row", style: { display: "flex", gap: "6px" } },
          h("button", { class: "btn danger", onclick: () => store.commit(removeClip(store.project, c.id)) }, "Delete"),
          h("button", { class: "btn danger", onclick: () => store.commit(removeClip(store.project, c.id, { ripple: true })) }, "Ripple delete")
        )
      )
    );
    return;
  }

  if (sel.length > 1) {
    root.append(h("div", { class: "empty-note" }, `${sel.length} clips selected.`, h("br"), "Press Delete to remove them, or Shift+Delete to ripple delete."));
    return;
  }

  // Nothing selected: project settings.
  const cur = `${p.settings.width}x${p.settings.height}`;
  const setSettings = (s) => store.commit({ ...store.project, settings: { ...store.project.settings, ...s } });
  root.append(
    h("div", { class: "section" },
      h("h4", {}, "Project"),
      field("Format", h("select", {
        onchange: (e) => {
          const [w, hh] = e.target.value.split("x").map(Number);
          setSettings({ width: w, height: hh });
        },
      },
        ...(FORMATS.some(([v]) => v === cur) ? [] : [h("option", { value: cur, selected: true }, `Custom ${p.settings.width}×${p.settings.height}`)]),
        ...FORMATS.map(([v, label]) => h("option", { value: v, selected: v === cur }, label))
      )),
      field("Frame rate", h("select", { onchange: (e) => setSettings({ fps: Number(e.target.value) }) },
        ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].concat([23.976, 24, 25, 29.97, 30, 50, 59.94, 60].includes(fps) ? [] : [fps]).map((f) => h("option", { value: f, selected: Math.abs(f - fps) < 0.001 }, `${f} fps`))
      )),
      field("Duration", h("span", {}, formatTimecode(store.duration, fps))),
      field("Clips", h("span", {}, String(p.clips.length)))
    )
  );
  if (p.markers.length) {
    root.append(
      h("div", { class: "section" },
        h("h4", {}, "Markers"),
        ...p.markers
          .slice()
          .sort((a, b) => a.time - b.time)
          .map((m) =>
            h("div", { class: "field" },
              h("button", { class: "btn ghost small", style: { fontFamily: "var(--mono)" }, onclick: () => store.setPlayhead(m.time) }, formatTimecode(m.time, fps)),
              h("div", { class: "row" },
                h("input", { value: m.label, onchange: (e) => store.commit({ ...store.project, markers: store.project.markers.map((x) => (x.id === m.id ? { ...x, label: e.target.value } : x)) }) }),
                h("button", { class: "btn ghost icon", title: "Remove marker", onclick: () => store.commit({ ...store.project, markers: store.project.markers.filter((x) => x.id !== m.id) }) }, "✕")
              )
            )
          )
      )
    );
  }
  root.append(h("div", { class: "empty-note small" }, "Select a clip on the timeline to edit its properties."));
}

store.on("selection", render);
store.on("change", ({ reason }) => reason !== "preview" && render());
store.on("media", render);
