import type { SequenceTileCache } from "../sequence-tile-cache.js";
import type { FramePrefetcher } from "../frame-prefetcher.js";
import type {
  TimeCOGBufferState,
  TimeCOGLayerState,
  TimeCOGStats,
} from "../types.js";

/**
 * Build the buffer-state payload for `onBufferStateChange`.
 */
export function buildBufferState(
  tileCache: SequenceTileCache,
  state: TimeCOGLayerState,
): TimeCOGBufferState {
  const tileStats = tileCache.stats();

  return {
    targetFrame: state.targetFrame,
    displayFrame: state.displayFrame,
    scheduledFrameIds: state.scheduledFrames.map((f) => f.id),
    readyFrameIds: tileStats.frameIds,
    missing: state.missing,
  };
}

/**
 * Combine tile-cache and prefetcher statistics into the
 * `TimeCOGStats` struct dispatched via `onStats`.
 */
export function buildStats(
  tileCache: SequenceTileCache,
  prefetcher: FramePrefetcher,
  state: TimeCOGLayerState,
): TimeCOGStats {
  const tileStats = tileCache.stats();
  const prefetchStats = prefetcher.stats();
  const totalAccesses = tileStats.hitCount + tileStats.missCount;

  return {
    frameCount: state.catalog.length,
    readyFrameCount: tileStats.frameIds.length,
    cacheEntryCount: tileStats.tileCount,
    scheduledFrameCount: state.scheduledFrames.length,
    currentTimeMs: state.currentTimeMs,
    targetFrameId: state.targetFrame?.id ?? null,
    displayFrameId: state.displayFrame?.id ?? null,
    prefetchTaskCount: prefetchStats.prefetchTaskCount,
    rttEWMA: prefetchStats.rttEWMA,
    throughputEWMA: prefetchStats.throughputEWMA,
    abortRate: prefetchStats.abortRate,
    cacheHitRate: totalAccesses > 0 ? tileStats.hitCount / totalAccesses : 0,
    wastedBytes: tileStats.wastedBytes,
    evictedNeverDisplayed: tileStats.evictedNeverDisplayed,
    evictedTotal: tileStats.evictedTotal,
  };
}
