import type { Device, Texture } from "@luma.gl/core";
import type {
  GeoTIFF,
  Overview,
  DecoderPool,
} from "@developmentseed/geotiff";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import { openGeoTIFF } from "./geotiff-source.js";
import type { SequenceTileCache, TileQuality } from "./sequence-tile-cache.js";
import { hasTile, imageForZ, isMissingTileError } from "./tile-utils.js";
import type { NormalizedTimeCOGFrame } from "./types.js";

type TileCoord = { x: number; y: number; z: number };

type TileTask = {
  frameId: string;
  frameUrl: string;
  requestInit?: RequestInit;
  x: number;
  y: number;
  z: number;
  quality: TileQuality;
  priority: number;
};

type PrefetchSnapshot = {
  targetFrame: NormalizedTimeCOGFrame;
  scheduledFrames: NormalizedTimeCOGFrame[];
  visibleTiles: TileCoord[];
  device: Device;
  getUserTileData: (
    image: GeoTIFF | Overview,
    options: {
      device: Device;
      x: number;
      y: number;
      signal?: AbortSignal;
      pool: DecoderPool;
    },
  ) => Promise<{ texture: Texture; mask?: Texture; byteLength: number; width: number; height: number }>;
  pool: DecoderPool;
  playing: boolean;
  playbackRate: number;
  signal?: AbortSignal;
};

const MAX_GEOTIFF_CACHE = 8;

export class FramePrefetcher {
  private tileCache: SequenceTileCache;
  private queue: TileTask[] = [];
  private queuedKeys = new Set<string>();
  private inFlight = new Map<string, { controller: AbortController; frameId: string }>();
  private geotiffs = new Map<string, GeoTIFF>();
  private maxConcurrent: number;

  private device: Device | null = null;
  private getUserTileDataFn: PrefetchSnapshot["getUserTileData"] | null = null;
  private pool: DecoderPool | null = null;
  private layerSignal: AbortSignal | undefined;
  private activeCount = 0;

  constructor(
    tileCache: SequenceTileCache,
    maxConcurrent = 4,
  ) {
    this.tileCache = tileCache;
    this.maxConcurrent = maxConcurrent;
  }

  update(snapshot: PrefetchSnapshot): void {
    this.device = snapshot.device;
    this.getUserTileDataFn = snapshot.getUserTileData;
    this.pool = snapshot.pool;
    this.layerSignal = snapshot.signal;

    const scheduledIds = new Set(snapshot.scheduledFrames.map((f) => f.id));

    for (const [, entry] of this.inFlight) {
      if (!scheduledIds.has(entry.frameId)) {
        entry.controller.abort();
      }
    }

    this.pruneQueue(scheduledIds);

    const newTasks: TileTask[] = [];

    for (const frame of snapshot.scheduledFrames) {
      if (frame.id === snapshot.targetFrame.id) {
        continue;
      }

      const distanceIndex =
        snapshot.scheduledFrames.indexOf(frame) -
        snapshot.scheduledFrames.indexOf(snapshot.targetFrame);

      for (const tile of snapshot.visibleTiles) {
        const key = taskKey(frame.id, tile.x, tile.y, tile.z);

        if (this.tileCache.get(frame.id, tile.x, tile.y, tile.z)) {
          continue;
        }

        if (this.inFlight.has(key) || this.queuedKeys.has(key)) {
          continue;
        }

        const quality: TileQuality =
          Math.abs(distanceIndex) <= 2 ? "full" : "preview";

        newTasks.push({
          frameId: frame.id,
          frameUrl: frame.url,
          requestInit: frame.requestInit,
          x: tile.x,
          y: tile.y,
          z: tile.z,
          quality,
          priority: this.score(distanceIndex, snapshot.playing, snapshot.playbackRate),
        });
        this.queuedKeys.add(key);
      }
    }

    this.queue.push(...newTasks);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
  }

  abortAll(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.queue.length = 0;
    this.queuedKeys.clear();
    this.activeCount = 0;
  }

  destroy(): void {
    this.abortAll();
    this.geotiffs.clear();
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();

      if (task) {
        this.queuedKeys.delete(taskKey(task.frameId, task.x, task.y, task.z));
        this.executeTask(task);
      }
    }
  }

  private async executeTask(task: TileTask): Promise<void> {
    const key = taskKey(task.frameId, task.x, task.y, task.z);

    if (this.tileCache.get(task.frameId, task.x, task.y, task.z)) {
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(key, { controller, frameId: task.frameId });
    this.activeCount += 1;

    try {
      let geotiff = this.geotiffs.get(task.frameId);

      if (!geotiff) {
        if (this.geotiffs.size >= MAX_GEOTIFF_CACHE) {
          const firstKey = this.geotiffs.keys().next().value;

          if (firstKey) {
            this.geotiffs.delete(firstKey);
          }
        }

        geotiff = await openGeoTIFF(task.frameUrl, {
          requestInit: task.requestInit,
        });
        this.geotiffs.set(task.frameId, geotiff);
      }

      const image = imageForZ(geotiff, task.z);

      if (!image || !hasTile(image, task.x, task.y)) {
        return;
      }

      let signal: AbortSignal | undefined;

      if (this.layerSignal && controller.signal) {
        signal = AbortSignal.any([this.layerSignal, controller.signal]);
      } else {
        signal = this.layerSignal ?? controller.signal;
      }

      if (!this.getUserTileDataFn || !this.device) {
        return;
      }

      const result = await this.getUserTileDataFn(image, {
        device: this.device,
        x: task.x,
        y: task.y,
        signal,
        pool: this.pool ?? defaultDecoderPool(),
      });

      if (result && result.texture) {
        this.tileCache.put(task.frameId, task.x, task.y, task.z, {
          x: task.x,
          y: task.y,
          z: task.z,
          texture: result.texture,
          mask: result.mask,
          byteLength: result.byteLength ?? 0,
          width: result.width,
          height: result.height,
          quality: task.quality,
        });
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError" && !isMissingTileError(err)) {
        console.warn("FramePrefetcher: tile fetch failed", err);
      }
    } finally {
      this.inFlight.delete(key);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.pump();
    }
  }

  private score(
    distanceIndex: number,
    playing: boolean,
    playbackRate: number,
  ): number {
    const absDistance = Math.abs(distanceIndex);
    const direction = playing ? Math.sign(playbackRate) || 1 : 0;
    const isForward =
      direction === 0
        ? false
        : Math.sign(distanceIndex) === direction;
    const directionalBoost = isForward ? 3 : 0;
    const distancePenalty = absDistance * 20;

    return 100 - distancePenalty + directionalBoost;
  }

  private pruneQueue(scheduledIds: Set<string>): void {
    const nextQueue: TileTask[] = [];
    const nextKeys = new Set<string>();

    for (const task of this.queue) {
      if (!scheduledIds.has(task.frameId)) {
        continue;
      }

      if (this.tileCache.get(task.frameId, task.x, task.y, task.z)) {
        continue;
      }

      const key = taskKey(task.frameId, task.x, task.y, task.z);

      if (nextKeys.has(key)) {
        continue;
      }

      nextQueue.push(task);
      nextKeys.add(key);
    }

    this.queue = nextQueue;
    this.queuedKeys = nextKeys;
  }
}

function taskKey(frameId: string, x: number, y: number, z: number): string {
  return JSON.stringify([frameId, x, y, z]);
}
