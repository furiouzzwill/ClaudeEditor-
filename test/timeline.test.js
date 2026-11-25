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
