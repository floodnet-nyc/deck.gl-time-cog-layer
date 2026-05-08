import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameCache,
  canonicalizeUrl,
  findNearestFrameIndex,
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

test("evicts frame cache entries by count and byte policy", () => {
  const catalog = normalizeFrameCatalog([
    { time: 0, url: "/0.tif" },
    { time: 1, url: "/1.tif" },
    { time: 2, url: "/2.tif" },
  ]);
  const cache = new FrameCache({ maxFrames: 2, memoryBytes: 10 });

  cache.touch(catalog[0], 4);
  cache.touch(catalog[1], 4);
  cache.touch(catalog[2], 4);

  assert.equal(cache.entries.size, 2);

  cache.updatePolicy({ memoryBytes: 4 });
  assert.equal(cache.entries.size, 1);
});
