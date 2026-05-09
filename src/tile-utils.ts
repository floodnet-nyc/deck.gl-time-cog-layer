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

export function isMissingTileError(error: unknown): boolean {
  return error instanceof Error && /^Tile at \(\d+, \d+\) not found$/.test(error.message);
}
