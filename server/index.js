import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { registerMedia, queuePrepare, removeMediaFiles, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, whisperAvailable, queueTranscribe } from "./media.js";
import { listJobs, cancelJob, createJob, getJob } from "./jobs.js";
import { renderProject, QUALITY } from "./render.js";
import { planEdit, aiStatus, DEFAULT_MODEL } from "./ai.js";
import { run, FFMPEG } from "./ffmpeg.js";
import { uid, SOUND_EFFECTS } from "../shared/timeline.js";
import { sfxFile } from "./sfx.js";
import { APP_NAME } from "../shared/brand.js";

const PORT = Number(process.env.PORT || 5317);
const HOST = process.env.HOST || "127.0.0.1";
const app = express();

// This server can read files on your machine, so it only answers requests
// addressed to localhost (blocks DNS-rebinding tricks from other websites).
app.use((req, res, next) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (HOST === "127.0.0.1" && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    return res.status(403).send("Forbidden host");
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use("/shared", express.static(path.join(store.ROOT, "shared")));
app.use(express.static(path.join(store.ROOT, "public")));

// ---- projects ---------------------------------------------------------------

app.get("/api/projects", wrap(async (req, res) => res.json(await store.listProjects())));

app.post("/api/projects", express.json(), wrap(async (req, res) => {
  res.json(await store.newProject(req.body?.name || "Untitled Project"));
}));

app.get("/api/projects/:id", wrap(async (req, res) => res.json(await store.getProject(req.params.id))));

// The client owns the edit (clips, tracks, markers, settings, chat). The media
// list is owned by the server, because background jobs keep updating it.
app.put("/api/projects/:id", express.json({ limit: "50mb" }), wrap(async (req, res) => {
  const body = req.body;
  const saved = await store.updateProject(req.params.id, (p) => {
    for (const k of ["name", "settings", "tracks", "clips", "markers", "chat"]) if (body[k] !== undefined) p[k] = body[k];
    p.version = (p.version || 0) + 1;
  });
  res.json({ ok: true, version: saved.version, media: saved.media });
}));

app.delete("/api/projects/:id", wrap(async (req, res) => {
  const p = await store.getProject(req.params.id);
  for (const m of p.media) await removeMediaFiles(m);
  await store.deleteProject(p.id);
  res.json({ ok: true });
}));

// ---- media import -------------------------------------------------------------

// Import by path: nothing is copied, so a 100 GB file imports instantly.
app.post("/api/projects/:id/import", express.json(), wrap(async (req, res) => {
  const files = [].concat(req.body?.path || req.body?.paths || []);
  const out = [];
  for (const f of files) {
    const abs = path.resolve(String(f).replace(/^~(?=$|\/|\\)/, os.homedir()));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw Object.assign(new Error(`Not a file: ${abs}`), { status: 400 });
    out.push(await registerMedia(req.params.id, { filePath: abs, name: path.basename(abs) }));
  }
  res.json(out);
}));

// Upload: the request body is streamed straight to disk (no size limit, no
// buffering in memory). Used when the browser can't give us a path.
app.put("/api/projects/:id/upload", wrap(async (req, res) => {
  await store.getProject(req.params.id);
  const name = path.basename(String(req.query.name || "upload.mp4"));
  if (!VIDEO_EXT.test(name) && !AUDIO_EXT.test(name) && !IMAGE_EXT.test(name)) throw Object.assign(new Error("Unsupported file type"), { status: 400 });
  const mediaId = uid("m");
  const dir = store.mediaDir(mediaId);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, "source" + path.extname(name).toLowerCase());
  try {
    await pipeline(req, fs.createWriteStream(dest));
    res.json(await registerMedia(req.params.id, { filePath: dest, name, mediaId }));
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
}));

// Add a built-in sound effect to the project's media (once per project).
app.post("/api/projects/:id/sfx", express.json(), wrap(async (req, res) => {
  const sound = String(req.body?.sound || "").toLowerCase();
  if (!SOUND_EFFECTS[sound]) throw Object.assign(new Error(`Unknown sound effect: ${sound}`), { status: 400 });
  const p = await store.getProject(req.params.id);
  const existing = p.media.find((m) => m.sfx === sound);
  if (existing) return res.json(existing);
  const file = await sfxFile(sound);
  res.json(await registerMedia(p.id, { filePath: file, name: `SFX · ${SOUND_EFFECTS[sound].label}`, extra: { sfx: sound } }));
}));
app.get("/api/sfx", (req, res) => res.json(SOUND_EFFECTS));

app.delete("/api/projects/:id/media/:mid", wrap(async (req, res) => {
  let removed = null;
  await store.updateProject(req.params.id, (p) => {
    removed = p.media.find((m) => m.id === req.params.mid);
    p.media = p.media.filter((m) => m.id !== req.params.mid);
    p.clips = p.clips.filter((c) => c.mediaId !== req.params.mid);
  });
  if (removed) {
    for (const j of listJobs()) if (j.refId === removed.id) cancelJob(j.id);
    await removeMediaFiles(removed);
  }
  res.json({ ok: true });
}));

app.post("/api/projects/:id/media/:mid/reprocess", wrap(async (req, res) => {
  const p = await store.getProject(req.params.id);
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) throw Object.assign(new Error("Media not found"), { status: 404 });
  await store.updateProject(p.id, (pp) => Object.assign(pp.media.find((x) => x.id === m.id), { status: "processing", progress: 0, error: null }));
  res.json(queuePrepare(p.id, m));
}));

app.post("/api/projects/:id/media/:mid/transcribe", wrap(async (req, res) => {
  if (!whisperAvailable()) throw Object.assign(new Error("Whisper isn't installed. On a Mac run: brew install openai-whisper (or: pip install -U openai-whisper), then try again."), { status: 400 });
  const p = await store.getProject(req.params.id);
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) throw Object.assign(new Error("Media not found"), { status: 404 });
  res.json(queueTranscribe(p.id, m));
}));

// A small file browser for import-by-path.
app.get("/api/fs", wrap(async (req, res) => {
  const dir = path.resolve(String(req.query.dir || os.homedir()).replace(/^~(?=$|\/|\\)/, os.homedir()));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) items.push({ name: e.name, type: "dir" });
    else if (e.isFile() && (VIDEO_EXT.test(e.name) || AUDIO_EXT.test(e.name) || IMAGE_EXT.test(e.name))) {
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      items.push({ name: e.name, type: "file", size: st?.size ?? 0 });
    }
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  res.json({ dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, items, home: os.homedir() });
}));

// ---- derived media files (proxies support HTTP range requests for seeking) ----

const safeId = (id) => (/^[\w-]+$/.test(id) ? id : null);
app.get("/media/:mid/proxy", (req, res) => {
  const id = safeId(req.params.mid);
  if (!id) return res.sendStatus(400);
  const dir = store.mediaDir(id);
  const f = ["proxy.mp4", "proxy.m4a"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!f) return res.sendStatus(404);
  res.sendFile(f, { maxAge: 0 });
});
app.get("/media/:mid/thumbs/:file", (req, res) => {
  const id = safeId(req.params.mid);
  if (!id || !/^\d{4}\.jpg$/.test(req.params.file)) return res.sendStatus(400);
  res.sendFile(path.join(store.mediaDir(id), "thumbs", req.params.file), { maxAge: "1h" }, (e) => e && res.sendStatus(404));
});
app.get("/media/:mid/image", (req, res) => {
  const id = safeId(req.params.mid);
  if (!id) return res.sendStatus(400);
  res.sendFile(path.join(store.mediaDir(id), "image.png"), { maxAge: 0 }, (e) => e && res.sendStatus(404));
});
app.get("/media/:mid/waveform", (req, res) => {
  const id = safeId(req.params.mid);
  if (!id) return res.sendStatus(400);
  res.sendFile(path.join(store.mediaDir(id), "waveform.json"), (e) => e && res.status(404).json(null));
});

// ---- jobs ----------------------------------------------------------------------

app.get("/api/jobs", (req, res) => res.json(listJobs()));
app.delete("/api/jobs/:id", (req, res) => res.json({ ok: cancelJob(req.params.id) }));

// ---- export ----------------------------------------------------------------------

app.post("/api/projects/:id/export", express.json(), wrap(async (req, res) => {
  const p = await store.getProject(req.params.id);
  const quality = QUALITY[req.body?.quality] ? req.body.quality : "standard";
  const notReady = p.clips.map((c) => p.media.find((m) => m.id === c.mediaId)).filter((m) => m && m.status === "error");
  if (notReady.length) throw Object.assign(new Error(`Some media failed to process: ${notReady[0].name}`), { status: 400 });
  const job = createJob("export", `Exporting ${p.name} (${quality})`, async (ctx) => {
    const file = await renderProject(p, { quality, fileName: req.body?.fileName, onProgress: ctx.progress, signal: ctx.signal });
    const st = await fsp.stat(file);
    return { file: path.basename(file), size: st.size };
  }, { refId: p.id });
  res.json(job);
}));

app.get("/api/exports", wrap(async (req, res) => {
  const files = (await fsp.readdir(store.EXPORTS)).filter((f) => f.endsWith(".mp4"));
  const out = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(store.EXPORTS, f));
    out.push({ file: f, size: st.size, createdAt: st.mtimeMs });
  }
  res.json(out.sort((a, b) => b.createdAt - a.createdAt));
}));
app.get("/exports/:file", (req, res) => {
  const f = path.basename(req.params.file);
  const full = path.join(store.EXPORTS, f);
  if (!f.endsWith(".mp4") || !fs.existsSync(full)) return res.sendStatus(404);
  if (req.query.download) res.download(full);
  else res.sendFile(full);
});

// ---- Claude ------------------------------------------------------------------------

app.post("/api/projects/:id/ai", express.json({ limit: "50mb" }), wrap(async (req, res) => {
  const p = await store.getProject(req.params.id);
  const request = String(req.body?.request || "").trim();
  if (!request) throw Object.assign(new Error("Empty request"), { status: 400 });
  // Plan against the client's current edit if provided (it may be unsaved).
  if (req.body.project) for (const k of ["clips", "tracks", "markers", "settings", "chat"]) if (req.body.project[k]) p[k] = req.body.project[k];
  res.json(await planEdit(p, { request, playhead: req.body.playhead, selectedClipId: req.body.selectedClipId }));
}));

// ---- settings & system ---------------------------------------------------------------

app.get("/api/settings", wrap(async (req, res) => {
  const cfg = await store.getConfig();
  res.json({
    model: cfg.model || DEFAULT_MODEL,
    apiKeySet: !!cfg.apiKey,
    apiKeyHint: cfg.apiKey ? "…" + cfg.apiKey.slice(-4) : null,
    envKey: !!process.env.ANTHROPIC_API_KEY,
  });
}));
app.post("/api/settings", express.json(), wrap(async (req, res) => {
  const patch = {};
  if (req.body.apiKey !== undefined) patch.apiKey = String(req.body.apiKey).trim() || null;
  if (req.body.model !== undefined) patch.model = String(req.body.model).trim() || null;
  await store.setConfig(patch);
  res.json({ ok: true });
}));

let ffmpegVersion = null;
app.get("/api/system", wrap(async (req, res) => {
  if (ffmpegVersion === null) {
    ffmpegVersion = await run(FFMPEG, ["-version"]).then((r) => r.stdout.split("\n")[0]).catch(() => "");
  }
  res.json({ ffmpeg: ffmpegVersion || null, whisper: whisperAvailable(), ai: await aiStatus(), dataDir: store.DATA });
}));

// ---- errors ------------------------------------------------------------------------------

app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || "Server error";
  if (err instanceof Anthropic.AuthenticationError) {
    status = 401;
    message = "Your Anthropic API key was rejected. Check it in Settings.";
  } else if (err instanceof Anthropic.RateLimitError) {
    status = 429;
    message = "Rate limited by the Anthropic API. Wait a moment and try again.";
  } else if (err instanceof Anthropic.APIError) {
    status = err.status || 502;
    message = `Anthropic API error: ${err.message}`;
  } else if (err.code === "ENOENT") {
    status = 404;
  } else if (/Could not resolve authentication method/i.test(message)) {
    status = 401;
    message = "No Anthropic API key configured. Add one in Settings.";
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Resume media that was mid-processing when the server last stopped.
async function resumeInterrupted() {
  for (const { id } of await store.listProjects()) {
    const p = await store.getProject(id);
    for (const m of p.media) if (m.status === "processing") queuePrepare(p.id, m);
  }
}

app.listen(PORT, HOST, () => {
  console.log(`\n  ${APP_NAME} running at http://localhost:${PORT}\n  Data folder: ${store.DATA}\n`);
  resumeInterrupted().catch((e) => console.error("resume failed:", e.message));
});
