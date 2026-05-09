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
import type { InteractionMode, NormalizedTimeCOGFrame, QualityPolicy } from "./types.js";

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
  bias: number;
};

/** The current playback snapshot, passed from `TimeCOGLayer.updateState`. */
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
  interactionMode: InteractionMode;
  qualityPolicy: QualityPolicy;
  /** Fraction of visible tiles cached at full quality for the target frame (0–1). */
  coverage?: number;
};

const MAX_GEOTIFF_CACHE = 8;

/**
 * Background tile-prefetch pipeline with progressive loading support.
 *
 * ## Role
 *
 * The prefetcher runs after every `TimeCOGLayer.updateState`.  It
 * receives the current visible tile coordinates, the frame schedule
 * window, the interaction mode, and the quality policy.  For each
 * scheduled frame (excluding the target, which is already being
 * loaded by the sublayer), it creates `(frameId, x, y, z, quality)`
 * tasks and scores them by temporal distance and playback direction.
 *
 * ## Progressive loading
 *
 * During seek / scrub interactions, tasks use biased (coarser) zoom
 * levels so that preview tiles appear quickly.  After the interaction
 * settles (idle mode), the prefetcher schedules full-resolution
 * upgrade tasks for any tile that has a preview entry but no full
 * entry.
 *
 * ## Execution
 *
 * Tasks are executed concurrently up to `maxConcurrent` (default 4).
 * Each task lazily opens the COG for the target frame, selects the
 * appropriate overview level, calls the user's `getTileData` function
 * (which creates GPU textures), and stores the result in the shared
 * `SequenceTileCache`.
 *
 * When the user seeks or the schedule window shifts, stale in-flight
 * tasks are aborted via `AbortController`.
 *
 * ## Scoring
 *
 * ```text
 * priority = 100 - (absDistance * 20) + directionalBoost
 * ```
 *
 * Upgrade tasks (preview → full) receive a flat high priority.
 */
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

  private rttEWMA = 0;
  private throughputEWMA = 0;
  private totalTasks = 0;
  private abortedTasks = 0;
  private uploadsThisFrame = 0;
  private maxDecodeTasks: number;
  private maxGpuUploads: number;

  constructor(
    tileCache: SequenceTileCache,
    maxConcurrent = 4,
    maxDecodeTasks?: number,
    maxGpuUploads?: number,
  ) {
    this.tileCache = tileCache;
    this.maxConcurrent = maxConcurrent;
    this.maxDecodeTasks = maxDecodeTasks ?? maxConcurrent;
    this.maxGpuUploads = maxGpuUploads ?? Math.max(1, Math.floor(maxConcurrent / 2));
  }

  update(snapshot: PrefetchSnapshot): void {
    this.device = snapshot.device;
    this.getUserTileDataFn = snapshot.getUserTileData;
    this.pool = snapshot.pool;
    this.layerSignal = snapshot.signal;
    this.uploadsThisFrame = 0;

    const scheduledIds = new Set(snapshot.scheduledFrames.map((f) => f.id));

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

    this.pruneQueue(scheduledIds);

    const newTasks: TileTask[] = [];
    const interactionMode = snapshot.interactionMode;
    const coverage = snapshot.coverage ?? 1;
    const abortRate = this.abortedTasks / (this.totalTasks || 1);

    let effectiveMaxConcurrent = this.maxConcurrent;

    if (abortRate > 0.5 && this.totalTasks > 4) {
      effectiveMaxConcurrent = Math.max(1, Math.floor(this.maxConcurrent / 2));
    }

    if (effectiveMaxConcurrent !== this.maxConcurrent) {
      this.maxConcurrent = effectiveMaxConcurrent;
    }

    const skipFutureFrames = coverage < 0.5 && interactionMode !== "idle";

    for (const frame of snapshot.scheduledFrames) {
      if (frame.id === snapshot.targetFrame.id) {
        continue;
      }

      const distanceIndex =
        snapshot.scheduledFrames.indexOf(frame) -
        snapshot.scheduledFrames.indexOf(snapshot.targetFrame);

      if (skipFutureFrames && distanceIndex !== 0) {
        continue;
      }

      const { quality, bias } = this.qualityForFrame(
        interactionMode,
        distanceIndex,
        snapshot.qualityPolicy,
      );

      for (const tile of snapshot.visibleTiles) {
        const key = taskKey(frame.id, tile.x, tile.y, tile.z);

        if (this.tileCache.get(frame.id, tile.x, tile.y, tile.z)) {
          continue;
        }

        if (this.inFlight.has(key) || this.queuedKeys.has(key)) {
          continue;
        }

        newTasks.push({
          frameId: frame.id,
          frameUrl: frame.url,
          requestInit: frame.requestInit,
          x: tile.x,
          y: tile.y,
          z: tile.z,
          quality,
          bias,
          priority: this.score(
            { frameId: frame.id, x: tile.x, y: tile.y, z: tile.z, quality } as TileTask,
            distanceIndex,
            snapshot,
          ),
        });
        this.queuedKeys.add(key);
      }
    }

    if (interactionMode === "idle") {
      for (const frame of snapshot.scheduledFrames) {
        for (const tile of snapshot.visibleTiles) {
          const exactKey = taskKey(frame.id, tile.x, tile.y, tile.z);
          const existing = this.tileCache.get(frame.id, tile.x, tile.y, tile.z);

          if (existing && existing.quality === "full") {
            continue;
          }

          if (this.inFlight.has(exactKey) || this.queuedKeys.has(exactKey)) {
            continue;
          }

          if (existing && existing.quality !== "full") {
            const upgradeTask: TileTask = {
              frameId: frame.id,
              frameUrl: frame.url,
              requestInit: frame.requestInit,
              x: tile.x,
              y: tile.y,
              z: tile.z,
              quality: "full",
              bias: 0,
              priority: 0,
            };
            const distanceIndex =
              snapshot.scheduledFrames.indexOf(frame) -
              snapshot.scheduledFrames.indexOf(snapshot.targetFrame);

            newTasks.push({
              ...upgradeTask,
              priority: this.score(upgradeTask, distanceIndex, snapshot),
            });
            this.queuedKeys.add(exactKey);
          }
        }
      }
    }

    this.queue.push(...newTasks);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
  }

  /**
   * Abort all in-flight tasks and cancel everything in the queue.
   * Called on seek / scrub and layer teardown.
   */
  abortAll(): void {
    this.abortedTasks += this.inFlight.size;

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

  stats(): {
    prefetchTaskCount: number;
    rttEWMA: number;
    throughputEWMA: number;
    abortRate: number;
  } {
    const denominator = this.totalTasks || 1;

    return {
      prefetchTaskCount: this.activeCount + this.queue.length,
      rttEWMA: this.rttEWMA,
      throughputEWMA: this.throughputEWMA,
      abortRate: this.abortedTasks / denominator,
    };
  }

  private pump(): void {
    while (
      this.activeCount < this.maxConcurrent &&
      this.activeCount < this.maxDecodeTasks &&
      this.uploadsThisFrame < this.maxGpuUploads &&
      this.queue.length > 0
    ) {
      const task = this.queue.shift();

      if (task) {
        this.queuedKeys.delete(taskKey(task.frameId, task.x, task.y, task.z));
        this.uploadsThisFrame += 1;
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
    this.totalTasks += 1;

    const t0 = performance.now();

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

      let image = imageForZ(geotiff, task.z - task.bias);

      if (!image || !hasTile(image, task.x, task.y)) {
        image = imageForZ(geotiff, task.z);
      }

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

      const elapsed = performance.now() - t0;

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

        if (elapsed > 0 && result.byteLength) {
          this.recordTelemetry(elapsed, result.byteLength);
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        this.abortedTasks += 1;
      } else if (!isMissingTileError(err)) {
        console.warn("FramePrefetcher: tile fetch failed", err);
      }
    } finally {
      this.inFlight.delete(key);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.pump();
    }
  }

  private recordTelemetry(sampleMs: number, sampleBytes: number): void {
    const alpha = 0.125;

    if (this.rttEWMA === 0) {
      this.rttEWMA = sampleMs;
    } else {
      this.rttEWMA = alpha * sampleMs + (1 - alpha) * this.rttEWMA;
    }

    const throughput = sampleBytes / (sampleMs / 1000);

    if (this.throughputEWMA === 0) {
      this.throughputEWMA = throughput;
    } else {
      this.throughputEWMA = alpha * throughput + (1 - alpha) * this.throughputEWMA;
    }
  }

  private score(
    task: TileTask,
    distanceIndex: number,
    snapshot: PrefetchSnapshot,
  ): number {
    const absDistance = Math.abs(distanceIndex);

    let score = 100 - absDistance * 20;

    if (
      snapshot.interactionMode === "seeking" ||
      snapshot.interactionMode === "scrubbing"
    ) {
      score += absDistance <= 1 ? 20 : -15;
    } else if (
      snapshot.interactionMode === "idle" &&
      task.quality === "preview"
    ) {
      score += 5;
    }

    if (snapshot.playing) {
      const direction = Math.sign(snapshot.playbackRate) || 1;
      const isForward = Math.sign(distanceIndex) === direction;

      if (isForward) {
        score += 10;
      }
    }

    if (task.quality === "full") {
      const existing = this.tileCache.get(task.frameId, task.x, task.y, task.z);

      score += existing && existing.quality === "preview" ? 50 : 10;
    }

    return Math.max(0, score);
  }

  private qualityForFrame(
    mode: InteractionMode,
    _distanceIndex: number,
    policy: QualityPolicy,
  ): { quality: TileQuality; bias: number } {
    if (policy.lowResFirst === false) {
      return { quality: "preview", bias: 0 };
    }

    if (mode === "scrubbing") {
      return { quality: "preview", bias: policy.scrubOverviewBias ?? 2 };
    }

    if (mode === "seeking") {
      return { quality: "preview", bias: policy.previewOverviewBias ?? 1 };
    }

    return { quality: "preview", bias: policy.previewOverviewBias ?? 1 };
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
