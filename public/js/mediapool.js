import { store } from "./state.js";
import { api } from "./api.js";
import { h, toast, fmtDur, fmtBytes } from "./ui.js";
import { appendMedia } from "/shared/timeline.js";
import { forgetMedia } from "./timeline.js";

const pool = document.getElementById("mediaPool");
const grid = document.getElementById("poolGrid");
const count = document.getElementById("poolCount");
const uploads = new Map(); // temp id -> { name, progress }

export function render() {
  const p = store.project;
  if (!p) return;
  grid.innerHTML = "";
  const shown = p.media.filter((m) => !m.sfx).length;
  pool.classList.toggle("empty", shown === 0 && uploads.size === 0);
  count.textContent = shown ? `${shown} item${shown === 1 ? "" : "s"}` : "";

  for (const [id, u] of uploads) {
    grid.append(
      h("div", { class: "media-card" },
        h("div", { class: "thumb" }, "⇪"),
        h("div", { class: "progress" }, h("i", { style: { width: `${Math.round(u.progress * 100)}%` } })),
        h("div", { class: "meta" }, h("div", { class: "name" }, u.name), h("div", { class: "sub" }, `Uploading ${Math.round(u.progress * 100)}%`))
      )
    );
  }

  for (const m of p.media) {
    if (m.sfx) continue; // built-in sounds live in the 🔊 Sounds menu
    const ready = m.status === "ready";
    const thumbN = m.thumbCount ? String(Math.max(1, Math.ceil(m.thumbCount / 3))).padStart(4, "0") : null;
    const sub =
      m.status === "error"
        ? "Error: " + (m.error || "processing failed")
        : !ready
          ? `${m.progressLabel || "Processing"} ${Math.round((m.progress || 0) * 100)}%`
          : [m.hasVideo ? `${m.width}×${m.height}` : "Audio", fmtBytes(m.size)].join(" · ");
    const card = h(
      "div",
      {
        class: "media-card" + (m.status === "error" ? " error" : ""),
        draggable: "true",
        title: `${m.name}\n${m.path}\nDouble-click to append to the timeline. Drag onto a track to place it.`,
        ondragstart: (e) => {
          window.__draggingMedia = m.id;
          e.dataTransfer.setData("text/plain", m.name);
          e.dataTransfer.effectAllowed = "copy";
        },
        ondragend: () => (window.__draggingMedia = null),
        ondblclick: () => {
          try {
            store.commit(appendMedia(store.project, m.id));
          } catch (e) {
            toast(e.message, { error: true });
          }
        },
      },
      h(
        "div",
        {
          class: "thumb",
          style: thumbN && m.hasVideo ? { backgroundImage: `url(/media/${m.id}/thumbs/${thumbN}.jpg)` } : null,
        },
        m.hasVideo ? "" : "♪",
        h("span", { class: "dur" }, fmtDur(m.duration))
      ),
      !ready && m.status !== "error" ? h("div", { class: "progress" }, h("i", { style: { width: `${Math.round((m.progress || 0) * 100)}%` } })) : null,
      h("div", { class: "meta" }, h("div", { class: "name" }, m.name), h("div", { class: "sub" }, sub)),
      h("button", {
        class: "x",
        title: "Remove from project (your original file is not touched)",
        onclick: async (e) => {
          e.stopPropagation();
          const used = store.project.clips.filter((c) => c.mediaId === m.id).length;
          if (used && !confirm(`"${m.name}" is used by ${used} clip(s) on the timeline. Remove it and those clips?`)) return;
          await store.save();
          await api.del(`/api/projects/${store.project.id}/media/${m.id}`);
          forgetMedia(m.id);
          store.project.clips = store.project.clips.filter((c) => c.mediaId !== m.id);
          store.project.media = store.project.media.filter((x) => x.id !== m.id);
          store.emit("change", { reason: "media" });
          store.emit("media");
        },
      }, "✕")
    );
    grid.append(card);
  }
}

export async function uploadFiles(files) {
  const list = [...files].filter((f) => /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|m2ts|ts|flv|wmv|mpg|mpeg|3gp|ogv|mp3|wav|aac|m4a|flac|ogg|opus|aif|aiff|wma)$/i.test(f.name));
  if (!list.length) return toast("Those files aren't a supported video or audio format.", { error: true });
  await Promise.all(
    list.map(async (file) => {
      const id = Math.random().toString(36).slice(2);
      uploads.set(id, { name: file.name, progress: 0 });
      render();
      let last = 0;
      try {
        await api.upload(store.project.id, file, (p) => {
          uploads.get(id).progress = p;
          if (Date.now() - last > 300) {
            last = Date.now();
            render();
          }
        });
      } catch (e) {
        toast(`${file.name}: ${e.message}`, { error: true });
      } finally {
        uploads.delete(id);
        await store.refreshMedia();
        render();
      }
    })
  );
}

// Drag files from the OS onto the pool.
pool.addEventListener("dragover", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  pool.classList.add("dragover");
});
pool.addEventListener("dragleave", (e) => {
  if (!pool.contains(e.relatedTarget)) pool.classList.remove("dragover");
});
pool.addEventListener("drop", (e) => {
  pool.classList.remove("dragover");
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  uploadFiles(e.dataTransfer.files);
});

store.on("media", render);
store.on("project", render);
