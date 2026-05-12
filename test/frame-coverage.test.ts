import assert from "node:assert/strict";
import test from "node:test";

import { SequenceTileCache, computeCoverage, computeBufferState, isFrameReady } from "../src/index.ts";

function makeTexture() {
  return { destroy() {} };
}

function makeFrame(id, timeMs) {
  return { id, timeMs, url: `/${id}.tif`, cacheKey: id, sourceIndex: 0 };
}

// ─── computeCoverage ───

test("computeCoverage returns 1 when frame is null", () => {
  const cache = new SequenceTileCache();
  assert.equal(computeCoverage(cache, null, [{ x: 0, y: 0, z: 0 }]), 1);
});

test("computeCoverage returns 1 when visible tiles are empty", () => {
  const cache = new SequenceTileCache();
  const frame = makeFrame("f1", 0);
  assert.equal(computeCoverage(cache, frame, []), 1);
});

test("computeCoverage returns 0 with no cached tiles", () => {
  const cache = new SequenceTileCache();
  const frame = makeFrame("f1", 0);
  assert.equal(
    computeCoverage(cache, frame, [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    0,
  );
});

test("computeCoverage returns 0.5 when half the tiles are cached at full quality", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  const frame = makeFrame("f1", 0);

  assert.equal(
    computeCoverage(cache, frame, [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    0.5,
  );
});

test("computeCoverage returns 1 when all tiles are cached at full quality", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put("f1", 1, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  const frame = makeFrame("f1", 0);

  assert.equal(
    computeCoverage(cache, frame, [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    1,
  );
});

test("computeCoverage ignores preview-quality tiles", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "preview" });
  const frame = makeFrame("f1", 0);

  assert.equal(computeCoverage(cache, frame, [{ x: 0, y: 0, z: 0 }]), 0);
});

test("computeCoverage is frame-specific", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  const frame = makeFrame("f2", 0);

  assert.equal(computeCoverage(cache, frame, [{ x: 0, y: 0, z: 0 }]), 0);
});

// ─── computeBufferState ───

test("computeBufferState returns zeros when displayFrame is null", () => {
  const cache = new SequenceTileCache();
  const frames = [makeFrame("f1", 0)];
  const result = computeBufferState(cache, null, frames, [{ x: 0, y: 0, z: 0 }], 6);
  assert.deepEqual(result, { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 });
});

test("computeBufferState returns zeros when visible tiles are empty", () => {
  const cache = new SequenceTileCache();
  const f1 = makeFrame("f1", 0);
  const result = computeBufferState(cache, f1, [f1], [], 6);
  assert.deepEqual(result, { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 });
});

test("computeBufferState counts contiguous full-coverage frames", () => {
  const cache = new SequenceTileCache();
  const tiles = [{ x: 0, y: 0, z: 0 }];
  const f0 = makeFrame("f0", 0);
  const f1 = makeFrame("f1", 1); // display
  const f2 = makeFrame("f2", 2);
  const f3 = makeFrame("f3", 3);

  // f1 (display) and f2 are cached; f3 is not
  [f1, f2].forEach((f) =>
    cache.put(f.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" }),
  );

  const result = computeBufferState(
    cache,
    f1,
    [f0, f1, f2, f3],
    tiles,
    6,
  );

  assert.equal(result.bufferedAhead, 1);
  assert.equal(result.bufferedBehind, 0);
  assert.equal(result.targetAhead, 6);
});

test("computeBufferState breaks at first non-full-coverage gap", () => {
  const cache = new SequenceTileCache();
  const tiles = [{ x: 0, y: 0, z: 0 }];
  const f0 = makeFrame("f0", 0);
  const f1 = makeFrame("f1", 1);
  const f2 = makeFrame("f2", 2); // display
  const f3 = makeFrame("f3", 3); // cached
  const f4 = makeFrame("f4", 4); // NOT cached
  const f5 = makeFrame("f5", 5); // cached but gap prevents reach

  cache.put(f1.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put(f3.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put(f5.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });

  const result = computeBufferState(
    cache,
    f2,
    [f0, f1, f2, f3, f4, f5],
    tiles,
    6,
  );

  assert.equal(result.bufferedAhead, 1, "only f3 is contiguous ahead of f2");
  assert.equal(result.bufferedBehind, 1, "only f1 is contiguous behind f2");
});

test("computeBufferState sorts by time, not priority", () => {
  const cache = new SequenceTileCache();
  const tiles = [{ x: 0, y: 0, z: 0 }];
  const f0 = makeFrame("f0", 0);
  const f1 = makeFrame("f1", 1);
  const f2 = makeFrame("f2", 2);
  const f3 = makeFrame("f3", 3);

  cache.put(f1.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put(f3.id, 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });

  // Priority-ordered: target first, then farthest, then nearest
  const result = computeBufferState(
    cache,
    f2,
    [f2, f0, f3, f1], // priority order
    tiles,
    6,
  );

  assert.equal(result.bufferedAhead, 1, "f3 is contiguous ahead");
  assert.equal(result.bufferedBehind, 1, "f1 is contiguous behind (f0 not cached)");
});

// ─── isFrameReady ───

test("isFrameReady returns true when all visible tiles are full-quality", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put("f1", 1, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(
    isFrameReady(cache, new Set(), makeFrame("f1", 0), [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    true,
  );
});

test("isFrameReady returns false when some tiles are missing", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(
    isFrameReady(cache, new Set(), makeFrame("f1", 0), [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    false,
  );
});

test("isFrameReady returns false when tiles are preview-quality only", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "preview" });

  assert.equal(
    isFrameReady(cache, new Set(), makeFrame("f1", 0), [{ x: 0, y: 0, z: 0 }]),
    false,
  );
});

test("isFrameReady returns false when frame already marked ready", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: makeTexture(), byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(
    isFrameReady(cache, new Set(["f1"]), makeFrame("f1", 0), [{ x: 0, y: 0, z: 0 }]),
    false,
    "already-ready frame should return false (idempotent)",
  );
});

test("isFrameReady returns false for empty visible tiles", () => {
  const cache = new SequenceTileCache();
  assert.equal(isFrameReady(cache, new Set(), makeFrame("f1", 0), []), false);
});
