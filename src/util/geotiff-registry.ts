import { GeoTIFF } from "@developmentseed/geotiff";
import { SourceCache, SourceChunk } from "@chunkd/middleware";
import { SourceView } from "@chunkd/source";
import { SourceHttp } from "@chunkd/source-http";

type GeoTIFFOpenOptions = {
  requestInit?: RequestInit;
  chunkSize?: number;
  cacheSize?: number;
};

const DEFAULT_MAX_SIZE = 12;

/**
 * Shared GeoTIFF instance cache used by both the render sublayer
 * and the background prefetcher.  Consolidating GeoTIFF lifecycle in
 * one place avoids redundant HTTP COG-header fetches (which can be
 * hundreds of kB for multi-overview files).
 *
 * The registry is frame-id-keyed so that the same COG URL opened for
 * two different frame identities (e.g. a reused COG across timesteps)
 * is treated as two separate entries.
 */
export class GeoTIFFRegistry {
  private map = new Map<string, GeoTIFF>();
  private maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /** @internal Exposed for test pre-population (backward compat with tests that set `prefetcher.geotiffs.set(...)`). */
  get mutableMap(): Map<string, GeoTIFF> {
    return this.map;
  }

  get(frameId: string): GeoTIFF | undefined {
    return this.map.get(frameId);
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
    if (existing) return existing;

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

  has(frameId: string): boolean {
    return this.map.has(frameId);
  }

  unsafelySet(frameId: string, geotiff: GeoTIFF): void {
    this.map.set(frameId, geotiff);
  }

  clear(): void {
    this.map.clear();
  }
}

export async function openGeoTIFF(
  url: string | URL,
  options: GeoTIFFOpenOptions = {},
): Promise<GeoTIFF> {
  const headers = headersToRecord(options.requestInit?.headers);

  if (Object.keys(headers).length === 0) {
    return GeoTIFF.fromUrl(url, {
      chunkSize: options.chunkSize,
      cacheSize: options.cacheSize,
    });
  }

  const source = new SourceHttp(url, headers);
  const chunk = new SourceChunk({ size: options.chunkSize });
  const cache = new SourceCache({ size: options.cacheSize ?? 1024 * 1024 });
  const view = new SourceView(source, [chunk, cache]);

  return GeoTIFF.open({
    dataSource: source,
    headerSource: view,
  });
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}
