import assert from "node:assert/strict";
import test from "node:test";

import { TaskQueue, taskKey, SequenceTileCache } from "../src/index.ts";

test("TaskQueue starts with empty queue, queuedKeys, inFlight", () => {
  const q = new TaskQueue();
  assert.equal(q.queue.length, 0);
  assert.equal(q.queuedKeys.size, 0);
  assert.equal(q.inFlight.size, 0);
  assert.equal(q.activeCount, 0);
  assert.equal(q.pendingCount, 0);
});

test("TaskQueue.enqueue inserts and sorts by priority descending", () => {
  const q = new TaskQueue();
  q.enqueue([
    { frameId: "a", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/a.tif" },
    { frameId: "b", x: 0, y: 0, z: 0, priority: 50, quality: "preview", frameUrl: "/b.tif" },
    { frameId: "c", x: 0, y: 0, z: 0, priority: 30, quality: "preview", frameUrl: "/c.tif" },
  ]);

  assert.equal(q.queue.length, 3);
  assert.equal(q.queue[0].frameId, "b");
  assert.equal(q.queue[1].frameId, "c");
  assert.equal(q.queue[2].frameId, "a");
});

test("TaskQueue.dequeue removes highest-priority task", () => {
  const q = new TaskQueue();
  q.enqueue([
    { frameId: "a", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/a.tif" },
    { frameId: "b", x: 0, y: 0, z: 0, priority: 50, quality: "preview", frameUrl: "/b.tif" },
  ]);

  const t1 = q.dequeue();
  assert.equal(t1.frameId, "b");
  assert.equal(q.queue.length, 1);

  const t2 = q.dequeue();
  assert.equal(t2.frameId, "a");
  assert.equal(q.queue.length, 0);

  assert.equal(q.dequeue(), undefined);
});

test("TaskQueue.prune removes tasks for unscheduled frames", () => {
  const q = new TaskQueue();
  const tileCache = new SequenceTileCache();

  q.enqueue([
    { frameId: "f1", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/f1" },
    { frameId: "f2", x: 0, y: 0, z: 0, priority: 50, quality: "preview", frameUrl: "/f2" },
    { frameId: "f3", x: 0, y: 0, z: 0, priority: 30, quality: "preview", frameUrl: "/f3" },
  ]);

  q.prune(new Set(["f1", "f3"]), tileCache);

  assert.equal(q.queue.length, 2);
  assert.equal(q.queue[0].frameId, "f3");
  assert.equal(q.queue[1].frameId, "f1");
});

test("TaskQueue.prune removes tasks for tiles already in cache", () => {
  const q = new TaskQueue();
  const tileCache = new SequenceTileCache();
  tileCache.put("f1", 0, 0, 0, {
    texture: { destroy() {} },
    byteLength: 1, width: 1, height: 1, quality: "full",
  });

  q.enqueue([
    { frameId: "f1", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/f1" },
    { frameId: "f2", x: 0, y: 0, z: 0, priority: 50, quality: "preview", frameUrl: "/f2" },
  ]);

  q.prune(new Set(["f1", "f2"]), tileCache);

  assert.equal(q.queue.length, 1);
  assert.equal(q.queue[0].frameId, "f2");
});

test("TaskQueue.prune deduplicates by key", () => {
  const q = new TaskQueue();
  const tileCache = new SequenceTileCache();

  q.enqueue([
    { frameId: "f1", x: 0, y: 0, z: 0, priority: 50, quality: "preview", frameUrl: "/f1" },
    { frameId: "f1", x: 0, y: 0, z: 0, priority: 40, quality: "preview", frameUrl: "/f1" },
  ]);

  q.prune(new Set(["f1"]), tileCache);

  assert.equal(q.queue.length, 1);
});

test("TaskQueue.abortStale aborts in-flight tasks for unscheduled frames", () => {
  const q = new TaskQueue();
  const ctrl = new AbortController();
  q.start("f1:0:0:0", ctrl, "f1");
  q.start("f2:0:0:0", new AbortController(), "f2");

  assert.equal(q.inFlight.size, 2);

  q.abortStale(new Set(["f1"]));

  assert.equal(q.inFlight.size, 1); // f2 aborted and removed
  assert.ok(q.inFlight.has("f1:0:0:0"));
  assert.ok(!q.inFlight.has("f2:0:0:0"));
});

test("TaskQueue.start registers an in-flight task", () => {
  const q = new TaskQueue();
  const ctrl = new AbortController();
  q.start("f1:0:0:0", ctrl, "f1");

  assert.equal(q.inFlight.size, 1);
  const entry = q.inFlight.get("f1:0:0:0");
  assert.ok(entry);
  assert.equal(entry.frameId, "f1");
  assert.equal(entry.controller, ctrl);
});

test("TaskQueue.finish removes an in-flight task", () => {
  const q = new TaskQueue();
  q.start("f1:0:0:0", new AbortController(), "f1");
  assert.equal(q.inFlight.size, 1);

  q.finish("f1:0:0:0");
  assert.equal(q.inFlight.size, 0);
});

test("TaskQueue.isTracked returns true for queued keys", () => {
  const q = new TaskQueue();
  q.markQueued("f1:0:0:0");
  assert.equal(q.isTracked("f1:0:0:0"), true);
  assert.equal(q.isTracked("f2:0:0:0"), false);
});

test("TaskQueue.isTracked returns true for in-flight keys", () => {
  const q = new TaskQueue();
  q.start("f1:0:0:0", new AbortController(), "f1");
  assert.equal(q.isTracked("f1:0:0:0"), true);
});

test("TaskQueue.unmarkQueued removes a key from dedup set", () => {
  const q = new TaskQueue();
  q.markQueued("f1:0:0:0");
  q.unmarkQueued("f1:0:0:0");
  assert.equal(q.isTracked("f1:0:0:0"), false);
});

test("TaskQueue.abortAll aborts all in-flight tasks and clears queues", () => {
  const q = new TaskQueue();
  const ctrl = new AbortController();
  q.start("f1:0:0:0", ctrl, "f1");
  q.start("f2:0:0:0", new AbortController(), "f2");
  q.markQueued("f3:0:0:0");
  q.enqueue([{ frameId: "f3", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/f3" }]);

  q.abortAll();

  assert.equal(q.inFlight.size, 0);
  assert.equal(q.queue.length, 0);
  assert.equal(q.queuedKeys.size, 0);
  assert.ok(ctrl.signal.aborted);
});

test("TaskQueue.getInFlightKeys returns all active keys", () => {
  const q = new TaskQueue();
  q.start("f1:1:2:3", new AbortController(), "f1");
  q.start("f2:4:5:6", new AbortController(), "f2");

  const keys = q.getInFlightKeys().sort();
  assert.deepEqual(keys, ["f1:1:2:3", "f2:4:5:6"]);
});

test("taskKey helper formats correctly", () => {
  assert.equal(taskKey("frame-1", 3, 5, 7), "frame-1:3:5:7");
  assert.equal(taskKey("a:b", 0, 0, 0), "a:b:0:0:0");
});

test("TaskQueue.activeCount reflects in-flight size", () => {
  const q = new TaskQueue();
  assert.equal(q.activeCount, 0);
  q.start("a:0:0:0", new AbortController(), "a");
  assert.equal(q.activeCount, 1);
  q.finish("a:0:0:0");
  assert.equal(q.activeCount, 0);
});

test("TaskQueue.pendingCount reflects queue length", () => {
  const q = new TaskQueue();
  assert.equal(q.pendingCount, 0);
  q.enqueue([{ frameId: "a", x: 0, y: 0, z: 0, priority: 10, quality: "preview", frameUrl: "/a" }]);
  assert.equal(q.pendingCount, 1);
});
