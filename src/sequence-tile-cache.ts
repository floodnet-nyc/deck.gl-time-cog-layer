import type { Texture } from "@luma.gl/core";

/** Whether a cached tile is a coarse preview or a full-resolution tile. */
export type TileQuality = "preview" | "full";

/**
 * A single cached tile entry.
 *
 * The `x`, `y`, `z` fields are stored redundantly (they also appear
 * in the cache key) so that diagnostic code can enumerate entries
 * without parsing string keys.  `lastAccessMs` drives the
 * LRU-inspired eviction policy.
 */
export type CachedTile = {
  texture: Texture;
  mask?: Texture;
  byteLength: number;
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
  quality: TileQuality;
  frameId: string;
  lastAccessMs: number;
  wasDisplayed: boolean;
  firstCachedMs: number;
};

export type TileCacheStats = {
  tileCount: number;
  totalBytes: number;
  frameIds: string[];
  protectedFrameIds: string[];
  hitCount: number;
  missCount: number;
  /** Tiles evicted that were never displayed. */
  evictedNeverDisplayed: number;
  /** Bytes of evicted tiles that were never displayed. */
  wastedBytes: number;
  /** Cumulative tiles evicted (for rate computation). */
  evictedTotal: number;
};

/**
 * Configuration knobs for the tile cache.
 *
 * Eviction is governed by up to four independent limits; the first
 * limit that is exceeded triggers eviction.
 */
export type TileCachePolicy = {
  /** Maximum total bytes of cached tile data. */
  memoryBytes?: number;
  /** Maximum number of distinct frames allowed in the cache.  Evicts the least-recently-accessed frame first. */
  maxFrames?: number;
  /** Maximum number of individual tile entries across all frames. */
  maxTileEntries?: number;
  /** Maximum total tile count (alias / complement to `maxTileEntries`). */
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

/**
 * GPU-texture cache keyed by `(frameId, tileX, tileY, zoom)`.
 *
 * ## Role in the architecture
 *
 * Both the `TimeSequenceTileLayer` sublayer and the `FramePrefetcher`
 * share a single instance of this cache.  When the display frame
 * changes and `tileset.reloadAll()` fires, the sublayer's
 * `getTileData` wrapper checks the cache for the new frame before
 * falling back to a COG fetch.  Cache hits return instantly (the
 * textures are already on the GPU), which is what makes frame
 * transitions flicker-free.
 *
 * ## Eviction policy
 *
 * Entries marked as **protected** (current frame + immediate
 * neighbours) are never evicted.  Among unprotected entries, the
 * policy prefers evicting far-future full-resolution tiles first,
 * then far-past full-resolution tiles, then preview tiles.  This
 * matches the research recommendation: keep close-to-playhead preview
 * tiles and sacrifice distant full-res tiles.
 *
 * Destroying a cache entry calls `texture.destroy()` on the
 * underlying luma.gl `Texture`, releasing GPU memory.
 */
export class SequenceTileCache {
  private tiles = new Map<string, CachedTile>();
  private retiredTextures = new Set<Texture>();
  private protected = new Set<string>();
  private policy: TileCachePolicy = {};
  private hitCount = 0;
  private missCount = 0;
  private evictedNeverDisplayed = 0;
  private wastedBytes = 0;
  private evictedTotal = 0;

  constructor(policy: TileCachePolicy = {}) {
    this.policy = policy;
  }

  updatePolicy(policy: TileCachePolicy): void {
    this.policy = policy;
    this.evict();
  }

  /**
   * Retrieve a cached tile.  Updates `lastAccessMs` so that the
   * entry is considered recently used for eviction purposes.
   */
  get(
    frameId: string,
    x: number,
    y: number,
    z: number,
  ): CachedTile | undefined {
    return this.lookup(frameId, x, y, z);
  }

  /**
   * Return the best available cached tile for a given coordinate,
   * searching progressively coarser zoom levels.
   *
   * First tries the exact `(frameId, x, y, z)` key.  On miss, maps
   * the coordinates to coarser zoom levels (power-of-2 pyramid) up to
   * `maxBias` levels and returns the first hit — which is the closest
   * available resolution to the target zoom.
   */
  getBest(
    frameId: string,
    x: number,
    y: number,
    z: number,
    maxBias = 2,
  ): CachedTile | undefined {
    let cx = x;
    let cy = y;
    let cz = z;

    for (let bias = 0; bias <= maxBias && cz >= 0; bias += 1) {
      const tile = this.lookup(frameId, cx, cy, cz);

      if (tile) {
        return tile;
      }

      cx = Math.floor(cx / 2);
      cy = Math.floor(cy / 2);
      cz = cz - 1;
    }

    return undefined;
  }

  /**
   * Check whether every tile in `tiles` exists in the cache for
   * `frameId` at `"full"` quality.
   */
  hasFullCoverage(
    frameId: string,
    tiles: readonly { x: number; y: number; z: number }[],
  ): boolean {
    if (tiles.length === 0) {
      return false;
    }

    for (const t of tiles) {
      const entry = this.lookup(frameId, t.x, t.y, t.z);

      if (!entry || entry.quality !== "full") {
        return false;
      }
    }

    return true;
  }

  /**
   * Store a tile.  If an entry already exists at the same key, the
   * new tile is only stored when it represents a quality upgrade
   * (preview → full).  The old texture is destroyed.
   */
  put(
    frameId: string,
    x: number,
    y: number,
    z: number,
    tile: Omit<CachedTile, "frameId" | "lastAccessMs" | "wasDisplayed" | "firstCachedMs">,
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
      x,
      y,
      z,
      frameId,
      lastAccessMs: Date.now(),
      wasDisplayed: false,
      firstCachedMs: Date.now(),
    });

    this.evict();
  }

  /**
   * Mark a set of frame IDs as immune to eviction.
   * Typically called with the current display frame and the first
   * few scheduled frames after each `updateState`.
   */
  protect(frameIds: string[]): void {
    this.protected = new Set(frameIds);
    this.evict();
  }

  /**
   * Aggressively evict all tiles belonging to a specific frame,
   * destroying their GPU textures.  Useful on seek / scrub.
   */
  purgeFrame(frameId: string): void {
    for (const [key, tile] of this.tiles) {
      if (tile.frameId === frameId) {
        this.retireTile(tile);

        this.tiles.delete(key);
      }
    }
  }

  /**
   * Destroy all GPU textures and clear the cache.
   * Called from `TimeCOGLayer.finalizeState`.
   */
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
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictedNeverDisplayed: this.evictedNeverDisplayed,
      wastedBytes: this.wastedBytes,
      evictedTotal: this.evictedTotal,
    };
  }

  entries(): IterableIterator<[string, CachedTile]> {
    return this.tiles.entries();
  }

  private lookup(
    frameId: string,
    x: number,
    y: number,
    z: number,
  ): CachedTile | undefined {
    const key = tileKey(frameId, x, y, z);
    const tile = this.tiles.get(key);

    if (tile) {
      tile.lastAccessMs = Date.now();
      this.hitCount += 1;
    }

    return tile;
  }

  /** Record a cache miss from a caller that will proceed to fetch the tile. */
  recordMiss(): void {
    this.missCount += 1;
  }

  /** Mark a tile as having been displayed to the user.  Idempotent. */
  markDisplayed(
    frameId: string,
    x: number,
    y: number,
    z: number,
  ): void {
    const key = tileKey(frameId, x, y, z);
    const tile = this.tiles.get(key);

    if (tile) {
      tile.wasDisplayed = true;
    }
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

    this.evictedTotal += 1;

    if (!tile.wasDisplayed) {
      this.evictedNeverDisplayed += 1;
      this.wastedBytes += tile.byteLength;
    }
  }
}
