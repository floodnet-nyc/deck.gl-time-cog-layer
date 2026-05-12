import type { SequenceTileCache } from "../sequence-tile-cache.js";
import type { FramePrefetcher } from "../frame-prefetcher.js";
import type {
  TimeCOGBufferState,
  TimeCOGStats,
} from "../types.js";
import type { TimeCOGLayerState } from "../time-cog-layer.js";

export function buildBufferState(
  _tileCache: SequenceTileCache,
  state: TimeCOGLayerState,
): TimeCOGBufferState {
  return {
    targetFrame: state.targetFrame,
    displayFrame: state.displayFrame,
    scheduledFrameIds: state.scheduledFrames.map((f) => f.id),
    readyFrameIds: [...state.readyFrameIds],
    missing: state.missing,
  };
}

export function buildStats(
  tileCache: SequenceTileCache,
  prefetcher: FramePrefetcher,
  state: TimeCOGLayerState,
): TimeCOGStats {
  const tileStats = tileCache.stats();
  const prefetchStats = prefetcher.stats();
  const totalDisplayAccesses =
    tileStats.displayHitCount + tileStats.displayMissCount;
  const prefetchedLoadedCount = tileStats.prefetchedLoadedCount;
  const prefetchedLoadedBytes = tileStats.prefetchedLoadedBytes;

  return {
    frameCount: state.catalog.length,
    readyFrameCount: state.readyFrameIds.size,
    cacheEntryCount: tileStats.tileCount,
    scheduledFrameCount: state.scheduledFrames.length,
    currentTimeMs: state.currentTimeMs,
    targetFrameId: state.targetFrame?.id ?? null,
    displayFrameId: state.displayFrame?.id ?? null,
    prefetchTaskCount: prefetchStats.prefetchTaskCount,
    queuedPrefetchTaskCount: prefetchStats.queuedTaskCount,
    inFlightPrefetchTaskCount: prefetchStats.inFlightTaskCount,
    rttEWMA: prefetchStats.rttEWMA,
    throughputEWMA: prefetchStats.throughputEWMA,
    abortRate: prefetchStats.abortRate,
    displayCacheHitRate:
      totalDisplayAccesses > 0
        ? tileStats.displayHitCount / totalDisplayAccesses
        : 0,
    prefetchedResidentCount: tileStats.prefetchedResidentCount,
    prefetchedUnusedResidentCount: tileStats.prefetchedUnusedResidentCount,
    prefetchedLoadedCount,
    prefetchedUsedCount: tileStats.prefetchedUsedCount,
    prefetchedWastedCount: tileStats.prefetchedWastedCount,
    prefetchedUseRate:
      prefetchedLoadedCount > 0
        ? tileStats.prefetchedUsedCount / prefetchedLoadedCount
        : 0,
    prefetchedWasteRate:
      prefetchedLoadedCount > 0
        ? tileStats.prefetchedWastedCount / prefetchedLoadedCount
        : 0,
    prefetchedResidentBytes: tileStats.prefetchedResidentBytes,
    prefetchedUnusedResidentBytes: tileStats.prefetchedUnusedResidentBytes,
    prefetchedLoadedBytes,
    prefetchedUsedBytes: tileStats.prefetchedUsedBytes,
    prefetchedWastedBytes: tileStats.prefetchedWastedBytes,
    evictedTotal: tileStats.evictedTotal,
  };
}
