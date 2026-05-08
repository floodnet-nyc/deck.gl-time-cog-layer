import type {
  MissingFramePolicy,
  NormalizedTimeCOGFrame,
  TimeCOGFrame,
  TimeCOGFrameResolution,
  TimeValue,
} from "./types.js";

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

export function normalizeFrameCatalog(
  frames: readonly TimeCOGFrame[],
): NormalizedTimeCOGFrame[] {
  const byIdOrTime = new Map<string, NormalizedTimeCOGFrame>();

  frames.forEach((frame, sourceIndex) => {
    const timeMs = parseTimeValue(frame.time);
    const url = String(frame.url);
    const id = frame.id ?? `${timeMs}:${canonicalizeUrl(url)}`;
    const cacheKey = frame.id ?? canonicalizeUrl(url);

    byIdOrTime.set(id, {
      ...frame,
      id,
      timeMs,
      url,
      cacheKey,
      sourceIndex,
    });
  });

  return [...byIdOrTime.values()].sort((a, b) => {
    if (a.timeMs !== b.timeMs) {
      return a.timeMs - b.timeMs;
    }

    return a.sourceIndex - b.sourceIndex;
  });
}

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
  catalog: readonly NormalizedTimeCOGFrame[],
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

export function findPreviousFrameIndex(
  catalog: readonly NormalizedTimeCOGFrame[],
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

export function resolveFrameForTime(
  catalog: readonly NormalizedTimeCOGFrame[],
  timeMs: number,
  policy: MissingFramePolicy,
): TimeCOGFrameResolution {
  if (catalog.length === 0) {
    return {
      targetFrame: null,
      displayFrame: null,
      missing: true,
    };
  }

  const nearestIndex = findNearestFrameIndex(catalog, timeMs);
  const targetFrame = nearestIndex >= 0 ? catalog[nearestIndex] ?? null : null;
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

  const previousIndex = findPreviousFrameIndex(catalog, timeMs);

  return {
    targetFrame,
    displayFrame: previousIndex >= 0 ? catalog[previousIndex] ?? null : targetFrame,
    missing: !exact,
  };
}
