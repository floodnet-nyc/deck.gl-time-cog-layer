import type {
  NormalizedTimeCOGFrame,
  TimeCOGBufferPolicy,
} from "../types.js";

export type ScheduledFrame = {
  frame: NormalizedTimeCOGFrame;
  index: number;
  priority: number;
};

const DEFAULT_BACKWARD_FRAMES = 2;
const DEFAULT_FORWARD_FRAMES = 6;

/**
 * Determine which frames to prefetch around the playhead.
 *
 * Returns a priority-sorted list of frames within the buffer window.
 * Frames closer to the target index score higher; frames in the
 * direction of playback receive a small directional boost.
 * The list is consumed both by the `FramePrefetcher` (to decide which
 * frames to prefetch tiles for) and by `TimeCOGLayer.updateFrameState`
 * (for cache protection).
 *
 * @param catalog      Full ordered frame catalog.
 * @param targetIndex  Index of the current display frame in the catalog.
 * @param policy       Buffer window sizes (default 2 backward, 6 forward).
 * @param playbackRate 0 = paused, sign indicates direction.
 * @param playing      Whether playback is active.
 */
export function scheduleFrameWindow(
  catalog: readonly NormalizedTimeCOGFrame[],
  targetIndex: number,
  policy: TimeCOGBufferPolicy = {},
  playbackRate = 0,
  maxFrameRate = 0,
  playing = false,
): ScheduledFrame[] {
  if (targetIndex < 0 || targetIndex >= catalog.length) {
    return [];
  }

  const backwardFrames = policy.backwardFrames ?? DEFAULT_BACKWARD_FRAMES;
  const forwardFrames = policy.forwardFrames ?? DEFAULT_FORWARD_FRAMES;
  const direction = playing ? Math.sign(playbackRate) || 1 : 0;
  const before = direction < 0 ? forwardFrames : backwardFrames;
  const after = direction < 0 ? backwardFrames : forwardFrames;
  const representative = direction < 0 ? "last" : "first";
  const bucketIntervalMs = maxFrameRate > 0 && playing
    ? (1000 / maxFrameRate) * Math.abs(playbackRate)
    : 0;
  const anchorIndex = representativeIndexForBucket(
    catalog,
    targetIndex,
    bucketIntervalMs,
    representative,
  );
  const targetBucket = bucketForIndex(catalog, anchorIndex, bucketIntervalMs);

  const backward = [
    anchorIndex,
    ...collectFrames(
      catalog,
      anchorIndex - 1,
      before,
      -1,
      bucketIntervalMs,
      representative,
      targetBucket,
    ),
  ];
  const forward = collectFrames(
    catalog,
    anchorIndex + 1,
    after,
    1,
    bucketIntervalMs,
    representative,
    targetBucket,
  );

  return [...backward.reverse(), ...forward]
    .map((index) => ({
      frame: catalog[index],
      index,
      priority: scoreFrame(index, anchorIndex, direction),
    }))
    .sort((a, b) => b.priority - a.priority);
}

function collectFrames(
  catalog: readonly NormalizedTimeCOGFrame[],
  targetIndex: number,
  count: number,
  step: -1 | 1,
  bucketIntervalMs: number,
  representative: "first" | "last",
  lastBucket: number | undefined,
): number[] {
  const indices: number[] = [];

  for (let index = targetIndex; index >= 0 && index < catalog.length && indices.length < count;) {
    const bucket = bucketForIndex(catalog, index, bucketIntervalMs);
    if (lastBucket === bucket) {
      index += step;
      continue;
    }

    const { start, end } = bucketBoundsForIndex(catalog, index, bucketIntervalMs);
    indices.push(representative === "first" ? start : end);
    lastBucket = bucket;
    index = step > 0 ? end + 1 : start - 1;
  }

  return indices;
}

function bucketBoundsForIndex(
  catalog: readonly NormalizedTimeCOGFrame[],
  index: number,
  bucketIntervalMs: number,
): { start: number; end: number } {
  const bucket = bucketForIndex(catalog, index, bucketIntervalMs);
  let start = index;
  let end = index;

  while (start - 1 >= 0 && bucketForIndex(catalog, start - 1, bucketIntervalMs) === bucket) {
    start -= 1;
  }

  while (end + 1 < catalog.length && bucketForIndex(catalog, end + 1, bucketIntervalMs) === bucket) {
    end += 1;
  }

  return { start, end };
}

function representativeIndexForBucket(
  catalog: readonly NormalizedTimeCOGFrame[],
  index: number,
  bucketIntervalMs: number,
  representative: "first" | "last",
): number {
  if (!bucketIntervalMs) {
    return index;
  }

  const { start, end } = bucketBoundsForIndex(catalog, index, bucketIntervalMs);
  return representative === "first" ? start : end;
}

function bucketForIndex(
  catalog: readonly NormalizedTimeCOGFrame[],
  index: number,
  bucketIntervalMs: number,
): number {
  const frame = catalog[index];

  if (!frame) {
    return Number.NaN;
  }

  if (!bucketIntervalMs) {
    return frame.sourceIndex;
  }

  const originTimeMs = catalog[0]?.timeMs ?? 0;
  return Math.floor((frame.timeMs - originTimeMs) / bucketIntervalMs);
}

function scoreFrame(index: number, targetIndex: number, direction: number): number {
  const distance = Math.abs(index - targetIndex);
  const directionalBoost =
    direction === 0 ? 0 : Math.sign(index - targetIndex) === direction ? 0.5 : -0.25;

  return 100 - distance + directionalBoost;
}

/**
 * When `maxFrameRate` is set and playback is active, suppress frame
 * changes that land in the same time bucket as the previously
 * displayed frame.  This prevents visual "stutter" when the clock
 * is ticking faster than the configured display rate.
 *
 * Returns the original `resolvedFrame` if the new frame belongs to a
 * different bucket, or the previously displayed frame if the
 * resolved frame falls in the same bucket.
 */
export function applyMaxFrameRateBucking(
  resolvedFrame: NormalizedTimeCOGFrame,
  catalog: readonly NormalizedTimeCOGFrame[],
  lastDisplayedFrameId: string | null,
  maxFrameRate: number,
  playbackRate: number,
): NormalizedTimeCOGFrame {
  if (maxFrameRate <= 0 || !lastDisplayedFrameId) {
    return resolvedFrame;
  }

  const bucketIntervalMs =
    (1000 / maxFrameRate) *
    Math.abs(playbackRate);
  const originTimeMs = catalog[0]?.timeMs ?? 0;
  const resolvedBucket = Math.floor(
    (resolvedFrame.timeMs - originTimeMs) / bucketIntervalMs,
  );

  const lastFrame = catalog.find(
    (f) => f.id === lastDisplayedFrameId,
  );

  if (!lastFrame) {
    return resolvedFrame;
  }

  const lastBucket = Math.floor(
    (lastFrame.timeMs - originTimeMs) / bucketIntervalMs,
  );

  if (lastBucket === resolvedBucket) {
    return lastFrame;
  }

  return resolvedFrame;
}
