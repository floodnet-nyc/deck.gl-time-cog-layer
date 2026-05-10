import type {
  Layer,
  LayersList,
  UpdateParameters,
} from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import {
  findNearestFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./util/frame-catalog.js";
import { FramePrefetcher } from "./frame-prefetcher.js";
import { scheduleFrameWindow } from "./util/frame-scheduler.js";
import { SequenceTileCache } from "./sequence-tile-cache.js";
import { TimeSequenceTileLayer } from "./time-sequence-tile-layer.js";
import type {
  InteractionMode,
  NormalizedTimeCOGFrame,
  QualityPolicy,
  TimeCOGBufferState,
  TimeCOGLayerProps,
  TimeCOGLayerState,
  TimeCOGStats,
} from "./types.js";
import type { TileDiagSnapshot } from "./util/tile-diagnostics.js";


const DEFAULT_MISSING_FRAME_POLICY = "hold-last";

const EMPTY_TILE_CACHE = new SequenceTileCache();

/**
 * A deck.gl `CompositeLayer` that orchestrates time-indexed playback of
 * Cloud-Optimized GeoTIFF (COG) sequences.
 *
 * ## Architecture
 *
 * `TimeCOGLayer` owns three long-lived infrastructure objects that it
 * injects into a single persistent `TimeSequenceTileLayer` sublayer:
 *
 * 1. **`SequenceTileCache`** — GPU texture cache keyed by
 *    `(frameId, x, y, z)`.  Serves instant cache hits when the
 *    display frame changes, avoiding the white flash that would occur
 *    if every frame switch destroyed and re-created the tile layer.
 *
 * 2. **`FramePrefetcher`** — Background pipeline that scores and
 *    fetches tiles for nearby frames before they are needed.
 *
 * 3. **`visibleTileRef`** — Shared mutable state that the inner
 *    `TileLayer` updates whenever the visible tile set changes;
 *    used to feed the prefetcher with the correct tile coordinates.
 *
 * ## Why not one COGLayer per frame?
 *
 * Creating a new `COGLayer` for each displayed frame (the naive
 * approach) destroys all GPU textures, decoded tiles, and in-flight
 * requests on every frame switch.  The resulting cold-start fetch path
 * produces the jarring flicker that this layer exists to eliminate.
 *
 * Instead, `TimeCOGLayer` creates one `TimeSequenceTileLayer` (which
 * extends `COGLayer`) with a **constant** `id`.  deck.gl therefore
 * never destroys it.  Frame changes are communicated by updating
 * `currentFrameId` and `currentFrameUrl` on the sublayer, which in
 * turn propagates them to the inner `TileLayer`'s `updateTriggers.all`.
 * The `updateTriggers` mechanism causes `tileset.reloadAll()` which
 * keeps old tile content visible **until** new data is ready — giving
 * a flicker-free transition.
 */
export class TimeCOGLayer extends CompositeLayer<TimeCOGLayerProps> {
  static layerName = "TimeCOGLayer";

  declare state: CompositeLayer["state"] & TimeCOGLayerState;

  /**
   * Creates the three shared infrastructure objects — `tileCache`,
   * `prefetcher`, and `visibleTileRef` — that live for the full
   * lifetime of the layer and are injected into the persistent
   * sublayer on every render.
   */
  initializeState(): void {
    const props = this.props;
    const tileCache = new SequenceTileCache(props.cachePolicy);

    this.setState({
      catalog: [],
      tileCache,
      prefetcher: new FramePrefetcher(
        tileCache,
        props.schedulerPolicy?.maxNetworkRequests ?? 4,
        props.schedulerPolicy?.maxDecodeTasks,
        props.schedulerPolicy?.maxGpuUploadsPerFrame,
        props.schedulerPolicy?.scoringWeights,
      ),
      visibleTileRef: { tiles: [] },
      initialGeotiffUrl: "",
      currentTimeMs: 0,
      targetFrame: null,
      displayFrame: null,
      scheduledFrames: [],
      missing: false,
      lastDisplayedFrameId: null,
      interactionMode: "idle",
      lastInteractionMs: 0,
      upgradeTimer: null,
      readyFrameIds: new Set<string>(),
    } satisfies TimeCOGLayerState);
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    const state = this.state;
    const framesChanged = props.frames !== oldProps.frames;
    const cachePolicyChanged = props.cachePolicy !== oldProps.cachePolicy;
    const timeChanged = props.currentTime !== oldProps.currentTime;
    const timingChanged =
      timeChanged ||
      props.playing !== oldProps.playing ||
      props.playbackRate !== oldProps.playbackRate ||
      props.bufferPolicy !== oldProps.bufferPolicy ||
      props.missingFramePolicy !== oldProps.missingFramePolicy;

    if (cachePolicyChanged) {
      state.tileCache.updatePolicy(props.cachePolicy ?? {});
    }

    const catalog = framesChanged
      ? normalizeFrameCatalog(props.frames)
      : state.catalog;

    if (framesChanged) {
      this.setState({ catalog });
    }

    if (framesChanged || timingChanged) {
      if (timeChanged) {
        state.lastInteractionMs = Date.now();
      }

      this.updateFrameState(catalog);
    }
  }

  /**
   * Returns the single persistent `TimeSequenceTileLayer` sublayer.
   *
   * The sublayer's `id` is **constant** (`${this.props.id}-tiles`)
   * so that deck.gl reuses the same layer instance across frame
   * switches rather than destroying / recreating it.  Frame changes
   * are communicated through the `currentFrameId` and
   * `currentFrameUrl` props.
   *
   * The `geotiff` prop is set to the very first frame's URL and
   * never changes.  This ensures `COGLayer` computes the shared
   * tileset descriptor exactly once.
   *
   * During seek / scrub a non-zero `previewBias` is forwarded so
   * that the sublayer fetches at a coarser zoom on cache miss,
   * delivering an immediate preview before the full-res upgrade.
   */
  renderLayers(): Layer | LayersList | null {
    const state = this.state;
    const frame = state.displayFrame;

    if (!frame) {
      return null;
    }

    const initialUrl = state.initialGeotiffUrl || frame.url;
    const passThrough = this.cogLayerProps(frame);
    const qualityPolicy = this.props.qualityPolicy ?? {};
    const bias =
      state.interactionMode === "scrubbing"
        ? (qualityPolicy.scrubOverviewBias ?? 2)
        : state.interactionMode === "seeking"
          ? (qualityPolicy.previewOverviewBias ?? 1)
          : 0;

    const userGeoTiff = this.props.onGeoTIFFLoad;
    let onGeoTIFFLoad = userGeoTiff;

    if (this.props.descriptorMode === "manifest" && this.props.descriptorManifest) {
      const manifest = this.props.descriptorManifest;

      onGeoTIFFLoad = (geotiff: any, options: any) => {
        if (geotiff) {
          const mismatches: string[] = [];

          if (geotiff.overviews.length + 1 !== manifest.overviewCount) {
            mismatches.push(`overviewCount: expected ${manifest.overviewCount}, got ${geotiff.overviews.length + 1}`);
          }

          if (mismatches.length > 0) {
            this.props.onDescriptorMismatch?.(frame, mismatches.join("; "));
          }
        }

        userGeoTiff?.(geotiff, options);
      }
    }

    return new TimeSequenceTileLayer({
      ...passThrough,
      id: `${this.props.id}-tiles`,
      geotiff: initialUrl,
      getTileData: this.props.getTileData,
      renderTile: this.props.renderTile,
      sequenceTileCache: state.tileCache,
      currentFrameId: frame.id,
      currentFrameUrl: frame.url,
      currentFrameRequestInit: frame.requestInit,
      previewBias: bias,
      visibleTileRef: state.visibleTileRef,
      onVisibleTilesChange: () => this.updatePrefetch(),
      onGeoTIFFLoad: onGeoTIFFLoad ?? undefined,
    } as object);
  }

  /**
   * Aborts all in-flight prefetch tasks and destroys GPU textures.
   */
  finalizeState(): void {
    const state = this.state;

    if (state.upgradeTimer) {
      clearTimeout(state.upgradeTimer);
      state.upgradeTimer = null;
    }

    state.prefetcher?.abortAll();
    state.tileCache?.destroy();
  }

  /**
   * Resolves the target and display frames from the current playback
   * time, computes the scheduled frame window, updates cache
   * protection, fires callbacks, and primes the prefetcher.
   *
   * This is the main orchestration point — called on every prop
   * change that affects timing (`currentTime`, `playing`,
   * `playbackRate`, `bufferPolicy`, `missingFramePolicy`) or the
   * frame catalog itself.
   */
  private updateFrameState(
    catalog: NormalizedTimeCOGFrame[],
  ): void {
    const state = this.state;
    const currentTimeMs = parseTimeValue(this.props.currentTime);
    const playing = this.props.playing ?? false;
    const resolution = resolveFrameForTime(
      catalog,
      currentTimeMs,
      this.props.missingFramePolicy ?? DEFAULT_MISSING_FRAME_POLICY,
    );

    this.applyMaxFrameRateBucking(
      resolution,
      catalog,
      playing,
    );

    const targetIndex = resolution.displayFrame
      ? findNearestFrameIndex(catalog, resolution.displayFrame.timeMs)
      : -1;

    const scheduledFrames = scheduleFrameWindow(
      catalog,
      targetIndex,
      this.props.bufferPolicy,
      this.props.playbackRate,
      this.props.maxFrameRate,
      playing,
    ).map((sf) => sf.frame);

    if (!state.initialGeotiffUrl && resolution.displayFrame) {
      this.setState({
        initialGeotiffUrl: resolution.displayFrame.url,
      });
    }

    const interactionMode = this.detectInteractionMode(
      playing,
      state.lastInteractionMs,
    );

    if (state.upgradeTimer) {
      clearTimeout(state.upgradeTimer);
      state.upgradeTimer = null;
    }

    if (interactionMode === "seeking" || interactionMode === "scrubbing") {
      const policy: QualityPolicy = this.props.qualityPolicy ?? {};
      const idleMs = policy.fullResUpgradeIdleMs ?? 150;

      state.upgradeTimer = setTimeout(() => {
        const s = this.state;

        if (s.interactionMode === "seeking" || s.interactionMode === "scrubbing") {
          s.interactionMode = "idle";
          this.updatePrefetch();
        }
      }, idleMs);
    }

    this.setState({
      catalog,
      currentTimeMs,
      targetFrame: resolution.targetFrame,
      displayFrame: resolution.displayFrame,
      scheduledFrames,
      missing: resolution.missing,
      interactionMode,
    });

    if (resolution.displayFrame) {
      const protectedFrames = [
        resolution.displayFrame.id,
        ...scheduledFrames.slice(0, 3).map((f) => f.id),
      ];

      if (
        state.lastDisplayedFrameId &&
        state.lastDisplayedFrameId !== resolution.displayFrame.id
      ) {
        protectedFrames.push(state.lastDisplayedFrameId);
      }

      state.tileCache.protect(protectedFrames);
    }

    if (
      resolution.displayFrame &&
      state.lastDisplayedFrameId !== resolution.displayFrame.id
    ) {
      this.props.onFrameDisplayed?.(resolution.displayFrame);
      this.setState({
        lastDisplayedFrameId: resolution.displayFrame.id,
      });
    }

    if (resolution.missing) {
      this.props.onMissingFrame?.(currentTimeMs);
    }

    if (
      resolution.displayFrame &&
      !state.readyFrameIds.has(resolution.displayFrame.id)
    ) {
      this.checkFrameReady(resolution.displayFrame);
    }

    this.updatePrefetch({
      displayFrame: resolution.displayFrame,
      scheduledFrames,
    });

    this.emitState({
      ...state,
      catalog,
      currentTimeMs,
      targetFrame: resolution.targetFrame,
      displayFrame: resolution.displayFrame,
      scheduledFrames,
      missing: resolution.missing,
      interactionMode,
    });
  }

  /** Derive the interaction mode from playback state and recency of timing changes. */
  private detectInteractionMode(
    playing: boolean,
    lastInteractionMs: number,
  ): InteractionMode {
    if (playing) {
      return "playing";
    }

    if (lastInteractionMs === 0) {
      return "idle";
    }

    const elapsed = Date.now() - lastInteractionMs;

    if (elapsed < 80) {
      return "scrubbing";
    }

    if (elapsed < 200) {
      return "seeking";
    }

    if (elapsed >= (this.props.qualityPolicy?.fullResUpgradeIdleMs ?? 300)) {
      return "idle";
    }

    return "seeking";
  }

  /** Fire `onFrameReady` if the display frame achieves full tile coverage for the first time. */
  private checkFrameReady(frame: NormalizedTimeCOGFrame): void {
    const state = this.state;

    if (state.readyFrameIds.has(frame.id)) {
      return;
    }

    if (
      state.tileCache.hasFullCoverage(
        frame.id,
        state.visibleTileRef.tiles,
      )
    ) {
      state.readyFrameIds.add(frame.id);
      this.props.onFrameReady?.(frame);
    }
  }

  /** Compute the fraction of visible tiles cached at full quality for a frame (0-1). */
  private computeCoverage(frame: NormalizedTimeCOGFrame | null): number {
    const state = this.state;

    if (!frame) {
      return 1;
    }

    const tiles = state.visibleTileRef.tiles;

    if (tiles.length === 0) {
      return 1;
    }

    let cached = 0;

    for (const t of tiles) {
      const entry = state.tileCache.get(frame.id, t.x, t.y, t.z);

      if (entry && entry.quality === "full") {
        cached += 1;
      }
    }

    return cached / tiles.length;
  }

  /**
   * Compute how many contiguous frames ahead of and behind the
   * playhead have full tile coverage.
   *
   * Uses {@link SequenceTileCache.hasFullCoverage} per frame so a
   * frame only counts as buffered when all of its visible tiles are
   * cached at full resolution — not just any single tile.
   *
   * Used by the prefetcher's buffer-shortfall scoring to boost
   * forward-frame tasks when the ahead-of-playhead buffer is
   * underfilled.
   */
  private computeBufferState(
    displayFrame: NormalizedTimeCOGFrame | null,
    scheduledFrames: NormalizedTimeCOGFrame[],
  ): { bufferedAhead: number; bufferedBehind: number; targetAhead: number } {
    const state = this.state;
    const tiles = state.visibleTileRef.tiles;

    let bufferedAhead = 0;
    let bufferedBehind = 0;

    if (tiles.length > 0 && displayFrame) {
      // Sort by time so forward/backward walks are in temporal order, not
      // priority order (scheduledFrames is priority-sorted, which interleaves
      // forward and backward frames and would cause premature loop breaks).
      const byTime = [...scheduledFrames].sort((a, b) => a.timeMs - b.timeMs);
      const idx = byTime.findIndex((f) => f.id === displayFrame.id);

      if (idx >= 0) {
        for (let i = idx + 1; i < byTime.length; i += 1) {
          const f = byTime[i];

          if (f && state.tileCache.hasFullCoverage(f.id, tiles)) {
            bufferedAhead += 1;
          } else {
            break;
          }
        }

        for (let i = idx - 1; i >= 0; i -= 1) {
          const f = byTime[i];

          if (f && state.tileCache.hasFullCoverage(f.id, tiles)) {
            bufferedBehind += 1;
          } else {
            break;
          }
        }
      }
    }

    return {
      bufferedAhead,
      bufferedBehind,
      targetAhead: this.props.bufferPolicy?.forwardFrames ?? 6,
    };
  }

  private applyMaxFrameRateBucking(
    resolution: { displayFrame: NormalizedTimeCOGFrame | null },
    catalog: NormalizedTimeCOGFrame[],
    playing: boolean,
  ): void {
    const state = this.state;
    const maxFrameRate = this.props.maxFrameRate ?? 0;

    if (!resolution.displayFrame || maxFrameRate <= 0 || !playing) {
      return;
    }

    const bucketIntervalMs =
      (1000 / maxFrameRate) *
      Math.abs(this.props.playbackRate ?? 0);
    const originTimeMs = catalog[0]?.timeMs ?? 0;
    const resolvedBucket = Math.floor(
      (resolution.displayFrame.timeMs - originTimeMs) / bucketIntervalMs,
    );

    if (!state.lastDisplayedFrameId) {
      return;
    }

    const lastFrame = catalog.find(
      (f) => f.id === state.lastDisplayedFrameId,
    );

    if (!lastFrame) {
      return;
    }

    const lastBucket = Math.floor(
      (lastFrame.timeMs - originTimeMs) / bucketIntervalMs,
    );

    if (lastBucket === resolvedBucket) {
      resolution.displayFrame = lastFrame;
    }
  }

  private emitState(s: TimeCOGLayerState): void {
    const tileStats = s.tileCache.stats();
    const prefetchStats = s.prefetcher.stats();
    const totalAccesses = tileStats.hitCount + tileStats.missCount;

    const bufferState: TimeCOGBufferState = {
      targetFrame: s.targetFrame,
      displayFrame: s.displayFrame,
      scheduledFrameIds: s.scheduledFrames.map((f) => f.id),
      readyFrameIds: tileStats.frameIds,
      missing: s.missing,
    };
    const stats: TimeCOGStats = {
      frameCount: s.catalog.length,
      readyFrameCount: tileStats.frameIds.length,
      cacheEntryCount: tileStats.tileCount,
      scheduledFrameCount: s.scheduledFrames.length,
      currentTimeMs: s.currentTimeMs,
      targetFrameId: s.targetFrame?.id ?? null,
      displayFrameId: s.displayFrame?.id ?? null,
      prefetchTaskCount: prefetchStats.prefetchTaskCount,
      rttEWMA: prefetchStats.rttEWMA,
      throughputEWMA: prefetchStats.throughputEWMA,
      abortRate: prefetchStats.abortRate,
      cacheHitRate: totalAccesses > 0 ? tileStats.hitCount / totalAccesses : 0,
      wastedBytes: tileStats.wastedBytes,
      evictedNeverDisplayed: tileStats.evictedNeverDisplayed,
      evictedTotal: tileStats.evictedTotal,
    };

    this.props.onBufferStateChange?.(bufferState);
    this.props.onStats?.(stats);
  }

  private updatePrefetch(snapshot?: {
    displayFrame: NormalizedTimeCOGFrame | null;
    scheduledFrames: NormalizedTimeCOGFrame[];
  }): void {
    const state = this.state;
    const displayFrame = snapshot?.displayFrame ?? state.displayFrame;
    const scheduledFrames = snapshot?.scheduledFrames ?? state.scheduledFrames;

    if (
      !displayFrame ||
      !this.context.device ||
      !this.props.getTileData
    ) {
      return;
    }

    const pool = this.props.pool ?? defaultDecoderPool();

    const coverage = this.computeCoverage(displayFrame);

    const bufferState = this.computeBufferState(
      displayFrame,
      scheduledFrames,
    );

    state.prefetcher.update({
      targetFrame: displayFrame,
      scheduledFrames,
      visibleTiles: state.visibleTileRef.tiles,
      device: this.context.device,
      coverage,
      bufferState,
      scoringWeights: this.props.schedulerPolicy?.scoringWeights,
      getUserTileData: this.props.getTileData,
      pool,
      playing: this.props.playing ?? false,
      playbackRate: this.props.playbackRate ?? 0,
      signal: this.props.signal,
      interactionMode: state.interactionMode,
      qualityPolicy: this.props.qualityPolicy ?? {},
    });

    this.checkFrameReady(displayFrame);
  }

  private cogLayerProps(
    frame: NormalizedTimeCOGFrame,
  ): Omit<
    TimeCOGLayerProps,
    | "id"
    | "frames"
    | "currentTime"
    | "playing"
    | "playbackRate"
    | "missingFramePolicy"
    | "bufferPolicy"
    | "cachePolicy"
    | "qualityPolicy"
    | "schedulerPolicy"
    | "descriptorMode"
    | "descriptorManifest"
    | "onFrameReady"
    | "onFrameDisplayed"
    | "onMissingFrame"
    | "onDescriptorMismatch"
    | "onBufferStateChange"
    | "onStats"
    | "onGeoTIFFLoad"
    | "getTileData"
    | "renderTile"
  > {
    const {
      frames: _frames,
      currentTime: _currentTime,
      playing: _playing,
      playbackRate: _playbackRate,
      missingFramePolicy: _missingFramePolicy,
      bufferPolicy: _bufferPolicy,
      cachePolicy: _cachePolicy,
      qualityPolicy: _qualityPolicy,
      schedulerPolicy: _schedulerPolicy,
      descriptorMode: _descriptorMode,
      descriptorManifest: _descriptorManifest,
      onFrameReady: _onFrameReady,
      onFrameDisplayed: _onFrameDisplayed,
      onMissingFrame: _onMissingFrame,
      onDescriptorMismatch: _onDescriptorMismatch,
      onBufferStateChange: _onBufferStateChange,
      onStats: _onStats,
      onGeoTIFFLoad: _onGeoTIFFLoad,
      getTileData: _getTileData,
      renderTile: _renderTile,
      ...cogProps
    } = this.props;

    if (!frame.requestInit) {
      return cogProps;
    }

    return {
      ...cogProps,
      loadOptions: {
        ...cogProps.loadOptions,
        fetch: {
          ...cogProps.loadOptions?.fetch,
          ...frame.requestInit,
        },
      },
    };
  }

  /**
   * Returns a snapshot of the current tile state for the diagnostic
   * minimap.
   *
   * @param windowSize - Number of frame columns to include in the
   *   window, centered on the playhead (default 60).
   */
  getDiagnosticSnapshot(windowSize = 60): TileDiagSnapshot {
    const empty: TileDiagSnapshot = {
      tileCache: EMPTY_TILE_CACHE,
      visibleTiles: [],
      frameIds: [],
      allFrameIds: [],
      playheadIndex: 0,
      maxZoom: 0,
      tileGrid: {},
      wastedBytes: 0,
      evictedNeverDisplayed: 0,
      abortedTasks: 0,
      scheduledFrameIds: new Set<string>(),
      inFlightKeys: new Set<string>(),
      abortedKeys: new Set<string>(),
    };
    const state = this.state;

    if (!state || !state.tileCache || !state.visibleTileRef) {
      return empty;
    }

    const tileStats = state.tileCache.stats();
    const prefetchStats = state.prefetcher.stats();

    const tileGrid: Record<number, { maxX: number; maxY: number }> = {};

    for (const [, tile] of state.tileCache.entries()) {
      if (!tileGrid[tile.z]) {
        tileGrid[tile.z] = { maxX: tile.x, maxY: tile.y };
      } else {
        tileGrid[tile.z]!.maxX = Math.max(tileGrid[tile.z]!.maxX, tile.x);
        tileGrid[tile.z]!.maxY = Math.max(tileGrid[tile.z]!.maxY, tile.y);
      }
    }

    for (const v of state.visibleTileRef.tiles) {
      if (!tileGrid[v.z]) {
        tileGrid[v.z] = { maxX: v.x, maxY: v.y };
      } else {
        tileGrid[v.z]!.maxX = Math.max(tileGrid[v.z]!.maxX, v.x);
        tileGrid[v.z]!.maxY = Math.max(tileGrid[v.z]!.maxY, v.y);
      }
    }

    const allFrameIds = state.catalog.map((f) => f.id);
    const displayId = state.displayFrame?.id;
    const playheadInCatalog = displayId
      ? allFrameIds.indexOf(displayId)
      : 0;
    const halfWindow = Math.floor(windowSize / 2);
    const winStart = Math.max(0, playheadInCatalog - halfWindow);
    const winEnd = Math.min(allFrameIds.length, winStart + windowSize);
    const frameIds = allFrameIds.slice(winStart, winEnd);
    const playheadIndex = Math.max(0, playheadInCatalog - winStart);

    const maxZoom = Math.max(0, ...Object.keys(tileGrid).map(Number));

    return {
      tileCache: state.tileCache,
      visibleTiles: state.visibleTileRef.tiles,
      frameIds,
      allFrameIds,
      playheadIndex,
      maxZoom,
      tileGrid,
      wastedBytes: tileStats.wastedBytes,
      evictedNeverDisplayed: tileStats.evictedNeverDisplayed,
      abortedTasks: prefetchStats.totalAborted,
      scheduledFrameIds: new Set(state.scheduledFrames.map((f) => f.id)),
      inFlightKeys: new Set(state.prefetcher.getInFlightKeys()),
      abortedKeys: state.prefetcher.getAbortedKeys(),
    };
  }
}
