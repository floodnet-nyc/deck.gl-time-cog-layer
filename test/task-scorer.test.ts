import assert from "node:assert/strict";
import test from "node:test";

import {
  SequenceTileCache,
  scoreTask,
  temporalProximityScore,
  directionScore,
  bufferShortfallScore,
  interactionScore,
  qualityUrgencyScore,
  sizeHintPenalty,
  etaPenalty,
  FALLBACK_WEIGHTS,
} from "../src/index.ts";

function makeCtx(overrides = {}) {
  const tileCache = new SequenceTileCache();

  return {
    getTileCache: () => tileCache,
    getRttEWMA: () => 0,
    getThroughputEWMA: () => 0,
    getFrameAvgBytes: () => 0,
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    coverage: 1,
    scheduledFrames: [],
    targetFrame: { id: "t", timeMs: 0, url: "/t", cacheKey: "0", sourceIndex: 0 },
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    frameId: "f1",
    frameUrl: "/f1.tif",
    x: 0,
    y: 0,
    z: 0,
    quality: "preview",
    priority: 0,
    ...overrides,
  };
}

// ─── temporalProximityScore ───

test("temporalProximityScore: distance 0 = 3x weight", () => {
  assert.equal(temporalProximityScore(0, FALLBACK_WEIGHTS), 3 * 30);
});

test("temporalProximityScore: distance 1 = 2x weight", () => {
  assert.equal(temporalProximityScore(1, FALLBACK_WEIGHTS), 2 * 30);
});

test("temporalProximityScore: distance 2 = 1x weight", () => {
  assert.equal(temporalProximityScore(2, FALLBACK_WEIGHTS), 1 * 30);
});

test("temporalProximityScore: distance >= 3 = 0", () => {
  assert.equal(temporalProximityScore(3, FALLBACK_WEIGHTS), 0);
  assert.equal(temporalProximityScore(10, FALLBACK_WEIGHTS), 0);
});

test("temporalProximityScore: respects custom weight", () => {
  const weights = { ...FALLBACK_WEIGHTS, viewportSalience: 10 };
  assert.equal(temporalProximityScore(1, weights), 20);
});

// ─── directionScore ───

test("directionScore: 0 when paused", () => {
  const ctx = makeCtx({ playing: false, playbackRate: 0 });
  assert.equal(directionScore(1, ctx, FALLBACK_WEIGHTS), 0);
  assert.equal(directionScore(-1, ctx, FALLBACK_WEIGHTS), 0);
});

test("directionScore: boosts forward frames during forward playback", () => {
  const ctx = makeCtx({ playing: true, playbackRate: 1 });
  const result = directionScore(1, ctx, FALLBACK_WEIGHTS);
  assert.ok(result > 0);
  assert.equal(result, FALLBACK_WEIGHTS.direction);
});

test("directionScore: penalises backward frames during forward playback", () => {
  const ctx = makeCtx({ playing: true, playbackRate: 1 });
  const result = directionScore(-1, ctx, FALLBACK_WEIGHTS);
  assert.ok(result < 0);
});

test("directionScore: boosts backward frames during reverse playback", () => {
  const ctx = makeCtx({ playing: true, playbackRate: -1 });
  // distanceIndex = -1 means frame is behind target
  // with playbackRate = -1, direction = -1, so -1 === -1 = true
  const result = directionScore(-1, ctx, FALLBACK_WEIGHTS);
  assert.ok(result > 0);
});

// ─── bufferShortfallScore ───

test("bufferShortfallScore: 0 for backward frames", () => {
  const ctx = makeCtx({
    playing: true, playbackRate: 1,
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });
  assert.equal(bufferShortfallScore(-1, ctx, FALLBACK_WEIGHTS), 0);
});

test("bufferShortfallScore: 0 without bufferState", () => {
  const ctx = makeCtx({ playing: true, playbackRate: 1 });
  assert.equal(bufferShortfallScore(1, ctx, FALLBACK_WEIGHTS), 0);
});

test("bufferShortfallScore: positive when ahead buffer is low", () => {
  const ctx = makeCtx({
    playing: true, playbackRate: 1,
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });
  const result = bufferShortfallScore(1, ctx, FALLBACK_WEIGHTS);
  assert.ok(result > 0);
  assert.equal(result, FALLBACK_WEIGHTS.bufferShortfall); // 100% shortfall
});

test("bufferShortfallScore: 0 when ahead buffer is full", () => {
  const ctx = makeCtx({
    playing: true, playbackRate: 1,
    bufferState: { bufferedAhead: 6, bufferedBehind: 0, targetAhead: 6 },
  });
  // 0% shortfall → 0 boost
  const result = bufferShortfallScore(1, ctx, FALLBACK_WEIGHTS);
  assert.equal(result, 0);
});

test("bufferShortfallScore: proportional to shortfall", () => {
  const ctx = makeCtx({
    playing: true, playbackRate: 1,
    bufferState: { bufferedAhead: 3, bufferedBehind: 0, targetAhead: 6 },
  });
  // 50% shortfall → 50% * 20 = 10
  const result = bufferShortfallScore(1, ctx, FALLBACK_WEIGHTS);
  assert.equal(result, 10);
});

// ─── interactionScore ───

test("interactionScore: 0 in idle mode", () => {
  const ctx = makeCtx({ interactionMode: "idle" });
  assert.equal(interactionScore(1, ctx, FALLBACK_WEIGHTS), 0);
});

test("interactionScore: boosts nearby frames during seeking", () => {
  const ctx = makeCtx({ interactionMode: "seeking" });
  const result = interactionScore(0, ctx, FALLBACK_WEIGHTS);
  assert.ok(result > 0);
  assert.equal(result, 2 * FALLBACK_WEIGHTS.interaction);
});

test("interactionScore: penalises far frames during seeking", () => {
  const ctx = makeCtx({ interactionMode: "seeking" });
  const result = interactionScore(4, ctx, FALLBACK_WEIGHTS);
  assert.ok(result < 0);
});

// ─── qualityUrgencyScore ───

test("qualityUrgencyScore: 0 for normal full task without existing preview", () => {
  const ctx = makeCtx();
  const task = makeTask({ quality: "full" });
  assert.equal(qualityUrgencyScore(task, ctx, FALLBACK_WEIGHTS), 0);
});

test("qualityUrgencyScore: boost for preview-to-full upgrade", () => {
  const tileCache = new SequenceTileCache();
  tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1,
    quality: "preview",
  });
  const ctx = makeCtx({ getTileCache: () => tileCache });
  const task = makeTask({ quality: "full" });

  assert.equal(
    qualityUrgencyScore(task, ctx, FALLBACK_WEIGHTS),
    FALLBACK_WEIGHTS.qualityUpgrade,
  );
});

test("qualityUrgencyScore: boost for fresh preview when coverage is low", () => {
  const ctx = makeCtx({ coverage: 0.2 });
  const task = makeTask({ quality: "preview" });

  assert.equal(
    qualityUrgencyScore(task, ctx, FALLBACK_WEIGHTS),
    FALLBACK_WEIGHTS.qualityFreshPreview,
  );
});

test("qualityUrgencyScore: no boost for preview when coverage is high", () => {
  const ctx = makeCtx({ coverage: 0.8 });
  const task = makeTask({ quality: "preview" });
  assert.equal(qualityUrgencyScore(task, ctx, FALLBACK_WEIGHTS), 0);
});

test("qualityUrgencyScore: no double boost for full task when full already cached", () => {
  const tileCache = new SequenceTileCache();
  tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1,
    quality: "full",
  });
  const ctx = makeCtx({ getTileCache: () => tileCache });
  const task = makeTask({ quality: "full" });

  assert.equal(qualityUrgencyScore(task, ctx, FALLBACK_WEIGHTS), 0);
});

// ─── sizeHintPenalty ───

test("sizeHintPenalty: no penalty when weight is zero", () => {
  const ctx = makeCtx();
  const task = makeTask({ byteSizeHint: 1000000 });
  const weights = { ...FALLBACK_WEIGHTS, sizeHintPerBit: 0 };
  assert.equal(sizeHintPenalty(task, ctx, weights), 0);
});

test("sizeHintPenalty: no penalty when byteSizeHint is absent", () => {
  const ctx = makeCtx();
  const task = makeTask(); // no byteSizeHint
  assert.equal(sizeHintPenalty(task, ctx, FALLBACK_WEIGHTS), 0);
});

test("sizeHintPenalty: penalises larger tiles more", () => {
  const ctx = makeCtx();
  const smallTask = makeTask({ byteSizeHint: 4 });
  const largeTask = makeTask({ byteSizeHint: 64 });

  const smallPenalty = sizeHintPenalty(smallTask, ctx, FALLBACK_WEIGHTS);
  const largePenalty = sizeHintPenalty(largeTask, ctx, FALLBACK_WEIGHTS);

  // 4 bytes: 2 * log2(5) ≈ 4.6 → penalty ≈ -5
  // 64 bytes: 2 * log2(65) ≈ 12.0 → penalty ≈ -12
  assert.ok(smallPenalty < 0, "small task should have negative penalty");
  assert.ok(largePenalty < smallPenalty, "large task should have larger (more negative) penalty");
});

test("sizeHintPenalty: penalty capped at -15", () => {
  const ctx = makeCtx();
  const task = makeTask({ byteSizeHint: 1e12 }); // extremely large
  const penalty = sizeHintPenalty(task, ctx, FALLBACK_WEIGHTS);
  assert.equal(penalty, -15);
});

test("sizeHintPenalty: uses frameAvgBytes when byteSizeHint is absent", () => {
  const ctx = makeCtx({ getFrameAvgBytes: () => 65536 });
  const task = makeTask(); // no byteSizeHint
  const penalty = sizeHintPenalty(task, ctx, FALLBACK_WEIGHTS);
  assert.ok(penalty < 0, "should use frameAvgBytes fallback");
});

// ─── etaPenalty ───

test("etaPenalty: no penalty when rttEWMA is zero", () => {
  const ctx = makeCtx({ getRttEWMA: () => 0 });
  const task = makeTask({ byteSizeHint: 1000000 });
  assert.equal(etaPenalty(task, ctx, FALLBACK_WEIGHTS), 0);
});

test("etaPenalty: negative when telemetry is available", () => {
  const ctx = makeCtx({
    getRttEWMA: () => 100,
    getThroughputEWMA: () => 1000000,
    getFrameAvgBytes: () => 50000,
  });
  const task = makeTask({ byteSizeHint: 50000 });
  const result = etaPenalty(task, ctx, FALLBACK_WEIGHTS);
  assert.ok(result < 0, "should have negative penalty with active telemetry");
});

test("etaPenalty: penalty capped at -20", () => {
  const ctx = makeCtx({
    getRttEWMA: () => 10000, // very slow
    getThroughputEWMA: () => 1,
    getFrameAvgBytes: () => 1e9,
  });
  const task = makeTask({ byteSizeHint: 1e9 });
  assert.equal(etaPenalty(task, ctx, FALLBACK_WEIGHTS), -20);
});

// ─── scoreTask integration ───

test("scoreTask: capped between 0 and 200", () => {
  const ctx = makeCtx({ interactionMode: "playing", playing: true, playbackRate: 1 });
  const task = makeTask({ quality: "preview" });

  const score = scoreTask(task, 0, ctx, FALLBACK_WEIGHTS);
  assert.ok(score >= 0);
  assert.ok(score <= 200);
});

test("scoreTask: near target frame scores higher than far frame", () => {
  const ctx = makeCtx({ interactionMode: "idle" });

  const scoreNear = scoreTask(makeTask(), 1, ctx, FALLBACK_WEIGHTS);
  const scoreFar = scoreTask(makeTask({ frameId: "far" }), 3, ctx, FALLBACK_WEIGHTS);

  assert.ok(scoreNear > scoreFar, "near frame should outrank far frame");
});

test("scoreTask: upgrade-to-full task gets significant bonus", () => {
  const tileCache = new SequenceTileCache();
  tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1,
    quality: "preview",
  });
  const ctx = makeCtx({ getTileCache: () => tileCache, interactionMode: "idle" });

  const upgradeScore = scoreTask(
    makeTask({ quality: "full" }),
    1,
    ctx,
    FALLBACK_WEIGHTS,
  );
  const freshScore = scoreTask(
    makeTask({ quality: "preview", frameId: "f2" }),
    1,
    ctx,
    FALLBACK_WEIGHTS,
  );

  assert.ok(upgradeScore > freshScore, "upgrade should outrank fresh preview");
});

test("scoreTask: seeking interaction boosts near and penalises far", () => {
  const ctx = makeCtx({ interactionMode: "seeking" });

  const scoreNear = scoreTask(makeTask(), 1, ctx, FALLBACK_WEIGHTS);
  const scoreFar = scoreTask(makeTask({ frameId: "f4" }), 4, ctx, FALLBACK_WEIGHTS);

  assert.ok(scoreNear > scoreFar + 10, "near frame should significantly outrank far during seek");
});
