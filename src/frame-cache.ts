import type {
  NormalizedTimeCOGFrame,
  TimeCOGCachePolicy,
  TimeCOGStats,
} from "./types.js";

export type FrameCacheEntry = {
  frame: NormalizedTimeCOGFrame;
  ready: boolean;
  byteLength: number;
  tileEntries: number;
  lastAccessMs: number;
};

export class FrameCache {
  readonly entries = new Map<string, FrameCacheEntry>();
  private policy: TimeCOGCachePolicy;

  constructor(policy: TimeCOGCachePolicy = {}) {
    this.policy = policy;
  }

  updatePolicy(policy: TimeCOGCachePolicy = {}): void {
    this.policy = policy;
    this.evict();
  }

  touch(frame: NormalizedTimeCOGFrame, byteLength = 0, tileEntries = 0): FrameCacheEntry {
    const existing = this.entries.get(frame.id);
    const entry: FrameCacheEntry = {
      frame,
      ready: existing?.ready ?? false,
      byteLength: Math.max(existing?.byteLength ?? 0, byteLength),
      tileEntries: Math.max(existing?.tileEntries ?? 0, tileEntries),
      lastAccessMs: Date.now(),
    };

    this.entries.set(frame.id, entry);
    this.evict();
    return entry;
  }

  markReady(frame: NormalizedTimeCOGFrame): FrameCacheEntry {
    const entry = this.touch(frame);
    entry.ready = true;
    entry.lastAccessMs = Date.now();
    return entry;
  }

  isReady(frame: NormalizedTimeCOGFrame | null): boolean {
    return frame ? this.entries.get(frame.id)?.ready === true : false;
  }

  readyFrameIds(): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.ready)
      .map((entry) => entry.frame.id);
  }

  pruneToCatalog(catalog: readonly NormalizedTimeCOGFrame[]): void {
    const validIds = new Set(catalog.map((frame) => frame.id));

    for (const id of this.entries.keys()) {
      if (!validIds.has(id)) {
        this.entries.delete(id);
      }
    }
  }

  stats(
    frameCount: number,
    scheduledFrameCount: number,
    currentTimeMs: number,
    targetFrameId: string | null,
    displayFrameId: string | null,
  ): TimeCOGStats {
    return {
      frameCount,
      readyFrameCount: this.readyFrameIds().length,
      cacheEntryCount: this.entries.size,
      scheduledFrameCount,
      currentTimeMs,
      targetFrameId,
      displayFrameId,
    };
  }

  private evict(): void {
    this.evictByEntryCount();
    this.evictByTileEntryCount();
    this.evictByMemory();
  }

  private evictByEntryCount(): void {
    const maxFrames = this.policy.maxFrames;

    if (!maxFrames || maxFrames < 1) {
      return;
    }

    while (this.entries.size > maxFrames) {
      this.deleteOldest();
    }
  }

  private evictByTileEntryCount(): void {
    const maxTileEntries = this.policy.maxTileEntries;

    if (!maxTileEntries || maxTileEntries < 1) {
      return;
    }

    while (this.totalTileEntries() > maxTileEntries) {
      this.deleteOldest();
    }
  }

  private evictByMemory(): void {
    const memoryBytes = this.policy.memoryBytes;

    if (!memoryBytes || memoryBytes < 1) {
      return;
    }

    while (this.totalByteLength() > memoryBytes) {
      this.deleteOldest();
    }
  }

  private deleteOldest(): void {
    let oldestId: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [id, entry] of this.entries) {
      if (entry.lastAccessMs < oldestAccess) {
        oldestId = id;
        oldestAccess = entry.lastAccessMs;
      }
    }

    if (oldestId === null) {
      return;
    }

    this.entries.delete(oldestId);
  }

  private totalTileEntries(): number {
    let total = 0;

    for (const entry of this.entries.values()) {
      total += entry.tileEntries;
    }

    return total;
  }

  private totalByteLength(): number {
    let total = 0;

    for (const entry of this.entries.values()) {
      total += entry.byteLength;
    }

    return total;
  }
}
