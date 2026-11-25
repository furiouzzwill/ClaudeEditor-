// The Claude editing assistant.
//
// Claude never receives the video file. It gets:
//   - the timeline (clips, tracks, markers) as JSON
//   - per-media analysis: scene cuts, silences, transcript (when available)
//   - the same facts mapped onto timeline time, so it doesn't do that math
//   - a few dozen small keyframe images (288p JPEGs)
// and replies with a structured edit plan: a list of timeline operations that
// the editor validates (dry run) and shows to the user before applying.

import fsp from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getConfig, mediaDir } from "./store.js";
import { getAnalysis } from "./media.js";
import { applyOperations, clipEnd, mapSourceIntervals, timelineDuration } from "../shared/timeline.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_IMAGES = 60;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const num = { type: "number" };
const str = { type: "string" };
const opSchema = (name, description, props = {}) => ({
  type: "object",
  description,
  properties: { op: { type: "string", enum: [name] }, ...props },
  required: ["op", ...Object.keys(props)],
  additionalProperties: false,
});
// Structured outputs compile the schema to a grammar, and union types are
// expensive there, so "not set" is expressed with plain defaults ("" / -1 / 0)
// instead of nullable fields. normalizeOp() turns them back into nulls.
const OPERATIONS_SCHEMA = {
  anyOf: [
    opSchema("ripple_delete_ranges", "Remove timeline ranges on all tracks and close the gaps. All ranges refer to the timeline as it is right before this operation; they may be listed in any order.", {
      ranges: { type: "array", items: { type: "object", properties: { start: num, end: num }, required: ["start", "end"], additionalProperties: false } },
    }),
    opSchema("lift_range", "Remove a timeline range but leave a gap (nothing shifts). trackIds [] = all tracks.", {
      start: num, end: num, trackIds: { type: "array", items: str },
    }),
    opSchema("split", "Cut clips at a timeline time. trackId \"\" = all tracks.", { time: num, trackId: str }),
    opSchema("delete_clip", "Delete one clip. ripple=true closes the gap on its track.", { clipId: str, ripple: { type: "boolean" } }),
    opSchema("move_clip", "Move a clip to a new start time, optionally to another track of the same kind (overwrites what is there). trackId \"\" = keep its track.", {
      clipId: str, start: num, trackId: str,
    }),
    opSchema("trim_clip", "Set a clip's source in/out points (source-media seconds). The clip's start stays put.", {
      clipId: str, sourceIn: num, sourceOut: num,
    }),
    opSchema("insert_media", "Place a range of a media file on a track, overwriting what is there. start -1 = append at the end of that track. trackId \"\" = V1 for video, A1 for audio-only media.", {
      mediaId: str, sourceIn: num, sourceOut: num, start: num, trackId: str,
    }),
    opSchema("add_text", "Add a title or caption on the text track. size 0 = default (56 at 1080p). color \"\" = white.", {
      start: num, end: num, text: str,
      position: { type: "string", enum: ["top", "center", "bottom"] },
      size: num, color: str,
    }),
    opSchema("set_clip_volume", "Set a clip's volume (1 = unchanged, 0 = mute, up to 4).", { clipId: str, volume: num }),
    opSchema("set_clip_fit", "fit = letterbox the whole frame; fill = crop to fill the frame (use for vertical reframes).", {
      clipId: str, fit: { type: "string", enum: ["fit", "fill"] },
    }),
    opSchema("set_format", "Change the output frame size (e.g. 1080x1920 for vertical 9:16). 0 keeps a value.", {
      width: num, height: num, fps: num,
    }),
    opSchema("add_marker", "Add a timeline marker, e.g. for chapters or points of interest.", { time: num, label: str }),
    opSchema("clear_timeline", "Remove all clips (trackId \"\") or all clips on one track. Use before rebuilding a timeline from scratch.", {
      trackId: str,
    }),
  ],
};

// Map the schema's "not set" defaults back to null for the timeline engine.
function normalizeOp(o) {
  const out = { ...o };
  for (const k of ["trackId", "color"]) if (out[k] === "") out[k] = null;
  if (Array.isArray(out.trackIds) && out.trackIds.length === 0) out.trackIds = null;
  if (out.op === "insert_media" && (out.start == null || out.start < 0)) out.start = null;
  for (const k of ["size", "width", "height", "fps"]) if (out[k] === 0) out[k] = null;
  if (typeof out.fit === "string") out.fit = out.fit.toLowerCase();
  if (typeof out.position === "string") out.position = out.position.toLowerCase();
  return out;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "Short reply to the user explaining what the plan does, or answering their question." },
    operations: { type: "array", items: OPERATIONS_SCHEMA, description: "Edit operations in the order to apply. Empty if the user only asked a question." },
  },
  required: ["message", "operations"],
  additionalProperties: false,
};

// Runtime validation of what comes back (defense in depth on top of the schema).
const n = z.number().finite();
const PlanZ = z.object({
  message: z.string(),
  operations: z.array(
    z.object({ op: z.string() }).passthrough().superRefine((o, ctx) => {
      const need = {
        ripple_delete_ranges: ["ranges"], lift_range: ["start", "end"], split: ["time"], delete_clip: ["clipId"],
        move_clip: ["clipId", "start"], trim_clip: ["clipId", "sourceIn", "sourceOut"], insert_media: ["mediaId", "sourceIn", "sourceOut"],
        add_text: ["start", "end", "text"], set_clip_volume: ["clipId", "volume"], set_clip_fit: ["clipId", "fit"],
        set_format: [], add_marker: ["time", "label"], clear_timeline: [],
      }[o.op];
      if (!need) return ctx.addIssue({ code: "custom", message: `unknown op ${o.op}` });
      for (const k of need) if (o[k] == null) ctx.addIssue({ code: "custom", message: `${o.op} missing ${k}` });
      for (const k of ["start", "end", "time", "sourceIn", "sourceOut", "volume"]) {
        if (o[k] != null && !n.safeParse(o[k]).success) ctx.addIssue({ code: "custom", message: `${o.op}.${k} must be a number` });
      }
    })
  ),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are the editing assistant inside Claude Editor, a non-linear video editor. You help the user cut, arrange and polish their video by proposing edit plans.

You cannot see or play the video. You see a description of it: the timeline as JSON, per-media analysis (scene cuts, silences, and a transcript when one exists), and sampled keyframe images labeled with their times. Judge visuals from the keyframes; be upfront when a request depends on visual detail the samples can't show.

How the timeline works:
- Times are in seconds. "start"/"end" are timeline positions. "in"/"out" (sourceIn/sourceOut) are positions inside the source media file.
- Tracks: T1 is titles. V2 is drawn above V1. A1/A2 are extra audio. Video clips carry their own audio.
- The context lists silences and transcript lines both in source time and already mapped onto the timeline ("timeline_*" fields). Use the timeline-mapped values for timeline operations.

How to plan:
- Operations run in order, and each one sees the timeline as the previous one left it. Removing material shifts everything after it, so prefer one ripple_delete_ranges with all ranges (they all refer to the same starting timeline) over many separate deletes.
- To build a new cut (highlight reel, short, trailer), clear_timeline then insert_media the chosen source ranges with start null so they append in order.
- When trimming silences, leave about 0.1-0.15s of padding on each side of speech so cuts don't sound clipped, and skip silences shorter than about 0.35s unless asked.
- For vertical 9:16, set_format 1080x1920 and set_clip_fit "fill" on the video clips.
- Use real clip ids and media ids from the context. Don't invent ones that aren't there.
- If the request is a question, or is too ambiguous to act on, answer in "message" with an empty operations list.
- Keep "message" short: what you changed and why, or what you need from the user. Plain text, no markdown headings.`;

function r2(t) {
  return Math.round(t * 100) / 100;
}

async function buildContext(project, { playhead, selectedClipId }) {
  const used = new Set(project.clips.map((c) => c.mediaId).filter(Boolean));
  const ready = project.media.filter((m) => m.status === "ready");

  const timeline = {
    settings: project.settings,
    duration: r2(timelineDuration(project)),
    playhead: playhead != null ? r2(playhead) : null,
    selected_clip: selectedClipId || null,
    tracks: project.tracks.map((t) => ({ id: t.id, kind: t.kind })),
    clips: project.clips
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((c) => ({
        id: c.id,
        track: c.trackId,
        start: r2(c.start),
        end: r2(clipEnd(c)),
        ...(c.mediaId ? { media: c.mediaId, in: r2(c.in), out: r2(c.out) } : {}),
        ...(c.text ? { text: c.text } : {}),
        ...(c.volume != null && c.volume !== 1 ? { volume: c.volume } : {}),
        ...(c.fit && c.fit !== "fit" ? { fit: c.fit } : {}),
      })),
    markers: project.markers.map((m) => ({ time: r2(m.time), label: m.label })),
  };

  const mediaInfo = [];
  const images = [];
  const imageBudget = Math.floor(MAX_IMAGES / Math.max(1, ready.length));
  for (const m of ready) {
    const a = await getAnalysis(m.id);
    const info = {
      id: m.id,
      name: m.name,
      duration: r2(m.duration),
      resolution: m.hasVideo ? `${m.width}x${m.height}` : null,
      fps: m.fps ? r2(m.fps) : null,
      has_audio: m.hasAudio,
      on_timeline: used.has(m.id),
      scene_cuts: (a.scenes || []).map(r2),
      silences: (a.silences || []).map((s) => [r2(s.start), r2(s.end)]),
    };
    if (a.transcript?.segments?.length) {
      info.transcript = a.transcript.segments.map((s) => [r2(s.start), r2(s.end), s.text]);
    }
    if (used.has(m.id)) {
      info.timeline_silences = mapSourceIntervals(project, m.id, a.silences || []).map((s) => [r2(s.start), r2(s.end)]);
      if (a.transcript?.segments?.length) {
        info.timeline_transcript = mapSourceIntervals(project, m.id, a.transcript.segments).map((s) => [r2(s.start), r2(s.end), s.text]);
      }
    }
    mediaInfo.push(info);

    const kfs = a.keyframes || [];
    const step = Math.max(1, kfs.length / Math.max(1, imageBudget));
    for (let i = 0; i < kfs.length && images.length < MAX_IMAGES; i += step) {
      const k = kfs[Math.floor(i)];
      try {
        const data = (await fsp.readFile(path.join(mediaDir(m.id), "keyframes", k.file))).toString("base64");
        images.push({ mediaId: m.id, time: k.time, data });
      } catch {}
    }
  }

  const pending = project.media.filter((m) => m.status !== "ready").map((m) => `${m.name} (${m.status})`);
  return { timeline, mediaInfo, images, pending };
}

function historyMessages(chat) {
  // Prior turns are replayed as plain text (no images, no thinking blocks), so
  // each request is self-contained and cheap.
  const msgs = [];
  for (const turn of (chat || []).slice(-12)) {
    if (turn.role === "user") msgs.push({ role: "user", content: turn.text });
    else if (turn.role === "assistant") {
      const opsNote = turn.operations?.length
        ? `\n\n[Proposed ${turn.operations.length} operation(s): ${[...new Set(turn.operations.map((o) => o.op))].join(", ")}. ${turn.applied ? "The user applied them." : "Not applied."}]`
        : "";
      msgs.push({ role: "assistant", content: turn.text + opsNote });
    }
  }
  // The API needs alternating roles starting with user.
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  if (merged.length && merged[merged.length - 1].role === "user") merged.pop();
  return merged;
}

async function client() {
  const cfg = await getConfig();
  const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  return { anthropic: apiKey ? new Anthropic({ apiKey }) : new Anthropic(), model: cfg.model || DEFAULT_MODEL };
}

export async function aiStatus() {
  const cfg = await getConfig();
  return {
    configured: !!(cfg.apiKey || process.env.ANTHROPIC_API_KEY),
    source: cfg.apiKey ? "settings" : process.env.ANTHROPIC_API_KEY ? "environment" : null,
    model: cfg.model || DEFAULT_MODEL,
  };
}

async function callClaude(anthropic, model, system, messages) {
  const stream = anthropic.beta.messages.stream({
    model,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    // If the primary model declines a request, let the API retry it on a
    // fallback model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    const why = msg.stop_details?.explanation ? ` (${msg.stop_details.explanation})` : "";
    throw Object.assign(new Error(`Claude declined this request${why}.`), { status: 422 });
  }
  if (msg.stop_reason === "max_tokens") {
    throw Object.assign(new Error("Claude's plan was too long and got cut off. Try a narrower request."), { status: 422 });
  }
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = PlanZ.parse(JSON.parse(text));
  } catch (e) {
    throw Object.assign(new Error("Claude returned a plan the editor couldn't read: " + e.message.slice(0, 300)), { status: 502 });
  }
  parsed.operations = parsed.operations.map(normalizeOp);
  return { plan: parsed, raw: text, usage: msg.usage, model: msg.model };
}

export async function planEdit(project, { request, playhead = null, selectedClipId = null }) {
  const { anthropic, model } = await client();
  const ctx = await buildContext(project, { playhead, selectedClipId });

  const content = [];
  content.push({
    type: "text",
    text:
      `<timeline>\n${JSON.stringify(ctx.timeline)}\n</timeline>\n\n` +
      `<media>\n${JSON.stringify(ctx.mediaInfo)}\n</media>` +
      (ctx.pending.length ? `\n\nStill processing (no analysis yet): ${ctx.pending.join(", ")}` : ""),
  });
  if (ctx.images.length) {
    content.push({ type: "text", text: `Keyframes (${ctx.images.length}), each labeled with its media id and source time:` });
    for (const img of ctx.images) {
      const mapped = project.clips
        .filter((c) => c.mediaId === img.mediaId && img.time >= c.in && img.time <= c.out)
        .map((c) => r2(c.start + img.time - c.in));
      content.push({ type: "text", text: `${img.mediaId} @ ${img.time}s${mapped.length ? ` (timeline ${mapped.join(", ")}s)` : " (not on timeline)"}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data } });
    }
  }
  content.push({ type: "text", text: `<request>\n${request}\n</request>` });

  const messages = [...historyMessages(project.chat), { role: "user", content }];
  let result = await callClaude(anthropic, model, SYSTEM, messages);

  // Dry-run the plan. If an operation fails, give Claude one chance to fix it.
  let dry = applyOperations(project, result.plan.operations);
  if (dry.error) {
    const retry = await callClaude(anthropic, model, SYSTEM, [
      ...messages,
      { role: "assistant", content: result.raw },
      { role: "user", content: `That plan failed when the editor dry-ran it: ${dry.error}\nReturn a corrected complete plan.` },
    ]);
    const dry2 = applyOperations(project, retry.plan.operations);
    if (!dry2.error || dry2.applied.length > dry.applied.length) {
      result = retry;
      dry = dry2;
    }
  }

  return {
    message: result.plan.message,
    operations: result.plan.operations,
    model: result.model,
    usage: result.usage,
    preview: {
      error: dry.error,
      durationBefore: timelineDuration(project),
      durationAfter: timelineDuration(dry.project),
      clipsBefore: project.clips.length,
      clipsAfter: dry.project.clips.length,
    },
  };
}

export { buildContext, PLAN_SCHEMA, normalizeOp };
