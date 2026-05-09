import type { Texture } from "@luma.gl/core";

export type TileQuality = "preview" | "full";

export type CachedTile = {
  texture: Texture;
  mask?: Texture;
  byteLength: number;
  width: number;
  height: number;
  quality: TileQuality;
  frameId: string;
  lastAccessMs: number;
};

export type TileCacheStats = {
  tileCount: number;
  totalBytes: number;
  frameIds: string[];
  protectedFrameIds: string[];
};

export type TileCachePolicy = {
  memoryBytes?: number;
  maxFrames?: number;
  maxTileEntries?: number;
  maxTiles?: number;
};

function tileKey(
  frameId: string,
  x: number,
  y: number,
  z: number,
): string {
  return `${frameId}:${x}:${y}:${z}`;
}

export class SequenceTileCache {
  private tiles = new Map<string, CachedTile>();
  private retiredTextures = new Set<Texture>();
  private protected = new Set<string>();
  private policy: TileCachePolicy = {};

  constructor(policy: TileCachePolicy = {}) {
    this.policy = policy;
  }

  updatePolicy(policy: TileCachePolicy): void {
    this.policy = policy;
    this.evict();
  }

  get(
    frameId: string,
    x: number,
    y: number,
    z: number,
  ): CachedTile | undefined {
    const key = tileKey(frameId, x, y, z);
    const tile = this.tiles.get(key);

    if (tile) {
      tile.lastAccessMs = Date.now();
    }

    return tile;
  }

  put(
    frameId: string,
    x: number,
    y: number,
    z: number,
    tile: Omit<CachedTile, "frameId" | "lastAccessMs">,
  ): void {
    const key = tileKey(frameId, x, y, z);
    const existing = this.tiles.get(key);

    if (existing) {
      if (tile.quality === "full" && existing.quality === "preview") {
        this.retireTile(existing);
      } else {
        existing.lastAccessMs = Date.now();
        return;
      }
    }

    this.tiles.set(key, {
      ...tile,
      frameId,
      lastAccessMs: Date.now(),
    });

    this.evict();
  }

  protect(frameIds: string[]): void {
    this.protected = new Set(frameIds);
    this.evict();
  }

  purgeFrame(frameId: string): void {
    for (const [key, tile] of this.tiles) {
      if (tile.frameId === frameId) {
        this.retireTile(tile);

        this.tiles.delete(key);
      }
    }
  }

  destroy(): void {
    for (const tile of this.tiles.values()) {
      this.retireTile(tile);
    }

    for (const texture of this.retiredTextures) {
      texture.destroy();
    }

    this.tiles.clear();
    this.retiredTextures.clear();
    this.protected.clear();
  }

  stats(): TileCacheStats {
    const frameIds = new Set<string>();
    let totalBytes = 0;

    for (const tile of this.tiles.values()) {
      frameIds.add(tile.frameId);
      totalBytes += tile.byteLength;
    }

    return {
      tileCount: this.tiles.size,
      totalBytes,
      frameIds: [...frameIds],
      protectedFrameIds: [...this.protected],
    };
  }

  private evict(): void {
    this.evictByFrameCount();
    this.evictByTileCount();
    this.evictByMemory();
  }

  private evictByFrameCount(): void {
    const maxFrames = this.policy.maxFrames;

    if (!maxFrames || maxFrames < 1) {
      return;
    }

    while (this.frameCount() > maxFrames) {
      const frameId = this.findOldestFrame();

      if (!frameId) {
        return;
      }

      this.purgeFrame(frameId);
    }
  }

  private evictByTileCount(): void {
    const maxTiles = this.policy.maxTiles ?? this.policy.maxTileEntries;

    if (!maxTiles || maxTiles < 1) {
      return;
    }

    while (this.tiles.size > maxTiles) {
      this.deleteBestCandidate();
    }
  }

  private evictByMemory(): void {
    const memoryBytes = this.policy.memoryBytes;

    if (!memoryBytes || memoryBytes < 1) {
      return;
    }

    while (this.totalBytes() > memoryBytes) {
      this.deleteBestCandidate();
    }
  }

  private deleteBestCandidate(): void {
    if (this.tiles.size === 0) {
      return;
    }

    let bestKey: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const [key, tile] of this.tiles) {
      if (this.protected.has(tile.frameId)) {
        continue;
      }

      const age = Date.now() - tile.lastAccessMs;
      const qualityPenalty = tile.quality === "preview" ? 0 : 1;

      const score = age + qualityPenalty * 30_000;

      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }

    if (bestKey === null) {
      const oldestKey = this.findOldestUnprotected();

      if (oldestKey) {
        const entry = this.tiles.get(oldestKey);

        if (entry) {
          this.retireTile(entry);
        }

        this.tiles.delete(oldestKey);
      }

      return;
    }

    const tile = this.tiles.get(bestKey);

    if (tile) {
      this.retireTile(tile);
    }

    this.tiles.delete(bestKey);
  }

  private findOldestUnprotected(): string | null {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, tile] of this.tiles) {
      if (tile.lastAccessMs < oldestAccess) {
        oldestKey = key;
        oldestAccess = tile.lastAccessMs;
      }
    }

    return oldestKey;
  }

  private findOldestFrame(): string | null {
    const frameAccess = new Map<string, number>();

    for (const tile of this.tiles.values()) {
      if (this.protected.has(tile.frameId)) {
        continue;
      }

      frameAccess.set(
        tile.frameId,
        Math.min(frameAccess.get(tile.frameId) ?? Number.POSITIVE_INFINITY, tile.lastAccessMs),
      );
    }

    if (frameAccess.size === 0) {
      for (const tile of this.tiles.values()) {
        frameAccess.set(
          tile.frameId,
          Math.min(frameAccess.get(tile.frameId) ?? Number.POSITIVE_INFINITY, tile.lastAccessMs),
        );
      }
    }

    let oldestFrameId: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [frameId, access] of frameAccess) {
      if (access < oldestAccess) {
        oldestFrameId = frameId;
        oldestAccess = access;
      }
    }

    return oldestFrameId;
  }

  private frameCount(): number {
    const frameIds = new Set<string>();

    for (const tile of this.tiles.values()) {
      frameIds.add(tile.frameId);
    }

    return frameIds.size;
  }

  private totalBytes(): number {
    let total = 0;

    for (const tile of this.tiles.values()) {
      total += tile.byteLength;
    }

    return total;
  }

  private retireTile(tile: CachedTile): void {
    this.retiredTextures.add(tile.texture);

    if (tile.mask) {
      this.retiredTextures.add(tile.mask);
    }
  }
}
