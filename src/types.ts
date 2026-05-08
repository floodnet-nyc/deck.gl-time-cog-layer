import type { COGLayerProps } from "@developmentseed/deck.gl-geotiff";

export type TimeValue = string | number | Date;

export type MissingFramePolicy = "hold-last" | "nearest" | "skip" | "transparent";

export type TimeCOGFrame = {
  id?: string;
  time: TimeValue;
  url: string | URL;
  requestInit?: RequestInit;
  meta?: Record<string, unknown>;
};

export type NormalizedTimeCOGFrame = TimeCOGFrame & {
  id: string;
  timeMs: number;
  url: string;
  cacheKey: string;
  sourceIndex: number;
};

export type TimeCOGBufferPolicy = {
  backwardFrames?: number;
  forwardFrames?: number;
};

export type TimeCOGCachePolicy = {
  maxFrames?: number;
  maxTileEntries?: number;
  memoryBytes?: number;
};

export type TimeCOGBufferState = {
  targetFrame: NormalizedTimeCOGFrame | null;
  displayFrame: NormalizedTimeCOGFrame | null;
  scheduledFrameIds: string[];
  readyFrameIds: string[];
  missing: boolean;
};

export type TimeCOGStats = {
  frameCount: number;
  readyFrameCount: number;
  cacheEntryCount: number;
  scheduledFrameCount: number;
  currentTimeMs: number;
  targetFrameId: string | null;
  displayFrameId: string | null;
};

export type TimeCOGFrameResolution = {
  targetFrame: NormalizedTimeCOGFrame | null;
  displayFrame: NormalizedTimeCOGFrame | null;
  missing: boolean;
};

type COGLayerPassThroughProps = Omit<
  COGLayerProps,
  "id" | "geotiff" | "data" | "onGeoTIFFLoad"
>;

export type TimeCOGLayerProps = COGLayerPassThroughProps & {
  frames: TimeCOGFrame[];
  currentTime: TimeValue;
  playing?: boolean;
  playbackRate?: number;
  frameIntervalMs?: number;
  missingFramePolicy?: MissingFramePolicy;
  bufferPolicy?: TimeCOGBufferPolicy;
  cachePolicy?: TimeCOGCachePolicy;
  onFrameReady?: (frame: NormalizedTimeCOGFrame) => void;
  onFrameDisplayed?: (frame: NormalizedTimeCOGFrame) => void;
  onMissingFrame?: (timeMs: number) => void;
  onBufferStateChange?: (state: TimeCOGBufferState) => void;
  onStats?: (stats: TimeCOGStats) => void;
  onGeoTIFFLoad?: COGLayerProps["onGeoTIFFLoad"];
};
