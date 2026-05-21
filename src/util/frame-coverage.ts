import type { SequenceTileCache } from "../sequence-tile-cache.js";
import type { NormalizedTimeCOGFrame } from "../types.js";

type TileCoord = { x: number; y: number; z: number };

/**
 * Compute the fraction of visible tiles cached at full quality for a
 * frame (0–1). Returns 1 when there is no frame or an empty visible
 * tile set so that the prefetcher doesn't artificially clamp
 * throughput.
 */
export function computeCoverage(
  tileCache: SequenceTileCache,
  frame: NormalizedTimeCOGFrame | null,
  visibleTiles: readonly TileCoord[],
): number {
  if (!frame || visibleTiles.length === 0) {
    return 1;
  }

  let cached = 0;

  for (const t of visibleTiles) {
    const entry = tileCache.peek(frame.id, t.x, t.y, t.z);

    if (entry && entry.quality === "full") {
      cached += 1;
    }
  }

  return cached / visibleTiles.length;
}

export type BufferCoverage = {
  bufferedAhead: number;
  bufferedBehind: number;
  targetAhead: number;
};

export type PrefetchBackpressureState = {
  coverage: number;
  bufferState: BufferCoverage;
};

/**
 * Count contiguous full-quality frames ahead of and behind the
 * playhead. Scheduled frames are sorted by timestamp so the walk
 * follows temporal order.
 */
export function computeBufferState(
  tileCache: SequenceTileCache,
  displayFrame: NormalizedTimeCOGFrame | null,
  scheduledFrames: NormalizedTimeCOGFrame[],
  visibleTiles: readonly TileCoord[],
  targetAhead: number,
): BufferCoverage {
  let bufferedAhead = 0;
  let bufferedBehind = 0;

  if (visibleTiles.length > 0 && displayFrame) {
    const byTime = [...scheduledFrames].sort((a, b) => a.timeMs - b.timeMs);
    const idx = byTime.findIndex((f) => f.id === displayFrame.id);

    if (idx >= 0) {
      for (let i = idx + 1; i < byTime.length; i += 1) {
        const f = byTime[i];

        if (f && tileCache.hasFullCoverage(f.id, visibleTiles, { trackAccess: false })) {
          bufferedAhead += 1;
        } else {
          break;
        }
      }

      for (let i = idx - 1; i >= 0; i -= 1) {
        const f = byTime[i];

        if (f && tileCache.hasFullCoverage(f.id, visibleTiles, { trackAccess: false })) {
          bufferedBehind += 1;
        } else {
          break;
        }
      }
    }
  }

  return { bufferedAhead, bufferedBehind, targetAhead };
}

/**
 * Compute the coverage and contiguous-buffer state for the frame the
 * prefetcher is actively trying to catch up to. This should be the
 * target / prefetch-anchor frame, not necessarily the currently
 * displayed frame, otherwise a fully cached held frame can mask
 * backlog on the real playback target.
 */
export function computePrefetchBackpressureState(
  tileCache: SequenceTileCache,
  targetFrame: NormalizedTimeCOGFrame | null,
  displayFrame: NormalizedTimeCOGFrame | null,
  scheduledFrames: NormalizedTimeCOGFrame[],
  visibleTiles: readonly TileCoord[],
  targetAhead: number,
): PrefetchBackpressureState {
  const anchorFrame = targetFrame ?? displayFrame;

  return {
    coverage: computeCoverage(tileCache, anchorFrame, visibleTiles),
    bufferState: computeBufferState(
      tileCache,
      anchorFrame,
      scheduledFrames,
      visibleTiles,
      targetAhead,
    ),
  };
}

export function isFrameReady(
  tileCache: SequenceTileCache,
  readyFrameIds: ReadonlySet<string>,
  frame: NormalizedTimeCOGFrame,
  visibleTiles: readonly TileCoord[],
): boolean {
  if (readyFrameIds.has(frame.id)) {
    return false;
  }

  return tileCache.hasFullCoverage(frame.id, visibleTiles, { trackAccess: false });
}
