import type { InteractionMode } from "../types.js";

const SCRUB_THRESHOLD_MS = 80;
const SEEK_THRESHOLD_MS = 200;
const DEFAULT_IDLE_THRESHOLD_MS = 300;

/**
 * Derive the playback interaction state from playback state and the
 * recency of user-initiated timing changes (`currentTime` prop).
 *
 * | Elapsed since change | Mode        |
 * |----------------------|-------------|
 * | < 80 ms              | "scrubbing" |
 * | 80–200 ms            | "seeking"   |
 * | >= idleThreshold     | "idle"      |
 * | actively playing     | "playing"   |
 *
 * The idle threshold defaults to 300 ms and can be overridden via
 * `fullResUpgradeIdleMs`.
 */
export function detectInteractionMode(
  playing: boolean,
  lastInteractionMs: number,
  fullResUpgradeIdleMs = DEFAULT_IDLE_THRESHOLD_MS,
): InteractionMode {
  if (playing) {
    return "playing";
  }

  if (lastInteractionMs === 0) {
    return "idle";
  }

  const elapsed = Date.now() - lastInteractionMs;

  if (elapsed < SCRUB_THRESHOLD_MS) {
    return "scrubbing";
  }

  if (elapsed < SEEK_THRESHOLD_MS) {
    return "seeking";
  }

  if (elapsed >= fullResUpgradeIdleMs) {
    return "idle";
  }

  return "seeking";
}
