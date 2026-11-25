// On-disk layout:
//   data/projects/<projectId>.json
//   data/media/<mediaId>/            proxy.mp4, thumbs/, waveform.json, analysis.json,
//                                    source.<ext> (only for uploaded files)
//   data/exports/<file>.mp4
//   data/config.json                 local settings (API key, etc.), never committed

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../shared/timeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA = path.resolve(process.env.CLAUDE_EDITOR_DATA || path.join(ROOT, "data"));
export const PROJECTS = path.join(DATA, "projects");
export const MEDIA = path.join(DATA, "media");
export const EXPORTS = path.join(DATA, "exports");
const CONFIG = path.join(DATA, "config.json");

for (const d of [DATA, PROJECTS, MEDIA, EXPORTS]) fs.mkdirSync(d, { recursive: true });

export const mediaDir = (id) => path.join(MEDIA, id);

async function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp" + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- projects --------------------------------------------------------------

const projectFile = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("Bad project id");
  return path.join(PROJECTS, id + ".json");
};

// Serialize writes per project so concurrent saves never interleave.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

export async function listProjects() {
  const files = (await fsp.readdir(PROJECTS)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const p = await readJson(path.join(PROJECTS, f));
    if (!p) continue;
    const st = await fsp.stat(path.join(PROJECTS, f));
    out.push({ id: p.id, name: p.name, updatedAt: st.mtimeMs, clips: p.clips.length, media: p.media.length });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id) {
  const p = await readJson(projectFile(id));
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  return p;
}

export async function newProject(name) {
  const p = createProject(name);
  await writeJsonAtomic(projectFile(p.id), p);
  return p;
}

export function saveProject(project) {
  return withLock(project.id, async () => {
    await writeJsonAtomic(projectFile(project.id), project);
    return project;
  });
}

// Read-modify-write under the project lock (used by background jobs that
// update media status while the user keeps editing).
export function updateProject(id, fn) {
  return withLock(id, async () => {
    const p = await getProject(id);
    const next = (await fn(p)) || p;
    await writeJsonAtomic(projectFile(id), next);
    return next;
  });
}

export async function deleteProject(id) {
  await fsp.rm(projectFile(id), { force: true });
}

// ---- config ----------------------------------------------------------------

export async function getConfig() {
  return (await readJson(CONFIG, {})) || {};
}

export async function setConfig(patch) {
  const cfg = { ...(await getConfig()), ...patch };
  for (const k of Object.keys(cfg)) if (cfg[k] === null || cfg[k] === "") delete cfg[k];
  await writeJsonAtomic(CONFIG, cfg);
  try {
    await fsp.chmod(CONFIG, 0o600);
  } catch {}
  return cfg;
}
