import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../shared/timeline.js";

function project() {
  let p = T.createProject("t");
  p.settings.fps = 30;
  p.media.push({ id: "m1", name: "a.mp4", duration: 20, hasVideo: true, hasAudio: true });
  p.media.push({ id: "m2", name: "b.wav", duration: 10, hasVideo: false, hasAudio: true });
  p = T.appendMedia(p, "m1");
  return p;
}
const spans = (p, track) => T.clipsOnTrack(p, track).map((c) => [+c.start.toFixed(3), +T.clipEnd(c).toFixed(3), +c.in.toFixed(3)]);

test("appendMedia places clips end to end", () => {
  let p = project();
  p = T.appendMedia(p, "m1", "V1", 2, 5);
  assert.deepEqual(spans(p, "V1"), [[0, 20, 0], [20, 23, 2]]);
  assert.equal(T.timelineDuration(p), 23);
});

test("splitAt splits only clips spanning the time", () => {
  const p = T.splitAt(project(), 7);
  assert.deepEqual(spans(p, "V1"), [[0, 7, 0], [7, 20, 7]]);
  assert.equal(T.splitAt(p, 7).clips.length, 2, "splitting at an existing edit is a no-op");
});

test("ripple delete ranges refer to the original timeline", () => {
  let p = project();
  p = T.applyOperation(p, { op: "ripple_delete_ranges", ranges: [{ start: 2, end: 4 }, { start: 10, end: 11 }] });
  assert.deepEqual(spans(p, "V1"), [[0, 2, 0], [2, 8, 4], [8, 17, 11]]);
  assert.equal(T.timelineDuration(p), 17);
});

test("overlapping ripple ranges are merged", () => {
  const p = T.deleteRanges(project(), [[5, 8], [7, 9], [1, 2]]);
  assert.equal(T.timelineDuration(p), 20 - 1 - 4);
});

test("track-scoped ripple delete leaves other tracks alone", () => {
  let p = project();
  p = T.applyOperation(p, { op: "add_text", start: 0, end: 6, text: "hi", position: "bottom" });
  p = T.deleteRange(p, 2, 4, { ripple: true, trackIds: ["V1"] });
  assert.deepEqual(spans(p, "T1"), [[0, 6, 0]], "title must not be split or shifted");
  assert.equal(T.timelineDuration(p), 18);
});

test("lift leaves a gap", () => {
  const p = T.applyOperation(project(), { op: "lift_range", start: 5, end: 6, trackIds: null });
  assert.deepEqual(spans(p, "V1"), [[0, 5, 0], [6, 20, 6]]);
});

test("placeClip overwrites what is underneath", () => {
  let p = project();
  p = T.placeClip(p, { trackId: "V1", mediaId: "m1", start: 5, in: 0, out: 2 });
  assert.deepEqual(spans(p, "V1"), [[0, 5, 0], [5, 7, 0], [7, 20, 7]]);
});

test("moveClip refuses mismatched track kinds", () => {
  const p = project();
  assert.throws(() => T.moveClip(p, p.clips[0].id, 0, "A1"));
});

test("trimClip clamps to media duration", () => {
  const p = project();
  const q = T.trimClip(p, p.clips[0].id, 2, 50);
  assert.equal(q.clips[0].in, 2);
  assert.equal(q.clips[0].out, 20);
});

test("insert_media with start null appends", () => {
  let p = project();
  p = T.applyOperation(p, { op: "clear_timeline", trackId: null });
  p = T.applyOperation(p, { op: "insert_media", mediaId: "m1", sourceIn: 3, sourceOut: 5, start: null, trackId: null });
  p = T.applyOperation(p, { op: "insert_media", mediaId: "m1", sourceIn: 10, sourceOut: 12.5, start: null, trackId: null });
  assert.deepEqual(spans(p, "V1"), [[0, 2, 3], [2, 4.5, 10]]);
  p = T.applyOperation(p, { op: "insert_media", mediaId: "m2", sourceIn: 0, sourceOut: 4, start: null, trackId: null });
  assert.deepEqual(spans(p, "A1"), [[0, 4, 0]]);
});

test("applyOperations reports the failing op and keeps earlier ones", () => {
  const r = T.applyOperations(project(), [
    { op: "split", time: 4 },
    { op: "delete_clip", clipId: "nope", ripple: false },
    { op: "insert_media", mediaId: "missing", sourceIn: 0, sourceOut: 1 },
  ]);
  assert.deepEqual(r.applied, [0]);
  assert.match(r.error, /Operation 2 \(delete_clip\): No clip with id nope/);
  assert.equal(r.project.clips.length, 2);
  const r2 = T.applyOperations(project(), [{ op: "insert_media", mediaId: "missing", sourceIn: 0, sourceOut: 1 }]);
  assert.match(r2.error, /Unknown media/);
});

test("set_format rounds to even sizes", () => {
  const p = T.applyOperation(project(), { op: "set_format", width: 1081, height: 1919, fps: null });
  assert.equal(p.settings.width % 2, 0);
  assert.equal(p.settings.height % 2, 0);
});

test("mapSourceIntervals maps silences onto the timeline", () => {
  let p = project();
  p = T.deleteRanges(p, [[2, 4]]);
  const mapped = T.mapSourceIntervals(p, "m1", [{ start: 1, end: 3 }, { start: 10, end: 11 }]);
  assert.deepEqual(mapped.map((m) => [m.start, m.end]), [[1, 2], [8, 9]]);
});

test("operations never mutate their input", () => {
  const p = project();
  const before = JSON.stringify(p);
  T.applyOperations(p, [
    { op: "split", time: 3 },
    { op: "ripple_delete_ranges", ranges: [{ start: 1, end: 2 }] },
    { op: "add_marker", time: 1, label: "x" },
  ]);
  assert.equal(JSON.stringify(p), before);
});

test("formatTimecode", () => {
  assert.equal(T.formatTimecode(3661.5, 30), "01:01:01:15");
});

// ---- effects, speed, freeze, sounds --------------------------------------------

test("slow_motion stretches a range and pushes later material", () => {
  let p = project();
  p = T.applyOperation(p, { op: "add_text", start: 15, end: 16, text: "later", position: "bottom" });
  p = T.applyOperation(p, { op: "slow_motion", start: 4, end: 6, speed: 0.5 });
  assert.deepEqual(spans(p, "V1"), [[0, 4, 0], [4, 8, 4], [8, 22, 6]]);
  assert.equal(T.clipsOnTrack(p, "V1")[1].speed, 0.5);
  assert.deepEqual(spans(p, "T1"), [[17, 18, 0]], "titles after the slow-mo shift by the added time");
  // Source times map correctly through the slowed clip.
  assert.deepEqual(T.mapSourcePoint(p, "m1", 5), [6]);
  assert.equal(T.srcAt(T.clipsOnTrack(p, "V1")[1], 6), 5);
});

test("speeding up pulls later material left", () => {
  let p = project();
  p = T.splitAt(p, 10);
  const first = T.clipsOnTrack(p, "V1")[0];
  p = T.applyOperation(p, { op: "set_clip_speed", clipId: first.id, speed: 2 });
  assert.deepEqual(spans(p, "V1"), [[0, 5, 0], [5, 15, 10]]);
});

test("freeze_frame inserts a held frame and shifts the rest", () => {
  let p = project();
  p = T.applyOperation(p, { op: "freeze_frame", time: 5, duration: 1.5 });
  const v1 = T.clipsOnTrack(p, "V1");
  assert.deepEqual(v1.map((c) => [c.start, +T.clipEnd(c).toFixed(3)]), [[0, 5], [5, 6.5], [6.5, 21.5]]);
  assert.equal(v1[1].hold, true);
  assert.equal(v1[1].holdAt, 5);
  assert.equal(T.timelineDuration(p), 21.5);
});

test("add_effect stacks on free effects tracks", () => {
  let p = project();
  p = T.applyOperation(p, { op: "add_effect", type: "zoom", start: 2, end: 4, intensity: 0 });
  p = T.applyOperation(p, { op: "add_effect", type: "Flash", start: 3, end: 3.4, intensity: 0.9 });
  const fx = p.clips.filter((c) => c.effect);
  assert.equal(fx.length, 2);
  assert.notEqual(fx[0].trackId, fx[1].trackId);
  assert.equal(fx[0].effect.intensity, T.EFFECT_TYPES.zoom.intensity, "0 means default");
  assert.equal(fx[1].effect.type, "flash");
  assert.throws(() => T.applyOperation(p, { op: "add_effect", type: "explode", start: 1, end: 2 }));
});

test("add_sound needs the sound in the project, then lands on a free audio track", () => {
  let p = project();
  assert.throws(() => T.applyOperation(p, { op: "add_sound", sound: "whoosh", time: 1 }), /hasn't been added/);
  p.media.push({ id: "sfx1", name: "Whoosh", sfx: "whoosh", duration: 0.8, hasAudio: true, hasVideo: false });
  p = T.applyOperation(p, { op: "add_sound", sound: "whoosh", time: 1, volume: 0.7 });
  p = T.applyOperation(p, { op: "add_sound", sound: "whoosh", time: 1.2, volume: 1 });
  const a = p.clips.filter((c) => c.mediaId === "sfx1");
  assert.deepEqual(a.map((c) => c.trackId).sort(), ["A1", "A2"]);
});

test("migrateProject adds effects tracks to old projects", () => {
  const p = project();
  p.tracks = p.tracks.filter((t) => t.kind !== "fx");
  T.migrateProject(p);
  assert.equal(p.tracks.filter((t) => t.kind === "fx").length, 2);
});

// ---- graphics ------------------------------------------------------------------

test("add_graphic places a template on the graphics track", () => {
  let p = project();
  p.media.push({ id: "img1", name: "logo.png", isImage: true, duration: 0 });
  p = T.applyOperation(p, { op: "add_graphic", template: "outro", start: -1, props: { title: "Bye!", logo: "img1", background: "nope" } });
  const g = p.clips.find((c) => c.graphic);
  assert.equal(g.trackId, "G1");
  assert.equal(g.start, 20, "start -1 appends after the end");
  assert.equal(T.clipEnd(g), 20 + T.GRAPHICS.outro.duration);
  assert.deepEqual(g.graphic.props, { title: "Bye!", logo: "img1" }, "invalid select values are dropped");
  assert.throws(() => T.applyOperation(p, { op: "add_graphic", template: "outro", start: 1, props: { logo: "m1" } }), /No image/);
  assert.throws(() => T.applyOperation(p, { op: "add_graphic", template: "fireworks", start: 1 }), /Unknown graphic/);
});

test("every graphics template draws without errors", async () => {
  const { GRAPHICS, drawGraphic } = await import("../shared/graphics.js");
  // A recording stub context: enough of the 2D API for the templates.
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s) => ({ width: String(s).length * 10 }) : k.startsWith("create") ? () => grad : noop),
    set: (t, k, v) => ((t[k] = v), true),
  });
  const makeCanvas = () => ({ getContext: () => ctx });
  for (const [id, g] of Object.entries(GRAPHICS)) {
    const clip = { in: 0, out: g.duration, graphic: { template: id, props: {} } };
    for (const t of [0, 0.5, g.duration / 2, g.duration - 0.1, g.duration]) {
      drawGraphic(ctx, clip, t, 1920, 1080, { logo: null, makeCanvas });
      drawGraphic(ctx, clip, t, 1080, 1920, { logo: null, makeCanvas });
    }
  }
});
