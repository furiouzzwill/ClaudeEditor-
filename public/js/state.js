// Central editor state: the project, selection, playhead, undo/redo and
// autosave. Edits go through `commit`, which snapshots for undo and schedules
// a save. UI modules subscribe to changes.

import { api } from "./api.js";
import { timelineDuration, applyOperations } from "/shared/timeline.js";

const EDIT_KEYS = ["name", "settings", "tracks", "clips", "markers"];
const snapshot = (p) => JSON.stringify(Object.fromEntries(EDIT_KEYS.map((k) => [k, p[k]])));

class Store extends EventTarget {
  project = null;
  selection = new Set();
  playhead = 0;
  playing = false;
  tool = "select";
  snapping = true;
  undoStack = [];
  redoStack = [];
  saveTimer = null;
  saving = false;
  dirty = false;

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
  }

  async load(projectId) {
    this.project = await api.get(`/api/projects/${projectId}`);
    this.project.chat ||= [];
    this.selection.clear();
    this.playhead = 0;
    this.undoStack = [];
    this.redoStack = [];
    try {
      localStorage.setItem("claudeEditor.lastProject", projectId);
    } catch {}
    this.emit("project");
    this.emit("change", { reason: "load" });
  }

  get duration() {
    return this.project ? timelineDuration(this.project) : 0;
  }

  // Replace the project with an edited version (as returned by the pure
  // functions in shared/timeline.js).
  commit(next, { reason = "edit", undoable = true } = {}) {
    if (undoable) {
      this.undoStack.push(snapshot(this.project));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.project = { ...next, media: this.project.media, chat: this.project.chat };
    for (const id of [...this.selection]) if (!this.project.clips.some((c) => c.id === id)) this.selection.delete(id);
    this.scheduleSave();
    this.emit("change", { reason });
  }

  applyOps(ops) {
    const res = applyOperations(this.project, ops);
    if (res.applied.length) this.commit(res.project, { reason: "ai" });
    return res;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(snapshot(this.project));
    this.restore(this.undoStack.pop());
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(snapshot(this.project));
    this.restore(this.redoStack.pop());
  }
  restore(snap) {
    Object.assign(this.project, JSON.parse(snap));
    for (const id of [...this.selection]) if (!this.project.clips.some((c) => c.id === id)) this.selection.delete(id);
    this.scheduleSave();
    this.emit("change", { reason: "undo" });
  }

  setPlayhead(t, { fromPlayback = false } = {}) {
    const max = Math.max(this.duration, 0);
    this.playhead = Math.max(0, Math.min(t, max + 0.0001));
    this.emit("playhead", { fromPlayback });
  }

  select(ids, { additive = false } = {}) {
    if (!additive) this.selection.clear();
    for (const id of [].concat(ids)) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else if (id) this.selection.add(id);
    }
    this.emit("selection");
  }

  setTool(tool) {
    this.tool = tool;
    this.emit("tool");
  }

  setChat(chat) {
    this.project.chat = chat;
    this.scheduleSave(200);
  }

  scheduleSave(delay = 600) {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), delay);
  }

  async save() {
    if (!this.project || this.saving) return;
    this.saving = true;
    this.dirty = false;
    const id = this.project.id;
    try {
      const body = Object.fromEntries([...EDIT_KEYS, "chat"].map((k) => [k, this.project[k]]));
      const res = await api.put(`/api/projects/${id}`, body);
      if (this.project?.id === id) this.mergeMedia(res.media);
    } catch (e) {
      this.dirty = true;
      this.emit("toast", { text: "Couldn't save: " + e.message, error: true });
    } finally {
      this.saving = false;
      if (this.dirty) this.scheduleSave(1500);
    }
  }

  // The server owns media status (background jobs update it).
  mergeMedia(media) {
    if (!media || !this.project) return;
    const before = JSON.stringify(this.project.media);
    if (before === JSON.stringify(media)) return;
    this.project.media = media;
    this.emit("media");
  }

  async refreshMedia() {
    if (!this.project) return;
    const p = await api.get(`/api/projects/${this.project.id}`);
    if (p.id === this.project.id) {
      // Clips might have been removed server-side when media was deleted.
      if (p.clips.length < this.project.clips.length && !this.dirty) {
        const ids = new Set(p.media.map((m) => m.id));
        this.project.clips = this.project.clips.filter((c) => !c.mediaId || ids.has(c.mediaId));
        this.emit("change", { reason: "media" });
      }
      this.mergeMedia(p.media);
    }
  }
}

export const store = new Store();
