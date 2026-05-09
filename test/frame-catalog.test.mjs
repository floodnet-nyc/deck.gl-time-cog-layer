import assert from "node:assert/strict";
import test from "node:test";

import {
  FramePrefetcher,
  SequenceTileCache,
  canonicalizeUrl,
  findNearestFrameIndex,
  hasTile,
  imageForZ,
  isMissingTileError,
  normalizeFrameCatalog,
  resolveFrameForTime,
  scheduleFrameWindow,
} from "../dist/index.js";

const frames = [
  { time: "2025-10-30T00:04:00Z", url: "https://example.test/004.tif?sig=drop&x=keep" },
  { time: "2025-10-30T00:00:00Z", url: "https://example.test/000.tif" },
  { id: "two", time: "2025-10-30T00:02:00Z", url: "https://example.test/002.tif" },
  { id: "two", time: "2025-10-30T00:02:00Z", url: "https://example.test/002-new.tif" },
];

test("normalizes, sorts, and de-duplicates frames", () => {
  const catalog = normalizeFrameCatalog(frames);

  assert.equal(catalog.length, 3);
  assert.deepEqual(
    catalog.map((frame) => frame.id),
    [
      "1761782400000:https://example.test/000.tif",
      "two",
      "1761782640000:https://example.test/004.tif?x=keep",
    ],
  );
  assert.equal(catalog[1].url, "https://example.test/002-new.tif");
});

test("canonicalizes volatile credential query params", () => {
  assert.equal(
    canonicalizeUrl("https://example.test/a.tif?sig=secret&se=soon&keep=1#frag"),
    "https://example.test/a.tif?keep=1",
  );
});

test("finds nearest frame by explicit catalog entries", () => {
  const catalog = normalizeFrameCatalog(frames);
  const target = Date.parse("2025-10-30T00:03:00Z");

  assert.equal(findNearestFrameIndex(catalog, target), 1);
});

test("resolves missing frame policies", () => {
  const catalog = normalizeFrameCatalog(frames);
  const missingTime = Date.parse("2025-10-30T00:03:00Z");

  assert.equal(resolveFrameForTime(catalog, missingTime, "nearest").displayFrame?.id, "two");
  assert.equal(resolveFrameForTime(catalog, missingTime, "hold-last").displayFrame?.id, "two");
  assert.equal(resolveFrameForTime(catalog, missingTime, "skip").displayFrame, null);
  assert.equal(resolveFrameForTime(catalog, missingTime, "transparent").displayFrame, null);
});

test("schedules a playback-aware frame window", () => {
  const catalog = normalizeFrameCatalog([
    { time: 0, url: "/0.tif" },
    { time: 1, url: "/1.tif" },
    { time: 2, url: "/2.tif" },
    { time: 3, url: "/3.tif" },
    { time: 4, url: "/4.tif" },
  ]);

  assert.deepEqual(
    scheduleFrameWindow(catalog, 2, { backwardFrames: 1, forwardFrames: 2 }, 1, true).map(
      (entry) => entry.index,
    ),
    [2, 3, 1, 4],
  );
  assert.deepEqual(
    scheduleFrameWindow(catalog, 2, { backwardFrames: 1, forwardFrames: 2 }, -1, true).map(
      (entry) => entry.index,
    ),
    [2, 1, 3, 0],
  );
});

test("sequence tile cache honors legacy max frame and tile-entry policy names", () => {
  const destroyed = [];
  const texture = (id) => ({
    destroy() {
      destroyed.push(id);
    },
  });

  const cache = new SequenceTileCache({ maxFrames: 2, maxTileEntries: 3 });

  cache.put("frame:0", 0, 0, 0, {
    texture: texture("0a"),
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "full",
  });
  cache.put("frame:1", 0, 0, 0, {
    texture: texture("1a"),
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "full",
  });
  cache.put("frame:2", 0, 0, 0, {
    texture: texture("2a"),
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "full",
  });

  assert.deepEqual(cache.stats().frameIds.sort(), ["frame:1", "frame:2"]);
  assert.deepEqual(destroyed, []);

  cache.put("frame:1", 1, 0, 0, {
    texture: texture("1b"),
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "full",
  });
  cache.put("frame:2", 1, 0, 0, {
    texture: texture("2b"),
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "full",
  });

  assert.equal(cache.stats().tileCount, 3);
  cache.destroy();
  assert.deepEqual(destroyed.sort(), ["0a", "1a", "1b", "2a", "2b"]);
});

test("frame prefetcher deduplicates and prunes queued tasks with colon frame ids", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);
  const targetFrame = {
    id: "1761782400000:https://example.test/0.tif",
    time: 0,
    timeMs: 0,
    url: "https://example.test/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "1761782520000:https://example.test/1.tif",
    time: 1,
    timeMs: 1,
    url: "https://example.test/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };
  const snapshot = {
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 1, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({
      texture: { destroy() {} },
      byteLength: 1,
      width: 1,
      height: 1,
    }),
    pool: {},
    playing: true,
    playbackRate: 1,
  };

  prefetcher.update(snapshot);
  prefetcher.update(snapshot);

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].frameId, nextFrame.id);

  prefetcher.update({
    ...snapshot,
    scheduledFrames: [targetFrame],
  });

  assert.equal(prefetcher.queue.length, 0);
  assert.equal(prefetcher.queuedKeys.size, 0);
});

test("tile helpers select overview levels and reject out-of-range tile coordinates", () => {
  const overview = { tileCount: { x: 2, y: 1 } };
  const geotiff = {
    overviews: [overview],
    tileCount: { x: 4, y: 3 },
  };

  assert.equal(imageForZ(geotiff, 0), overview);
  assert.equal(imageForZ(geotiff, 1), geotiff);
  assert.equal(imageForZ(geotiff, 2), undefined);
  assert.equal(hasTile(overview, 1, 0), true);
  assert.equal(hasTile(overview, 2, 0), false);
  assert.equal(hasTile(overview, 1, 1), false);
  assert.equal(hasTile(overview, -1, 0), false);
});

test("missing COG tile errors are classified separately from real failures", () => {
  assert.equal(isMissingTileError(new Error("Tile at (2, 1) not found")), true);
  assert.equal(isMissingTileError(new Error("Tile at (-1, 1) not found")), false);
  assert.equal(isMissingTileError(new Error("Network failed")), false);
  assert.equal(isMissingTileError("Tile at (2, 1) not found"), false);
});

test("frame prefetcher suppresses expected missing COG tile warnings", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 1);
  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "https://example.test/target.tif",
    cacheKey: "target",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "https://example.test/next.tif",
    cacheKey: "next",
    sourceIndex: 1,
  };
  const warnings = [];
  const originalWarn = console.warn;

  prefetcher.geotiffs.set(nextFrame.id, {
    overviews: [],
    tileCount: { x: 3, y: 2 },
  });
  console.warn = (...args) => warnings.push(args);

  try {
    prefetcher.update({
      targetFrame,
      scheduledFrames: [targetFrame, nextFrame],
      visibleTiles: [{ x: 2, y: 1, z: 0 }],
      device: {},
      getUserTileData: async () => {
        throw new Error("Tile at (2, 1) not found");
      },
      pool: {},
      playing: true,
      playbackRate: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});
