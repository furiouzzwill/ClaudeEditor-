import { store } from "./state.js";
import { api } from "./api.js";
import { h, toast } from "./ui.js";
import { applyOperations, timelineDuration, withSoundStubs, EFFECT_TYPES, SOUND_EFFECTS, GRAPHICS } from "/shared/timeline.js";
import { ensureSounds } from "./sounds.js";
import { VIDEO_TYPES, videoTypeOf } from "/shared/presets.js";
import { openSettings } from "./dialogs.js";

const chatEl = document.getElementById("chat");
const chipsEl = document.getElementById("chips");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");
const sendBtn = document.getElementById("btnSend");

let busy = false;
let aiConfigured = true;

const typeSelect = document.getElementById("videoType");
for (const [id, t] of Object.entries(VIDEO_TYPES)) typeSelect.append(h("option", { value: id }, t.label));
typeSelect.addEventListener("change", () => {
  store.commit({ ...store.project, settings: { ...store.project.settings, videoType: typeSelect.value } });
});

// Quick actions come from the project's video type.
let chipsType = null;
function renderChips() {
  const type = videoTypeOf(store.project);
  chipsType = type;
  typeSelect.value = type;
  chipsEl.innerHTML = "";
  for (const [label, prompt] of VIDEO_TYPES[type].chips) {
    chipsEl.append(h("button", { class: "chip", type: "button", title: prompt, onclick: () => send(prompt) }, label));
  }
}

function describeOp(o) {
  const t = (x) => (x == null ? "" : `${Number(x).toFixed(2)}s`);
  switch (o.op) {
    case "ripple_delete_ranges": {
      const total = (o.ranges || []).reduce((a, r) => a + Math.max(0, r.end - r.start), 0);
      return `Remove ${o.ranges.length} range${o.ranges.length === 1 ? "" : "s"} (${total.toFixed(1)}s total) and close gaps`;
    }
    case "lift_range": return `Lift ${t(o.start)}–${t(o.end)}, leaving a gap`;
    case "split": return `Split at ${t(o.time)}${o.trackId ? ` on ${o.trackId}` : ""}`;
    case "delete_clip": return `${o.ripple ? "Ripple delete" : "Delete"} clip ${o.clipId}`;
    case "move_clip": return `Move ${o.clipId} to ${t(o.start)}${o.trackId ? ` on ${o.trackId}` : ""}`;
    case "trim_clip": return `Trim ${o.clipId} to source ${t(o.sourceIn)}–${t(o.sourceOut)}`;
    case "insert_media": {
      const m = store.project.media.find((x) => x.id === o.mediaId);
      return `Insert ${m?.name || o.mediaId} ${t(o.sourceIn)}–${t(o.sourceOut)} ${o.start == null ? "at end" : `at ${t(o.start)}`}${o.trackId ? ` on ${o.trackId}` : ""}`;
    }
    case "add_text": return `${o.look === "impact" ? "💥 Impact title" : "Title"} “${o.text}” ${t(o.start)}–${t(o.end)}`;
    case "set_clip_volume": return `Set ${o.clipId} volume to ${Math.round(o.volume * 100)}%`;
    case "set_clip_fit": return `Set ${o.clipId} framing to ${o.fit}`;
    case "set_format": return `Change format to ${o.width ?? "same"}×${o.height ?? "same"}${o.fps ? ` @ ${o.fps}fps` : ""}`;
    case "add_marker": return `Marker at ${t(o.time)}: ${o.label}`;
    case "clear_timeline": return o.trackId ? `Clear track ${o.trackId}` : "Clear the timeline";
    case "add_effect": return `✨ ${EFFECT_TYPES[o.type]?.label || o.type} ${t(o.start)}–${t(o.end)}${o.intensity ? ` (${Math.round(o.intensity * 100)}%)` : ""}`;
    case "add_sound": return `🔊 ${SOUND_EFFECTS[o.sound]?.label || o.sound} at ${t(o.time)}`;
    case "slow_motion": return `🐢 Slow motion ${o.speed}× ${t(o.start)}–${t(o.end)}`;
    case "freeze_frame": return `❄ Freeze frame at ${t(o.time)} for ${t(o.duration)}`;
    case "set_clip_speed": return `Set ${o.clipId} speed to ${o.speed}×`;
    case "update_graphic": return `🎬 Update animation ${o.spec?.name ? `“${o.spec.name}”` : o.clipId}`;
    case "add_graphic": {
      if (o.template === "custom") return `✨ New animation “${o.spec?.name || "Custom"}” ${o.start == null || o.start < 0 ? "at the end" : `at ${t(o.start)}`} (${o.spec?.layers?.length || 0} layers)`;
      const g = GRAPHICS[o.template];
      const text = o.props?.headline || o.props?.title || o.props?.name || o.props?.text || "";
      return `🎬 ${g?.label || o.template}${text ? ` “${text}”` : ""} ${o.start == null || o.start < 0 ? "at the end" : `at ${t(o.start)}`}`;
    }
    default: return o.op;
  }
}

function render() {
  const chat = store.project?.chat || [];
  chatEl.innerHTML = "";
  if (!aiConfigured) {
    chatEl.append(
      h("div", { class: "msg system" },
        "Add your Anthropic API key to start editing with Claude. ",
        h("button", { class: "btn", style: { marginTop: "8px" }, onclick: openSettings }, "Open settings")
      )
    );
  } else if (!chat.length) {
    chatEl.append(
      h("div", { class: "msg system" },
        "Ask Claude to edit your timeline, or pick a quick action below. Set the video type above so its suggestions fit your content. ",
        "Claude sees scene cuts, silences, loud moments, transcripts (if Whisper is installed) and keyframes, never the video file itself. ",
        "Every plan is shown to you before it's applied."
      )
    );
  }
  chat.forEach((turn, i) => {
    if (turn.role === "user") return chatEl.append(h("div", { class: "msg user" }, turn.text));
    if (turn.role === "error") return chatEl.append(h("div", { class: "msg assistant error" }, turn.text));
    const el = h("div", { class: "msg assistant" }, turn.text);
    if (turn.operations?.length) {
      const ops = turn.operations;
      const stats = turn.preview
        ? `${ops.length} operation${ops.length === 1 ? "" : "s"} · duration ${turn.preview.durationBefore.toFixed(1)}s → ${turn.preview.durationAfter.toFixed(1)}s · clips ${turn.preview.clipsBefore} → ${turn.preview.clipsAfter}`
        : `${ops.length} operations`;
      el.append(
        h("div", { class: "plan" },
          h("div", { class: "plan-stats" }, stats),
          turn.preview?.error ? h("div", { class: "warn" }, `⚠ ${turn.preview.error}. Operations before it can still be applied.`) : null,
          h("ol", {}, ops.map((o) => h("li", {}, describeOp(o)))),
          turn.applied
            ? h("div", { class: "status" }, "✓ Applied. Undo with Ctrl/Cmd+Z.")
            : turn.discarded
              ? h("div", { class: "muted small" }, "Discarded")
              : h("div", { class: "actions" },
                  h("button", { class: "btn primary", onclick: () => apply(i) }, "Apply"),
                  h("button", { class: "btn ghost", onclick: () => update(i, { discarded: true }) }, "Discard")
                )
        )
      );
    }
    chatEl.append(el);
  });
  if (busy) chatEl.append(h("div", { class: "msg assistant" }, h("span", { class: "thinking" }, h("i"), h("i"), h("i")), "  Claude is planning the edit…"));
  chatEl.scrollTop = chatEl.scrollHeight;
  sendBtn.disabled = busy || !aiConfigured;
}

function update(i, fields) {
  const chat = store.project.chat.slice();
  chat[i] = { ...chat[i], ...fields };
  store.setChat(chat);
  render();
}

async function apply(i) {
  const turn = store.project.chat[i];
  try {
    await ensureSounds(turn.operations.filter((o) => o.op === "add_sound").map((o) => o.sound));
  } catch (e) {
    toast("Couldn't add sound effects: " + e.message, { error: true });
  }
  const res = store.applyOps(turn.operations);
  if (res.error) toast(res.error, { error: true });
  update(i, { applied: res.applied.length > 0 });
  if (res.applied.length) toast(`Applied ${res.applied.length} operation${res.applied.length === 1 ? "" : "s"}`);
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  input.value = "";
  const history = store.project.chat.slice();
  store.setChat([...history, { role: "user", text, at: Date.now() }]);
  render();
  try {
    const res = await api.post(`/api/projects/${store.project.id}/ai`, {
      request: text,
      playhead: store.playhead,
      selectedClipId: [...store.selection][0] || null,
      // Plan against exactly what's on screen (it may not be saved yet).
      project: { clips: store.project.clips, tracks: store.project.tracks, markers: store.project.markers, settings: store.project.settings, chat: history },
    });
    // Re-check against the timeline as it is now (the user may have edited meanwhile).
    const dry = applyOperations(withSoundStubs(store.project, res.operations), res.operations);
    store.setChat([
      ...store.project.chat,
      {
        role: "assistant",
        text: res.message,
        operations: res.operations,
        preview: { ...res.preview, error: dry.error, durationAfter: timelineDuration(dry.project), clipsAfter: dry.project.clips.length, durationBefore: store.duration, clipsBefore: store.project.clips.length },
        at: Date.now(),
      },
    ]);
  } catch (e) {
    store.setChat([...store.project.chat, { role: "error", text: e.message, at: Date.now() }]);
  } finally {
    busy = false;
    render();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});

store.on("project", renderChips);
store.on("change", () => store.project && chipsType !== videoTypeOf(store.project) && renderChips());

async function checkStatus() {
  try {
    const sys = await api.get("/api/system");
    aiConfigured = sys.ai.configured;
  } catch {}
  render();
}
document.addEventListener("ai-status", checkStatus);
store.on("project", checkStatus);
