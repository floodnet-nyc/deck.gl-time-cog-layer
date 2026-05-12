import type { InteractionMode, NormalizedTimeCOGFrame, ScoringWeights } from "../types.js";
import type { SequenceTileCache, TileQuality } from "../sequence-tile-cache.js";
import type { TileTask } from "./task-queue.js";

/** Prefetch snapshot subset used only by the scoring functions. */
export type ScoringContext = {
  getTileCache: () => SequenceTileCache;
  getRttEWMA: () => number;
  getThroughputEWMA: () => number;
  getFrameAvgBytes: (frameId: string) => number;
  playing: boolean;
  playbackRate: number;
  interactionMode: InteractionMode;
  coverage: number;
  bufferState?: {
    bufferedAhead: number;
    bufferedBehind: number;
    targetAhead: number;
  };
  scheduledFrames: NormalizedTimeCOGFrame[];
  targetFrame: NormalizedTimeCOGFrame;
};

export const FALLBACK_WEIGHTS: Required<ScoringWeights> = {
  viewportSalience: 30,
  direction: 15,
  bufferShortfall: 20,
  interaction: 25,
  qualityUpgrade: 50,
  qualityFreshPreview: 20,
  sizeHintPerBit: 2,
  etaPerMs: 0.02,
};

/**
 * Pure scoring functions for the prefetcher's task priority queue.
 *
 * Every function is stateless — telemetry values (EWMA latency,
 * throughput, per-frame byte averages) are passed via the
 * `ScoringContext` callbacks so that scoring logic is testable in
 * isolation without instantiating the full prefetcher.
 */

/**
 * Compute the composite priority score for a prefetch tile task.
 *
 * Combines seven additive factors — temporal proximity, directional
 * playback boost, buffer shortfall pressure, interaction-mode override,
 * quality urgency, log₂ size-hint penalty, and ETA-based latency
 * penalty — into a single score clamped to `[0, 200]`.  Higher scores
 * are dequeued first.
 *
 * @param task          The tile-fetch task to score.
 * @param distanceIndex Signed frame offset from the target frame.
 * @param ctx           Telemetry-access callbacks for stateless scoring.
 * @param scoringWeights Optional per-factor weight overrides.
 */
export function scoreTask(
  task: TileTask,
  distanceIndex: number,
  ctx: ScoringContext,
  scoringWeights?: ScoringWeights,
): number {
  const weights: Required<ScoringWeights> = {
    ...FALLBACK_WEIGHTS,
    ...scoringWeights,
  };
  const absDistance = Math.abs(distanceIndex);

  const v = temporalProximityScore(absDistance, weights);
  const d = directionScore(distanceIndex, ctx, weights);
  const b = bufferShortfallScore(distanceIndex, ctx, weights);
  const i = interactionScore(absDistance, ctx, weights);
  const q = qualityUrgencyScore(task, ctx, weights);
  const s = sizeHintPenalty(task, ctx, weights);
  const e = etaPenalty(task, ctx, weights);

  return Math.max(0, Math.min(200, v + d + b + i + q + s + e));
}

/**
 * Temporal proximity component: frames at distance 0 get 3× viewport
 * salience, distance 1 gets 2×, distance 2 gets 1×, beyond that 0.
 */
export function temporalProximityScore(
  absDistance: number,
  weights: Required<ScoringWeights>,
): number {
  if (absDistance === 0) return 3 * weights.viewportSalience;
  if (absDistance === 1) return 2 * weights.viewportSalience;
  if (absDistance === 2) return 1 * weights.viewportSalience;
  return 0;
}

/**
 * Directional boost: forward frames receive a bonus, backward frames
 * a penalty.  Only active during playback.
 */
export function directionScore(
  distanceIndex: number,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  if (!ctx.playing) return 0;

  const direction = Math.sign(ctx.playbackRate) || 1;
  const isForward = Math.sign(distanceIndex) === direction;

  return isForward ? weights.direction : -Math.ceil(weights.direction / 2);
}

/**
 * Buffer shortfall: boosts forward-frame priority when the
 * ahead-of-playhead buffer falls below its target depth.
 */
export function bufferShortfallScore(
  distanceIndex: number,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  if (distanceIndex <= 0) return 0;

  const buf = ctx.bufferState;
  if (!buf || buf.targetAhead <= 0) return 0;

  const shortfall = Math.max(0, 1 - buf.bufferedAhead / buf.targetAhead);

  return shortfall > 0 ? Math.round(weights.bufferShortfall * shortfall) : 0;
}

/**
 * Interaction override: during seek / scrub, nearby frames get a
 * strong boost while distant frames are penalized to avoid wasted
 * work.
 */
export function interactionScore(
  absDistance: number,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  const mode = ctx.interactionMode;

  if (mode === "idle" || mode === "playing") return 0;

  if (absDistance <= 1) return Math.round(2 * weights.interaction);
  if (absDistance === 2) return Math.round(0.4 * weights.interaction);

  return -Math.round(1.2 * weights.interaction);
}

/**
 * Quality urgency: full-res tasks get a bonus when upgrading an
 * existing cached preview; preview tasks get a bonus when current
 * frame coverage is below 30 %.
 */
export function qualityUrgencyScore(
  task: TileTask,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  if (task.quality === "full") {
    const cache = ctx.getTileCache();
    const existing = cache.peek(task.frameId, task.x, task.y, task.z);

    if (existing && existing.quality === "preview") {
      return weights.qualityUpgrade;
    }

    return 0;
  }

  const coverage = ctx.coverage;

  if (coverage < 0.3 && task.quality === "preview") {
    return weights.qualityFreshPreview;
  }

  return 0;
}

/**
 * Size-hint penalty: applies a −log₂(estimatedBytes + 1) penalty
 * capped at −15 so that frames with large COGs are deprioritised.
 */
export function sizeHintPenalty(
  task: TileTask,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  if (weights.sizeHintPerBit <= 0) return 0;

  const estimatedBytes =
    task.byteSizeHint ?? ctx.getFrameAvgBytes(task.frameId) ?? 0;

  if (estimatedBytes <= 0) return 0;

  const penalty = Math.round(
    weights.sizeHintPerBit * Math.log2(estimatedBytes + 1),
  );

  return -Math.min(15, penalty);
}

/**
 * ETA penalty: penalises tiles by estimated fetch + transfer time,
 * derived from the EWMA round-trip time and throughput.  Capped at
 * −20.
 */
export function etaPenalty(
  task: TileTask,
  ctx: ScoringContext,
  weights: Required<ScoringWeights>,
): number {
  const rtt = ctx.getRttEWMA();

  if (rtt <= 0 || weights.etaPerMs <= 0) return 0;

  const estimatedBytes =
    task.byteSizeHint ?? ctx.getFrameAvgBytes(task.frameId) ?? 0;

  let eta = rtt;

  const throughput = ctx.getThroughputEWMA();

  if (estimatedBytes > 0 && throughput > 0) {
    eta += (estimatedBytes / throughput) * 1000;
  }

  const penalty = Math.round(weights.etaPerMs * eta);

  return -Math.min(20, penalty);
}

/**
 * Determine the target quality for a new prefetch task.
 * Currently always returns `"full"` (progressive preview loading is
 * deferred).
 */
export function qualityForTask(
  mode: InteractionMode,
  _distanceIndex: number,
  _lowResFirst: boolean | undefined,
): { quality: TileQuality } {
  void mode;
  return { quality: "full" };
}
