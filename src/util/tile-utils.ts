import type { Device } from "@luma.gl/core";
import type { GeoTIFF, Overview, DecoderPool } from "@developmentseed/geotiff";
import { defaultDecoderPool } from "@developmentseed/geotiff";
import { epsgResolver, makeClampedForwardTo3857, metersPerUnit, parseWkt, } from "@developmentseed/proj";
import proj4 from "proj4";
import { geoTiffToDescriptor } from "./geotiff-tileset.js";

/**
 * Select the GeoTIFF or Overview image for a given zoom level.
 * Zoom 0 maps to the coarsest overview; the highest zoom maps to the
 * full-resolution image.
 */
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
 * background prefetcher. Consolidates overview selection, bounds
 * checking, the user-decode call, and missing-tile error handling so
 * the two callers cannot drift.
 */
export async function decodeGeoTIFFTile<T>({
  geotiff,
  x,
  y,
  z,
  getTileData,
  options,
}: {
  geotiff: GeoTIFF;
  x: number;
  y: number;
  z: number;
  getTileData: (
    image: GeoTIFF | Overview,
    options: { device: Device; x: number; y: number; signal?: AbortSignal; pool: DecoderPool },
  ) => Promise<T>;
  options: { device: Device; signal?: AbortSignal; pool?: DecoderPool | null; requestInit?: RequestInit };
}): Promise<T | null> {
  const image = imageForZ(geotiff, z);

  if (!image || !hasTile(image, x, y)) {
    return null;
  }

  try {
    return await getTileData(image, {
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
 * Build an AffineTileset descriptor from an opened GeoTIFF, resolving
 * CRS / projection transforms and meters-per-unit.
 */
export async function getGeoTiffDescriptor(geotiff: GeoTIFF) {
  const crs = geotiff.crs;
  const sourceProjection =
    typeof crs === "number"
      ? await epsgResolver!(crs)
      : parseWkt(crs);

  // @ts-expect-error - proj4 typings are incomplete and don't support
  // wkt-parser input
  const converter4326 = proj4(sourceProjection, "EPSG:4326");
  const projectTo4326 = (x: number, y: number) =>
    converter4326.forward<[number, number]>([x, y], false);
  const projectFrom4326 = (x: number, y: number) =>
    converter4326.inverse<[number, number]>([x, y], false);

  // @ts-expect-error - proj4 typings are incomplete and don't support
  // wkt-parser input
  const converter3857 = proj4(sourceProjection, "EPSG:3857");
  const projectTo3857 = makeClampedForwardTo3857(
    (x: number, y: number) =>
      converter3857.forward<[number, number]>([x, y], false),
    projectTo4326,
  );
  const projectFrom3857 = (x: number, y: number) =>
    converter3857.inverse<[number, number]>([x, y], false);

  const units = sourceProjection.units;
  if (!units) {
    throw new Error(
      "Source projection is missing 'units' property, cannot compute meters per unit",
    );
  }
  const mpu = metersPerUnit(units as Parameters<typeof metersPerUnit>[0], {
    semiMajorAxis: sourceProjection.datum?.a ?? sourceProjection.a,
  });

  return geoTiffToDescriptor(geotiff, {
    projectTo4326,
    projectFrom4326,
    projectTo3857,
    projectFrom3857,
    mpu,
  });
}


/**
 * Map tile coordinates to a coarser zoom level for preview fetches.
 * Assumes a power-of-2 tile pyramid (standard for deck.gl TileLayer
 * and COG overviews).
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

/**
 * Predicate: is this error caused by requesting a tile coordinate
 * that doesn't exist in the COG? These are expected (edge tiles)
 * and should be silently ignored.
 */
export function isMissingTileError(error: unknown): boolean {
  return error instanceof Error && /^Tile at \(\d+, \d+\) not found$/.test(error.message);
}
