import type { SequenceTileCache } from "../sequence-tile-cache.js";
import type { NormalizedTimeCOGFrame } from "../types.js";

type TileCoord = { x: number; y: number; z: number };

/**
 * Compute the fraction of visible tiles cached at full quality for a
 * frame (0–1).  Returns 1 when there is no frame or an empty visible
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
    const entry = tileCache.get(frame.id, t.x, t.y, t.z);

    if (entry && entry.quality === "full") {
      cached += 1;
    }
  }

  return cached / visibleTiles.length;
}

export type BufferCoverage = {
  /** Contiguous full-quality frames ahead of the playhead. */
  bufferedAhead: number;
  /** Contiguous full-quality frames behind the playhead. */
  bufferedBehind: number;
  /** Target number of forward frames (from `bufferPolicy.forwardFrames`). */
  targetAhead: number;
};

/**
 * Count how many contiguous frames ahead of and behind the playhead
 * have full tile coverage.  Scheduled frames are sorted by timestamp
 * so the walk follows temporal order, not priority order.
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

        if (f && tileCache.hasFullCoverage(f.id, visibleTiles)) {
          bufferedAhead += 1;
        } else {
          break;
        }
      }

      for (let i = idx - 1; i >= 0; i -= 1) {
        const f = byTime[i];

        if (f && tileCache.hasFullCoverage(f.id, visibleTiles)) {
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
 * Check whether a frame has not yet fired `onFrameReady` but is now
 * fully cached.  Returns the set of newly ready frames for the caller
 * to callback.
 */
export function isFrameReady(
  tileCache: SequenceTileCache,
  readyFrameIds: ReadonlySet<string>,
  frame: NormalizedTimeCOGFrame,
  visibleTiles: readonly TileCoord[],
): boolean {
  if (readyFrameIds.has(frame.id)) {
    return false;
  }

  return tileCache.hasFullCoverage(frame.id, visibleTiles);
}
