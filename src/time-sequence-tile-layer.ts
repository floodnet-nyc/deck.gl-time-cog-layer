import type { Device } from "@luma.gl/core";
import type { Texture } from "@luma.gl/core";
import type { _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import {
  RasterTileLayer,
  RasterTileset2D,
} from "@developmentseed/deck.gl-raster";
import type { RenderTileResult, TilesetDescriptor } from "@developmentseed/deck.gl-raster";
import type {
  GetTileDataOptions,
  MinimalTileData,
} from "@developmentseed/deck.gl-geotiff";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import type { GeoTIFF, Overview, DecoderPool } from "@developmentseed/geotiff";
import { GeoTIFF as GeoTIFFClass, defaultDecoderPool } from "@developmentseed/geotiff";
import type { TileQuality, SequenceTileCache } from "./sequence-tile-cache.js";
import type { FramePrefetcher } from "./frame-prefetcher.js";

type TileCoord = { x: number; y: number; z: number };

export type TimeSequenceTileLayerProps<DataT extends MinimalTileData = MinimalTileData> = {
  sequenceTileCache: SequenceTileCache;
  currentFrameId: string;
  currentFrameUrl: string;
  prefetcher: FramePrefetcher;
  visibleTileRef: { tiles: TileCoord[] };
};

const TIME_SEQ_TILE_LAYER_NAME = "TimeSequenceTileLayer";

export class TimeSequenceTileLayer<
  DataT extends MinimalTileData = MinimalTileData,
> extends COGLayer<DataT> {
  static layerName = TIME_SEQ_TILE_LAYER_NAME;

  declare props: COGLayer<DataT>["props"] & TimeSequenceTileLayerProps<DataT>;
  declare state: COGLayer<DataT>["state"] & {
    geotiffByUrl?: Map<string, GeoTIFF>;
  };

  initializeState(): void {
    super.initializeState();
    this.setState({ geotiffByUrl: new Map() });
  }

  updateState(
    params: Parameters<COGLayer<DataT>["updateState"]>[0],
  ): void {
    const oldProps = params.oldProps as
      | (COGLayer<DataT>["props"] & TimeSequenceTileLayerProps<DataT>)
      | undefined;
    const oldFrameId = oldProps?.currentFrameId;

    super.updateState(params);

    const newFrameId = (this.props as TimeSequenceTileLayerProps<DataT>)
      .currentFrameId;

    if (newFrameId !== oldFrameId) {
      this.setNeedsUpdate();
    }
  }

  protected _getTileDataCallback(): ReturnType<
    RasterTileLayer<DataT>["_getTileDataCallback"]
  > {
    const tileCache = this.props.sequenceTileCache;

    if (!tileCache) {
      return undefined;
    }

    const userFn = this.props.getTileData ?? this.state.defaultGetTileData;

    if (!userFn) {
      return undefined;
    }

    return async (
      tile: TileLoadProps,
      options: { device: Device; signal?: AbortSignal },
    ) => {
      const seqProps = this.props as TimeSequenceTileLayerProps<DataT>;
      const { currentFrameId, currentFrameUrl } = seqProps;
      const { x, y, z } = tile.index;

      const cached = tileCache.get(currentFrameId, x, y, z);

      if (cached) {
        return {
          texture: cached.texture,
          mask: cached.mask,
          byteLength: cached.byteLength,
          width: cached.width,
          height: cached.height,
        } as unknown as DataT;
      }

      const geotiffByUrl =
        this.state.geotiffByUrl ?? new Map<string, GeoTIFF>();
      let geotiff = geotiffByUrl.get(currentFrameUrl);

      if (!geotiff) {
        geotiff = await GeoTIFFClass.fromUrl(currentFrameUrl);

        if (geotiffByUrl.size >= 12) {
          const firstKey = geotiffByUrl.keys().next().value;

          if (firstKey) {
            geotiffByUrl.delete(firstKey);
          }
        }

        geotiffByUrl.set(currentFrameUrl, geotiff);
        this.setState({ geotiffByUrl });
      }

      const image: GeoTIFF | Overview | undefined =
        z === geotiff.overviews.length
          ? geotiff
          : geotiff.overviews[geotiff.overviews.length - 1 - z];

      if (!image) {
        return null;
      }

      const getTileDataOptions: GetTileDataOptions = {
        device: options.device,
        x,
        y,
        signal: options.signal,
        pool:
          (
            this.props as unknown as { pool?: DecoderPool }
          ).pool ?? defaultDecoderPool(),
      };

      const result = await (
        userFn as (
          image: GeoTIFF | Overview,
          opts: GetTileDataOptions,
        ) => Promise<DataT>
      )(image, getTileDataOptions);

      if (
        result &&
        typeof result === "object" &&
        "texture" in result
      ) {
        const r = result as unknown as {
          texture: Texture;
          mask?: Texture;
          byteLength?: number;
          width: number;
          height: number;
        };

        tileCache.put(currentFrameId, x, y, z, {
          texture: r.texture,
          mask: r.mask,
          byteLength: r.byteLength ?? 0,
          width: r.width,
          height: r.height,
          quality: "full" as TileQuality,
        });
      }

      return result;
    };
  }

  protected _renderTileCallback(): ReturnType<
    RasterTileLayer<DataT>["_renderTileCallback"]
  > {
    const userFn = this.props.renderTile ?? this.state.defaultRenderTile;

    if (!userFn) {
      return undefined;
    }

    return userFn as (data: DataT) => RenderTileResult | null;
  }

  protected _renderTileLayer(
    descriptor: TilesetDescriptor,
    tileFetchFn: (
      tile: TileLoadProps,
      options: { device: Device; signal?: AbortSignal },
    ) => Promise<DataT>,
    renderTileFn: (data: DataT) => RenderTileResult | null,
  ): TileLayer {
    class TilesetFactory extends RasterTileset2D {
      constructor(
        opts: ConstructorParameters<typeof RasterTileset2D>[0],
      ) {
        super(opts, descriptor);
      }
    }

    const props = this.props as TimeSequenceTileLayerProps<DataT> & {
      tileSize?: number;
      zoomOffset?: number;
      maxZoom?: number;
      minZoom?: number;
      extent?: [number, number, number, number];
      debounceTime?: number;
      maxCacheSize?: number;
      maxCacheByteSize?: number;
      maxRequests?: number;
      refinementStrategy?: string;
      updateTriggers?: Record<string, unknown>;
      signal?: AbortSignal;
    };

    const {
      tileSize,
      zoomOffset,
      maxZoom,
      minZoom,
      extent,
      debounceTime,
      maxCacheSize,
      maxCacheByteSize,
      maxRequests,
      refinementStrategy,
      updateTriggers,
      visibleTileRef,
      currentFrameId,
      signal: userSignal,
    } = props;

    const renderSubLayers = (
      subProps: Record<string, unknown>,
    ): Layer[] => {
      const base = this as unknown as {
        _renderSubLayers: (
          s: Record<string, unknown>,
          d: TilesetDescriptor,
          r: (data: DataT) => RenderTileResult | null,
        ) => Layer[];
      };
      return base._renderSubLayers(
        subProps,
        descriptor,
        renderTileFn,
      );
    };

    return new TileLayer({
      id: `raster-tile-layer-${this.id}`,
      TilesetClass: TilesetFactory,
      getTileData: (tile: TileLoadProps) => {
        const { signal: tileSignal } = tile;
        const signal =
          userSignal && tileSignal
            ? AbortSignal.any([userSignal, tileSignal])
            : (userSignal ?? tileSignal);
        const options = {
          device: this.context.device,
          signal,
        };
        return tileFetchFn(tile, options);
      },
      renderSubLayers,
      updateTriggers: {
        getTileData: currentFrameId,
        renderSubLayers: updateTriggers?.renderTile,
      },
      onViewportLoad: (loadedTiles: unknown[]) => {
        if (visibleTileRef) {
          const tiles = loadedTiles as Array<{
            index: TileCoord;
          }>;
          visibleTileRef.tiles = tiles.map((t) => ({
            x: t.index.x,
            y: t.index.y,
            z: t.index.z,
          }));
        }
      },
      tileSize,
      zoomOffset,
      maxZoom,
      minZoom,
      extent,
      debounceTime,
      maxCacheSize,
      maxCacheByteSize,
      maxRequests,
      refinementStrategy,
    });
  }
}
