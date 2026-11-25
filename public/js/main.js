import { store } from "./state.js";
import { api } from "./api.js";
import { toast, menu } from "./ui.js";
import { ensureSounds } from "./sounds.js";
import { redraw, zoomBy, zoomToFit } from "./timeline.js";
import { togglePlay, pause, step } from "./viewer.js";
import * as inspector from "./inspector.js";
import "./mediapool.js";
import "./assistant.js";
import { openImport, openExport, openSettings, openProjectsMenu } from "./dialogs.js";
import { splitAt, removeClip, deleteRanges, clipEnd, uid, snapToFrame, applyOperation, EFFECT_TYPES, SOUND_EFFECTS } from "/shared/timeline.js";

const $ = (id) => document.getElementById(id);

// ---- project loading ----------------------------------------------------------

async function loadProject(id) {
  await store.save();
  await store.load(id);
}

async function boot() {
  let id = null;
  try {
    id = localStorage.getItem("claudeEditor.lastProject");
  } catch {}
  const projects = await api.get("/api/projects");
  if (!projects.some((p) => p.id === id)) id = projects[0]?.id;
  if (!id) id = (await api.post("/api/projects", { name: "My First Project" })).id;
  await store.load(id);
}

store.on("project", () => ($("projectName").value = store.project.name));
$("projectName").addEventListener("change", (e) => store.commit({ ...store.project, name: e.target.value.trim() || "Untitled Project" }));
$("btnProjects").onclick = (e) => openProjectsMenu(e.currentTarget, loadProject);
store.on("toast", ({ text, error }) => toast(text, { error }));

// ---- top bar ---------------------------------------------------------------------

$("btnImport").onclick = openImport;
$("btnExport").onclick = openExport;
$("btnSettings").onclick = openSettings;
$("btnUndo").onclick = () => store.undo();
$("btnRedo").onclick = () => store.redo();
const syncUndo = () => {
  $("btnUndo").disabled = !store.undoStack.length;
  $("btnRedo").disabled = !store.redoStack.length;
};
store.on("change", syncUndo);

// ---- side tabs ---------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("tab-assistant").hidden = tab.dataset.tab !== "assistant";
    $("tab-inspector").hidden = tab.dataset.tab !== "inspector";
    inspector.render();
  })
);
// Selecting a clip shows the inspector.
store.on("selection", () => {
  if (store.selection.size && $("tab-inspector").hidden && document.activeElement !== $("prompt")) {
    document.querySelector('.tab[data-tab="inspector"]').click();
  }
});

// ---- timeline toolbar ------------------------------------------------------------------

document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => store.setTool(b.dataset.tool)));
store.on("tool", () => document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === store.tool)));
$("snapToggle").onchange = (e) => (store.snapping = e.target.checked);
$("btnZoomIn").onclick = () => zoomBy(1.5);
$("btnZoomOut").onclick = () => zoomBy(1 / 1.5);
$("btnFit").onclick = zoomToFit;

function splitAtPlayhead() {
  const t = snapToFrame(store.playhead, store.project.settings.fps);
  // If selected clips sit under the playhead, only split those tracks;
  // otherwise split every track.
  const sel = [...store.selection]
    .map((id) => store.project.clips.find((c) => c.id === id))
    .filter((c) => c && t > c.start && t < clipEnd(c));
  const tracks = sel.length ? [...new Set(sel.map((c) => c.trackId))] : [null];
  let p = store.project;
  for (const tr of tracks) p = splitAt(p, t, tr);
  if (p.clips.length !== store.project.clips.length) store.commit(p);
}
function deleteSelection(ripple) {
  const ids = [...store.selection];
  if (!ids.length) return;
  let p = store.project;
  if (ripple && ids.length > 1) {
    // Ripple-delete the selected clips' time ranges on their tracks.
    const byTrack = {};
    for (const id of ids) {
      const c = p.clips.find((x) => x.id === id);
      if (c) (byTrack[c.trackId] ||= []).push([c.start, clipEnd(c)]);
    }
    for (const [trackId, ranges] of Object.entries(byTrack)) p = deleteRanges(p, ranges, { ripple: true, trackIds: [trackId] });
  } else {
    for (const id of ids) p = removeClip(p, id, { ripple });
  }
  store.select([]);
  store.commit(p);
}
function addMarker() {
  const t = snapToFrame(store.playhead, store.project.settings.fps);
  store.commit({ ...store.project, markers: [...store.project.markers, { id: uid("m"), time: t, label: `Marker ${store.project.markers.length + 1}`, color: "#f5a623" }] });
}
// ---- quick effects & sounds at the playhead ----------------------------------------

const EFFECT_LENGTH = { zoom: 2, shake: 1, flash: 0.3, rainbow: 2, blur: 2, black_white: 2, spotlight: 2 };
function runOp(op) {
  try {
    const next = applyOperation(store.project, op);
    store.commit(next);
  } catch (e) {
    toast(e.message, { error: true });
  }
}
$("btnEffects").onclick = (e) => {
  const t = snapToFrame(store.playhead, store.project.settings.fps);
  menu(e.currentTarget, [
    ...Object.entries(EFFECT_TYPES).map(([type, d]) => ({
      label: d.label,
      hint: `${EFFECT_LENGTH[type]}s`,
      action: () => runOp({ op: "add_effect", type, start: t, end: t + EFFECT_LENGTH[type] }),
    })),
    "-",
    { label: "Slow motion (0.5×)", hint: "next 2s", action: () => runOp({ op: "slow_motion", start: t, end: t + 2, speed: 0.5 }) },
    { label: "Freeze frame", hint: "1s", action: () => runOp({ op: "freeze_frame", time: t, duration: 1 }) },
    { label: "Hype title", hint: "2s", action: () => runOp({ op: "add_text", start: t, end: t + 2, text: "LET'S GO!", look: "impact" }) },
  ]);
};
$("btnSounds").onclick = (e) => {
  const t = snapToFrame(store.playhead, store.project.settings.fps);
  menu(e.currentTarget, Object.entries(SOUND_EFFECTS).map(([sound, d]) => ({
    label: d.label,
    hint: `${d.duration}s`,
    action: async () => {
      try {
        await ensureSounds([sound]);
        runOp({ op: "add_sound", sound, time: t, volume: 1 });
      } catch (err) {
        toast(err.message, { error: true });
      }
    },
  })));
};

$("btnSplit").onclick = splitAtPlayhead;
$("btnDelete").onclick = (e) => deleteSelection(e.shiftKey);
$("btnMarker").onclick = addMarker;

// ---- resizable timeline ------------------------------------------------------------------

(() => {
  const pane = document.querySelector(".timeline-pane");
  let startY = null;
  let startH = 0;
  try {
    const saved = localStorage.getItem("claudeEditor.timelineH");
    if (saved) document.getElementById("app").style.setProperty("--timeline-h", saved);
  } catch {}
  pane.addEventListener("mousedown", (e) => {
    if (e.offsetY > 4 || e.target !== pane) return;
    startY = e.clientY;
    startH = pane.getBoundingClientRect().height;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (startY == null) return;
    const hh = Math.max(140, Math.min(window.innerHeight - 260, startH + (startY - e.clientY)));
    document.getElementById("app").style.setProperty("--timeline-h", hh + "px");
  });
  window.addEventListener("mouseup", () => {
    if (startY == null) return;
    startY = null;
    try {
      localStorage.setItem("claudeEditor.timelineH", document.getElementById("app").style.getPropertyValue("--timeline-h"));
    } catch {}
  });
})();

// ---- keyboard ------------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (!store.project) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector(".modal-backdrop")) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod && k.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
  } else if (mod && k.toLowerCase() === "y") {
    e.preventDefault();
    store.redo();
  } else if (mod && k.toLowerCase() === "s") {
    e.preventDefault();
    store.save().then(() => toast("Saved"));
  } else if (mod && k.toLowerCase() === "b") {
    e.preventDefault();
    splitAtPlayhead();
  } else if (mod && k.toLowerCase() === "a") {
    e.preventDefault();
    store.select(store.project.clips.map((c) => c.id));
  } else if (mod && k.toLowerCase() === "i") {
    e.preventDefault();
    openImport();
  } else if (mod && k.toLowerCase() === "e") {
    e.preventDefault();
    openExport();
  } else if (mod) {
    return;
  } else if (k === " ") {
    e.preventDefault();
    togglePlay();
  } else if (k === "k" || k === "K") pause();
  else if (k === "l" || k === "L") togglePlay();
  else if (k === "ArrowLeft") {
    e.preventDefault();
    step(e.shiftKey ? -Math.round(store.project.settings.fps) : -1);
  } else if (k === "ArrowRight") {
    e.preventDefault();
    step(e.shiftKey ? Math.round(store.project.settings.fps) : 1);
  } else if (k === "Home") {
    pause();
    store.setPlayhead(0);
  } else if (k === "End") {
    pause();
    store.setPlayhead(store.duration);
  } else if (k === "Delete" || k === "Backspace") {
    e.preventDefault();
    deleteSelection(e.shiftKey);
  } else if (k === "s" || k === "S") splitAtPlayhead();
  else if (k === "b" || k === "B") store.setTool("razor");
  else if (k === "v" || k === "V") store.setTool("select");
  else if (k === "a" || k === "A") store.setTool("select");
  else if (k === "m" || k === "M") addMarker();
  else if (k === "n" || k === "N") {
    store.snapping = !store.snapping;
    $("snapToggle").checked = store.snapping;
    toast(`Snapping ${store.snapping ? "on" : "off"}`, { ms: 1200 });
  } else if (k === "=" || k === "+") zoomBy(1.5);
  else if (k === "-" || k === "_") zoomBy(1 / 1.5);
  else if (k === "Z" && e.shiftKey) zoomToFit();
  else if (k === "Escape") store.select([]);
  else return;
  redraw();
});

// ---- background jobs -------------------------------------------------------------------------

let lastJobsKey = "";
async function pollJobs() {
  try {
    const jobs = await api.get("/api/jobs");
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
    const ind = $("jobsIndicator");
    ind.hidden = active.length === 0;
    if (active.length) {
      const avg = active.reduce((a, j) => a + j.progress, 0) / active.length;
      ind.innerHTML = `<span>${active.length === 1 ? active[0].label : active.length + " tasks running"}</span><span class="bar"><i style="width:${Math.round(avg * 100)}%"></i></span>`;
      ind.title = active.map((j) => `${j.label}: ${j.message || j.status} ${Math.round(j.progress * 100)}%`).join("\n");
      ind.onclick = active.some((j) => j.kind === "export") ? openExport : null;
    }
    // Refresh media when processing jobs are active or have just finished.
    const key = jobs.map((j) => j.id + j.status + Math.round(j.progress * 20)).join();
    if (key !== lastJobsKey) {
      lastJobsKey = key;
      if (jobs.some((j) => j.kind === "prepare" || j.kind === "transcribe")) await store.refreshMedia();
    }
    for (const j of jobs) {
      if (j.kind === "export" && j.status === "done" && !seenDone.has(j.id)) {
        seenDone.add(j.id);
        if (seenInit) toast(`Export finished: ${j.result?.file}`, { ms: 6000 });
      }
    }
    seenInit = true;
    setTimeout(pollJobs, active.length ? 800 : 2500);
  } catch {
    setTimeout(pollJobs, 4000);
  }
}
const seenDone = new Set();
let seenInit = false;

window.addEventListener("beforeunload", (e) => {
  if (store.dirty) {
    store.save();
    e.preventDefault();
  }
});

boot()
  .then(pollJobs)
  .catch((e) => toast("Failed to start: " + e.message, { error: true, ms: 10000 }));

// Handy for debugging from the browser console.
window.claudeEditor = { store };
