import type { Device, Texture } from "@luma.gl/core";
import type {
  GeoTIFF,
  Overview,
  DecoderPool,
} from "@developmentseed/geotiff";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import type { SequenceTileCache } from "./sequence-tile-cache.js";
import { openGeoTIFF } from "./util/geotiff-source.js";
import { hasTile, imageForZ, isMissingTileError } from "./util/tile-utils.js";
import type { InteractionMode, NormalizedTimeCOGFrame, QualityPolicy, ScoringWeights } from "./types.js";
import { TaskQueue, taskKey, type TileCoord, type TileTask } from "./task-queue.js";
import {
  scoreTask,
  qualityForTask,
  type ScoringContext,
} from "./util/task-scorer.js";
import type { GeoTIFFRegistry } from "./util/geotiff-registry.js";

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
  coverage?: number;
  bufferState?: {
    bufferedAhead: number;
    bufferedBehind: number;
    targetAhead: number;
  };
  scoringWeights?: ScoringWeights;
  geotiffRegistry?: GeoTIFFRegistry;
};

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
  private taskQueue = new TaskQueue();
  private maxConcurrent: number;

  private device: Device | null = null;
  private getUserTileDataFn: PrefetchSnapshot["getUserTileData"] | null = null;
  private pool: DecoderPool | null = null;
  private layerSignal: AbortSignal | undefined;
  private uploadsThisFrame = 0;
  private maxDecodeTasks: number;
  private maxGpuUploads: number;
  private readonly originalMaxConcurrent: number;
  private consecutiveLowAbort = 0;

  private rttEWMA = 0;
  private throughputEWMA = 0;
  private totalTasks = 0;
  private abortedTasks = 0;

  /** Per-frame EWMA of tile byteLength, used for ETA-aware size penalty. */
  frameAvgBytes = new Map<string, number>();

  private defaultScoringWeights: ScoringWeights;

  private geotiffRegistry: GeoTIFFRegistry | null = null;

  /** Backward-compat geotiff map used when no shared registry is wired. */
  private localGeotiffs = new Map<string, GeoTIFF>();

  constructor(
    tileCache: SequenceTileCache,
    maxConcurrent = 4,
    maxDecodeTasks?: number,
    maxGpuUploads?: number,
    scoringWeights?: ScoringWeights,
  ) {
    this.tileCache = tileCache;
    this.maxConcurrent = maxConcurrent;
    this.originalMaxConcurrent = maxConcurrent;
    this.maxDecodeTasks = maxDecodeTasks ?? maxConcurrent;
    this.maxGpuUploads = maxGpuUploads ?? Math.max(1, Math.floor(maxConcurrent / 2));
    this.defaultScoringWeights = scoringWeights ?? {};
  }

  /** @internal Public for test compatibility. */
  get queue(): TileTask[] {
    return this.taskQueue.queue;
  }

  /** @internal Public for test compatibility. */
  get inFlight(): Map<string, { controller: AbortController; frameId: string }> {
    return this.taskQueue.inFlight;
  }

  /** @internal Public for test compatibility. */
  get queuedKeys(): Set<string> {
    return this.taskQueue.queuedKeys;
  }

  /**
   * Expose the currently-active GeoTIFF store as a writable Map for
   * backward compatibility with tests that pre-populate fake GeoTIFF
   * objects via `prefetcher.geotiffs.set(...)`.
   */
  get geotiffs(): Map<string, GeoTIFF> {
    if (this.geotiffRegistry) {
      return this.geotiffRegistry.mutableMap;
    }
    return this.localGeotiffs;
  }

  update(snapshot: PrefetchSnapshot): void {
    this.device = snapshot.device;
    this.getUserTileDataFn = snapshot.getUserTileData;
    this.pool = snapshot.pool;
    this.layerSignal = snapshot.signal;
    this.uploadsThisFrame = 0;
    this.geotiffRegistry = snapshot.geotiffRegistry ?? null;

    const scheduledIds = new Set(snapshot.scheduledFrames.map((f) => f.id));

    this.taskQueue.abortStale(scheduledIds);
    this.taskQueue.prune(scheduledIds, this.tileCache);

    const newTasks: TileTask[] = [];
    const interactionMode = snapshot.interactionMode;
    const coverage = snapshot.coverage ?? 1;
    const abortRate = this.abortedTasks / (this.totalTasks || 1);

    let effectiveMaxConcurrent = this.maxConcurrent;

    if (abortRate > 0.5 && this.totalTasks > 4) {
      effectiveMaxConcurrent = Math.max(1, Math.floor(this.originalMaxConcurrent / 2));
      this.consecutiveLowAbort = 0;
    } else if (abortRate < 0.1) {
      this.consecutiveLowAbort += 1;

      if (
        this.consecutiveLowAbort >= 3 &&
        this.maxConcurrent < this.originalMaxConcurrent
      ) {
        effectiveMaxConcurrent = Math.min(
          this.originalMaxConcurrent,
          this.maxConcurrent + 1,
        );
        this.consecutiveLowAbort = 0;
      }
    } else {
      this.consecutiveLowAbort = 0;
    }

    if (effectiveMaxConcurrent !== this.maxConcurrent) {
      this.maxConcurrent = effectiveMaxConcurrent;
    }

    const skipFutureFrames = coverage < 0.5 && interactionMode !== "idle";

    const scoringCtx: ScoringContext = {
      getTileCache: () => this.tileCache,
      getRttEWMA: () => this.rttEWMA,
      getThroughputEWMA: () => this.throughputEWMA,
      getFrameAvgBytes: (frameId: string) => this.frameAvgBytes.get(frameId) ?? 0,
      playing: snapshot.playing,
      playbackRate: snapshot.playbackRate,
      interactionMode: snapshot.interactionMode,
      coverage,
      bufferState: snapshot.bufferState,
      scheduledFrames: snapshot.scheduledFrames,
      targetFrame: snapshot.targetFrame,
    };

    const { quality: defaultQuality } = qualityForTask(
      interactionMode,
      0,
      snapshot.qualityPolicy.lowResFirst,
    );

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

      for (const tile of snapshot.visibleTiles) {
        const key = taskKey(frame.id, tile.x, tile.y, tile.z);

        if (this.tileCache.get(frame.id, tile.x, tile.y, tile.z)) {
          continue;
        }

        if (this.taskQueue.isTracked(key)) {
          continue;
        }

        const task: TileTask = {
          frameId: frame.id,
          frameUrl: frame.url,
          requestInit: frame.requestInit,
          byteSizeHint: frame.byteSizeHint,
          x: tile.x,
          y: tile.y,
          z: tile.z,
          quality: defaultQuality,
          priority: 0,
        };

        task.priority = scoreTask(
          task,
          distanceIndex,
          scoringCtx,
          { ...this.defaultScoringWeights, ...snapshot.scoringWeights },
        );

        newTasks.push(task);
        this.taskQueue.markQueued(key);
      }
    }

    if (interactionMode === "idle") {
      for (const frame of snapshot.scheduledFrames) {
        if (frame.id === snapshot.targetFrame.id) {
          continue;
        }
        for (const tile of snapshot.visibleTiles) {
          const exactKey = taskKey(frame.id, tile.x, tile.y, tile.z);
          const existing = this.tileCache.get(frame.id, tile.x, tile.y, tile.z);

          if (existing && existing.quality === "full") {
            continue;
          }

          if (this.taskQueue.isTracked(exactKey)) {
            continue;
          }

          if (existing && existing.quality !== "full") {
            const upgradeTask: TileTask = {
              frameId: frame.id,
              frameUrl: frame.url,
              requestInit: frame.requestInit,
              byteSizeHint: frame.byteSizeHint,
              x: tile.x,
              y: tile.y,
              z: tile.z,
              quality: "full",
              priority: 0,
            };
            const distanceIndex =
              snapshot.scheduledFrames.indexOf(frame) -
              snapshot.scheduledFrames.indexOf(snapshot.targetFrame);

            upgradeTask.priority = scoreTask(
              upgradeTask,
              distanceIndex,
              scoringCtx,
              { ...this.defaultScoringWeights, ...snapshot.scoringWeights },
            );

            newTasks.push(upgradeTask);
            this.taskQueue.markQueued(exactKey);
          }
        }
      }
    }

    this.taskQueue.enqueue(newTasks);
    this.pump();
  }

  abortAll(): void {
    this.taskQueue.abortAll();
  }

  destroy(): void {
    this.abortAll();
    this.localGeotiffs.clear();
  }

  getInFlightKeys(): string[] {
    return this.taskQueue.getInFlightKeys();
  }

  /** @deprecated Abort rate is now tracked via {@link stats}.abortRate. */
  getAbortedKeys(): Set<string> {
    return new Set<string>();
  }

  stats(): {
    prefetchTaskCount: number;
    rttEWMA: number;
    throughputEWMA: number;
    abortRate: number;
    totalAborted: number;
  } {
    const denominator = this.totalTasks || 1;

    return {
      prefetchTaskCount: this.taskQueue.activeCount + this.taskQueue.queue.length,
      rttEWMA: this.rttEWMA,
      throughputEWMA: this.throughputEWMA,
      abortRate: this.abortedTasks / denominator,
      totalAborted: this.abortedTasks,
    };
  }

  private pump(): void {
    while (
      this.taskQueue.activeCount < this.maxConcurrent &&
      this.taskQueue.activeCount < this.maxDecodeTasks &&
      this.uploadsThisFrame < this.maxGpuUploads &&
      this.taskQueue.queue.length > 0
    ) {
      const task = this.taskQueue.dequeue();

      if (task) {
        this.taskQueue.unmarkQueued(taskKey(task.frameId, task.x, task.y, task.z));
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
    this.taskQueue.start(key, controller, task.frameId);
    this.totalTasks += 1;

    const t0 = performance.now();

    try {
      let geotiff: GeoTIFF | undefined;

      if (this.geotiffRegistry) {
        geotiff = this.geotiffRegistry.get(task.frameId);

        if (!geotiff) {
          geotiff = await this.geotiffRegistry.open(
            task.frameId,
            task.frameUrl,
            task.requestInit,
          );
        }
      } else {
        geotiff = this.localGeotiffs.get(task.frameId);

        if (!geotiff) {
          const MAX_LOCAL_GEOTIFF_CACHE = 8;

          if (this.localGeotiffs.size >= MAX_LOCAL_GEOTIFF_CACHE) {
            const firstKey = this.localGeotiffs.keys().next().value;

            if (firstKey) {
              this.localGeotiffs.delete(firstKey);
            }
          }

          geotiff = await openGeoTIFF(task.frameUrl, {
            requestInit: task.requestInit,
          });
          this.localGeotiffs.set(task.frameId, geotiff);
        }
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
          quality: "full",
        });

        if (elapsed > 0 && result.byteLength) {
          this.recordTelemetry(elapsed, result.byteLength, task.frameId);
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        this.abortedTasks += 1;
      } else if (!isMissingTileError(err)) {
        console.warn("FramePrefetcher: tile fetch failed", err);
      }
    } finally {
      this.taskQueue.finish(key);
      this.pump();
    }
  }

  private recordTelemetry(sampleMs: number, sampleBytes: number, frameId?: string): void {
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

    if (frameId && sampleBytes > 0) {
      const prev = this.frameAvgBytes.get(frameId);

      this.frameAvgBytes.set(
        frameId,
        prev ? alpha * sampleBytes + (1 - alpha) * prev : sampleBytes,
      );
    }
  }
}
