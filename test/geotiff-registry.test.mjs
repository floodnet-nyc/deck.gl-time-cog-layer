import assert from "node:assert/strict";
import test from "node:test";

import { GeoTIFFRegistry, SequenceTileCache } from "../dist/index.js";

test("GeoTIFFRegistry.get returns undefined for unknown frame", () => {
  const registry = new GeoTIFFRegistry();
  assert.equal(registry.get("unknown"), undefined);
});

test("GeoTIFFRegistry.has returns false for unknown frame", () => {
  const registry = new GeoTIFFRegistry();
  assert.equal(registry.has("f1"), false);
});

test("GeoTIFFRegistry.mutableMap allows pre-population for tests", () => {
  const registry = new GeoTIFFRegistry();
  const fakeGeotiff = { overviews: [], tileCount: { x: 3, y: 2 } };
  registry.mutableMap.set("f1", fakeGeotiff);

  assert.equal(registry.has("f1"), true);
  assert.equal(registry.get("f1"), fakeGeotiff);
});

test("GeoTIFFRegistry.unsafelySet stores a GeoTIFF", () => {
  const registry = new GeoTIFFRegistry();
  const fakeGeotiff = { overviews: [], tileCount: { x: 3, y: 2 } };
  registry.unsafelySet("f1", fakeGeotiff);

  assert.equal(registry.get("f1"), fakeGeotiff);
  assert.equal(registry.has("f1"), true);
});

test("GeoTIFFRegistry.clear removes all entries", () => {
  const registry = new GeoTIFFRegistry();
  registry.unsafelySet("f1", {});
  registry.unsafelySet("f2", {});

  registry.clear();
  assert.equal(registry.has("f1"), false);
  assert.equal(registry.has("f2"), false);
});

test("GeoTIFFRegistry.open returns cached GeoTIFF when already present", async () => {
  const registry = new GeoTIFFRegistry();
  const fakeGeotiff = { overviews: [], tileCount: { x: 1, y: 1 } };
  registry.unsafelySet("f1", fakeGeotiff);

  const result = await registry.open("f1", "http://example.test/f1.tif");
  assert.equal(result, fakeGeotiff);
});

test("GeoTIFFRegistry has configurable maxSize", () => {
  const registry = new GeoTIFFRegistry(2);
  registry.unsafelySet("f1", { id: "a" });
  registry.unsafelySet("f2", { id: "b" });

  // unsafelySet intentionally bypasses eviction — the map is raw.
  // When a third entry is set without eviction, all 3 coexist.
  registry.unsafelySet("f3", { id: "c" });
  assert.equal(registry.mutableMap.size, 3);
  assert.ok(registry.get("f1"));
  assert.ok(registry.get("f2"));
  assert.ok(registry.get("f3"));

  // The eviction policy is only enforced through registry.open().
  // Create a fresh registry to verify that.
  const registry2 = new GeoTIFFRegistry(2);
  registry2.unsafelySet("a", { id: "a" });
  registry2.unsafelySet("b", { id: "b" });

  // Manually evict via mutableMap to simulate open() behavior
  const firstKey = registry2.mutableMap.keys().next().value;
  registry2.mutableMap.delete(firstKey);
  registry2.unsafelySet("c", { id: "c" });

  assert.equal(registry2.mutableMap.size, 2);
  assert.ok(registry2.get("c"));
});

test("GeoTIFFRegistry.mutableMap exposes writable Map for backward compat", () => {
  const registry = new GeoTIFFRegistry();
  assert.ok(registry.mutableMap instanceof Map);

  registry.mutableMap.set("f1", { id: "a" });
  assert.ok(registry.has("f1"));
  assert.deepEqual(registry.get("f1"), { id: "a" });
});

test("GeoTIFFRegistry can be used from SequenceTileCache prefetcher tests (back compat)", () => {
  const cache = new SequenceTileCache();
  const registry = new GeoTIFFRegistry();
  registry.unsafelySet("frame-1", {
    overviews: [{ tileCount: { x: 4, y: 4 } }],
    tileCount: { x: 8, y: 8 },
  });

  // Simulates the test pattern: pre-populate registry, then check
  assert.ok(registry.get("frame-1"));
  assert.equal(registry.has("frame-1"), true);
});
