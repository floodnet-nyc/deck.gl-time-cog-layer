export {
  canonicalizeUrl,
  findNearestFrameIndex,
  findPreviousFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./util/frame-catalog.js";
export { FramePrefetcher } from "./frame-prefetcher.js";
export { GeoTIFFRegistry } from "./util/geotiff-registry.js";
export type { BufferCoverage } from "./util/frame-coverage.js";
export { computeCoverage, computeBufferState, isFrameReady } from "./util/frame-coverage.js";
export type { CachedTile, TileCachePolicy, TileCacheStats, TileOrigin, TileQuality } from "./sequence-tile-cache.js";
export { SequenceTileCache } from "./sequence-tile-cache.js";
export type { TimeCOGLayerProps } from "./time-cog-layer.js";
export { TimeCOGLayer } from "./time-cog-layer.js";
export type { TileDiagSnapshot } from "./util/tile-diagnostics.js";
export { renderTileDiagnostics, buildTileDiagSnapshot } from "./util/tile-diagnostics.js";
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
} from "./types.js";
export { scheduleFrameWindow, applyMaxFrameRateBucking, type ScheduledFrame } from "./util/frame-scheduler.js";
export { detectInteractionMode } from "./util/interaction-mode.js";
export { buildBufferState, buildStats } from "./util/stats-collector.js";
export { TaskQueue, taskKey, type TileTask, type TileCoord } from "./util/task-queue.js";
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
} from "./util/task-scorer.js";
export {
  imageForZ,
  hasTile,
  decodeGeoTIFFTile,
  getGeoTiffDescriptor,
  mapToCoarserZoom,
  isMissingTileError,
} from "./util/tile-utils.js";
