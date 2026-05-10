/**
 * Keys that belong to {@link TimeCOGLayerProps} but are **not**
 * forwarded to the underlying {@link COGLayer} sublayer via the
 * pass-through in {@link TimeCOGLayer.renderLayers}.
 *
 * This is the **single source of truth**: both the compile-time
 * `Omit` type and the runtime prop filter use this list so that
 * adding a new orchestration prop only requires editing this array.
 */
export const TIME_COG_EXCLUDED_KEYS = [
  "id",
  "frames",
  "currentTime",
  "playing",
  "playbackRate",
  "maxFrameRate",
  "missingFramePolicy",
  "bufferPolicy",
  "cachePolicy",
  "qualityPolicy",
  "schedulerPolicy",
  "descriptorMode",
  "descriptorManifest",
  "onFrameReady",
  "onFrameDisplayed",
  "onMissingFrame",
  "onDescriptorMismatch",
  "onBufferStateChange",
  "onStats",
  "onGeoTIFFLoad",
  "getTileData",
  "renderTile",
] as const;

export type TimeCOGExcludedKey = (typeof TIME_COG_EXCLUDED_KEYS)[number];

const EXCLUDED_SET = new Set<string>(TIME_COG_EXCLUDED_KEYS);

/**
 * Return a shallow copy of `props` with all TimeCOG-specific
 * orchestration keys removed, leaving only the base
 * {@link COGLayerProps} fields (opacity, colormap, etc.).
 */
export function extractCOGLayerProps<P extends Record<string, unknown>>(
  props: P,
): Omit<P, TimeCOGExcludedKey> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(props)) {
    if (!EXCLUDED_SET.has(key)) {
      result[key] = props[key];
    }
  }

  return result as Omit<P, TimeCOGExcludedKey>;
}
