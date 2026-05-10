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
  /**
   * Estimated compressed byte size of this frame's COG (the entire
   * file, not per-tile).  Used by the prefetcher to penalise frames
   * with large COGs in the priority queue via a log₂-scaled penalty.
   *
   * When omitted, the prefetcher auto-estimates per-frame byte sizes
   * from previously-fetched tile `byteLength` values via EWMA.
   * Because `byteSizeHint` is a *frame-level* estimate while the EWMA
   * tracks *per-tile* sizes, the EWMA takes precedence when a frame
   * has been fetched at least once — the hint serves as a cold-start
   * guide for frames that have not been loaded yet.
   */
  byteSizeHint?: number;
};

/**
 * The internally-normalized frame representation produced by
 * {@link normalizeFrameCatalog}.
 *
 * Extends {@link TimeCOGFrame} with computed fields and inherits
 * all user-supplied fields including {@link TimeCOGFrame.byteSizeHint}.
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
 * - `lowResFirst`: fetch coarse overview tiles first, then refine
 *   (always active during seek/scrub, optional during playback).
 * - `previewOverviewBias`: levels coarser than ideal visible level
 *   for initial preview on seek (default 1).
 * - `scrubOverviewBias`: additional coarse bias for scrub interactions
 *   (default 2).
 * - `fullResUpgradeIdleMs`: milliseconds of idle time before upgrading
 *   from preview to full-res (default 150).
 */
export type QualityPolicy = {
  lowResFirst?: boolean;
  previewOverviewBias?: number;
  scrubOverviewBias?: number;
  fullResUpgradeIdleMs?: number;
};

/** Detected playback interaction state, derived from prop changes. */
export type InteractionMode = 'idle' | 'seeking' | 'scrubbing' | 'playing';

/**
 * How the layer determines its tileset descriptor.
 *
 * - `'reuse-first'` (default): open the first displayed frame, compute
 *   the descriptor once, and reuse it for the layer lifetime.
 * - `'manifest'`: use a caller-supplied manifest; the layer validates
 *   the first frame against it and fires `onDescriptorMismatch` on
 *   discrepancies.
 */
export type DescriptorMode = 'reuse-first' | 'manifest';

/** Pre-declared GeoTIFF structure used with `descriptorMode: 'manifest'`. */
export type DescriptorManifest = {
  tileSize: number;
  overviewCount: number;
  tileCounts: { x: number; y: number }[];
  crs: number | object;
  nodata: number | null;
  dimensions: { width: number; height: number };
};

/**
 * Per-factor weights that control how the prefetcher scores tile tasks.
 *
 * All weights are optional.  When omitted the defaults listed below are
 * used, producing a priority order where current-frame visible tiles
 * always outrank far-future tiles.
 *
 * The final score for a task is capped to `[0, 200]`.
 */
export type ScoringWeights = {
  /** Weight per viewport-salience level (0–3).  Default 30. */
  viewportSalience?: number;
  /** Forward-direction bonus magnitude.  Default 15. */
  direction?: number;
  /** Maximum buffer-pressure boost when ahead-of-playhead buffer is low.  Default 20. */
  bufferShortfall?: number;
  /** Maximum seek/scrub interaction-override magnitude.  Default 25. */
  interaction?: number;
  /** Bonus added when a preview tile is upgraded to full resolution.  Default 50. */
  qualityUpgrade?: number;
  /** Bonus for a fresh preview when current-frame coverage is below 30 %.  Default 20. */
  qualityFreshPreview?: number;
  /** Penalty multiplier for `log₂(estimatedBytes + 1)`.  Default 2. */
  sizeHintPerBit?: number;
  /** Penalty per millisecond of estimated tile fetch time (`rttEWMA`).  Default 0.02. */
  etaPerMs?: number;
};

/** Concurrency and backpressure knobs for the prefetcher. */
export type SchedulerPolicy = {
  maxNetworkRequests?: number;
  maxDecodeTasks?: number;
  maxGpuUploadsPerFrame?: number;
  /** Optional per-factor scoring weights.  When omitted sensible defaults are used. */
  scoringWeights?: ScoringWeights;
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
  /** Tasks currently queued or in-flight in the prefetcher. */
  prefetchTaskCount: number;
  /** Exponential weighted moving average tile fetch time (ms). */
  rttEWMA: number;
  /** EWMA throughput estimate (bytes/sec). */
  throughputEWMA: number;
  /** Fraction of prefetch tasks aborted (0–1). */
  abortRate: number;
  /** Cache hit rate (0–1) across all tile lookups. */
  cacheHitRate: number;
  /** Bytes of evicted tiles that were never displayed. */
  wastedBytes: number;
  /** Tiles evicted that were never displayed. */
  evictedNeverDisplayed: number;
  /** Cumulative tiles evicted (for computing waste ratio). */
  evictedTotal: number;
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
};
