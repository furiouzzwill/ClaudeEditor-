import { store } from "./state.js";
import { api } from "./api.js";

// Make sure the built-in sound effects are imported into this project
// (synthesized and added as media the first time each one is used).
export async function ensureSounds(names) {
  const missing = [...new Set(names.map((n) => String(n).toLowerCase()))].filter((n) => !store.project.media.some((m) => m.sfx === n));
  if (!missing.length) return;
  for (const sound of missing) await api.post(`/api/projects/${store.project.id}/sfx`, { sound });
  await store.refreshMedia();
}
