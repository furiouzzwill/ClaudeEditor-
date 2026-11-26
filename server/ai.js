// The Claude editing assistant.
//
// Claude never receives the video file. It gets:
//   - per-media analysis: scene cuts, silences, loud moments, transcript
//   - keyframe images (432p JPEGs, one every ~2s for short videos)
//   - the timeline (clips, effects, tracks, markers) as JSON, with the media
//     facts mapped onto timeline time so it doesn't do that math
// and replies with a structured edit plan: a list of timeline operations that
// the editor validates (dry run) and shows to the user before applying.
//
// Request layout (for prompt caching): the footage block (analysis + images)
// comes first and only changes when media changes, so follow-up requests
// re-read it from cache. The timeline and the request come last.

import fsp from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getConfig, mediaDir } from "./store.js";
import { getAnalysis } from "./media.js";
import {
  applyOperations, clipEnd, mapSourceIntervals, mapSourcePoint, timelineDuration, speedOf,
  EFFECT_TYPES, SOUND_EFFECTS, withSoundStubs,
} from "../shared/timeline.js";
import { VIDEO_TYPES, videoTypeOf } from "../shared/presets.js";
import { APP_NAME } from "../shared/brand.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
// ~440 tokens per keyframe; a 3-minute video sends ~90 of them.
const MAX_IMAGES = 140;

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
// "Not set" is expressed with plain defaults ("" / -1 / 0) instead of nullable
// fields; normalizeOp() turns them (or omitted fields) back into nulls.
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
    opSchema("add_text", "Add a title or caption on the text track. look \"caption\" = white text on a dark box; \"impact\" = big bold yellow text with a black outline, for hype moments. size 0 and color \"\" = the look's defaults.", {
      start: num, end: num, text: str,
      look: { type: "string", enum: ["caption", "impact"] },
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
    opSchema("add_effect", "Add a visual effect over [start, end) on an effects track. intensity 0..1 (0 = the effect's default).", {
      type: { type: "string", enum: Object.keys(EFFECT_TYPES) },
      start: num, end: num, intensity: num,
    }),
    opSchema("add_sound", "Add a built-in sound effect starting at `time`. volume 1 = normal.", {
      sound: { type: "string", enum: Object.keys(SOUND_EFFECTS) },
      time: num, volume: num,
    }),
    opSchema("slow_motion", "Play the video between start and end at `speed` (0.5 = half speed). Everything after it shifts later.", {
      start: num, end: num, speed: num,
    }),
    opSchema("freeze_frame", "Hold the frame at `time` for `duration` seconds. Everything after it shifts later.", {
      time: num, duration: num,
    }),
    opSchema("set_clip_speed", "Change a whole clip's speed (0.25-4). Later material shifts to stay in sync.", {
      clipId: str, speed: num,
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
  for (const k of ["type", "sound", "look"]) if (typeof out[k] === "string") out[k] = out[k].toLowerCase();
  if (out.op === "add_effect" && !(out.intensity > 0)) out.intensity = null;
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
        add_effect: ["type", "start", "end"], add_sound: ["sound", "time"], slow_motion: ["start", "end", "speed"],
        freeze_frame: ["time", "duration"], set_clip_speed: ["clipId", "speed"],
      }[o.op];
      if (!need) return ctx.addIssue({ code: "custom", message: `unknown op ${o.op}` });
      for (const k of need) if (o[k] == null) ctx.addIssue({ code: "custom", message: `${o.op} missing ${k}` });
      for (const k of ["start", "end", "time", "sourceIn", "sourceOut", "volume", "speed", "duration", "intensity"]) {
        if (o[k] != null && !n.safeParse(o[k]).success) ctx.addIssue({ code: "custom", message: `${o.op}.${k} must be a number` });
      }
    })
  ),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are the editing assistant inside ${APP_NAME}, a non-linear video editor. You help the user cut, arrange and polish their videos, and add fun effects, by proposing edit plans.

You cannot play the video. You see a description of it: per-media analysis (scene cuts, silences, loud moments, and a transcript when one exists), keyframe images labeled with their source time, and the timeline as JSON. Judge visuals from the keyframes, and be upfront when something depends on detail the samples can't show.

How the timeline works:
- Times are in seconds. "start"/"end" are timeline positions. "in"/"out" (sourceIn/sourceOut) are positions inside the source media file.
- Tracks: FX1/FX2 hold effects, T1 holds titles, V2 is drawn above V1, A1/A2 are extra audio (sound effects go here). Video clips carry their own audio.
- The <timeline> block maps media facts onto the timeline for you ("timeline_*" fields and keyframe positions). Use those values for timeline operations.

How to plan:
- Operations run in order, and each one sees the timeline as the previous one left it.
- Removing material shifts everything after it, so prefer one ripple_delete_ranges with all ranges (they all refer to the same starting timeline).
- slow_motion, freeze_frame and set_clip_speed also shift everything after them, including effects, titles and sounds you've already placed. Put these timing changes at the END of the plan, ordered from the latest time to the earliest, so the times in every other operation can refer to the timeline as it is now.
- To build a new cut (highlight reel, short), clear_timeline then insert_media the chosen source ranges with start -1 so they append in order.
- When trimming silences, leave about 0.1-0.15s of padding around speech, and skip silences shorter than about 0.35s unless asked.
- For vertical 9:16, set_format 1080x1920 and set_clip_fit "fill" on the video clips.
- Use real clip ids and media ids from the context.
- If the request is a question, or is too ambiguous to act on, answer in "message" with an empty operations list.
- Keep "message" short: what you changed and why, or what you need. Plain text, no markdown headings.

Effects toolkit:
- Visual effects (add_effect): zoom punch-in, shake, flash, rainbow (holographic shimmer), blur (hide something), black_white and spotlight (drama). Sounds (add_sound): whoosh and pop for transitions, riser and drumroll for build-up, sparkle and ka-ching for reveals, boom and air horn for big impacts. Timing: slow_motion and freeze_frame. Titles: "caption" look for information, "impact" look for hype.
- Time effects to the moment itself: start a build-up sound before it, and put the flash and sound exactly on it.
- Restraint makes edits feel good: emphasize the few moments that matter, vary the effects, and leave ordinary footage clean. If you can't tell which moments matter, say what you see and ask.`;

function r2(t) {
  return Math.round(t * 100) / 100;
}

async function buildContext(project, { playhead, selectedClipId }) {
  const used = new Set(project.clips.map((c) => c.mediaId).filter(Boolean));
  // Sound effects are listed by name in the schema; their analysis isn't useful.
  const ready = project.media.filter((m) => m.status === "ready" && !m.sfx);
  const analyses = new Map();
  for (const m of ready) analyses.set(m.id, await getAnalysis(m.id));

  // ---- stable footage block (cacheable) ----
  const footage = [];
  const images = [];
  const totalDur = ready.reduce((a, m) => a + (m.hasVideo ? m.duration : 0), 0) || 1;
  for (const m of ready) {
    const a = analyses.get(m.id);
    const info = {
      id: m.id,
      name: m.name,
      duration: r2(m.duration),
      resolution: m.hasVideo ? `${m.width}x${m.height}` : null,
      fps: m.fps ? r2(m.fps) : null,
      has_audio: m.hasAudio,
      scene_cuts: (a.scenes || []).map(r2),
      silences: (a.silences || []).map((s) => [r2(s.start), r2(s.end)]),
      loud_moments: (a.loud || []).map((l) => [r2(l.start), r2(l.end), l.level]),
    };
    if (a.transcript?.segments?.length) info.transcript = a.transcript.segments.map((s) => [r2(s.start), r2(s.end), s.text]);
    footage.push(info);

    const kfs = a.keyframes || [];
    const budget = Math.max(4, Math.floor((MAX_IMAGES * (m.hasVideo ? m.duration : 0)) / totalDur));
    const step = Math.max(1, kfs.length / budget);
    for (let i = 0; i < kfs.length && images.length < MAX_IMAGES; i += step) {
      const k = kfs[Math.floor(i)];
      try {
        const data = (await fsp.readFile(path.join(mediaDir(m.id), "keyframes", k.file))).toString("base64");
        images.push({ mediaId: m.id, time: k.time, data });
      } catch {}
    }
  }

  // ---- dynamic timeline block ----
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
        ...(c.mediaId && !c.hold ? { media: c.mediaId, in: r2(c.in), out: r2(c.out) } : {}),
        ...(c.hold ? { freeze_frame_of: c.mediaId, at: r2(c.holdAt) } : {}),
        ...(speedOf(c) !== 1 ? { speed: speedOf(c) } : {}),
        ...(c.text ? { text: c.text } : {}),
        ...(c.effect ? { effect: c.effect.type, intensity: c.effect.intensity } : {}),
        ...(c.mediaId && project.media.find((m) => m.id === c.mediaId)?.sfx ? { sound: project.media.find((m) => m.id === c.mediaId).sfx } : {}),
        ...(c.volume != null && c.volume !== 1 && !c.effect && !c.text ? { volume: c.volume } : {}),
        ...(c.fit && c.fit !== "fit" && !c.effect && !c.text ? { fit: c.fit } : {}),
      })),
    markers: project.markers.map((m) => ({ time: r2(m.time), label: m.label })),
    media_on_timeline: [],
  };
  for (const m of ready) {
    if (!used.has(m.id)) continue;
    const a = analyses.get(m.id);
    const mapped = { media: m.id };
    mapped.timeline_silences = mapSourceIntervals(project, m.id, a.silences || []).map((s) => [r2(s.start), r2(s.end)]);
    mapped.timeline_loud_moments = mapSourceIntervals(project, m.id, a.loud || []).map((s) => [r2(s.start), r2(s.end), s.level]);
    if (a.transcript?.segments?.length) {
      mapped.timeline_transcript = mapSourceIntervals(project, m.id, a.transcript.segments).map((s) => [r2(s.start), r2(s.end), s.text]);
    }
    mapped.keyframes_on_timeline = images
      .filter((img) => img.mediaId === m.id)
      .map((img) => [img.time, mapSourcePoint(project, m.id, img.time).map(r2)])
      .filter(([, ts]) => ts.length)
      .map(([src, ts]) => [src, ts.length === 1 ? ts[0] : ts]);
    timeline.media_on_timeline.push(mapped);
  }

  const pending = project.media.filter((m) => m.status !== "ready" && !m.sfx).map((m) => `${m.name} (${m.status})`);
  return { footage, images, timeline, pending };
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

// The plan comes back as a call to this tool. A tool (not strict, not
// output_config.format) is used on purpose: those modes compile the schema
// into a grammar, and an 18-operation plan schema is over the API's grammar
// size limit. The editor validates and dry-runs every plan itself instead.
const PLAN_TOOL = {
  name: "propose_edit_plan",
  description:
    "Propose an edit plan for the user to review. Always call this tool to reply, including for questions (answer in `message` with an empty `operations` list).",
  input_schema: PLAN_SCHEMA,
  // Stream the (possibly long) operations list as it is generated.
  eager_input_streaming: true,
};

// Returns { plan, invalid, content, toolUseId, usage, model }. `invalid` is set
// when Claude's tool input didn't validate (it gets a chance to fix it).
async function callClaude(anthropic, model, system, messages) {
  const stream = anthropic.beta.messages.stream({
    model,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [PLAN_TOOL],
    tool_choice: { type: "auto" },
    // If the primary model declines a request, let the API retry it on a
    // fallback model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Base instructions are cached; the video-type guidance follows them.
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: system + "\n\nReply by calling the propose_edit_plan tool." },
    ],
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
  const base = { content: msg.content, usage: msg.usage, model: msg.model };
  const call = msg.content.find((b) => b.type === "tool_use" && b.name === PLAN_TOOL.name);
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!call) {
    // Plain-text reply (e.g. a question answered without calling the tool).
    return { ...base, plan: { message: text || "(no reply)", operations: [] }, invalid: null, toolUseId: null };
  }
  const parsed = PlanZ.safeParse(call.input);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ...base, plan: null, invalid: why || "invalid plan", toolUseId: call.id };
  }
  const plan = { message: parsed.data.message || text, operations: parsed.data.operations.map(normalizeOp) };
  return { ...base, plan, invalid: null, toolUseId: call.id };
}

export async function planEdit(project, { request, playhead = null, selectedClipId = null }) {
  const { anthropic, model } = await client();
  const type = VIDEO_TYPES[videoTypeOf(project)];
  const typeGuidance = `Video type: ${type.label}.\n${type.guidance}`;
  const ctx = await buildContext(project, { playhead, selectedClipId });

  // Footage block first: unchanged between requests unless media changes, so
  // it is cached (the breakpoint is on its last block).
  const footage = [{ type: "text", text: `<footage>\n${JSON.stringify(ctx.footage)}\n</footage>\nKeyframes (${ctx.images.length}), each labeled "media id @ source seconds":` }];
  for (const img of ctx.images) {
    footage.push({ type: "text", text: `${img.mediaId} @ ${img.time}s` });
    footage.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data } });
  }
  footage[footage.length - 1].cache_control = { type: "ephemeral" };

  const content = [
    {
      type: "text",
      text:
        `<timeline>\n${JSON.stringify(ctx.timeline)}\n</timeline>` +
        (ctx.pending.length ? `\n\nStill processing (no analysis yet): ${ctx.pending.join(", ")}` : "") +
        `\n\n<request>\n${request}\n</request>`,
    },
  ];

  const messages = [
    { role: "user", content: footage },
    { role: "assistant", content: "I've reviewed the footage analysis and keyframes. What would you like to do?" },
    ...historyMessages(project.chat),
    { role: "user", content },
  ];
  let result = await callClaude(anthropic, model, typeGuidance, messages);

  // Validate and dry-run the plan. If it doesn't parse or an operation fails,
  // tell Claude what went wrong (as the tool's result) and let it fix it once.
  const dryRun = (ops) => applyOperations(withSoundStubs(project, ops), ops);
  let dry = result.plan ? dryRun(result.plan.operations) : null;
  const problem = result.invalid
    ? `The plan didn't match the tool's schema: ${result.invalid}`
    : dry.error
      ? `That plan failed when the editor dry-ran it: ${dry.error}`
      : null;
  if (problem && result.toolUseId) {
    const retry = await callClaude(anthropic, model, typeGuidance, [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: result.toolUseId, is_error: true, content: `${problem}\nCall propose_edit_plan again with a corrected complete plan.` }],
      },
    ]);
    if (retry.plan) {
      const dry2 = dryRun(retry.plan.operations);
      if (!result.plan || !dry2.error || dry2.applied.length > dry.applied.length) {
        result = retry;
        dry = dry2;
      }
    }
  }
  if (!result.plan) {
    throw Object.assign(new Error("Claude's plan couldn't be read, even after a retry: " + result.invalid), { status: 502 });
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
