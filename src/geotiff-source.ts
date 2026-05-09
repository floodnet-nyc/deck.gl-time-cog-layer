import { SourceCache, SourceChunk } from "@chunkd/middleware";
import { SourceView } from "@chunkd/source";
import { SourceHttp } from "@chunkd/source-http";
import { GeoTIFF } from "@developmentseed/geotiff";

type GeoTIFFOpenOptions = {
  requestInit?: RequestInit;
  chunkSize?: number;
  cacheSize?: number;
};

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
