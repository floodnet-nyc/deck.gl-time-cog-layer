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
  NormalizedTimeCOGFrame,
  TimeCOGBufferState,
  TimeCOGLayerProps,
  TimeCOGStats,
} from "./types.js";

type TileCoord = { x: number; y: number; z: number };

type TimeCOGLayerState = {
  catalog: NormalizedTimeCOGFrame[];
  tileCache: SequenceTileCache;
  prefetcher: FramePrefetcher;
  visibleTileRef: { tiles: TileCoord[] };
  initialGeotiffUrl: string;
  currentTimeMs: number;
  targetFrame: NormalizedTimeCOGFrame | null;
  displayFrame: NormalizedTimeCOGFrame | null;
  scheduledFrames: NormalizedTimeCOGFrame[];
  missing: boolean;
  lastDisplayedFrameId: string | null;
};

const DEFAULT_MISSING_FRAME_POLICY = "hold-last";

export class TimeCOGLayer extends CompositeLayer<TimeCOGLayerProps> {
  static layerName = "TimeCOGLayer";

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
    } satisfies TimeCOGLayerState);
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    const state = this.state as TimeCOGLayerState;
    const framesChanged = props.frames !== oldProps.frames;
    const cachePolicyChanged = props.cachePolicy !== oldProps.cachePolicy;
    const timingChanged =
      props.currentTime !== oldProps.currentTime ||
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
      this.updateFrameState(
        framesChanged
          ? normalizeFrameCatalog(props.frames)
          : state.catalog,
      );
    }
  }

  renderLayers(): Layer | LayersList | null {
    const state = this.state as TimeCOGLayerState;
    const frame = state.displayFrame;

    if (!frame) {
      return null;
    }

    const initialUrl =
      state.initialGeotiffUrl || frame.url;

    const passThrough = this.cogLayerProps(frame);

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
      visibleTileRef: state.visibleTileRef,
      onVisibleTilesChange: () => this.updatePrefetch(),
    } as object);
  }

  finalizeState(): void {
    const state = this.state as TimeCOGLayerState;
    state.prefetcher?.abortAll();
    state.tileCache?.destroy();
  }

  private updateFrameState(
    catalog: NormalizedTimeCOGFrame[],
  ): void {
    const state = this.state as TimeCOGLayerState;
    const currentTimeMs = parseTimeValue(this.props.currentTime);
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
      this.props.playing,
    ).map((sf) => sf.frame);

    if (!state.initialGeotiffUrl && resolution.displayFrame) {
      this.setState({
        initialGeotiffUrl: resolution.displayFrame.url,
      });
    }

    this.setState({
      catalog,
      currentTimeMs,
      targetFrame: resolution.targetFrame,
      displayFrame: resolution.displayFrame,
      scheduledFrames,
      missing: resolution.missing,
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
    });
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
    });
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
    | "frameIntervalMs"
    | "missingFramePolicy"
    | "bufferPolicy"
    | "cachePolicy"
    | "qualityPolicy"
    | "schedulerPolicy"
    | "onFrameReady"
    | "onFrameDisplayed"
    | "onMissingFrame"
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
      frameIntervalMs: _frameIntervalMs,
      missingFramePolicy: _missingFramePolicy,
      bufferPolicy: _bufferPolicy,
      cachePolicy: _cachePolicy,
      qualityPolicy: _qualityPolicy,
      schedulerPolicy: _schedulerPolicy,
      onFrameReady: _onFrameReady,
      onFrameDisplayed: _onFrameDisplayed,
      onMissingFrame: _onMissingFrame,
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
