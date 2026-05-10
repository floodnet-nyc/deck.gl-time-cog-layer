import type { SequenceTileCache } from "./sequence-tile-cache.js";
import type { TileQuality } from "./sequence-tile-cache.js";

export type TileCoord = { x: number; y: number; z: number };

export type TileTask = {
  frameId: string;
  frameUrl: string;
  requestInit?: RequestInit;
  x: number;
  y: number;
  z: number;
  quality: TileQuality;
  priority: number;
  byteSizeHint?: number;
};

export function taskKey(
  frameId: string,
  x: number,
  y: number,
  z: number,
): string {
  return `${frameId}:${x}:${y}:${z}`;
}

/**
 * Priority-ordered queue of tile-fetch tasks with deduplication and
 * in-flight tracking.
 *
 * Owns `queue` (sorted by priority descending), `queuedKeys` (dedup
 * set), and `inFlight` (abort-aware task registry).  The external
 * prefetcher wires the actual execution; this class handles insertion,
 * pruning, and lifecycle.
 */
export class TaskQueue {
  queue: TileTask[] = [];
  queuedKeys = new Set<string>();
  inFlight = new Map<string, { controller: AbortController; frameId: string }>();

  get activeCount(): number {
    return this.inFlight.size;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /** Add tasks, then re-sort by priority (highest first). */
  enqueue(tasks: TileTask[]): void {
    this.queue.push(...tasks);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  /** Remove and return the highest-priority task, or undefined. */
  dequeue(): TileTask | undefined {
    return this.queue.shift();
  }

  /**
   * Drop queued tasks for frames no longer in the schedule window and
   * tasks whose tiles are already cached.
   */
  prune(scheduledIds: Set<string>, tileCache: SequenceTileCache): void {
    const nextQueue: TileTask[] = [];
    const nextKeys = new Set<string>();

    for (const task of this.queue) {
      if (!scheduledIds.has(task.frameId)) continue;
      if (tileCache.get(task.frameId, task.x, task.y, task.z)) continue;

      const key = taskKey(task.frameId, task.x, task.y, task.z);
      if (nextKeys.has(key)) continue;

      nextQueue.push(task);
      nextKeys.add(key);
    }

    this.queue = nextQueue;
    this.queuedKeys = nextKeys;
  }

  /**
   * Abort in-flight tasks whose frame is no longer in the schedule
   * window.  Called on every `update()` before enqueuing new work.
   */
  abortStale(scheduledIds: Set<string>): void {
    const toAbort: string[] = [];

    for (const [key, entry] of this.inFlight) {
      if (!scheduledIds.has(entry.frameId)) {
        entry.controller.abort();
        toAbort.push(key);
      }
    }

    for (const key of toAbort) {
      this.inFlight.delete(key);
    }
  }

  /** Register an in-flight task with its abort controller. */
  start(key: string, controller: AbortController, frameId: string): void {
    this.inFlight.set(key, { controller, frameId });
  }

  /** Remove a completed or aborted task from in-flight tracking. */
  finish(key: string): void {
    this.inFlight.delete(key);
  }

  /** Check whether a key is already queued or in-flight. */
  isTracked(key: string): boolean {
    return this.queuedKeys.has(key) || this.inFlight.has(key);
  }

  /** Mark a key as queued (decoupled from `enqueue` for external coordination). */
  markQueued(key: string): void {
    this.queuedKeys.add(key);
  }

  /** Remove a key from the dedup set (called when dequeueing for execution). */
  unmarkQueued(key: string): void {
    this.queuedKeys.delete(key);
  }

  /** Abort all in-flight tasks and clear the queue. */
  abortAll(): void {
    for (const [, entry] of this.inFlight) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.queue.length = 0;
    this.queuedKeys.clear();
  }

  getInFlightKeys(): string[] {
    return [...this.inFlight.keys()];
  }
}
