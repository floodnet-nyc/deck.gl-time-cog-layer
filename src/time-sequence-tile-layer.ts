import type { Device, Texture } from "@luma.gl/core";
import type { Layer } from "@deck.gl/core";
import type { _Tile2DHeader as Tile2DHeader, _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
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
import { defaultDecoderPool } from "@developmentseed/geotiff";
import { openGeoTIFF } from "./geotiff-source.js";
import type { TileQuality, SequenceTileCache } from "./sequence-tile-cache.js";
import { hasTile, imageForZ, isMissingTileError } from "./tile-utils.js";

type TileCoord = { x: number; y: number; z: number };

export type TimeSequenceTileLayerProps = {
  sequenceTileCache: SequenceTileCache;
  currentFrameId: string;
  currentFrameUrl: string;
  currentFrameRequestInit?: RequestInit;
  visibleTileRef: { tiles: TileCoord[] };
  onVisibleTilesChange?: () => void;
};

const TIME_SEQ_TILE_LAYER_NAME = "TimeSequenceTileLayer";

export class TimeSequenceTileLayer<
  DataT extends MinimalTileData = MinimalTileData,
> extends COGLayer<DataT> {
  static layerName = TIME_SEQ_TILE_LAYER_NAME;

  declare props: COGLayer<DataT>["props"] & TimeSequenceTileLayerProps;
  declare state: COGLayer<DataT>["state"] & {
    geotiffByUrl?: Map<string, GeoTIFF>;
    lastFrameId?: string;
  };

  initializeState(): void {
    super.initializeState();
    this.setState({ geotiffByUrl: new Map() });
  }

  finalizeState(context: Parameters<COGLayer<DataT>["finalizeState"]>[0]): void {
    super.finalizeState(context);
  }

  renderLayers(): Layer | null {
    const descriptor = this._tilesetDescriptor();

    if (!descriptor) {
      return null;
    }

    const resolvedDescriptor = descriptor;

    const tileFetchFn = this._getTileDataCallback();
    const renderTileFn = this._renderTileCallback();

    if (!tileFetchFn || !renderTileFn) {
      return null;
    }

    const seqProps = this.props as TimeSequenceTileLayerProps;
    const { visibleTileRef, currentFrameId, onVisibleTilesChange } = seqProps;

    class TilesetFactory extends RasterTileset2D {
      constructor(
        opts: ConstructorParameters<typeof RasterTileset2D>[0],
      ) {
        super(opts, resolvedDescriptor);
      }
    }

    const base = this as unknown as {
      _renderSubLayers: (
        subProps: Record<string, unknown>,
        desc: TilesetDescriptor,
        rt: (data: DataT) => RenderTileResult | null,
      ) => Layer[];
    };
    const updateTriggers = (this.props as Record<string, unknown>)
      .updateTriggers as Record<string, unknown> | undefined;
    const userSignal = (this.props as Record<string, unknown>)
      .signal as AbortSignal | undefined;
    const userOnViewportLoad = (this.props as Record<string, unknown>)
      .onViewportLoad as
        | ((tiles: Tile2DHeader<Record<string, unknown>>[]) => void)
        | undefined;

    const renderSubLayers = (
      subProps: Record<string, unknown>,
    ): Layer[] => {
      return base._renderSubLayers(
        subProps,
        resolvedDescriptor,
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
      tileSize: (this.props as Record<string, unknown>).tileSize as
        | number
        | undefined,
      zoomOffset: (this.props as Record<string, unknown>).zoomOffset as
        | number
        | undefined,
      maxZoom: (this.props as Record<string, unknown>).maxZoom as
        | number
        | undefined,
      minZoom: (this.props as Record<string, unknown>).minZoom as
        | number
        | undefined,
      extent: (this.props as Record<string, unknown>).extent as
        | [number, number, number, number]
        | undefined,
      debounceTime: (this.props as Record<string, unknown>).debounceTime as
        | number
        | undefined,
      maxCacheSize: (this.props as Record<string, unknown>).maxCacheSize as
        | number
        | undefined,
      maxCacheByteSize: (this.props as Record<string, unknown>)
        .maxCacheByteSize as number | undefined,
      maxRequests: (this.props as Record<string, unknown>).maxRequests as
        | number
        | undefined,
      refinementStrategy:
        (
          (this.props as Record<string, unknown>)
            .refinementStrategy as never
        ) ?? "no-overlap",
      onViewportLoad: (loadedTiles: Tile2DHeader<Record<string, unknown>>[]) => {
        if (visibleTileRef) {
          visibleTileRef.tiles = loadedTiles.map((t) => ({
            x: t.index.x,
            y: t.index.y,
            z: t.index.z,
          }));
        }

        onVisibleTilesChange?.();
        userOnViewportLoad?.(loadedTiles);
      },
    });
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
      const seqProps = this.props as TimeSequenceTileLayerProps;
      const { currentFrameId, currentFrameUrl, currentFrameRequestInit } = seqProps;
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
      let geotiff = geotiffByUrl.get(currentFrameId);

      if (!geotiff) {
        geotiff = await openGeoTIFF(currentFrameUrl, {
          requestInit: currentFrameRequestInit,
        });

        if (geotiffByUrl.size >= 12) {
          const firstKey = geotiffByUrl.keys().next().value;

          if (firstKey) {
            geotiffByUrl.delete(firstKey);
          }
        }

        geotiffByUrl.set(currentFrameId, geotiff);
        this.setState({ geotiffByUrl });
      }

      const image = imageForZ(geotiff, z);

      if (!image || !hasTile(image, x, y)) {
        return null as DataT;
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

      let result: DataT;

      try {
        result = await (
          userFn as (
            img: GeoTIFF | Overview,
            opts: GetTileDataOptions,
          ) => Promise<DataT>
        )(image, getTileDataOptions);
      } catch (error) {
        if (isMissingTileError(error)) {
          return null as DataT;
        }

        throw error;
      }

      if (result && typeof result === "object" && "texture" in result) {
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
}
