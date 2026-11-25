// A tiny in-process job queue. Heavy work (proxies, analysis, renders) runs
// here so HTTP requests return immediately; the UI polls /api/jobs.

import { EventEmitter } from "node:events";

const jobs = new Map();
const queue = [];
let running = 0;
const MAX_CONCURRENT = Number(process.env.MAX_JOBS || 2);

export const jobEvents = new EventEmitter();

export function createJob(kind, label, fn, { refId = null } = {}) {
  const job = {
    id: "j_" + Math.random().toString(36).slice(2, 10),
    kind,
    label,
    refId,
    status: "queued",
    progress: 0,
    message: "",
    error: null,
    result: null,
    createdAt: Date.now(),
    controller: new AbortController(),
    fn,
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.status === "cancelled") continue;
    running++;
    job.status = "running";
    emit(job);
    const ctx = {
      signal: job.controller.signal,
      progress: (p, message) => {
        job.progress = Math.max(0, Math.min(1, p));
        if (message !== undefined) job.message = message;
        emit(job);
      },
    };
    Promise.resolve()
      .then(() => job.fn(ctx))
      .then((result) => {
        job.status = "done";
        job.progress = 1;
        job.result = result ?? null;
      })
      .catch((err) => {
        job.status = job.controller.signal.aborted ? "cancelled" : "error";
        job.error = err.message;
        console.error(`[job ${job.kind}] ${job.label}:`, err.message);
      })
      .finally(() => {
        running--;
        emit(job);
        pump();
      });
  }
}

function emit(job) {
  jobEvents.emit("update", publicJob(job));
}

export function publicJob(j) {
  const { fn, controller, ...rest } = j;
  return rest;
}

export function listJobs() {
  // Drop finished jobs older than 10 minutes.
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (["done", "error", "cancelled"].includes(j.status) && j.createdAt < cutoff) jobs.delete(id);
  }
  return [...jobs.values()].map(publicJob);
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === "queued") j.status = "cancelled";
  j.controller.abort();
  emit(j);
  return true;
}
