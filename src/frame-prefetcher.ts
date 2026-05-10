import type { Device, Texture } from "@luma.gl/core";
import type {
  GeoTIFF,
  Overview,
  DecoderPool,
} from "@developmentseed/geotiff";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import { openGeoTIFF } from "./util/geotiff-source.js";
import type { SequenceTileCache, TileQuality } from "./sequence-tile-cache.js";
import { hasTile, imageForZ, isMissingTileError } from "./util/tile-utils.js";
import type { InteractionMode, NormalizedTimeCOGFrame, QualityPolicy, ScoringWeights } from "./types.js";

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
  /** User-supplied byte-size estimate from the frame catalog (if any). */
  byteSizeHint?: number;
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

  /** Buffer coverage summary computed by the coordinator. */
  bufferState?: {
    bufferedAhead: number;
    bufferedBehind: number;
    targetAhead: number;
  };

  /** Optional per-factor scoring weights from SchedulerPolicy. */
  scoringWeights?: ScoringWeights;
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
  private abortedKeys = new Set<string>();
  private uploadsThisFrame = 0;
  private maxDecodeTasks: number;
  private maxGpuUploads: number;
  private readonly originalMaxConcurrent: number;
  private consecutiveLowAbort = 0;

  /** Per-frame EWMA of tile byteLength, used for ETA-aware size penalty. */
  private frameAvgBytes = new Map<string, number>();

  /** Immutable scoring weights fallback (populated from constructor/defaults). */
  private scoringDefaults: Required<ScoringWeights>;

  private static readonly FALLBACK_WEIGHTS: Required<ScoringWeights> = {
    viewportSalience: 30,
    direction: 15,
    bufferShortfall: 20,
    interaction: 25,
    qualityUpgrade: 50,
    qualityFreshPreview: 20,
    sizeHintPerBit: 2,
    etaPerMs: 0.02,
  };

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
    this.scoringDefaults = { ...FramePrefetcher.FALLBACK_WEIGHTS, ...scoringWeights };
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
      this.abortedKeys.add(key);
      this.inFlight.delete(key);
    }

    this.pruneQueue(scheduledIds);

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
          byteSizeHint: frame.byteSizeHint,
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
              byteSizeHint: frame.byteSizeHint,
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
    for (const [key, entry] of this.inFlight) {
      this.abortedKeys.add(key);
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

  /** Return the keys of all currently in-flight prefetch tasks. */
  getInFlightKeys(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Return the keys of all tasks aborted since the layer was created. */
  getAbortedKeys(): Set<string> {
    return this.abortedKeys;
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
      prefetchTaskCount: this.activeCount + this.queue.length,
      rttEWMA: this.rttEWMA,
      throughputEWMA: this.throughputEWMA,
      abortRate: this.abortedTasks / denominator,
      totalAborted: this.abortedTasks,
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
        this.abortedKeys.add(key);
      } else if (!isMissingTileError(err)) {
        console.warn("FramePrefetcher: tile fetch failed", err);
      }
    } finally {
      this.inFlight.delete(key);
      this.activeCount = Math.max(0, this.activeCount - 1);
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

  private score(
    task: TileTask,
    distanceIndex: number,
    snapshot: PrefetchSnapshot,
  ): number {
    const weights = { ...this.scoringDefaults, ...snapshot.scoringWeights };
    const absDistance = Math.abs(distanceIndex);

    const v = this.temporalProximityScore(absDistance, weights);
    const d = this.directionScore(distanceIndex, snapshot, weights);
    const b = this.bufferShortfallScore(distanceIndex, snapshot, weights);
    const i = this.interactionScore(absDistance, snapshot, weights);
    const q = this.qualityUrgencyScore(task, snapshot, weights);
    const s = this.sizeHintPenalty(task, weights);
    const e = this.etaPenalty(task, weights);

    return Math.max(0, Math.min(200, v + d + b + i + q + s + e));
  }

  /**
   * Temporal-proximity score (proxy for viewport-salience V).
   *
   * All visible tiles in the current viewport share the same spatial
   * importance, so temporal distance from the target frame serves as
   * the primary salience proxy: frames closer to the playhead are
   * more likely to be displayed next.
   *
   * | distance | level | score      |
   * |----------|-------|------------|
   * | 0        | 3     | 3 * W_v    |
   * | 1        | 2     | 2 * W_v    |
   * | 2        | 1     | 1 * W_v    |
   * | >=3      | 0     | 0          |
   */
  private temporalProximityScore(
    absDistance: number,
    weights: Required<ScoringWeights>,
  ): number {
    if (absDistance === 0) return 3 * weights.viewportSalience;
    if (absDistance === 1) return 2 * weights.viewportSalience;
    if (absDistance === 2) return 1 * weights.viewportSalience;
    return 0;
  }

  /**
   * Playback-direction alignment (D).
   *
   * Forward frames get a bonus during forward playback; backward
   * frames get a mild penalty.  Paused mode returns 0.
   */
  private directionScore(
    distanceIndex: number,
    snapshot: PrefetchSnapshot,
    weights: Required<ScoringWeights>,
  ): number {
    if (!snapshot.playing) return 0;

    const direction = Math.sign(snapshot.playbackRate) || 1;
    const isForward = Math.sign(distanceIndex) === direction;

    return isForward ? weights.direction : -Math.ceil(weights.direction / 2);
  }

  /**
   * Buffer-shortfall pressure (B).
   *
   * When the contiguous cached buffer ahead of the playhead is below
   * the target, all forward-frame tasks receive a proportional boost
   * so the prefetcher closes the gap faster.
   */
  private bufferShortfallScore(
    distanceIndex: number,
    snapshot: PrefetchSnapshot,
    weights: Required<ScoringWeights>,
  ): number {
    if (distanceIndex <= 0) return 0;

    const buf = snapshot.bufferState;
    if (!buf || buf.targetAhead <= 0) return 0;

    const shortfall = Math.max(0, 1 - buf.bufferedAhead / buf.targetAhead);

    return shortfall > 0 ? Math.round(weights.bufferShortfall * shortfall) : 0;
  }

  /**
   * Interaction override (I).
   *
   * During seek / scrub the requested frame's tiles are boosted
   * heavily while tiles far from the playhead are penalised so they
   * don't compete for bandwidth.
   */
  private interactionScore(
    absDistance: number,
    snapshot: PrefetchSnapshot,
    weights: Required<ScoringWeights>,
  ): number {
    const mode = snapshot.interactionMode;

    if (mode === "idle" || mode === "playing") return 0;

    if (absDistance <= 1) return Math.round(2 * weights.interaction);
    if (absDistance === 2) return Math.round(0.4 * weights.interaction);

    return -Math.round(1.2 * weights.interaction);
  }

  /**
   * Quality-urgency score (Q).
   *
   * Preview→full upgrades are the highest quality priority because
   * they are the cheapest path to a better-looking frame.  Fresh
   * previews get a smaller boost when current-frame coverage is below
   * 30 %, encouraging at least *something* to appear quickly.
   */
  private qualityUrgencyScore(
    task: TileTask,
    snapshot: PrefetchSnapshot,
    weights: Required<ScoringWeights>,
  ): number {
    if (task.quality === "full") {
      const existing = this.tileCache.get(task.frameId, task.x, task.y, task.z);

      if (existing && existing.quality === "preview") {
        return weights.qualityUpgrade;
      }

      return 0;
    }

    const coverage = snapshot.coverage ?? 1;

    if (coverage < 0.3 && task.quality === "preview") {
      return weights.qualityFreshPreview;
    }

    return 0;
  }

  /**
   * Estimated-size penalty (W_s · log₂).
   *
   * Larger tiles cost more time and bandwidth.  The penalty grows
   * sub-linearly via log₂ so very large tiles are not completely
   * starved.
   *
   * Byte estimate sources (in order of preference):
   * 1. Frame-level `byteSizeHint` (carried on the catalog entry).
   *    Because this is a whole-COG size rather than a per-tile size,
   *    the log₂-scaled penalty naturally handles the magnitude
   *    difference between frame-level and tile-level sizes.
   * 2. Per-frame EWMA of previously-fetched tile `byteLength` values.
   * 3. No penalty when nothing is known.
   */
  private sizeHintPenalty(
    task: TileTask,
    weights: Required<ScoringWeights>,
  ): number {
    if (weights.sizeHintPerBit <= 0) return 0;

    const estimatedBytes = task.byteSizeHint ?? this.frameAvgBytes.get(task.frameId) ?? 0;

    if (estimatedBytes <= 0) return 0;

    const penalty = Math.round(
      weights.sizeHintPerBit * Math.log2(estimatedBytes + 1),
    );

    return -Math.min(15, penalty);
  }

  /**
   * ETA penalty (W_e · estimatedETA).
   *
   * Estimates per-tile fetch time using the EWMA telemetry:
   * `estimatedETA ≈ rttEWMA + (bytes / throughputEWMA) * 1000`.
   *
   * Tasks whose tiles are expected to take longer are deprioritised.
   * When no telemetry has been collected yet (`rttEWMA === 0`) or the
   * weight is disabled (`etaPerMs <= 0`), returns 0.
   *
   * Byte estimate sources (in order of preference):
   * 1. Task's `byteSizeHint` (from the catalog entry).
   * 2. Per-frame EWMA of previously-fetched `byteLength` values.
   * 3. No per-tile size estimate → uses bare `rttEWMA` as fallback.
   */
  private etaPenalty(
    task: TileTask,
    weights: Required<ScoringWeights>,
  ): number {
    if (this.rttEWMA <= 0 || weights.etaPerMs <= 0) return 0;

    const estimatedBytes =
      task.byteSizeHint ?? this.frameAvgBytes.get(task.frameId) ?? 0;

    let eta = this.rttEWMA;

    if (estimatedBytes > 0 && this.throughputEWMA > 0) {
      eta += (estimatedBytes / this.throughputEWMA) * 1000;
    }

    const penalty = Math.round(weights.etaPerMs * eta);

    return -Math.min(20, penalty);
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
