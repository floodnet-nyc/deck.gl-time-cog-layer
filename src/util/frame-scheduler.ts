import type {
  BucketSnapPolicy,
  NormalizedTimeCOGFrame,
  TimeCOGBufferPolicy,
} from "../types.js";

export type ScheduledFrame = {
  frame: NormalizedTimeCOGFrame;
  index: number;
  priority: number;
  level: number;
  bucketWidthMs: number;
};

export type FrameRateSnapPolicy = BucketSnapPolicy;

const DEFAULT_BACKWARD_FRAMES = 2;
const DEFAULT_FORWARD_FRAMES = 6;
const BASE_LEVEL_QUOTA = 2;
const DEFAULT_MULTISCALE_LEVEL_PENALTY = 0.5;

/**
 * Determine which frames to prefetch around the playhead.
 *
 * Returns a priority-sorted list of frames within the buffer window.
 * Frames closer to the target index score higher; frames in the
 * direction of playback receive a small directional boost.
 *
 * When `maxFrameRate` > 0 and `playing` is true, frames are
 * time-bucketed and only one representative per bucket is scheduled
 * to prevent visual stutter at sub-frame-rate playback speeds.
 */
export function scheduleFrameWindow(
  catalog: readonly NormalizedTimeCOGFrame[],
  targetIndex: number,
  policy: TimeCOGBufferPolicy = {},
  playbackRate = 0,
  maxFrameRate = 0,
  playing = false,
  multiscaleLevelPenalty = DEFAULT_MULTISCALE_LEVEL_PENALTY,
  frameRateSnap: FrameRateSnapPolicy = "off",
  explicitBucketIntervalMs = 0,
): ScheduledFrame[] {
  if (targetIndex < 0 || targetIndex >= catalog.length) {
    return [];
  }

  const backwardFrames = policy.backwardFrames ?? DEFAULT_BACKWARD_FRAMES;
  const forwardFrames = policy.forwardFrames ?? DEFAULT_FORWARD_FRAMES;
  const direction = playing ? Math.sign(playbackRate) || 1 : 0;
  const before = direction < 0 ? forwardFrames : backwardFrames;
  const after = direction < 0 ? backwardFrames : forwardFrames;

  const bucketIntervalMs =
    explicitBucketIntervalMs > 0
      ? explicitBucketIntervalMs
      : resolvePlaybackBucketIntervalMs(
        catalog,
        maxFrameRate,
        playbackRate,
        playing,
        frameRateSnap,
      );

  const representative = direction < 0 ? "last" : "first";
  const anchorIndex = representativeIndex(catalog, targetIndex, bucketIntervalMs, representative);

  const anchorBucket = bucketIntervalMs > 0
    ? computeBucket(catalog, anchorIndex, bucketIntervalMs)
    : null;

  const backwardIndices = collectFrameIndices(
    catalog, anchorIndex - 1, before, -1, bucketIntervalMs, representative, anchorBucket,
  );
  const forwardIndices = collectFrameIndices(
    catalog, anchorIndex + 1, after, 1, bucketIntervalMs, representative, anchorBucket,
  );

  return [
    ...backwardIndices.reverse(),
    { index: anchorIndex, level: 0, bucketWidthMs: bucketIntervalMs },
    ...forwardIndices,
  ]
    .map(({ index, level, bucketWidthMs }) => ({
      frame: catalog[index],
      index,
      level,
      bucketWidthMs,
      priority: scoreFrame(index, anchorIndex, direction, level, multiscaleLevelPenalty),
    }))
    .sort((a, b) => b.priority - a.priority);
}

export function resolvePlaybackBucketIntervalMs(
  catalog: readonly NormalizedTimeCOGFrame[],
  maxFrameRate: number,
  playbackRate: number,
  playing: boolean,
  frameRateSnap: FrameRateSnapPolicy = "off",
): number {
  if (maxFrameRate <= 0 || !playing) {
    return 0;
  }

  const rawBucketIntervalMs = (1000 / maxFrameRate) * Math.abs(playbackRate);
  if (!Number.isFinite(rawBucketIntervalMs) || rawBucketIntervalMs <= 0) {
    return 0;
  }

  return snapBucketIntervalMs(catalog, rawBucketIntervalMs, frameRateSnap);
}

export function snapBucketIntervalMs(
  catalog: readonly NormalizedTimeCOGFrame[],
  rawBucketIntervalMs: number,
  snap: BucketSnapPolicy = "off",
): number {
  if (!Number.isFinite(rawBucketIntervalMs) || rawBucketIntervalMs <= 0) {
    return 0;
  }

  if (snap === "off") {
    return rawBucketIntervalMs;
  }

  const representativeFramePeriodMs = representativeFramePeriod(catalog);
  if (!Number.isFinite(representativeFramePeriodMs) || representativeFramePeriodMs <= 0) {
    return rawBucketIntervalMs;
  }

  const ratio = rawBucketIntervalMs / representativeFramePeriodMs;
  const normalizedRatio = Math.abs(ratio - Math.round(ratio)) < 1e-9 ? Math.round(ratio) : ratio;
  const snappedBucketIntervalMs =
    snap === "faster"
      ? Math.max(1, Math.floor(normalizedRatio)) * representativeFramePeriodMs
      : Math.ceil(normalizedRatio) * representativeFramePeriodMs;

  return snappedBucketIntervalMs || rawBucketIntervalMs;
}

/**
 * Walk from `startIndex` in direction `step`, collecting up to
 * `count` frame indices. When `bucketIntervalMs > 0`, adjacent frames
 * in the same time bucket are skipped — only the representative
 * (`"first"` or `"last"`) per bucket is kept.
 */
function collectFrameIndices(
  catalog: readonly NormalizedTimeCOGFrame[],
  startIndex: number,
  count: number,
  step: -1 | 1,
  bucketIntervalMs: number,
  representative: "first" | "last",
  excludeBucket: number | null,
): Array<{ index: number; level: number; bucketWidthMs: number }> {
  if (count <= 0) {
    return [];
  }

  if (!bucketIntervalMs) {
    return collectSingleScaleFrameIndices(
      catalog,
      startIndex,
      count,
      step,
      bucketIntervalMs,
      representative,
      excludeBucket,
      0,
    );
  }

  const indices: Array<{ index: number; level: number; bucketWidthMs: number }> = [];
  let cursor = startIndex;
  let level = 0;
  let lastVisitedIndex = step > 0 ? startIndex - 1 : startIndex + 1;

  while (
    cursor >= 0 &&
    cursor < catalog.length &&
    indices.length < count
  ) {
    const levelBucketWidthMs = bucketIntervalMs * (2 ** level);
    const levelQuota = levelQuotaFor(level, count - indices.length);
    const levelExcludeBucket = computeBucket(
      catalog,
      Math.min(Math.max(startIndex - step, 0), catalog.length - 1),
      levelBucketWidthMs,
    );
    const collected = collectSingleScaleFrameIndices(
      catalog,
      cursor,
      levelQuota,
      step,
      levelBucketWidthMs,
      representative,
      levelExcludeBucket ?? excludeBucket,
      level,
      lastVisitedIndex,
    );

    if (collected.length === 0) {
      break;
    }

    indices.push(...collected);
    lastVisitedIndex = collected[collected.length - 1]?.index ?? lastVisitedIndex;
    cursor = step > 0 ? lastVisitedIndex + 1 : lastVisitedIndex - 1;
    level += 1;
  }

  return indices.slice(0, count);
}

function collectSingleScaleFrameIndices(
  catalog: readonly NormalizedTimeCOGFrame[],
  startIndex: number,
  count: number,
  step: -1 | 1,
  bucketIntervalMs: number,
  representative: "first" | "last",
  excludeBucket: number | null,
  level: number,
  boundaryIndex?: number,
): Array<{ index: number; level: number; bucketWidthMs: number }> {
  const indices: Array<{ index: number; level: number; bucketWidthMs: number }> = [];
  let lastBucket = excludeBucket;

  for (
    let index = startIndex;
    index >= 0 && index < catalog.length && indices.length < count;
  ) {
    const bucket = computeBucket(catalog, index, bucketIntervalMs);
    if (lastBucket === bucket) {
      index += step;
      continue;
    }

    const { start, end } = findBucketBounds(catalog, index, bucketIntervalMs);
    const representativeIndex = representative === "first" ? start : end;

    if (
      boundaryIndex !== undefined &&
      (
        (step > 0 && representativeIndex <= boundaryIndex) ||
        (step < 0 && representativeIndex >= boundaryIndex)
      )
    ) {
      lastBucket = bucket;
      index = step > 0 ? end + 1 : start - 1;
      continue;
    }

    indices.push({
      index: representativeIndex,
      level,
      bucketWidthMs: bucketIntervalMs,
    });
    lastBucket = bucket;
    index = step > 0 ? end + 1 : start - 1;
  }

  return indices;
}

function levelQuotaFor(level: number, remaining: number): number {
  if (remaining <= 0) {
    return 0;
  }

  if (level === 0) {
    return Math.min(BASE_LEVEL_QUOTA, remaining);
  }

  return Math.min(Math.max(BASE_LEVEL_QUOTA, 2 ** (level - 1)), remaining);
}

function findBucketBounds(
  catalog: readonly NormalizedTimeCOGFrame[],
  index: number,
  bucketIntervalMs: number,
): { start: number; end: number } {
  const bucket = computeBucket(catalog, index, bucketIntervalMs);
  let start = index;
  let end = index;

  while (start - 1 >= 0 && computeBucket(catalog, start - 1, bucketIntervalMs) === bucket) {
    start -= 1;
  }

  while (end + 1 < catalog.length && computeBucket(catalog, end + 1, bucketIntervalMs) === bucket) {
    end += 1;
  }

  return { start, end };
}

function representativeIndex(
  catalog: readonly NormalizedTimeCOGFrame[],
  index: number,
  bucketIntervalMs: number,
  representative: "first" | "last",
): number {
  if (!bucketIntervalMs) {
    return index;
  }

  const { start, end } = findBucketBounds(catalog, index, bucketIntervalMs);
  return representative === "first" ? start : end;
}

/**
 * Compute the time bucket for a frame. When `bucketIntervalMs` is 0,
 * each frame gets its own bucket (its `sourceIndex`).
 */
function computeBucket(
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

function scoreFrame(
  index: number,
  targetIndex: number,
  direction: number,
  level = 0,
  multiscaleLevelPenalty = DEFAULT_MULTISCALE_LEVEL_PENALTY,
): number {
  const distance = Math.abs(index - targetIndex);
  const directionalBoost =
    direction === 0 ? 0 : Math.sign(index - targetIndex) === direction ? 0.5 : -0.25;
  const levelPenalty = level * multiscaleLevelPenalty;

  return 100 - distance + directionalBoost - levelPenalty;
}

function representativeFramePeriod(catalog: readonly NormalizedTimeCOGFrame[]): number {
  if (catalog.length < 2) {
    return 0;
  }

  const deltas: number[] = [];
  for (let index = 1; index < catalog.length; index += 1) {
    const delta = catalog[index]!.timeMs - catalog[index - 1]!.timeMs;
    if (delta > 0 && Number.isFinite(delta)) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return 0;
  }

  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? 0;
}

/**
 * When `maxFrameRate` is set and playback is active, suppress frame
 * changes that land in the same time bucket as the previously
 * displayed frame. This prevents visual "stutter" when the clock
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
  frameRateSnap: FrameRateSnapPolicy = "off",
): NormalizedTimeCOGFrame {
  if (maxFrameRate <= 0 || !lastDisplayedFrameId) {
    return resolvedFrame;
  }

  const bucketIntervalMs = resolvePlaybackBucketIntervalMs(
    catalog,
    maxFrameRate,
    playbackRate,
    true,
    frameRateSnap,
  );
  if (!bucketIntervalMs) {
    return resolvedFrame;
  }

  return applyExplicitBucketBucketing(
    resolvedFrame,
    catalog,
    lastDisplayedFrameId,
    bucketIntervalMs,
    playbackRate < 0 ? "last" : "first",
  );
}

export function applyExplicitBucketBucketing(
  resolvedFrame: NormalizedTimeCOGFrame,
  catalog: readonly NormalizedTimeCOGFrame[],
  lastDisplayedFrameId: string | null,
  bucketIntervalMs: number,
  representative: "first" | "last" = "first",
): NormalizedTimeCOGFrame {
  if (bucketIntervalMs <= 0) {
    return resolvedFrame;
  }

  const resolvedIndex = catalog.findIndex((frame) => frame.id === resolvedFrame.id);
  if (resolvedIndex < 0) {
    return resolvedFrame;
  }

  const resolvedRepresentative = catalog[representativeIndex(
    catalog,
    resolvedIndex,
    bucketIntervalMs,
    representative,
  )];

  if (!lastDisplayedFrameId) {
    return resolvedRepresentative ?? resolvedFrame;
  }

  const lastIndex = catalog.findIndex((frame) => frame.id === lastDisplayedFrameId);
  if (lastIndex < 0) {
    return resolvedRepresentative ?? resolvedFrame;
  }

  const resolvedBucket = computeBucket(catalog, resolvedIndex, bucketIntervalMs);
  const lastBucket = computeBucket(catalog, lastIndex, bucketIntervalMs);

  if (resolvedBucket === lastBucket) {
    return catalog[lastIndex] ?? resolvedFrame;
  }

  return resolvedRepresentative ?? resolvedFrame;
}
