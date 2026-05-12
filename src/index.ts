export {
  canonicalizeUrl,
  findNearestFrameIndex,
  findPreviousFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./util/frame-catalog";
export { FramePrefetcher } from "./frame-prefetcher";
export { GeoTIFFRegistry } from "./util/geotiff-registry";
export type { BufferCoverage } from "./util/frame-coverage";
export { computeCoverage, computeBufferState, isFrameReady } from "./util/frame-coverage";
export type { CachedTile, TileCachePolicy, TileCacheStats, TileOrigin, TileQuality } from "./sequence-tile-cache";
export { SequenceTileCache } from "./sequence-tile-cache";
export type { TimeCOGLayerProps } from "./time-cog-layer";
export { TimeCOGLayer } from "./time-cog-layer";
export type { TileDiagSnapshot } from "./util/tile-diagnostics";
export { renderTileDiagnostics, buildTileDiagSnapshot } from "./util/tile-diagnostics";
export type {
  DescriptorManifest,
  DescriptorMode,
  InteractionMode,
  MissingFramePolicy,
  NormalizedTimeCOGFrame,
  QualityPolicy,
  SchedulerPolicy,
  ScoringWeights,
  TimeCOGBufferPolicy,
  TimeCOGBufferState,
  TimeCOGCachePolicy,
  TimeCOGFrame,
  TimeCOGFrameResolution,
  TimeCOGStats,
  TimeValue,
} from "./types";
export { scheduleFrameWindow, applyMaxFrameRateBucking, type ScheduledFrame } from "./util/frame-scheduler";
export { detectInteractionMode } from "./util/interaction-mode";
export { buildBufferState, buildStats } from "./util/stats-collector";
export { TaskQueue, taskKey, type TileTask, type TileCoord } from "./util/task-queue";
export {
  scoreTask,
  temporalProximityScore,
  directionScore,
  bufferShortfallScore,
  interactionScore,
  qualityUrgencyScore,
  sizeHintPenalty,
  etaPenalty,
  FALLBACK_WEIGHTS,
  type ScoringContext,
} from "./util/task-scorer";
export {
  imageForZ,
  hasTile,
  decodeGeoTIFFTile,
  getGeoTiffDescriptor,
  mapToCoarserZoom,
  isMissingTileError,
} from "./util/tile-utils";
