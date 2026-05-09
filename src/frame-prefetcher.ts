import type { Device, Texture } from "@luma.gl/core";
import type {
  GeoTIFF,
  Overview,
  DecoderPool,
} from "@developmentseed/geotiff";
import { GeoTIFF as GeoTIFFClass, defaultDecoderPool } from "@developmentseed/geotiff";
import type { SequenceTileCache, TileQuality } from "./sequence-tile-cache.js";
import type { NormalizedTimeCOGFrame } from "./types.js";

type TileCoord = { x: number; y: number; z: number };

type TileTask = {
  frameId: string;
  frameUrl: string;
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
  private inFlight = new Map<string, AbortController>();
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

    for (const [key, ctrl] of this.inFlight) {
      const frameId = key.slice(0, key.indexOf(":"));
      if (!scheduledIds.has(frameId)) {
        ctrl.abort();
      }
    }

    const newTasks: TileTask[] = [];

    for (const frame of snapshot.scheduledFrames) {
      if (frame.id === snapshot.targetFrame.id) {
        continue;
      }

      const distanceIndex =
        snapshot.scheduledFrames.indexOf(frame) -
        snapshot.scheduledFrames.indexOf(snapshot.targetFrame);

      for (const tile of snapshot.visibleTiles) {
        const key = `${frame.id}:${tile.x}:${tile.y}:${tile.z}`;

        if (this.tileCache.get(frame.id, tile.x, tile.y, tile.z)) {
          continue;
        }

        if (this.inFlight.has(key)) {
          continue;
        }

        const quality: TileQuality =
          Math.abs(distanceIndex) <= 2 ? "full" : "preview";

        newTasks.push({
          frameId: frame.id,
          frameUrl: frame.url,
          x: tile.x,
          y: tile.y,
          z: tile.z,
          quality,
          priority: this.score(distanceIndex, snapshot.playing, snapshot.playbackRate),
        });
      }
    }

    this.queue.push(...newTasks);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
  }

  abortAll(): void {
    for (const ctrl of this.inFlight.values()) {
      ctrl.abort();
    }
    this.inFlight.clear();
    this.queue.length = 0;
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
        this.executeTask(task);
      }
    }
  }

  private async executeTask(task: TileTask): Promise<void> {
    const key = `${task.frameId}:${task.x}:${task.y}:${task.z}`;
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    this.activeCount += 1;

    try {
      let geotiff = this.geotiffs.get(task.frameUrl);

      if (!geotiff) {
        if (this.geotiffs.size >= MAX_GEOTIFF_CACHE) {
          const firstKey = this.geotiffs.keys().next().value;

          if (firstKey) {
            this.geotiffs.delete(firstKey);
          }
        }

        geotiff = await GeoTIFFClass.fromUrl(task.frameUrl);
        this.geotiffs.set(task.frameUrl, geotiff);
      }

      const image =
        task.z === geotiff.overviews.length
          ? geotiff
          : geotiff.overviews[geotiff.overviews.length - 1 - task.z];

      if (!image) {
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
          texture: result.texture,
          mask: result.mask,
          byteLength: result.byteLength ?? 0,
          width: result.width,
          height: result.height,
          quality: task.quality,
        });
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
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
}
