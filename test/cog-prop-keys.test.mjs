import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCOGLayerProps,
  TIME_COG_EXCLUDED_KEYS,
} from "../dist/index.js";

test("TIME_COG_EXCLUDED_KEYS contains all orchestration keys", () => {
  const set = new Set(TIME_COG_EXCLUDED_KEYS);
  assert.ok(set.has("id"));
  assert.ok(set.has("frames"));
  assert.ok(set.has("currentTime"));
  assert.ok(set.has("playing"));
  assert.ok(set.has("playbackRate"));
  assert.ok(set.has("maxFrameRate"));
  assert.ok(set.has("missingFramePolicy"));
  assert.ok(set.has("bufferPolicy"));
  assert.ok(set.has("cachePolicy"));
  assert.ok(set.has("qualityPolicy"));
  assert.ok(set.has("schedulerPolicy"));
  assert.ok(set.has("descriptorMode"));
  assert.ok(set.has("descriptorManifest"));
  assert.ok(set.has("onFrameReady"));
  assert.ok(set.has("onFrameDisplayed"));
  assert.ok(set.has("onMissingFrame"));
  assert.ok(set.has("onDescriptorMismatch"));
  assert.ok(set.has("onBufferStateChange"));
  assert.ok(set.has("onStats"));
  assert.ok(set.has("onGeoTIFFLoad"));
  assert.ok(set.has("getTileData"));
  assert.ok(set.has("renderTile"));
  assert.equal(TIME_COG_EXCLUDED_KEYS.length, 22);
});

test("extractCOGLayerProps removes all TimeCOG-specific orchestration props", () => {
  const props = {
    id: "demo",
    frames: [{ time: 0, url: "/0.tif" }],
    currentTime: 0,
    playing: false,
    playbackRate: 1,
    maxFrameRate: 10,
    missingFramePolicy: "nearest",
    bufferPolicy: { forwardFrames: 3 },
    cachePolicy: { maxFrames: 120 },
    qualityPolicy: { lowResFirst: false },
    schedulerPolicy: {},
    descriptorMode: "reuse-first",
    descriptorManifest: null,
    onFrameReady: () => {},
    onFrameDisplayed: () => {},
    onMissingFrame: () => {},
    onDescriptorMismatch: () => {},
    onBufferStateChange: () => {},
    onStats: () => {},
    onGeoTIFFLoad: () => {},
    getTileData: () => {},
    renderTile: () => {},
    // These COG base props should pass through
    opacity: 0.86,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 18,
    colormap: "viridis",
  };

  const result = extractCOGLayerProps(props);

  assert.equal(result.opacity, 0.86);
  assert.equal(result.tileSize, 256);
  assert.equal(result.minZoom, 0);
  assert.equal(result.maxZoom, 18);
  assert.equal(result.colormap, "viridis");

  // Verify none of the removed keys leaked through
  for (const key of TIME_COG_EXCLUDED_KEYS) {
    assert.equal(key in result, false, `key "${key}" should not appear in result`);
  }
});

test("extractCOGLayerProps preserves loadOptions when present", () => {
  const props = {
    id: "demo",
    frames: [],
    currentTime: 0,
    opacity: 1,
    loadOptions: {
      fetch: { headers: { Authorization: "Bearer t" } },
    },
  };

  const result = extractCOGLayerProps(props);

  assert.deepEqual(result.loadOptions, {
    fetch: { headers: { Authorization: "Bearer t" } },
  });
  assert.equal(result.opacity, 1);
});

test("extractCOGLayerProps handles empty object gracefully", () => {
  const result = extractCOGLayerProps({});
  assert.deepEqual(result, {});
});

test("extractCOGLayerProps returns a new object (does not mutate input)", () => {
  const props = { opacity: 1, id: "test" };
  const result = extractCOGLayerProps(props);

  assert.equal(result.opacity, 1);
  assert.equal(props.id, "test");
  assert.notEqual(result, props);
});
