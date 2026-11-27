import { store } from "./state.js";
import { api } from "./api.js";
import { h, modal, toast, fmtBytes, menu } from "./ui.js";
import { uploadFiles } from "./mediapool.js";
import { timelineDuration } from "/shared/timeline.js";
import { APP_NAME } from "/shared/brand.js";

// ---- import ----------------------------------------------------------------

export function openImport() {
  let mode = "disk";
  let dir = null;
  try {
    dir = localStorage.getItem("claudeEditor.lastDir");
  } catch {}
  const selected = new Set();
  const pathInput = h("input", { class: "input", spellcheck: false });
  const list = h("div", { class: "fs-list" });
  const diskPane = h("div", {}, h("div", { class: "fs-path" }, h("button", { class: "btn", title: "Up one folder", onclick: () => parent && load(parent) }, "↑"), pathInput, h("button", { class: "btn", onclick: () => load(pathInput.value) }, "Go")), list);
  const fileInput = h("input", { type: "file", multiple: true, accept: "video/*,audio/*,image/*", hidden: true, onchange: () => (fileInput.files.length && uploadFiles(fileInput.files), m.close()) });
  const uploadPane = h(
    "div",
    { hidden: true },
    h("div", { class: "note" }, `Uploading copies the file into ${APP_NAME}'s data folder. It works for any size, but for very large files “From disk” is faster because nothing is copied.`),
    h("p", {}, h("button", { class: "btn primary", onclick: () => fileInput.click() }, "Choose files…"), fileInput)
  );
  const importBtn = h("button", { class: "btn primary", disabled: true, onclick: doImport }, "Import");
  const seg = h(
    "div",
    { class: "seg" },
    h("button", { class: "active", onclick: () => setMode("disk") }, "From disk (no copy)"),
    h("button", { onclick: () => setMode("upload") }, "Upload")
  );
  let parent = null;

  function setMode(mo) {
    mode = mo;
    seg.children[0].classList.toggle("active", mo === "disk");
    seg.children[1].classList.toggle("active", mo === "upload");
    diskPane.hidden = mo !== "disk";
    uploadPane.hidden = mo !== "upload";
    importBtn.hidden = mo !== "disk";
  }

  async function load(d) {
    try {
      const res = await api.get(`/api/fs?dir=${encodeURIComponent(d || "")}`);
      dir = res.dir;
      parent = res.parent;
      try {
        localStorage.setItem("claudeEditor.lastDir", dir);
      } catch {}
      pathInput.value = dir;
      selected.clear();
      importBtn.disabled = true;
      list.innerHTML = "";
      if (!res.items.length) list.append(h("div", { class: "empty-note" }, "No folders or media files here."));
      for (const it of res.items) {
        const full = dir.replace(/[\\/]$/, "") + (dir.includes("\\") ? "\\" : "/") + it.name;
        const row = h(
          "div",
          {
            class: "fs-item",
            ondblclick: () => (it.type === "dir" ? load(full) : (selected.clear(), selected.add(full), doImport())),
            onclick: (e) => {
              if (it.type === "dir") return load(full);
              if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                selected.clear();
                list.querySelectorAll(".selected").forEach((x) => x.classList.remove("selected"));
              }
              if (selected.has(full)) {
                selected.delete(full);
                row.classList.remove("selected");
              } else {
                selected.add(full);
                row.classList.add("selected");
              }
              importBtn.disabled = selected.size === 0;
              importBtn.textContent = selected.size > 1 ? `Import ${selected.size} files` : "Import";
            },
          },
          h("span", {}, it.type === "dir" ? "📁" : /\.(mp3|wav|aac|m4a|flac|ogg|opus|aif|aiff|wma)$/i.test(it.name) ? "🎵" : /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(it.name) ? "🖼" : "🎞"),
          h("span", {}, it.name),
          it.type === "file" ? h("span", { class: "size" }, fmtBytes(it.size)) : null
        );
        list.append(row);
      }
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  async function doImport() {
    if (!selected.size) return;
    importBtn.disabled = true;
    try {
      await api.post(`/api/projects/${store.project.id}/import`, { paths: [...selected] });
      await store.refreshMedia();
      m.close();
    } catch (e) {
      toast(e.message, { error: true });
      importBtn.disabled = false;
    }
  }

  pathInput.addEventListener("keydown", (e) => e.key === "Enter" && load(pathInput.value));
  const m = modal("Import media", [seg, diskPane, uploadPane], { footer: [importBtn] });
  load(dir);
}

// ---- export ----------------------------------------------------------------

export function openExport() {
  const p = store.project;
  const dur = timelineDuration(p);
  let quality = "standard";
  const name = h("input", { class: "input", value: p.name });
  const qseg = h(
    "div",
    { class: "seg" },
    ...[
      ["draft", "Draft (fast)"],
      ["standard", "Standard"],
      ["high", "High quality"],
    ].map(([q, label]) =>
      h("button", {
        class: q === quality ? "active" : "",
        onclick: (e) => {
          quality = q;
          [...qseg.children].forEach((b) => b.classList.toggle("active", b === e.currentTarget));
        },
      }, label)
    )
  );
  const jobsBox = h("div");
  const exportsBox = h("div");
  const pending = p.media.filter((mm) => mm.status !== "ready" && p.clips.some((c) => c.mediaId === mm.id));

  const go = h("button", {
    class: "btn primary",
    disabled: dur <= 0,
    onclick: async () => {
      go.disabled = true;
      try {
        await store.save();
        await api.post(`/api/projects/${p.id}/export`, { quality, fileName: name.value });
        refresh();
      } catch (e) {
        toast(e.message, { error: true });
      } finally {
        go.disabled = false;
      }
    },
  }, "Render");

  async function refresh() {
    const [jobs, files] = await Promise.all([api.get("/api/jobs"), api.get("/api/exports")]);
    jobsBox.innerHTML = "";
    for (const j of jobs.filter((j) => j.kind === "export").reverse()) {
      const done = j.status === "done";
      jobsBox.append(
        h("div", { class: "job-row" },
          h("div", { class: "grow" },
            h("div", {}, j.label),
            h("div", { class: "muted small" }, j.status === "running" ? `${j.message || "Rendering"} · ${Math.round(j.progress * 100)}%` : j.status === "error" ? "Failed: " + j.error : j.status),
            j.status === "running" || j.status === "queued" ? h("div", { class: "bar" }, h("i", { style: { width: `${Math.round(j.progress * 100)}%` } })) : null
          ),
          j.status === "running" || j.status === "queued" ? h("button", { class: "btn ghost danger", onclick: async () => (await api.del(`/api/jobs/${j.id}`), refresh()) }, "Cancel") : null,
          done && j.result ? h("a", { class: "btn", href: `/exports/${encodeURIComponent(j.result.file)}?download=1` }, "Download") : null
        )
      );
    }
    exportsBox.innerHTML = "";
    if (files.length) {
      exportsBox.append(h("h4", { class: "muted small", style: { margin: "6px 0 0", textTransform: "uppercase" } }, "Previous exports"));
      for (const f of files.slice(0, 8)) {
        exportsBox.append(
          h("div", { class: "job-row" },
            h("div", { class: "grow" }, h("div", {}, f.file), h("div", { class: "muted small" }, `${fmtBytes(f.size)} · ${new Date(f.createdAt).toLocaleString()}`)),
            h("a", { class: "btn ghost", href: `/exports/${encodeURIComponent(f.file)}`, target: "_blank" }, "Play"),
            h("a", { class: "btn", href: `/exports/${encodeURIComponent(f.file)}?download=1` }, "Download")
          )
        );
      }
    }
  }
  const timer = setInterval(refresh, 1000);
  refresh();

  modal(
    "Export",
    [
      h("div", { class: "field" }, h("label", {}, "File name"), name),
      h("div", { class: "field" }, h("label", {}, "Quality"), qseg),
      h("div", { class: "note" },
        `${p.settings.width}×${p.settings.height} · ${p.settings.fps} fps · H.264/AAC MP4 · ${Math.round(dur * 10) / 10}s. `,
        "Rendered from your original full-quality files, not the proxies."),
      pending.length ? h("div", { class: "note" }, `Still processing: ${pending.map((x) => x.name).join(", ")}. You can render now; the originals are used either way.`) : null,
      jobsBox,
      exportsBox,
    ],
    { footer: [go], onClose: () => clearInterval(timer) }
  );
}

// ---- settings ----------------------------------------------------------------

export async function openSettings() {
  const [s, sys] = await Promise.all([api.get("/api/settings"), api.get("/api/system")]);
  const key = h("input", { class: "input", type: "password", placeholder: s.apiKeySet ? `Saved (${s.apiKeyHint}). Leave blank to keep.` : s.envKey ? "Using ANTHROPIC_API_KEY from the environment" : "sk-ant-…", autocomplete: "off" });
  const model = h("input", { class: "input", value: s.model, spellcheck: false });
  const save = h("button", {
    class: "btn primary",
    onclick: async () => {
      const body = { model: model.value };
      if (key.value.trim()) body.apiKey = key.value.trim();
      await api.post("/api/settings", body);
      toast("Settings saved");
      m.close();
      document.dispatchEvent(new Event("ai-status"));
    },
  }, "Save");
  const clearKey = s.apiKeySet
    ? h("button", { class: "btn ghost danger", onclick: async () => (await api.post("/api/settings", { apiKey: "" }), toast("API key removed"), m.close(), document.dispatchEvent(new Event("ai-status"))) }, "Remove saved key")
    : null;
  const m = modal(
    "Settings",
    [
      h("div", { class: "section" }, h("h4", {}, "Claude"),
        h("div", { class: "field" }, h("label", {}, "API key"), key),
        h("div", { class: "field" }, h("label", {}, "Model"), model),
        h("div", { class: "note" }, "Get an API key at console.anthropic.com. It's stored only in this computer's data folder. Video files are never sent to Claude, only the timeline, analysis data and small keyframe images.")
      ),
      h("div", { class: "section" }, h("h4", {}, "System"),
        h("div", { class: "field" }, h("label", {}, "FFmpeg"), h("span", { class: sys.ffmpeg ? "" : "muted" }, sys.ffmpeg ? sys.ffmpeg.replace(/Copyright.*/, "") : "Not found. Install FFmpeg and restart.")),
        h("div", { class: "field" }, h("label", {}, "Transcripts"), h("span", { class: "muted" }, sys.whisper ? "Whisper found. New media is transcribed automatically." : "Optional: install Whisper (pip install -U openai-whisper) so Claude can edit by what's said.")),
        h("div", { class: "field" }, h("label", {}, "Data folder"), h("span", { class: "muted small" }, sys.dataDir))
      ),
    ],
    { footer: [clearKey, save].filter(Boolean) }
  );
}

// ---- projects ------------------------------------------------------------------

export async function openProjectsMenu(anchor, loadProject) {
  const projects = await api.get("/api/projects");
  menu(anchor, [
    { label: "New project", action: async () => loadProject((await api.post("/api/projects", { name: "Untitled Project" })).id) },
    "-",
    ...projects.slice(0, 15).map((p) => ({
      label: (p.id === store.project?.id ? "● " : "") + p.name,
      hint: `${p.clips} clips`,
      action: () => loadProject(p.id),
    })),
    "-",
    {
      label: "Delete this project…",
      action: async () => {
        if (!confirm(`Delete "${store.project.name}"? Uploaded copies and proxies are removed. Original files you imported from disk are not touched.`)) return;
        await api.del(`/api/projects/${store.project.id}`);
        const rest = await api.get("/api/projects");
        loadProject(rest[0]?.id || (await api.post("/api/projects", { name: "Untitled Project" })).id);
      },
    },
  ]);
}
