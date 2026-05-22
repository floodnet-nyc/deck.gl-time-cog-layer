import assert from "node:assert/strict";
import test from "node:test";

import {
  SequenceTileCache,
  FramePrefetcher,
  buildBufferState,
  buildStats,
} from "../src/index.ts";

function makeFrame(id, timeMs) {
  return { id, timeMs, url: `/${id}.tif`, cacheKey: id, sourceIndex: 0 };
}

function makeState(overrides = {}) {
  const f1 = makeFrame("f1", 0);
  const f2 = makeFrame("f2", 1);

  return {
    catalog: [f1, f2],
    tileCache: new SequenceTileCache(),
    prefetcher: new FramePrefetcher(new SequenceTileCache()),
    visibleTileRef: { tiles: [] },
    initialGeotiffUrl: "",
    currentTimeMs: 0,
    targetFrame: f1,
    displayFrame: f1,
    scheduledFrames: [f2],
    missing: false,
    lastDisplayedFrameId: null,
    interactionMode: "idle",
    lastInteractionMs: 0,
    upgradeTimer: null,
    readyFrameIds: new Set(),
    geotiffRegistry: null,
    ...overrides,
  };
}

test("buildBufferState includes display frame and scheduled frame IDs", () => {
  const state = makeState();
  const result = buildBufferState(state.tileCache, state);

  assert.equal(result.displayFrame, state.displayFrame);
  assert.deepEqual(result.scheduledFrameIds, ["f2"]);
  assert.equal(result.missing, false);
});

test("buildBufferState reports missing flag", () => {
  const state = makeState({ missing: true });
  const result = buildBufferState(state.tileCache, state);
  assert.equal(result.missing, true);
});

test("buildBufferState readyFrameIds come from state readiness tracking", () => {
  const state = makeState({ readyFrameIds: new Set(["f1"]) });

  const result = buildBufferState(state.tileCache, state);
  assert.deepEqual(result.readyFrameIds, ["f1"]);
});

test("buildBufferState includes missingFrameIds from display and prefetch tracking", () => {
  const state = makeState();
  state.prefetcher.markMissingFrame("f1");
  state.prefetcher.markMissingFrame("f2");

  const result = buildBufferState(state.tileCache, state);
  assert.deepEqual(result.missingFrameIds.sort(), ["f1", "f2"]);
});

test("buildStats reports frame counts and current time", () => {
  const state = makeState();
  const result = buildStats(state.tileCache, state.prefetcher, state);

  assert.equal(result.frameCount, 2);
  assert.equal(result.currentTimeMs, 0);
  assert.equal(result.targetFrameId, "f1");
  assert.equal(result.displayFrameId, "f1");
});

test("buildStats cache stats reflect tile cache contents", () => {
  const state = makeState({ readyFrameIds: new Set(["f1"]) });
  state.tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 100, width: 1, height: 1, quality: "full",
  });

  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.cacheEntryCount, 1);
  assert.equal(result.readyFrameCount, 1);
});

test("buildStats reports missing frame ids from display and prefetch tracking", () => {
  const state = makeState();
  state.prefetcher.markMissingFrame("f1");
  state.prefetcher.markMissingFrame("f2");

  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.missingFrameCount, 2);
  assert.deepEqual(result.missingFrameIds.sort(), ["f1", "f2"]);
});

test("buildStats displayCacheHitRate computes correctly", () => {
  const state = makeState();
  state.tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1, quality: "full",
  });
  state.tileCache.recordDisplayHit();
  state.tileCache.recordDisplayMiss();

  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.displayCacheHitRate, 0.5);
});

test("buildStats displayCacheHitRate is 0 with no accesses", () => {
  const state = makeState();
  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.displayCacheHitRate, 0);
});

test("buildStats prefetchTaskCount comes from prefetcher", () => {
  const state = makeState();
  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.prefetchTaskCount, 0);
  assert.equal(result.queuedPrefetchTaskCount, 0);
  assert.equal(result.inFlightPrefetchTaskCount, 0);
});

test("buildStats scheduledFrameCount reflects state", () => {
  const f3 = makeFrame("f3", 2);
  const f4 = makeFrame("f4", 3);
  const state = makeState({ scheduledFrames: [f3, f4] });
  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.scheduledFrameCount, 2);
});

test("buildStats handles null targetFrame gracefully", () => {
  const state = makeState({ targetFrame: null });
  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.targetFrameId, null);
});

test("buildStats handles null displayFrame gracefully", () => {
  const state = makeState({ displayFrame: null });
  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.displayFrameId, null);
});

test("buildStats reports prefetch efficiency metrics", () => {
  const state = makeState();

  state.tileCache.put("prefetch-used", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 100,
    width: 1,
    height: 1,
    quality: "full",
    origin: "prefetch",
  });
  state.tileCache.markDisplayed("prefetch-used", 0, 0, 0);

  state.tileCache.put("prefetch-unused", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 50,
    width: 1,
    height: 1,
    quality: "full",
    origin: "prefetch",
  });

  const result = buildStats(state.tileCache, state.prefetcher, state);
  assert.equal(result.prefetchedLoadedCount, 2);
  assert.equal(result.prefetchedUsedCount, 1);
  assert.equal(result.prefetchedWastedCount, 0);
  assert.equal(result.prefetchedResidentCount, 2);
  assert.equal(result.prefetchedUnusedResidentCount, 1);
  assert.equal(result.prefetchedUseRate, 0.5);
  assert.equal(result.prefetchedWasteRate, 0);
});
