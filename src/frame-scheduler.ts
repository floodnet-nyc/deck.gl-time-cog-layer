import type {
  NormalizedTimeCOGFrame,
  TimeCOGBufferPolicy,
} from "./types.js";

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
  const start = Math.max(0, targetIndex - before);
  const end = Math.min(catalog.length - 1, targetIndex + after);
  const scheduled: ScheduledFrame[] = [];

  for (let index = start; index <= end; index += 1) {
    const frame = catalog[index];

    if (!frame) {
      continue;
    }

    scheduled.push({
      frame,
      index,
      priority: scoreFrame(index, targetIndex, direction),
    });
  }

  return scheduled.sort((a, b) => b.priority - a.priority);
}

function scoreFrame(index: number, targetIndex: number, direction: number): number {
  const distance = Math.abs(index - targetIndex);
  const directionalBoost =
    direction === 0 ? 0 : Math.sign(index - targetIndex) === direction ? 0.5 : -0.25;

  return 100 - distance + directionalBoost;
}
