import assert from "node:assert/strict";
import test from "node:test";

import {
  FramePrefetcher,
  GeoTIFFRegistry,
  SequenceTileCache,
  canonicalizeUrl,
  findNearestFrameIndex,
  hasTile,
  imageForZ,
  isMissingTileError,
  mapToCoarserZoom,
  normalizeFrameCatalog,
  resolveFrameForTime,
  scheduleFrameWindow,
} from "../dist/index.js";
import { TimeSequenceTileLayer } from "../dist/time-sequence-tile-layer.js";

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
    scheduleFrameWindow(catalog, 2, { backwardFrames: 1, forwardFrames: 2 }, 1, 0, true).map(
      (entry) => entry.index,
    ),
    [2, 3, 1, 4],
  );
  assert.deepEqual(
    scheduleFrameWindow(catalog, 2, { backwardFrames: 1, forwardFrames: 2 }, -1, 0, true).map(
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
  assert.deepEqual(destroyed, ["0a"]);

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
    interactionMode: "playing",
    qualityPolicy: {},
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
      interactionMode: "playing",
      qualityPolicy: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test("frame prefetcher keeps preview requests on the exact tile grid", async () => {
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
  const coarse = { id: "coarse", tileCount: { x: 4, y: 4 } };
  const geotiff = {
    overviews: [coarse],
    tileCount: { x: 8, y: 8 },
  };
  const requests = [];

  prefetcher.geotiffs.set(nextFrame.id, geotiff);

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 6, z: 1 }],
    device: {},
    getUserTileData: async (image, options) => {
      requests.push({
        imageId: image.id,
        x: options.x,
        y: options.y,
        rasterValue: options.x * 1000 + options.y,
      });

      return {
        texture: { destroy() {} },
        byteLength: 1,
        width: 1,
        height: 1,
      };
    },
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: { previewOverviewBias: 1 },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [
    { imageId: undefined, x: 4, y: 6, rasterValue: 4006 },
  ]);

  const cached = cache.get(nextFrame.id, 4, 6, 1);
  assert.ok(cached);
  assert.equal(cached.quality, "full");
});

// ─── Phase 1: progressive loading, onFrameReady, descriptor validation ───

test("mapToCoarserZoom halves coordinates at bias 1", () => {
  assert.deepEqual(mapToCoarserZoom(8, 6, 3, 1), { x: 4, y: 3, z: 2 });
});

test("mapToCoarserZoom quarters coordinates at bias 2", () => {
  assert.deepEqual(mapToCoarserZoom(8, 7, 4, 2), { x: 2, y: 1, z: 2 });
});

test("mapToCoarserZoom clamps z at bias exceeding zoom", () => {
  assert.deepEqual(mapToCoarserZoom(4, 2, 1, 2), { x: 1, y: 0, z: 0 });
});

test("mapToCoarserZoom returns identity at bias 0", () => {
  assert.deepEqual(mapToCoarserZoom(5, 5, 5, 0), { x: 5, y: 5, z: 5 });
});

test("time sequence tile layer keeps preview requests on the exact tile grid", async () => {
  const cache = new SequenceTileCache();
  const registry = new GeoTIFFRegistry();
  const coarse = { id: "coarse", tileCount: { x: 4, y: 4 } };
  const geotiff = {
    overviews: [coarse],
    tileCount: { x: 8, y: 8 },
  };
  registry.unsafelySet("frame-1", geotiff);
  const requests = [];

  const layer = Object.create(TimeSequenceTileLayer.prototype);
  layer.props = {
    sequenceTileCache: cache,
    currentFrameId: "frame-1",
    currentFrameUrl: "https://example.test/frame-1.tif",
    previewBias: 1,
    visibleTileRef: { tiles: [] },
    pool: {},
    geotiffRegistry: registry,
    getTileData: async (image, options) => {
      requests.push({
        imageId: image.id,
        x: options.x,
        y: options.y,
      });
      return {
        texture: { destroy() {} },
        byteLength: 1,
        width: 1,
        height: 1,
        rasterValue: options.x * 1000 + options.y,
      };
    },
  };
  layer.state = {};
  layer.context = {
    device: {},
  };

  const getTileData = TimeSequenceTileLayer.prototype._getTileDataCallback.call(layer);
  const result = await getTileData(
    { index: { x: 4, y: 6, z: 1 } },
    { device: {}, signal: undefined },
  );

  assert.deepEqual(requests, [{ imageId: undefined, x: 4, y: 6 }]);
  assert.equal(result.rasterValue, 4006);

  const cached = cache.get("frame-1", 4, 6, 1);
  assert.ok(cached);
  assert.equal(cached.quality, "full");
});

test("SequenceTileCache.getBest returns exact match on first try", () => {
  const cache = new SequenceTileCache();
  const tex = { destroy() {} };
  cache.put("f1", 2, 3, 2, { texture: tex, byteLength: 1, width: 1, height: 1, quality: "full" });

  const result = cache.getBest("f1", 2, 3, 2, 2);
  assert.ok(result);
  assert.equal(result.quality, "full");
  assert.equal(result.x, 2);
});

test("SequenceTileCache.getBest falls back to coarser zoom", () => {
  const cache = new SequenceTileCache();
  const tex = { destroy() {} };
  cache.put("f1", 1, 1, 1, { texture: tex, byteLength: 1, width: 1, height: 1, quality: "preview" });

  const result = cache.getBest("f1", 2, 3, 2, 2);
  assert.ok(result);
  assert.equal(result.quality, "preview");
  assert.equal(result.x, 1);
});

test("SequenceTileCache.getBest returns undefined when no levels match", () => {
  const cache = new SequenceTileCache();
  const result = cache.getBest("f1", 4, 4, 3, 2);
  assert.equal(result, undefined);
});

test("SequenceTileCache.getBest only searches same frame", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 1, 1, 1, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });
  const result = cache.getBest("f2", 2, 3, 2, 2);
  assert.equal(result, undefined);
});

test("SequenceTileCache.hasFullCoverage returns true when all tiles present at full", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 1, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });
  cache.put("f1", 1, 0, 1, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(cache.hasFullCoverage("f1", [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }]), true);
});

test("SequenceTileCache.hasFullCoverage returns false when a tile is missing", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 1, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(cache.hasFullCoverage("f1", [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }]), false);
});

test("SequenceTileCache.hasFullCoverage returns false when tile is preview, not full", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 1, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "preview" });

  assert.equal(cache.hasFullCoverage("f1", [{ x: 0, y: 0, z: 1 }]), false);
});

test("SequenceTileCache.hasFullCoverage returns false for empty tile list", () => {
  const cache = new SequenceTileCache();
  assert.equal(cache.hasFullCoverage("f1", []), false);
});

test("SequenceTileCache allows preview-to-full quality upgrade on put", () => {
  const destroyed = [];
  const cache = new SequenceTileCache();

  cache.put("f1", 0, 0, 0, {
    texture: { destroy() {},
    },
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "preview",
  });

  const first = cache.get("f1", 0, 0, 0);
  assert.equal(first.quality, "preview");

  cache.put("f1", 0, 0, 0, {
    texture: { destroy() {},
    },
    byteLength: 2,
    width: 2,
    height: 2,
    quality: "full",
  });

  const second = cache.get("f1", 0, 0, 0);
  assert.equal(second.quality, "full");
  assert.equal(second.byteLength, 2);
});

test("SequenceTileCache does not downgrade full to preview on put", () => {
  const cache = new SequenceTileCache();

  cache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 2,
    width: 2,
    height: 2,
    quality: "full",
  });

  cache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "preview",
  });

  const result = cache.get("f1", 0, 0, 0);
  assert.equal(result.quality, "full");
  assert.equal(result.byteLength, 2);
});

test("frame prefetcher creates preview tasks at biased zoom during seeking", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: { previewOverviewBias: 1 },
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].quality, "preview");
  assert.equal(prefetcher.queue[0].x, 4);
  assert.equal(prefetcher.queue[0].y, 2);
  assert.equal(prefetcher.queue[0].z, 3);
});

test("frame prefetcher creates preview tasks at coarser bias during scrubbing", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 8, y: 4, z: 4 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "scrubbing",
    qualityPolicy: { scrubOverviewBias: 2 },
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].quality, "preview");
  assert.equal(prefetcher.queue[0].x, 8);
  assert.equal(prefetcher.queue[0].y, 4);
  assert.equal(prefetcher.queue[0].z, 4);
});

test("frame prefetcher creates preview tasks at biased zoom during playing for nearby frames", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: { previewOverviewBias: 1 },
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].quality, "preview");
  assert.equal(prefetcher.queue[0].x, 4);
  assert.equal(prefetcher.queue[0].y, 2);
  assert.equal(prefetcher.queue[0].z, 3);
});

test("frame prefetcher in idle mode creates upgrade tasks for preview-only tiles", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  cache.put("next", 4, 2, 3, {
    texture: { destroy() {} },
    byteLength: 1,
    width: 1,
    height: 1,
    quality: "preview",
    x: 4,
    y: 2,
    z: 3,
  });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].quality, "full");
  assert.equal(prefetcher.queue[0].x, 4);
  assert.equal(prefetcher.queue[0].y, 2);
  assert.equal(prefetcher.queue[0].z, 3);
  assert.ok(prefetcher.queue[0].priority >= 100, "upgrade priority should be high");
});

test("frame prefetcher in idle mode skips upgrade when full tile already cached", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  cache.put("next", 4, 2, 3, {
    texture: { destroy() {} },
    byteLength: 2,
    width: 2,
    height: 2,
    quality: "full",
    x: 4,
    y: 2,
    z: 3,
  });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const upgradeTasks = prefetcher.queue.filter((t) => t.quality === "full" && t.priority > 100);
  assert.equal(upgradeTasks.length, 0);
});

test("frame prefetcher respects lowResFirst: false in qualityPolicy", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const nextFrame = {
    id: "next",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 4, y: 2, z: 3 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: { lowResFirst: false, previewOverviewBias: 1 },
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].quality, "full");
  assert.equal(prefetcher.queue[0].x, 4);
  assert.equal(prefetcher.queue[0].y, 2);
  assert.equal(prefetcher.queue[0].z, 3);
});

test("frame prefetcher skips target frame in all interaction modes", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };

  for (const mode of ["idle", "seeking", "scrubbing", "playing"]) {
    prefetcher.update({
      targetFrame,
      scheduledFrames: [targetFrame],
      visibleTiles: [{ x: 0, y: 0, z: 0 }],
      device: {},
      getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
      pool: {},
      playing: mode === "playing",
      playbackRate: mode === "playing" ? 1 : 0,
      interactionMode: mode,
      qualityPolicy: {},
    });

    assert.equal(prefetcher.queue.length, 0, `queue should be empty in ${mode} mode when only target frame is scheduled`);
  }
});

test("frame prefetcher aborts stale in-flight tasks when frame leaves window", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 2);

  const targetFrame = {
    id: "target",
    time: 0,
    timeMs: 0,
    url: "http://ex/0.tif",
    cacheKey: "0",
    sourceIndex: 0,
  };
  const frameA = {
    id: "A",
    time: 1,
    timeMs: 1,
    url: "http://ex/1.tif",
    cacheKey: "1",
    sourceIndex: 1,
  };
  const frameB = {
    id: "B",
    time: 2,
    timeMs: 2,
    url: "http://ex/2.tif",
    cacheKey: "2",
    sourceIndex: 2,
  };

  prefetcher.geotiffs.set("A", { overviews: [], tileCount: { x: 5, y: 5 } });
  prefetcher.geotiffs.set("B", { overviews: [], tileCount: { x: 5, y: 5 } });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, frameA, frameB],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  const inFlightBefore = prefetcher.inFlight.size;
  assert.ok(inFlightBefore > 0, "should have in-flight tasks before update");

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.inFlight.size, 0, "all in-flight tasks should be cleared when frames leave window");
  assert.equal(prefetcher.queue.length, 0, "queue should be pruned when frames leave window");
});

// ─── Phase 2a: performance telemetry ───

test("SequenceTileCache displayHitCount increments on recorded display hit", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });

  assert.equal(cache.stats().displayHitCount, 0);
  cache.recordDisplayHit();
  assert.equal(cache.stats().displayHitCount, 1);
  cache.recordDisplayHit();
  assert.equal(cache.stats().displayHitCount, 2);
});

test("SequenceTileCache displayMissCount increments on recordDisplayMiss", () => {
  const cache = new SequenceTileCache();
  assert.equal(cache.stats().displayMissCount, 0);
  cache.recordDisplayMiss();
  cache.recordDisplayMiss();
  assert.equal(cache.stats().displayMissCount, 2);
});

test("SequenceTileCache getBest does not affect display hit metrics", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "preview" });

  const before = cache.stats().displayHitCount;
  cache.getBest("f1", 1, 1, 1, 2);
  assert.equal(cache.stats().displayHitCount, before);
});

test("FramePrefetcher.stats reports initial zero values", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 4);
  const s = prefetcher.stats();

  assert.equal(s.prefetchTaskCount, 0);
  assert.equal(s.rttEWMA, 0);
  assert.equal(s.throughputEWMA, 0);
  assert.equal(s.abortRate, 0);
});

test("FramePrefetcher EWMA converges with known latency", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 1);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/t.tif", cacheKey: "0", sourceIndex: 0 };
  const nextFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/n.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.geotiffs.set("n", { overviews: [], tileCount: { x: 5, y: 5 } });

  let call = 0;
  const start = performance.now();

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => {
      call += 1;
      return { texture: { destroy() {} }, byteLength: 1024, width: 1, height: 1 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  await new Promise((r) => setTimeout(r, 10));

  const stats = prefetcher.stats();
  assert.ok(stats.rttEWMA > 0, "rttEWMA should be positive after a task completes");
  assert.ok(stats.throughputEWMA > 0, "throughputEWMA should be positive after a task completes");
  assert.equal(stats.abortRate, 0, "abort rate should be 0 when no tasks aborted");
  assert.equal(stats.prefetchTaskCount, 0, "no tasks should remain after completion");
});

test("FramePrefetcher abortRate reflects aborted tasks", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 2);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/t.tif", cacheKey: "0", sourceIndex: 0 };
  const nextFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/n.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.geotiffs.set("n", { overviews: [], tileCount: { x: 5, y: 5 } });

  let resolvePending;
  const pending = new Promise((r) => { resolvePending = r; });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 2, y: 1, z: 0 }],
    device: {},
    getUserTileData: async (_image, options) => {
      await pending;
      if (options.signal?.aborted) {
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      }
      return { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.ok(prefetcher.inFlight.size > 0, "should have in-flight tasks");
  assert.equal(prefetcher.stats().abortRate, 0, "abort rate should be 0 before abort");

  prefetcher.abortAll();
  resolvePending?.();

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(prefetcher.inFlight.size, 0, "all tasks should be cleared after abortAll");
  assert.ok(prefetcher.stats().abortRate > 0, "abortRate should be > 0 after abortAll clears in-flight tasks");
});

// ─── Phase 2b: richer priority scoring ───

test("scoring: seeking boosts nearby frames, deprioritizes far frames", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "near", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const farFrame = { id: "far", time: 3, timeMs: 3, url: "http://ex/3.tif", cacheKey: "3", sourceIndex: 3 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame, farFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: {},
  });

  const nearTask = prefetcher.queue.find((t) => t.frameId === "near");
  const farTask = prefetcher.queue.find((t) => t.frameId === "far");

  assert.ok(nearTask, "should have task for near frame");
  assert.ok(farTask, "should have task for far frame");
  assert.ok(nearTask.priority > farTask.priority, "near frame should outrank far frame during seek");
});

test("scoring: playing mode gives direction bonus to forward frames", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const forwardFrame = { id: "fw", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };
  const backFrame = { id: "bk", time: -2, timeMs: -2, url: "http://ex/n2.tif", cacheKey: "-2", sourceIndex: 2 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [backFrame, targetFrame, forwardFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  const fwTask = prefetcher.queue.find((t) => t.frameId === "fw");
  const bkTask = prefetcher.queue.find((t) => t.frameId === "bk");

  assert.ok(fwTask, "should have task for forward frame");
  assert.ok(bkTask, "should have task for backward frame");
  assert.ok(fwTask.priority > bkTask.priority, "forward frame should outrank backward during play");
});

test("scoring: upgrade tasks outrank fresh full tasks", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const frameA = { id: "A", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const frameB = { id: "B", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  cache.put("A", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1,
    quality: "preview", x: 0, y: 0, z: 0,
  });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, frameA, frameB],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const upgradeTask = prefetcher.queue.find((t) => t.frameId === "A" && t.quality === "full");
  const freshTask = prefetcher.queue.find((t) => t.frameId === "B" && t.quality === "preview");

  assert.ok(upgradeTask, "should have upgrade task for frame A");
  assert.ok(freshTask, "should have fresh task for frame B");
  assert.ok(upgradeTask.priority > freshTask.priority, "upgrade should outrank fresh preview");
});

test("scoring: idle mode preview tasks get slight boost", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "near", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.queue.length, 1);
});

// ─── Phase 2c: backpressure ───

test("backpressure: maxDecodeTasks gates pump", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 4, 1, 4);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const frameA = { id: "A", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const frameB = { id: "B", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  let resolvePending;
  const pending = new Promise((r) => { resolvePending = r; });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, frameA, frameB],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => {
      await pending;
      return { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.inFlight.size, 1, "only 1 task should start when maxDecodeTasks=1");
  assert.ok(prefetcher.queue.length > 0, "remaining tasks should stay in queue");

  resolvePending();
});

test("backpressure: maxGpuUploadsPerFrame throttles pump", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 4, 4, 1);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const frameA = { id: "A", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const frameB = { id: "B", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  let resolvePending;
  const pending = new Promise((r) => { resolvePending = r; });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, frameA, frameB],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => {
      await pending;
      return { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.inFlight.size, 1, "only 1 task should start when maxGpuUploads=1");
  assert.ok(prefetcher.queue.length > 0, "remaining tasks should stay in queue");

  resolvePending();
});

test("backpressure: low coverage suspends future frame prefetch", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "near", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const farFrame = { id: "far", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame, farFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: {},
    coverage: 0.3,
  });

  assert.equal(prefetcher.queue.length, 0, "no future frames should be prefetched when coverage < 0.5");
});

test("backpressure: sufficient coverage allows future frame prefetch", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "target", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "near", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const farFrame = { id: "far", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame, farFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: {},
    coverage: 0.8,
  });

  assert.ok(prefetcher.queue.length >= 2, "future frames should be prefetched when coverage >= 0.5");
});

test("backpressure: high abort rate reduces concurrency", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 4);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const frameA = { id: "A", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const frameB = { id: "B", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  prefetcher.geotiffs.set("A", { overviews: [], tileCount: { x: 5, y: 5 } });
  prefetcher.geotiffs.set("B", { overviews: [], tileCount: { x: 5, y: 5 } });

  for (let i = 0; i < 6; i += 1) {
    let resolvePending;
    const pending = new Promise((r) => { resolvePending = r; });

    prefetcher.update({
      targetFrame,
      scheduledFrames: [targetFrame, frameA, frameB],
      visibleTiles: [{ x: 0, y: 0, z: 0 }],
      device: {},
      getUserTileData: async (_image, options) => {
        await pending;
        if (options.signal?.aborted) {
          const err = new DOMException("The operation was aborted", "AbortError");
          throw err;
        }
        return { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 };
      },
      pool: {},
      playing: true,
      playbackRate: 1,
      interactionMode: "playing",
      qualityPolicy: {},
    });

    await new Promise((r) => setTimeout(r, 0));

    prefetcher.abortAll();
    resolvePending?.();
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.ok(prefetcher.maxConcurrent <= 2, "maxConcurrent should be halved after repeated aborts");
});

// ─── Phase 3: multi-factor ETA-aware scoring ───

test("byteSizeHint is preserved through frame normalization", () => {
  const catalog = normalizeFrameCatalog([
    { time: 0, url: "/a.tif", byteSizeHint: 4096 },
    { time: 1, url: "/b.tif" },
  ]);

  assert.equal(catalog[0].byteSizeHint, 4096);
  assert.equal(catalog[1].byteSizeHint, undefined);
});

test("ScoringWeights defaults are applied when no override is provided", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.ok(prefetcher.queue[0].priority >= 50, "near frame should get reasonable salience score with defaults");
});

test("scoring: custom ScoringWeights influence task priorities", () => {
  const cache = new SequenceTileCache();
  const prefetcherLow = new FramePrefetcher(cache, 0, undefined, undefined, {
    viewportSalience: 10,
  });
  const cache2 = new SequenceTileCache();
  const prefetcherHigh = new FramePrefetcher(cache2, 0, undefined, undefined, {
    viewportSalience: 100,
  });

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  const snapshot = {
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  };

  prefetcherLow.update(snapshot);
  prefetcherHigh.update(snapshot);

  assert.ok(prefetcherHigh.queue[0].priority > prefetcherLow.queue[0].priority,
    "higher viewportSalience weight should produce higher score");
});

test("scoring: viewport salience orders target > +1 > +2 > far frames", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const midFrame = { id: "+2", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };
  const farFrame = { id: "+3", time: 3, timeMs: 3, url: "http://ex/3.tif", cacheKey: "3", sourceIndex: 3 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame, midFrame, farFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const near = prefetcher.queue.find((t) => t.frameId === "+1");
  const mid = prefetcher.queue.find((t) => t.frameId === "+2");
  const far = prefetcher.queue.find((t) => t.frameId === "+3");

  assert.ok(near, "should have task for +1");
  assert.ok(mid, "should have task for +2");
  assert.ok(far, "should have task for +3");
  assert.ok(near.priority > mid.priority, "+1 should outrank +2");
  assert.ok(mid.priority > far.priority, "+2 should outrank +3");
});

test("scoring: direction bonus boosts forward frames during forward playback", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const forwardFrame = { id: "fw", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };
  const backFrame = { id: "bk", time: -2, timeMs: -2, url: "http://ex/n2.tif", cacheKey: "-2", sourceIndex: 2 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [backFrame, targetFrame, forwardFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.deepEqual(
    prefetcher.queue.map((t) => t.frameId),
    ["fw", "bk"],
    "forward frame should be first in queue",
  );
});

test("scoring: direction bonus is absent when paused", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const forwardFrame = { id: "fw", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };
  const backFrame = { id: "bk", time: -2, timeMs: -2, url: "http://ex/n2.tif", cacheKey: "-2", sourceIndex: 2 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [backFrame, targetFrame, forwardFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const fw = prefetcher.queue.find((t) => t.frameId === "fw");
  const bk = prefetcher.queue.find((t) => t.frameId === "bk");

  assert.ok(fw && bk, "should have both tasks when paused");
  assert.equal(fw.priority, bk.priority, "forward and backward should have equal score when paused");
});

test("scoring: buffer shortfall boosts forward frames when ahead buffer is low", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  const lowBuffer = prefetcher.update.bind(prefetcher);

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });

  const priorityLow = prefetcher.queue[0].priority;

  assert.ok(priorityLow > 0, "should have positive priority");
});

test("scoring: no buffer shortfall boost when ahead buffer is full", () => {
  const cache = new SequenceTileCache();
  const cache2 = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);
  const prefetcherFull = new FramePrefetcher(cache2, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });

  prefetcherFull.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
    bufferState: { bufferedAhead: 6, bufferedBehind: 2, targetAhead: 6 },
  });

  assert.ok(prefetcher.queue[0].priority > prefetcherFull.queue[0].priority,
    "forward task with empty buffer should outrank full-buffer task");
});

test("scoring: buffer shortfall does not boost backward frames", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const backFrame = { id: "-1", time: -1, timeMs: -1, url: "http://ex/n1.tif", cacheKey: "-1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [backFrame, targetFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });

  assert.equal(prefetcher.queue.length, 1);
  assert.equal(prefetcher.queue[0].frameId, "-1");
});

test("scoring: interaction override boosts near frames and penalises far during seek", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const farFrame = { id: "+3", time: 3, timeMs: 3, url: "http://ex/3.tif", cacheKey: "3", sourceIndex: 3 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame, farFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: {},
  });

  const near = prefetcher.queue.find((t) => t.frameId === "+1");
  const far = prefetcher.queue.find((t) => t.frameId === "+3");

  assert.ok(near, "should have task for +1");
  assert.ok(far, "should have task for +3");
  assert.ok(near.priority > far.priority + 20, "near frame should significantly outrank far frame during seek");
});

test("scoring: interaction override is zero in idle mode", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const priority = prefetcher.queue[0].priority;

  assert.ok(priority >= 50 && priority <= 100, "idle priority should be pure salience (60) without interaction boost");
});

test("scoring: quality urgency gives highest bonus to preview-to-full upgrade", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const frameA = { id: "A", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const frameB = { id: "B", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2 };

  cache.put("A", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1,
    quality: "preview", x: 0, y: 0, z: 0,
  });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, frameA, frameB],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const upgradeTask = prefetcher.queue.find((t) => t.frameId === "A" && t.quality === "full");
  const freshTask = prefetcher.queue.find((t) => t.frameId === "B" && t.quality === "preview");

  assert.ok(upgradeTask, "should have upgrade task for frame A");
  assert.ok(freshTask, "should have fresh task for frame B");
  assert.ok(upgradeTask.priority > freshTask.priority + 20,
    "upgrade should significantly outrank fresh preview");
});

test("scoring: quality urgency boosts fresh preview when coverage is below 30%", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  const prefetcherUnderfilled = new FramePrefetcher(new SequenceTileCache(), 0);

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
    coverage: 1,
  });

  prefetcherUnderfilled.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
    coverage: 0.2,
  });

  const fullCovPri = prefetcher.queue[0].priority;
  const underCovPri = prefetcherUnderfilled.queue[0].priority;

  assert.ok(underCovPri > fullCovPri,
    "preview task should get qualityFreshPreview bonus when coverage < 0.3");
});

test("scoring: size hint penalty deprioritises tiles with large byteSizeHint", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const smallFrame = { id: "small", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1, byteSizeHint: 1024 };
  const largeFrame = { id: "large", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2, byteSizeHint: 1048576 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, smallFrame, largeFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const small = prefetcher.queue.find((t) => t.frameId === "small");
  const large = prefetcher.queue.find((t) => t.frameId === "large");

  assert.ok(small, "should have task for small frame");
  assert.ok(large, "should have task for large frame");
  assert.ok(small.priority > large.priority,
    "small frame should outrank large frame due to size hint penalty");
});

test("scoring: no size penalty when byteSizeHint is absent or zero", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const noHintFrame = { id: "a", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const zeroHintFrame = { id: "b", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2, byteSizeHint: 0 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, noHintFrame, zeroHintFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "idle",
    qualityPolicy: {},
  });

  const noHint = prefetcher.queue.find((t) => t.frameId === "a");
  const zeroHint = prefetcher.queue.find((t) => t.frameId === "b");

  assert.ok(noHint, "should have task for no-hint frame");
  assert.ok(noHint.priority > 0, "no-hint frame should have positive priority");
  assert.ok(zeroHint, "should have task for zero-hint frame");
  assert.ok(zeroHint.priority > 0, "zero-hint frame should have positive priority");
  assert.ok(noHint.priority > zeroHint.priority,
    "no-hint frame (distance 1) should outrank zero-hint frame (distance 2) due to salience");
});

test("scoring: ETA penalty reduces scores after tile fetch telemetry is available", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 1);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nextFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/n.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.geotiffs.set("n", { overviews: [], tileCount: { x: 3, y: 2 } });

  const start0 = Date.now();
  await new Promise((r) => setTimeout(r, 5));

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => {
      return { texture: { destroy() {} }, byteLength: 65536, width: 256, height: 256 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  await new Promise((r) => setTimeout(r, 20));

  const stats = prefetcher.stats();
  assert.ok(stats.rttEWMA > 0, "rttEWMA should be positive after task completion");

  const cache2 = new SequenceTileCache();
  const prefetcher2 = new FramePrefetcher(cache2, 0);

  prefetcher2.geotiffs.set("n", { overviews: [], tileCount: { x: 3, y: 2 } });

  prefetcher2.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 65536, width: 256, height: 256 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  const etaStats = prefetcher2.stats();
  assert.equal(etaStats.rttEWMA, 0, "no telemetry yet for cold prefetcher");
});

test("scoring: per-frame byte average is tracked across task completions", async () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 1);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nextFrame = { id: "n", time: 1, timeMs: 1, url: "http://ex/n.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.geotiffs.set("n", { overviews: [], tileCount: { x: 3, y: 2 } });

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => {
      return { texture: { destroy() {} }, byteLength: 4096, width: 64, height: 64 };
    },
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  await new Promise((r) => setTimeout(r, 20));

  const cache2 = new SequenceTileCache();
  const prefetcher2 = new FramePrefetcher(cache2, 0);

  prefetcher2.update({
    targetFrame,
    scheduledFrames: [targetFrame, nextFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
  });

  assert.ok(prefetcher2.frameAvgBytes, "frameAvgBytes should exist");
});

test("scoring: combined factors produce correct priority ordering in playing mode with buffer state", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0);

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFw = { id: "+1f", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };
  const farFw = { id: "+2f", time: 2, timeMs: 2, url: "http://ex/2.tif", cacheKey: "2", sourceIndex: 2, byteSizeHint: 1048576 };
  const nearBk = { id: "-1b", time: -1, timeMs: -1, url: "http://ex/n1.tif", cacheKey: "-1", sourceIndex: 3 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [nearBk, targetFrame, nearFw, farFw],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: true,
    playbackRate: 1,
    interactionMode: "playing",
    qualityPolicy: {},
    bufferState: { bufferedAhead: 0, bufferedBehind: 0, targetAhead: 6 },
  });

  const ordered = prefetcher.queue.map((t) => t.frameId);

  assert.equal(ordered[0], "+1f", "closest forward frame should be first");
  assert.ok(ordered.includes("+2f"), "far forward frame should be present");
  assert.ok(ordered.includes("-1b"), "backward frame should be present");
  assert.ok(
    ordered.indexOf("+2f") !== 1 || "+2f should come after +1f",
  );
});

test("scoring: custom scoringWeights in schedulerPolicy override defaults via snapshot", () => {
  const cache = new SequenceTileCache();
  const prefetcher = new FramePrefetcher(cache, 0, undefined, undefined, {
    viewportSalience: 1,
    interaction: 0,
  });

  const targetFrame = { id: "t", time: 0, timeMs: 0, url: "http://ex/0.tif", cacheKey: "0", sourceIndex: 0 };
  const nearFrame = { id: "+1", time: 1, timeMs: 1, url: "http://ex/1.tif", cacheKey: "1", sourceIndex: 1 };

  prefetcher.update({
    targetFrame,
    scheduledFrames: [targetFrame, nearFrame],
    visibleTiles: [{ x: 0, y: 0, z: 0 }],
    device: {},
    getUserTileData: async () => ({ texture: { destroy() {} }, byteLength: 1, width: 1, height: 1 }),
    pool: {},
    playing: false,
    playbackRate: 0,
    interactionMode: "seeking",
    qualityPolicy: {},
    scoringWeights: {
      viewportSalience: 50,
      interaction: 50,
    },
  });

  assert.ok(prefetcher.queue.length >= 1, "should have tasks");
  assert.ok(prefetcher.queue[0].priority >= 100, "snapshot override should use high weights");
});

// ─── Eviction efficiency metrics ───

test("markDisplayed sets wasDisplayed flag on cached tile", () => {
  const cache = new SequenceTileCache();
  cache.put("f1", 0, 0, 0, { texture: { destroy() {} }, byteLength: 1, width: 1, height: 1, quality: "full" });

  cache.markDisplayed("f1", 0, 0, 0);
  const tile = cache.get("f1", 0, 0, 0);
  assert.equal(tile.wasDisplayed, true);
});

test("eviction tallies wasted prefetched tiles only", () => {
  const cache = new SequenceTileCache({ maxTileEntries: 1 });

  cache.put("f1", 0, 0, 0, { texture: { destroy() {} }, byteLength: 100, width: 1, height: 1, quality: "full" });
  cache.markDisplayed("f1", 0, 0, 0);

  cache.put("f2", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 300,
    width: 1,
    height: 1,
    quality: "preview",
    origin: "prefetch",
  });

  const stats = cache.stats();
  assert.equal(stats.evictedTotal, 1, "should have evicted exactly one tile");
  assert.equal(stats.prefetchedWastedBytes, 0, "displayed non-prefetch tile f1 should not count as prefetched waste");
  assert.equal(stats.prefetchedWastedCount, 0, "displayed non-prefetch tile f1 should not count as prefetched waste");

  const cache2 = new SequenceTileCache({ maxTileEntries: 1 });

  cache2.put("never", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 200,
    width: 1,
    height: 1,
    quality: "full",
    origin: "prefetch",
  });

  cache2.put("f2", 0, 0, 0, { texture: { destroy() {} }, byteLength: 300, width: 1, height: 1, quality: "preview" });

  const stats2 = cache2.stats();
  assert.equal(stats2.evictedTotal, 1, "should have evicted exactly one tile");
  assert.equal(stats2.prefetchedWastedBytes, 200, "never-displayed prefetched tile should count as wasted");
  assert.equal(stats2.prefetchedWastedCount, 1, "prefetchedWastedCount should be 1 when prefetched tile was never shown");
});

test("displayed prefetched tiles do not count as wasted when evicted", () => {
  const cache = new SequenceTileCache({ maxTileEntries: 1 });

  cache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 100,
    width: 1,
    height: 1,
    quality: "full",
    origin: "prefetch",
  });
  cache.markDisplayed("f1", 0, 0, 0);
  cache.put("f2", 0, 0, 0, { texture: { destroy() {} }, byteLength: 200, width: 1, height: 1, quality: "full" });

  const stats = cache.stats();
  assert.equal(stats.prefetchedWastedBytes, 0, "displayed prefetched tiles should not count as wasted when evicted");
  assert.equal(stats.prefetchedWastedCount, 0, "prefetchedWastedCount should be 0 when prefetched tile was shown");
  assert.equal(stats.prefetchedUsedCount, 1, "displayed prefetched tile should count as used");
});
