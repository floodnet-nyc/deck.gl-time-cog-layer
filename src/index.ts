export {
  canonicalizeUrl,
  findNearestFrameIndex,
  findPreviousFrameIndex,
  normalizeFrameCatalog,
  parseTimeValue,
  resolveFrameForTime,
} from "./util/frame-catalog.js";
export { FramePrefetcher } from "./frame-prefetcher.js";
export { TaskQueue, taskKey } from "./task-queue.js";
export type { TileTask, TileCoord } from "./task-queue.js";
export { GeoTIFFRegistry } from "./util/geotiff-registry.js";
export {
  scoreTask,
  temporalProximityScore,
  directionScore,
  bufferShortfallScore,
  interactionScore,
  qualityUrgencyScore,
  sizeHintPenalty,
  etaPenalty,
  qualityForTask,
  FALLBACK_WEIGHTS,
  type ScoringContext,
} from "./util/task-scorer.js";
export { detectInteractionMode } from "./util/interaction-mode.js";
export { computeCoverage, computeBufferState, isFrameReady } from "./util/frame-coverage.js";
export type { BufferCoverage } from "./util/frame-coverage.js";
export { buildBufferState, buildStats } from "./util/stats-collector.js";
export { extractCOGLayerProps, TIME_COG_EXCLUDED_KEYS } from "./util/cog-prop-keys.js";
export type { TimeCOGExcludedKey } from "./util/cog-prop-keys.js";
export { scheduleFrameWindow } from "./util/frame-scheduler.js";
export type { CachedTile, TileCachePolicy, TileCacheStats, TileQuality } from "./sequence-tile-cache.js";
export { SequenceTileCache } from "./sequence-tile-cache.js";
export {
  hasTile,
  imageForZ,
  isMissingTileError,
  mapToCoarserZoom,
} from "./util/tile-utils.js";
export { TimeCOGLayer } from "./time-cog-layer.js";
export type { TileDiagSnapshot } from "./util/tile-diagnostics.js";
export { renderTileDiagnostics } from "./util/tile-diagnostics.js";
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
  TimeCOGLayerProps,
  TimeCOGStats,
  TimeValue,
} from "./types.js";
