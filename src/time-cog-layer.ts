import type {
  Layer,
  LayersList,
  UpdateParameters,
} from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import type { _Tile2DHeader, _Tileset2DProps, _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
import type { Device } from "@luma.gl/core";
import {
  findNearestFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./util/frame-catalog.js";
import { FramePrefetcher } from "./frame-prefetcher.js";
import { scheduleFrameWindow, applyMaxFrameRateBucking } from "./util/frame-scheduler.js";
import { SequenceTileCache } from "./sequence-tile-cache.js";
import { TimeSequenceTileLayer } from "./time-sequence-tile-layer.js";
import { GeoTIFFRegistry } from "./util/geotiff-registry.js";
import { detectInteractionMode } from "./util/interaction-mode.js";
import { computeCoverage, computeBufferState } from "./util/frame-coverage.js";
import { buildBufferState, buildStats } from "./util/stats-collector.js";
import type {
  COGLayerPassThroughProps,
  DescriptorManifest,
  DescriptorMode,
  InteractionMode,
  MissingFramePolicy,
  NormalizedTimeCOGFrame,
  QualityPolicy,
  SchedulerPolicy,
  TileCoord,
  TimeCOGBufferPolicy,
  TimeCOGBufferState,
  TimeCOGCachePolicy,
  TimeCOGFrame,
  TimeCOGStats,
  TimeValue,
} from "./types.js";
import type { TileDiagSnapshot } from "./util/tile-diagnostics.js";
import type { COGLayerProps } from "@developmentseed/deck.gl-geotiff";

/**
 * Props for {@link TimeCOGLayer}.
 *
 * Extends all COG rendering props (opacity, colormap, etc.) and
 * adds the temporal orchestration knobs.
 */

export type TimeCOGLayerProps = COGLayerPassThroughProps & {
  /** Ordered list of time → COG URL entries. */
  frames: TimeCOGFrame[];
  /** Current playback time (epoch ms, ISO string, or Date). */
  currentTime: TimeValue;
  /** Whether playback is active. */
  playing?: boolean;
  /**
   * Playback speed multiplier.
   * A value of 60 means 60× real-time (1 minute per second).
   */
  playbackRate?: number;
  /** Maximum display frame rate during playback in frames per second (0 = unlimited).  Default 0. */
  maxFrameRate?: number;
  missingFramePolicy?: MissingFramePolicy;
  bufferPolicy?: TimeCOGBufferPolicy;
  cachePolicy?: TimeCOGCachePolicy;
  qualityPolicy?: QualityPolicy;
  schedulerPolicy?: SchedulerPolicy;
  /**
   * How the shared tileset descriptor is determined.
   *
   * - `'reuse-first'` (default): compute once from the first displayed
   *   frame and never re-validate.
   * - `'manifest'`: validate the first frame against {@link descriptorManifest}.
   */
  descriptorMode?: DescriptorMode;
  /** Required when `descriptorMode` is `'manifest'`. */
  descriptorManifest?: DescriptorManifest;
  /** Fired when the display frame is fully cached at full resolution. */
  onFrameReady?: (frame: NormalizedTimeCOGFrame) => void;
  /** Fired when a new frame becomes the display frame. */
  onFrameDisplayed?: (frame: NormalizedTimeCOGFrame) => void;
  /** Fired when the requested time has no exact catalog match. */
  onMissingFrame?: (timeMs: number) => void;
  /** Fired when `descriptorMode: 'manifest'` detects a structural mismatch. */
  onDescriptorMismatch?: (frame: NormalizedTimeCOGFrame, reason: string) => void;
  onBufferStateChange?: (state: TimeCOGBufferState) => void;
  onStats?: (stats: TimeCOGStats) => void;
  /** Forwarded to the underlying COGLayer for the initial (representative) GeoTIFF. */
  onGeoTIFFLoad?: COGLayerProps["onGeoTIFFLoad"];
  /** Optional callback fired whenever the visible tile set changes. */
  onViewportLoad?: (tiles: _Tile2DHeader<Record<string, unknown>>[]) => void;
};/**
 * Internal state for {@link TimeCOGLayer}.
 *
 * The state is intentionally flat so that deck.gl can shallow-diff it
 * efficiently across the render / update cycle.  The three “shared
 * infrastructure” fields — `tileCache`, `prefetcher`, and
 * `visibleTileRef` — are created once in `initializeState` and live
 * for the full lifetime of the layer.  The sublayer
 * (`TimeSequenceTileLayer`) reads from them via props, so they must
 * remain the **same object** across renders.
 */

export type TimeCOGLayerState = {
  /** Full ordered catalog of every frame (time → URL).  Never mutated, only replaced when `frames` prop changes. */
  catalog: NormalizedTimeCOGFrame[];

  /**
   * The shared GPU / CPU tile cache.
   * Stores decoded textures keyed by `(frameId, tileX, tileY, zoom)`.
   * Both the sublayer (`_getTileDataCallback`) and the
   * `FramePrefetcher` read from and write to this cache, which is why
   * it lives on the parent composite layer.
   */
  tileCache: SequenceTileCache;

  /**
   * Shared GeoTIFF instance registry.
   * Both the sublayer and the prefetcher use this to open COG files,
   * eliminating redundant header fetches.
   */
  geotiffRegistry: GeoTIFFRegistry;

  /**
   * Background prefetch pipeline.
   * On every `updateState` it receives the current playback snapshot
   * (target frame, scheduled frames, visible tiles, device, etc.) and
   * proactively fetches tiles for nearby frames.
   */
  prefetcher: FramePrefetcher;

  /**
 
 
  /**
   * Shared mutable reference that the inner TileLayer updates via its
   * `onViewportLoad` callback.  The parent layer reads this on each
   * `updateState` to feed the prefetcher.
   */
  visibleTileRef: { tiles: TileCoord[]; };

  /**
   * The GeoTIFF URL of the very first displayed frame.
   * This URL is passed as the `geotiff` prop to the persistent
   * `COGLayer` sublayer so that the shared tileset descriptor is
   * parsed **once** and reused for the lifetime of the layer.
   * Changing the `geotiff` URL would cause COGLayer to re-parse the
   * header, tearing down the descriptor and inner TileLayer.
   */
  initialGeotiffUrl: string;

  /** The current playback time, as a millisecond epoch. */
  currentTimeMs: number;

  /** The frame closest to `currentTimeMs` in the catalog. */
  targetFrame: NormalizedTimeCOGFrame | null;

  /**
   * The frame that is actually visible on screen.
   * May differ from `targetFrame` when the configured
   * `missingFramePolicy` resolves to a fallback (e.g. `hold-last`).
   */
  displayFrame: NormalizedTimeCOGFrame | null;

  /** Frames selected for prefetching, sorted by priority (target first). */
  scheduledFrames: NormalizedTimeCOGFrame[];

  /** True when the requested time has no exact match in the catalog. */
  missing: boolean;

  /** Tracks the most recently displayed frame so that `onFrameDisplayed` only fires on transitions. */
  lastDisplayedFrameId: string | null;

  /** Detected playback interaction state, derived from prop change frequency. */
  interactionMode: InteractionMode;

  /** `Date.now()` of the last user-triggered timing change (seek / scrub). */
  lastInteractionMs: number;

  /** Timer that fires `fullResUpgradeIdleMs` after the last interaction to trigger full-res upgrades. */
  upgradeTimer: ReturnType<typeof setTimeout> | null;

  /** Frame IDs that have already fired `onFrameReady` to avoid duplicate signals. */
  readyFrameIds: Set<string>;
};

const DEFAULT_MISSING_FRAME_POLICY = "hold-last";

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
      geotiffRegistry: new GeoTIFFRegistry(),
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
   * Frame changes are handled by the shared cache plus a reload of the
   * persistent sublayer's tile data callback for the new frame.
   */
  renderLayers(): Layer | LayersList | null {
    const state = this.state;
    const frame = state.displayFrame;

    if (!frame) {
      return null;
    }

    // Get passThrough props by excluding this layer's props
    const {
      id,
      frames,
      currentTime,
      playing,
      playbackRate,
      maxFrameRate,

      descriptorMode,
      descriptorManifest,

      missingFramePolicy,
      bufferPolicy,
      cachePolicy,
      qualityPolicy,
      schedulerPolicy,

      onFrameReady,
      onFrameDisplayed,
      onMissingFrame,
      onDescriptorMismatch,
      onBufferStateChange,
      onStats,
      getTileData,
      
      renderTile,
      loadOptions,
      updateTriggers,
      onViewportLoad,
      onGeoTIFFLoad,
      ...passThrough
    } = this.props;

    const initialUrl = state.initialGeotiffUrl || frame.url;

    return new TimeSequenceTileLayer({
      ...passThrough,
      id: `${id}-tiles`,
      geotiff: initialUrl,
      getTileData: this._getTileDataCallback(frame),
      renderTile,
      loadOptions: frame.requestInit ? {
        ...loadOptions,
        fetch: {
          ...loadOptions?.fetch,
          ...frame.requestInit,
        }
      } : loadOptions,
      updateTriggers: {
        renderSubLayers: updateTriggers?.renderTile,
        ...updateTriggers,
        getTileData: frame.id,
      },
      onGeoTIFFLoad: this._getOnGeoTiffLoadCallback(frame),
      onViewportLoad: (loadedTiles: _Tile2DHeader<Record<string, unknown>>[]) => {
        if (state.visibleTileRef) {
          state.visibleTileRef.tiles = loadedTiles.map(({ index: { x, y, z } }) => ({ x, y, z }));
        }

        this.updatePrefetch();
        onViewportLoad?.(loadedTiles);
      },
    } as object);
  }

  protected _getTileDataCallback(frame: NormalizedTimeCOGFrame): ((props: TileLoadProps, options: { device: Device; signal?: AbortSignal }) => Promise<any>) | undefined {
    const tileCache = this.state.tileCache;
    const registry = this.state.geotiffRegistry;
    if (!tileCache) {
      return undefined;
    }

    const getTileData = this.props.getTileData;
    if (!getTileData) {
      return undefined;
    }

    return async (
      tile: TileLoadProps,
      options: { device: Device; signal?: AbortSignal },
    ) => {
      const { id, url, requestInit } = frame;
      const { x, y, z } = tile.index;

      const hit = tileCache.get(id, x, y, z);
      if (hit) {
        tileCache.recordDisplayHit();
        tileCache.markDisplayed(id, x, y, z);
        return hit;
      }
      tileCache.recordDisplayMiss();

      const result = await registry.decodeTile(
        { id, url, x, y, z, getTileData },
        {
          device: options.device,
          signal: options.signal,
          pool: this.props.pool,
          requestInit,
        },
      );

      if (!result) {
        return null;
      }

      tileCache.put(id, x, y, z, {
        x, y, z,
        ...result,
        quality: "full",
        origin: "display",
      });

      return result;
    };
  }

  protected _getOnGeoTiffLoadCallback(frame: NormalizedTimeCOGFrame): COGLayerProps["onGeoTIFFLoad"] {
    const userCallback = this.props.onGeoTIFFLoad;

    if (!this.props.descriptorMode || this.props.descriptorMode === "reuse-first") {
      return userCallback;
    }

    if (this.props.descriptorMode === "manifest" && this.props.descriptorManifest) {
      const manifest = this.props.descriptorManifest;

      return (geotiff: any, options: any) => {
        if (geotiff) {
          const mismatches: string[] = [];

          if (geotiff.overviews.length + 1 !== manifest.overviewCount) {
            mismatches.push(`overviewCount: expected ${manifest.overviewCount}, got ${geotiff.overviews.length + 1}`);
          }

          if (mismatches.length > 0) {
            this.props.onDescriptorMismatch?.(frame, mismatches.join("; "));
          }
        }

        userCallback?.(geotiff, options);
      }
    }

    return userCallback;
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

    if (playing && resolution.displayFrame) {
      resolution.displayFrame = applyMaxFrameRateBucking(
        resolution.displayFrame,
        catalog,
        state.lastDisplayedFrameId,
        this.props.maxFrameRate ?? 0,
        this.props.playbackRate ?? 0,
      );
    }

    const prefetchAnchorFrame =
      playing && (this.props.maxFrameRate ?? 0) > 0 && resolution.displayFrame
        ? resolution.displayFrame
        : resolution.targetFrame;

    const targetIndex = prefetchAnchorFrame
      ? findNearestFrameIndex(catalog, prefetchAnchorFrame.timeMs)
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

    const interactionMode = detectInteractionMode(
      playing,
      state.lastInteractionMs,
      this.props.qualityPolicy?.fullResUpgradeIdleMs,
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
      targetFrame: prefetchAnchorFrame,
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

  private emitState(s: TimeCOGLayerState): void {
    this.props.onBufferStateChange?.(buildBufferState(s.tileCache, s));
    this.props.onStats?.(buildStats(s.tileCache, s.prefetcher, s));
  }

  private updatePrefetch(snapshot?: {
    targetFrame: NormalizedTimeCOGFrame | null;
    displayFrame: NormalizedTimeCOGFrame | null;
    scheduledFrames: NormalizedTimeCOGFrame[];
  }): void {
    const state = this.state;
    const targetFrame = snapshot?.targetFrame ?? state.targetFrame;
    const displayFrame = snapshot?.displayFrame ?? state.displayFrame;
    const scheduledFrames = snapshot?.scheduledFrames ?? state.scheduledFrames;

    if (
      !targetFrame ||
      !displayFrame ||
      !this.context.device ||
      !this.props.getTileData
    ) {
      return;
    }

    const pool = this.props.pool ?? defaultDecoderPool();

    const coverage = computeCoverage(
      state.tileCache,
      displayFrame,
      state.visibleTileRef.tiles,
    );

    const bufferState = computeBufferState(
      state.tileCache,
      displayFrame,
      scheduledFrames,
      state.visibleTileRef.tiles,
      this.props.bufferPolicy?.forwardFrames ?? 6,
    );

    state.prefetcher.update({
      targetFrame,
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
      geotiffRegistry: state.geotiffRegistry,
    });

    this.checkFrameReady(displayFrame);
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
        { trackAccess: false },
      )
    ) {
      state.readyFrameIds.add(frame.id);
      this.props.onFrameReady?.(frame);
    }
  }

  /**
   * Returns a snapshot of the current tile state for the diagnostic
   * minimap.
   *
   * @param windowSize - Optional number of frame columns to include in a
   *   playhead-centered window. Omit to capture the full timeline.
   */
  getDiagnosticSnapshot(windowSize?: number): TileDiagSnapshot {
    const empty: TileDiagSnapshot = {
      frameIds: [],
      allFrameIds: [],
      playheadIndex: 0,
      zoomLevels: [],
      visibleTiles: [],
      tileGrid: {},
      tileStates: {},
      prefetchedUnusedResidentCount: 0,
      prefetchedUnusedResidentBytes: 0,
      prefetchedWastedCount: 0,
      prefetchedWastedBytes: 0,
      prefetchedUsedCount: 0,
      prefetchedLoadedCount: 0,
      abortedTasks: 0,
      scheduledFrameIds: new Set<string>(),
      inFlightKeys: new Set<string>(),
    };
    const state = this.state;

    if (!state || !state.tileCache) {
      return empty;
    }

    const tileStats = state.tileCache.stats();
    const prefetchStats = state.prefetcher.stats();

    const tileGrid: Record<number, { cols: number; rows: number }> = {};
    const tileStates: TileDiagSnapshot["tileStates"] = {};
    const visibleTiles = state.visibleTileRef?.tiles ?? [];

    for (const v of visibleTiles) {
      if (!tileGrid[v.z]) {
        tileGrid[v.z] = { cols: v.x + 1, rows: v.y + 1 };
      } else {
        tileGrid[v.z]!.cols = Math.max(tileGrid[v.z]!.cols, v.x + 1);
        tileGrid[v.z]!.rows = Math.max(tileGrid[v.z]!.rows, v.y + 1);
      }
    }

    for (const [, tile] of state.tileCache.entries()) {
      tileStates[`${tile.frameId}:${tile.x}:${tile.y}:${tile.z}`] = {
        quality: tile.quality,
        origin: tile.origin,
        wasDisplayed: tile.wasDisplayed,
      };

      if (!tileGrid[tile.z]) {
        tileGrid[tile.z] = { cols: tile.x + 1, rows: tile.y + 1 };
      } else if (visibleTiles.length === 0) {
        tileGrid[tile.z]!.cols = Math.max(tileGrid[tile.z]!.cols, tile.x + 1);
        tileGrid[tile.z]!.rows = Math.max(tileGrid[tile.z]!.rows, tile.y + 1);
      }
    }

    const allFrameIds = state.catalog.map((f) => f.id);
    const displayId = state.displayFrame?.id;
    const playheadInCatalog = displayId
      ? allFrameIds.indexOf(displayId)
      : 0;
    const hasWindow = typeof windowSize === "number" && windowSize > 0;
    const halfWindow = hasWindow ? Math.floor(windowSize / 2) : 0;
    const winStart = hasWindow
      ? Math.max(0, playheadInCatalog - halfWindow)
      : 0;
    const winEnd = hasWindow
      ? Math.min(allFrameIds.length, winStart + windowSize)
      : allFrameIds.length;
    const frameIds = allFrameIds.slice(winStart, winEnd);
    const playheadIndex = Math.max(0, playheadInCatalog - winStart);
    const zoomLevels = Object.keys(tileGrid)
      .map(Number)
      .sort((a, b) => a - b);

    return {
      frameIds,
      allFrameIds,
      playheadIndex,
      zoomLevels,
      visibleTiles,
      tileGrid,
      tileStates,
      prefetchedUnusedResidentCount: tileStats.prefetchedUnusedResidentCount,
      prefetchedUnusedResidentBytes: tileStats.prefetchedUnusedResidentBytes,
      prefetchedWastedCount: tileStats.prefetchedWastedCount,
      prefetchedWastedBytes: tileStats.prefetchedWastedBytes,
      prefetchedUsedCount: tileStats.prefetchedUsedCount,
      prefetchedLoadedCount: tileStats.prefetchedLoadedCount,
      abortedTasks: prefetchStats.totalAborted,
      scheduledFrameIds: new Set(state.scheduledFrames.map((f) => f.id)),
      inFlightKeys: new Set(state.prefetcher.getInFlightKeys()),
    };
  }
}
