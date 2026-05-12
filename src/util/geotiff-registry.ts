import type { Device } from "@luma.gl/core";
import { GeoTIFF } from "@developmentseed/geotiff";
import type { Overview, DecoderPool } from "@developmentseed/geotiff";
import { decodeGeoTIFFTile } from "./tile-utils.js";
import { openGeoTIFF } from "./geotiff-open.js";

const DEFAULT_MAX_SIZE = 12;

/**
 * Shared GeoTIFF instance cache used by both the render sublayer
 * and the background prefetcher. Frame-id-keyed to avoid redundant
 * HTTP COG-header fetches (which can be hundreds of kB for
 * multi-overview files).
 *
 * `decodeTile` is the single entry point for both callers,
 * consolidating open → overview-select → bounds-check → user-decode.
 */
export class GeoTIFFRegistry {
  private map = new Map<string, GeoTIFF>();
  private maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /** @internal Exposed for test pre-population. */
  get mutableMap(): Map<string, GeoTIFF> {
    return this.map;
  }

  get(frameId: string): GeoTIFF | undefined {
    return this.map.get(frameId);
  }

  has(frameId: string): boolean {
    return this.map.has(frameId);
  }

  unsafelySet(frameId: string, geotiff: GeoTIFF): void {
    this.map.set(frameId, geotiff);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Lazily open the GeoTIFF for `frameId`, caching the result.
   * Evicts the oldest entry when the cache exceeds `maxSize`.
   */
  async open(
    frameId: string,
    url: string,
    requestInit?: RequestInit,
  ): Promise<GeoTIFF> {
    const existing = this.map.get(frameId);

    if (existing) {
      return existing;
    }

    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;

      if (firstKey) {
        this.map.delete(firstKey);
      }
    }

    const geotiff = await openGeoTIFF(url, { requestInit });
    this.map.set(frameId, geotiff);
    return geotiff;
  }

  async decodeTile<T>(
    {
      id, url, x, y, z, getTileData
    }: {
      id: string;
      url: string;
      x: number;
      y: number;
      z: number;
      getTileData: (
        image: GeoTIFF | Overview,
        options: { device: Device; x: number; y: number; signal?: AbortSignal; pool: DecoderPool },
      ) => Promise<T>,
    },
    options: {
      device: Device;
      signal?: AbortSignal;
      pool?: DecoderPool | null;
      requestInit?: RequestInit;
    },
  ): Promise<T | null> {
    const geotiff = await this.open(id, url, options.requestInit);
    return decodeGeoTIFFTile({
      geotiff, x, y, z, getTileData, 
      options: {
      device: options.device,
      signal: options.signal,
      pool: options.pool,
    }
    });
  }
}
