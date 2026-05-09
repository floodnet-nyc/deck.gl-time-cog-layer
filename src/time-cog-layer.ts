import type {
  Layer,
  LayersList,
  UpdateParameters,
} from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import type { DecoderPool, GeoTIFF, Overview } from "@developmentseed/geotiff";
import {
  findNearestFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./frame-catalog.js";
import { FramePrefetcher } from "./frame-prefetcher.js";
import { scheduleFrameWindow } from "./frame-scheduler.js";
import { SequenceTileCache } from "./sequence-tile-cache.js";
import {
  TimeSequenceTileLayer,
} from "./time-sequence-tile-layer.js";
import type {
  InteractionMode,
  NormalizedTimeCOGFrame,
  QualityPolicy,
  TimeCOGBufferState,
  TimeCOGLayerProps,
  TimeCOGStats,
} from "./types.js";

type TileCoord = { x: number; y: number; z: number };

/**
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
type TimeCOGLayerState = {
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
   * Background prefetch pipeline.
   * On every `updateState` it receives the current playback snapshot
   * (target frame, scheduled frames, visible tiles, device, etc.) and
   * proactively fetches tiles for nearby frames.
   */
  prefetcher: FramePrefetcher;

  /**
   * Shared mutable reference that the inner TileLayer updates via its
   * `onViewportLoad` callback.  The parent layer reads this on each
   * `updateState` to feed the prefetcher.
   */
  visibleTileRef: { tiles: TileCoord[] };

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
    const state = this.state as TimeCOGLayerState;
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

    if (framesChanged) {
      const catalog = normalizeFrameCatalog(props.frames);
      this.setState({ catalog });
    }

    if (framesChanged || timingChanged) {
      if (timeChanged) {
        state.lastInteractionMs = Date.now();
      }

      this.updateFrameState(
        framesChanged
          ? normalizeFrameCatalog(props.frames)
          : state.catalog,
      );
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
    const state = this.state as TimeCOGLayerState;
    const frame = state.displayFrame;

    if (!frame) {
      return null;
    }

    const initialUrl =
      state.initialGeotiffUrl || frame.url;

    const passThrough = this.cogLayerProps(frame);
    const qualityPolicy = this.props.qualityPolicy ?? {};
    const bias =
      state.interactionMode === "scrubbing"
        ? (qualityPolicy.scrubOverviewBias ?? 2)
        : state.interactionMode === "seeking"
          ? (qualityPolicy.previewOverviewBias ?? 1)
          : 0;

    const userGeoTiff = this.props.onGeoTIFFLoad;
    const wrappedGeoTiff = userGeoTiff
      ? (...args: Parameters<typeof userGeoTiff>) => {
          userGeoTiff(...args);
        }
      : undefined;

    if (this.props.descriptorMode === "manifest" && this.props.descriptorManifest) {
      const manifest = this.props.descriptorManifest;

      return new TimeSequenceTileLayer({
        ...passThrough,
        id: `${this.props.id}-tiles`,
        geotiff: initialUrl,
        getTileData: this.props.getTileData as never,
        renderTile: this.props.renderTile as never,
        sequenceTileCache: state.tileCache,
        currentFrameId: frame.id,
        currentFrameUrl: frame.url,
        currentFrameRequestInit: frame.requestInit,
        previewBias: bias,
        visibleTileRef: state.visibleTileRef,
        onVisibleTilesChange: () => this.updatePrefetch(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onGeoTIFFLoad: ((geotiff: any, options: any) => {
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
        }) as never,
      } as object);
    }

    return new TimeSequenceTileLayer({
      ...passThrough,
      id: `${this.props.id}-tiles`,
      geotiff: initialUrl,
      getTileData: this.props.getTileData as never,
      renderTile: this.props.renderTile as never,
      sequenceTileCache: state.tileCache,
      currentFrameId: frame.id,
      currentFrameUrl: frame.url,
      currentFrameRequestInit: frame.requestInit,
      previewBias: bias,
      visibleTileRef: state.visibleTileRef,
      onVisibleTilesChange: () => this.updatePrefetch(),
      ...(wrappedGeoTiff ? { onGeoTIFFLoad: wrappedGeoTiff } : {}),
    } as object);
  }

  /**
   * Aborts all in-flight prefetch tasks and destroys GPU textures.
   */
  finalizeState(): void {
    const state = this.state as TimeCOGLayerState;

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
    const state = this.state as TimeCOGLayerState;
    const currentTimeMs = parseTimeValue(this.props.currentTime);
    const playing = this.props.playing ?? false;
    const resolution = resolveFrameForTime(
      catalog,
      currentTimeMs,
      this.props.missingFramePolicy ?? DEFAULT_MISSING_FRAME_POLICY,
    );
    const targetIndex = resolution.targetFrame
      ? findNearestFrameIndex(catalog, resolution.targetFrame.timeMs)
      : -1;

    const scheduledFrames = scheduleFrameWindow(
      catalog,
      targetIndex,
      this.props.bufferPolicy,
      this.props.playbackRate,
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
        const s = this.state as TimeCOGLayerState;

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

    const elapsed = Date.now() - lastInteractionMs;

    if (lastInteractionMs === 0 || elapsed >= (this.props.qualityPolicy?.fullResUpgradeIdleMs ?? 150)) {
      return "idle";
    }

    if (elapsed < 200) {
      return "scrubbing";
    }

    return "seeking";
  }

  /** Fire `onFrameReady` if the display frame achieves full tile coverage for the first time. */
  private checkFrameReady(frame: NormalizedTimeCOGFrame): void {
    const state = this.state as TimeCOGLayerState;

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

  private emitState(s: TimeCOGLayerState): void {
    const tileStats = s.tileCache.stats();

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
    };

    this.props.onBufferStateChange?.(bufferState);
    this.props.onStats?.(stats);
  }

  private updatePrefetch(snapshot?: {
    displayFrame: NormalizedTimeCOGFrame | null;
    scheduledFrames: NormalizedTimeCOGFrame[];
  }): void {
    const state = this.state as TimeCOGLayerState;
    const displayFrame = snapshot?.displayFrame ?? state.displayFrame;
    const scheduledFrames = snapshot?.scheduledFrames ?? state.scheduledFrames;

    if (
      !displayFrame ||
      !this.context.device ||
      !this.props.getTileData
    ) {
      return;
    }

    const pool =
      (
        this.props as unknown as { pool?: DecoderPool }
      ).pool ?? defaultDecoderPool();

    state.prefetcher.update({
      targetFrame: displayFrame,
      scheduledFrames,
      visibleTiles: state.visibleTileRef.tiles,
      device: this.context.device,
      getUserTileData: this.props.getTileData as (
        image: GeoTIFF | Overview,
        options: {
          device: import("@luma.gl/core").Device;
          x: number;
          y: number;
          signal?: AbortSignal;
          pool: DecoderPool;
        },
      ) => Promise<{
        texture: import("@luma.gl/core").Texture;
        mask?: import("@luma.gl/core").Texture;
        byteLength: number;
        width: number;
        height: number;
      }>,
      pool,
      playing: this.props.playing ?? false,
      playbackRate: this.props.playbackRate ?? 0,
      signal:
        (this.props as Record<string, unknown>).signal as
          | AbortSignal
          | undefined,
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
      return cogProps as ReturnType<typeof this.cogLayerProps>;
    }

    return {
      ...cogProps,
      loadOptions: {
        ...(
          cogProps as Record<string, unknown>
        ).loadOptions as Record<string, unknown>,
        fetch: {
          ...(
            (
              cogProps as Record<string, unknown>
            ).loadOptions as Record<string, unknown>
          )?.fetch as Record<string, unknown>,
          ...frame.requestInit,
        },
      },
    } as ReturnType<typeof this.cogLayerProps>;
  }

  /**
   * Returns a snapshot of the current tile state for the diagnostic
   * minimap.
   *
   * @param windowSize - Number of frame columns to include in the
   *   window, centered on the playhead (default 60).
   */
  getDiagnosticSnapshot(windowSize = 60): {
    tileCache: SequenceTileCache;
    visibleTiles: { x: number; y: number; z: number }[];
    frameIds: string[];
    allFrameIds: string[];
    playheadIndex: number;
    maxZoom: number;
    tileGrid: Record<number, { maxX: number; maxY: number }>;
  } {
    const empty = {
      tileCache: new SequenceTileCache(),
      visibleTiles: [] as { x: number; y: number; z: number }[],
      frameIds: [] as string[],
      allFrameIds: [] as string[],
      playheadIndex: 0,
      maxZoom: 0,
      tileGrid: {} as Record<number, { maxX: number; maxY: number }>,
    };
    const state = this.state as TimeCOGLayerState | undefined;

    if (!state || !state.tileCache || !state.visibleTileRef) {
      return empty;
    }

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
    };
  }
}
