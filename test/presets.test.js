import { test } from "node:test";
import assert from "node:assert/strict";
import { VIDEO_TYPES, DEFAULT_VIDEO_TYPE, videoTypeOf } from "../shared/presets.js";

test("every video type has a label, guidance and quick actions", () => {
  for (const [id, t] of Object.entries(VIDEO_TYPES)) {
    assert.ok(t.label, `${id} label`);
    assert.ok(t.guidance.length > 50, `${id} guidance`);
    assert.ok(t.chips.length >= 3, `${id} chips`);
    for (const [label, prompt] of t.chips) assert.ok(label && prompt.length > 10, `${id} chip ${label}`);
  }
});

test("videoTypeOf falls back to the default", () => {
  assert.equal(videoTypeOf({ settings: {} }), DEFAULT_VIDEO_TYPE);
  assert.equal(videoTypeOf({ settings: { videoType: "nope" } }), DEFAULT_VIDEO_TYPE);
  assert.equal(videoTypeOf({ settings: { videoType: "gaming" } }), "gaming");
  assert.equal(DEFAULT_VIDEO_TYPE, "general");
});
