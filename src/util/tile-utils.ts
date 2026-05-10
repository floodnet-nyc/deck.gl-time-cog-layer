import type { GeoTIFF, Overview } from "@developmentseed/geotiff";

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
