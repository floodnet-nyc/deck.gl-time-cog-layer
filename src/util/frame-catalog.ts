import type { AccessorContext } from "@deck.gl/core";
import type {
  MissingFramePolicy,
  NormalizedTimeCOGFrame,
  TimeCOGFrame,
  TimeCOGFrameResolution,
  TimeValue,
} from "../types.js";

export type Catalog = NormalizedTimeCOGFrame[];

/** SAS tokens and other volatile auth params stripped from cache keys. */
const VOLATILE_QUERY_PARAMS = new Set([
  "sig",
  "signature",
  "se",
  "sp",
  "spr",
  "sr",
  "srt",
  "ss",
  "st",
  "sv",
  "token",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-security-token",
  "x-amz-signature",
  "x-amz-signedheaders",
]);

/**
 * Normalize a `TimeValue` to a millisecond epoch. Accepts `number`,
 * `string` (ISO 8601), or `Date`.
 */
export function parseTimeValue(value: TimeValue): number {
  const timeMs =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);

  if (!Number.isFinite(timeMs)) {
    throw new Error(`Invalid time value: ${String(value)}`);
  }

  return timeMs;
}

/**
 * Deduplicate, sort, and canonically normalise the raw frame list.
 * Duplicate IDs win the last-declared URL.
 */
export function normalizeFrameCatalog<TFrame = TimeCOGFrame>(
  frames: readonly TFrame[],
  getTime?: (frame: TFrame, context: AccessorContext<TFrame>) => TimeValue,
  getUrl?: (frame: TFrame, context: AccessorContext<TFrame>) => string | URL,
): Catalog {
  const byIdOrTime = new Map<string, NormalizedTimeCOGFrame>();
  getTime ??= (frame) => (frame as unknown as TimeCOGFrame).time;
  getUrl ??= (frame) => (frame as unknown as TimeCOGFrame).url;

  frames.forEach((frame, index) => {
    const rawTime = getTime(frame, { index, data: frames, target: [] });
    const timeMs = parseTimeValue(rawTime);
    const url = String(getUrl(frame, { index, data: frames, target: [] }));
    const baseFrame = frame as unknown as Partial<TimeCOGFrame>;
    const id = baseFrame.id ?? `${timeMs}:${canonicalizeUrl(url)}`;
    const cacheKey = baseFrame.id ?? canonicalizeUrl(url);

    byIdOrTime.set(id, {
      ...(typeof frame === "object" && frame !== null ? frame : {}),
      time: rawTime,
      id,
      timeMs,
      url,
      cacheKey,
      sourceIndex: index,
    } as NormalizedTimeCOGFrame);
  });

  return [...byIdOrTime.values()].sort((a, b) => {
    if (a.timeMs !== b.timeMs) {
      return a.timeMs - b.timeMs;
    }

    return a.sourceIndex - b.sourceIndex;
  });
}

/**
 * Strip SAS / auth query parameters from a URL so that cache keys
 * remain stable across token rotations.
 */
export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input, globalThis.location?.href);

    for (const key of [...url.searchParams.keys()]) {
      if (VOLATILE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}

export function findNearestFrameIndex(
  catalog: Catalog,
  timeMs: number,
): number {
  if (catalog.length === 0) {
    return -1;
  }

  let low = 0;
  let high = catalog.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = catalog[mid]?.timeMs ?? 0;

    if (midTime === timeMs) {
      return mid;
    }

    if (midTime < timeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (low >= catalog.length) {
    return catalog.length - 1;
  }

  if (high < 0) {
    return 0;
  }

  const before = catalog[high];
  const after = catalog[low];

  if (!before) {
    return low;
  }

  if (!after) {
    return high;
  }

  return timeMs - before.timeMs <= after.timeMs - timeMs ? high : low;
}

/**
 * Linear scan for the most recent frame whose timestamp is ≤ `timeMs`.
 * Returns the catalog index, or −1 if no frame satisfies the condition.
 */
export function findPreviousFrameIndex(
  catalog: Catalog,
  timeMs: number,
): number {
  let previous = -1;

  for (let index = 0; index < catalog.length; index += 1) {
    const frame = catalog[index];

    if (frame && frame.timeMs <= timeMs) {
      previous = index;
    } else {
      break;
    }
  }

  return previous;
}

/**
 * Resolve a timestamp into target and display frames according to the
 * configured `MissingFramePolicy`.
 *
 * `"hold-last"` (default): show the most recent frame at or before
 * the requested time (least visually disruptive for transient gaps).
 */
export function resolveFrameForTime(
  catalog: Catalog,
  timeMs: number,
  policy: MissingFramePolicy,
  excludedFrameIds?: ReadonlySet<string>,
): TimeCOGFrameResolution {
  const selectableCatalog = excludedFrameIds?.size
    ? catalog.filter((frame) => !excludedFrameIds.has(frame.id))
    : catalog;

  if (selectableCatalog.length === 0) {
    return {
      targetFrame: null,
      displayFrame: null,
      missing: true,
    };
  }

  const nearestIndex = findNearestFrameIndex(selectableCatalog, timeMs);
  const targetFrame = nearestIndex >= 0 ? selectableCatalog[nearestIndex] ?? null : null;
  const exact = targetFrame?.timeMs === timeMs;

  if (exact || policy === "nearest") {
    return {
      targetFrame,
      displayFrame: targetFrame,
      missing: !exact,
    };
  }

  if (policy === "transparent" || policy === "skip") {
    return {
      targetFrame,
      displayFrame: exact ? targetFrame : null,
      missing: !exact,
    };
  }

  const previousIndex = findPreviousFrameIndex(selectableCatalog, timeMs);

  return {
    targetFrame,
    displayFrame: previousIndex >= 0 ? selectableCatalog[previousIndex] ?? null : targetFrame,
    missing: !exact,
  };
}
