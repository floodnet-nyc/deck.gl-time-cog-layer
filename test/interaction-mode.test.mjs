import assert from "node:assert/strict";
import test from "node:test";

import { detectInteractionMode } from "../dist/index.js";

test("playing returns 'playing' regardless of lastInteractionMs", () => {
  assert.equal(detectInteractionMode(true, 0), "playing");
  assert.equal(detectInteractionMode(true, Date.now()), "playing");
  assert.equal(detectInteractionMode(true, Date.now() - 10000), "playing");
});

test("lastInteractionMs === 0 with paused returns 'idle'", () => {
  assert.equal(detectInteractionMode(false, 0), "idle");
});

test("recent interaction (< 80ms) returns 'scrubbing'", () => {
  const recent = Date.now() - 30;
  assert.equal(detectInteractionMode(false, recent), "scrubbing");
});

test("brief pause (80–200ms) returns 'seeking'", () => {
  const brief = Date.now() - 100;
  assert.equal(detectInteractionMode(false, brief), "seeking");
});

test("sustained pause (200ms to idle threshold) returns 'seeking'", () => {
  const sustained = Date.now() - 250;
  assert.equal(detectInteractionMode(false, sustained), "seeking");
});

test("long pause exceeds idle threshold returns 'idle'", () => {
  const long = Date.now() - 400;
  assert.equal(detectInteractionMode(false, long, 300), "idle");
});

test("custom idle threshold is respected", () => {
  const medium = Date.now() - 200;
  assert.equal(detectInteractionMode(false, medium, 150), "idle");
});

test("edge: exactly at scrub/seek boundary (80ms)", () => {
  const exact80 = Date.now() - 80;
  assert.equal(detectInteractionMode(false, exact80), "seeking");
});

test("edge: exactly at seek threshold (200ms)", () => {
  const exact200 = Date.now() - 200;
  assert.equal(detectInteractionMode(false, exact200, 300), "seeking");
});
