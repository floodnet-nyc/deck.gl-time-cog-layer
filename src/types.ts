import type { COGLayerProps } from "@developmentseed/deck.gl-geotiff";
import type { TileCachePolicy } from "./sequence-tile-cache.js";

/** Accepted input types for a single point on the playback timeline. */
export type TimeValue = string | number | Date;

/**
 * How to resolve a requested time that falls between catalog entries.
 *
 * - `"hold-last"`: show the most recent frame at or before the
 *   requested time (least visually disruptive for transient gaps).
 * - `"nearest"`: show the closest frame by time.
 * - `"skip"`: show nothing (returns `null` display frame).
 * - `"transparent"`: show nothing (returns `null` display frame).
 */
export type MissingFramePolicy = "hold-last" | "nearest" | "skip" | "transparent";

/**
 * A single entry in the time → COG URL frame catalog.
 * Passed as the `frames` prop to `TimeCOGLayer`.
 */
export type TimeCOGFrame = {
  /** Stable identifier.  When omitted, an ID is derived from the timestamp and canonicalized URL. */
  id?: string;
  /** Timestamp for this frame. */
  time: TimeValue;
  /** URL to the COG for this frame. */
  url: string | URL;
  /** Optional Fetch `RequestInit` (e.g. SAS auth headers) forwarded when opening this COG. */
  requestInit?: RequestInit;
  /** Opaque metadata carried through to callbacks. */
  meta?: Record<string, unknown>;
};

/**
 * The internally-normalized frame representation produced by
 * {@link normalizeFrameCatalog}.
 */
export type NormalizedTimeCOGFrame = TimeCOGFrame & {
  id: string;
  timeMs: number;
  url: string;
  cacheKey: string;
  sourceIndex: number;
};

/**
 * Controls how many frames before and after the playhead are
 * included in the prefetch schedule.
 */
export type TimeCOGBufferPolicy = {
  /** Default 2. */
  backwardFrames?: number;
  /** Default 6. */
  forwardFrames?: number;
};

/**
 * Controls progressive loading of preview (overview-biased) tiles
 * vs full-resolution tiles during seek / scrub / playback.
 *
 * Currently accepted by the API but full progressive loading is
 * deferred to a later phase; the current implementation always
 * fetches at the zoom level dictated by the tileset descriptor.
 */
export type QualityPolicy = {
  /** Fetch coarse overview tiles first, then refine. */
  lowResFirst?: boolean;
  /** Levels coarser than the ideal visible level for initial preview. */
  previewOverviewBias?: number;
  /** Additional coarse bias for scrub interactions. */
  scrubOverviewBias?: number;
  /** Milliseconds of idle time before upgrading from preview to full-res. */
  fullResUpgradeIdleMs?: number;
};

/** Concurrency and backpressure knobs for the prefetcher. */
export type SchedulerPolicy = {
  maxNetworkRequests?: number;
  maxDecodeTasks?: number;
  maxGpuUploadsPerFrame?: number;
};

export type TimeCOGCachePolicy = TileCachePolicy & {
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
  /** Interval between successive frames in milliseconds (default inferred from catalog). */
  frameIntervalMs?: number;
  missingFramePolicy?: MissingFramePolicy;
  bufferPolicy?: TimeCOGBufferPolicy;
  cachePolicy?: TimeCOGCachePolicy;
  qualityPolicy?: QualityPolicy;
  schedulerPolicy?: SchedulerPolicy;
  /** Fired once tiles for a frame begin loading. */
  onFrameReady?: (frame: NormalizedTimeCOGFrame) => void;
  /** Fired when a new frame becomes the display frame. */
  onFrameDisplayed?: (frame: NormalizedTimeCOGFrame) => void;
  /** Fired when the requested time has no exact catalog match. */
  onMissingFrame?: (timeMs: number) => void;
  onBufferStateChange?: (state: TimeCOGBufferState) => void;
  onStats?: (stats: TimeCOGStats) => void;
  /** Forwarded to the underlying COGLayer for the initial (representative) GeoTIFF. */
  onGeoTIFFLoad?: COGLayerProps["onGeoTIFFLoad"];
};
