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
