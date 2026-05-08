import type {
  Layer,
  LayersList,
  UpdateParameters,
} from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import type { COGLayerProps } from "@developmentseed/deck.gl-geotiff";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";

import {
  findNearestFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./frame-catalog.js";
import { FrameCache } from "./frame-cache.js";
import { scheduleFrameWindow } from "./frame-scheduler.js";
import type {
  NormalizedTimeCOGFrame,
  TimeCOGBufferState,
  TimeCOGLayerProps,
  TimeCOGStats,
} from "./types.js";

type TimeCOGLayerState = {
  catalog: NormalizedTimeCOGFrame[];
  cache: FrameCache;
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
    this.setState({
      catalog: [],
      cache: new FrameCache(this.props.cachePolicy),
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
      state.cache.updatePolicy(props.cachePolicy);
    }

    if (framesChanged) {
      const catalog = normalizeFrameCatalog(props.frames);
      state.cache.pruneToCatalog(catalog);
      this.setState({ catalog });
    }

    if (framesChanged || timingChanged) {
      this.updateFrameState(framesChanged ? normalizeFrameCatalog(props.frames) : state.catalog);
    }
  }

  renderLayers(): Layer | LayersList | null {
    const state = this.state as TimeCOGLayerState;
    const frame = state.displayFrame;

    if (!frame) {
      return null;
    }

    const cogProps = this.cogLayerProps(frame);

    return new COGLayer({
      ...cogProps,
      id: `${this.props.id}-cog-${frame.id}`,
      geotiff: frame.url,
      onGeoTIFFLoad: (geotiff, options) => {
        const currentState = this.state as TimeCOGLayerState;
        currentState.cache.markReady(frame);
        this.props.onFrameReady?.(frame);
        this.props.onGeoTIFFLoad?.(geotiff, options);
        this.emitState(currentState);
      },
    });
  }

  private updateFrameState(catalog: NormalizedTimeCOGFrame[]): void {
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
    ).map((scheduledFrame) => scheduledFrame.frame);
    const state = this.state as TimeCOGLayerState;

    for (const frame of scheduledFrames) {
      state.cache.touch(frame);
    }

    if (resolution.displayFrame) {
      state.cache.touch(resolution.displayFrame);
    }

    this.setState({
      catalog,
      currentTimeMs,
      targetFrame: resolution.targetFrame,
      displayFrame: resolution.displayFrame,
      scheduledFrames,
      missing: resolution.missing,
    });

    const nextState = {
      ...state,
      catalog,
      currentTimeMs,
      targetFrame: resolution.targetFrame,
      displayFrame: resolution.displayFrame,
      scheduledFrames,
      missing: resolution.missing,
    };

    if (resolution.displayFrame && state.lastDisplayedFrameId !== resolution.displayFrame.id) {
      this.props.onFrameDisplayed?.(resolution.displayFrame);
      this.setState({ lastDisplayedFrameId: resolution.displayFrame.id });
      nextState.lastDisplayedFrameId = resolution.displayFrame.id;
    }

    if (resolution.missing) {
      this.props.onMissingFrame?.(currentTimeMs);
    }

    this.emitState(nextState);
  }

  private emitState(state: TimeCOGLayerState): void {
    const bufferState: TimeCOGBufferState = {
      targetFrame: state.targetFrame,
      displayFrame: state.displayFrame,
      scheduledFrameIds: state.scheduledFrames.map((frame) => frame.id),
      readyFrameIds: state.cache.readyFrameIds(),
      missing: state.missing,
    };
    const stats: TimeCOGStats = state.cache.stats(
      state.catalog.length,
      state.scheduledFrames.length,
      state.currentTimeMs,
      state.targetFrame?.id ?? null,
      state.displayFrame?.id ?? null,
    );

    this.props.onBufferStateChange?.(bufferState);
    this.props.onStats?.(stats);
  }

  private cogLayerProps(frame: NormalizedTimeCOGFrame): Omit<
    COGLayerProps,
    "id" | "geotiff" | "onGeoTIFFLoad"
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
      onFrameReady: _onFrameReady,
      onFrameDisplayed: _onFrameDisplayed,
      onMissingFrame: _onMissingFrame,
      onBufferStateChange: _onBufferStateChange,
      onStats: _onStats,
      onGeoTIFFLoad: _onGeoTIFFLoad,
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
}
