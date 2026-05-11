import type { Device } from "@luma.gl/core";
import type { GeoTIFF, Overview, DecoderPool } from "@developmentseed/geotiff";
import { defaultDecoderPool } from "@developmentseed/geotiff";

export function imageForZ(
  geotiff: GeoTIFF,
  z: number,
): GeoTIFF | Overview | undefined {
  return z === geotiff.overviews.length
    ? geotiff
    : geotiff.overviews[geotiff.overviews.length - 1 - z];
}

export function hasTile(
  image: Pick<GeoTIFF | Overview, "tileCount">,
  x: number,
  y: number,
): boolean {
  const { tileCount } = image;

  return x >= 0 && y >= 0 && x < tileCount.x && y < tileCount.y;
}

/**
 * Shared tile-decode pipeline used by both the render sublayer and the
 * background prefetcher.  Consolidates overview selection, bounds
 * checking, the user-decode call, and missing-tile error handling so
 * the two callers cannot drift.
 */
export async function decodeGeoTIFFTile<T>(
  geotiff: GeoTIFF,
  x: number,
  y: number,
  z: number,
  decodeFn: (
    image: GeoTIFF | Overview,
    options: { device: Device; x: number; y: number; signal?: AbortSignal; pool: DecoderPool },
  ) => Promise<T>,
  options: { device: Device; signal?: AbortSignal; pool?: DecoderPool | null },
): Promise<T | null> {
  const image = imageForZ(geotiff, z);

  if (!image || !hasTile(image, x, y)) {
    return null;
  }

  try {
    return await decodeFn(image, {
      device: options.device,
      x,
      y,
      signal: options.signal,
      pool: options.pool ?? defaultDecoderPool(),
    });
  } catch (error) {
    if (isMissingTileError(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Map tile coordinates to a coarser zoom level for preview fetches.
 *
 * Assumes a power-of-2 tile pyramid (standard for deck.gl TileLayer
 * and COG overviews).  At bias=1 the tile grid halves in each
 * dimension; at bias=2 it quarters, etc.
 */
export function mapToCoarserZoom(
  x: number,
  y: number,
  z: number,
  bias: number,
): { x: number; y: number; z: number } {
  const shift = 1 << bias;

  return {
    x: Math.floor(x / shift),
    y: Math.floor(y / shift),
    z: Math.max(0, z - bias),
  };
}

export function isMissingTileError(error: unknown): boolean {
  return error instanceof Error && /^Tile at \(\d+, \d+\) not found$/.test(error.message);
}
