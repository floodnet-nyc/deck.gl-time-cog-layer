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

/**
 * Custom props injected by {@link TimeCOGLayer} into the persistent
 * sublayer.  These carry the dynamic frame identity, the shared tile
 * cache, the mutable visible-tile reference, and the preview bias so
 * that every `getTileData` invocation can check the cache for the
 * current frame and fall back to coarser preview tiles on miss.
 */
export type TimeSequenceTileLayerProps = {
  /** Shared GPU tile cache — the key integration point between the sublayer and the background prefetcher. */
  sequenceTileCache: SequenceTileCache;

  /** Stable identifier of the currently displayed frame (its catalog `id`).  Used as the cache prefix and in `updateTriggers.all`. */
  currentFrameId: string;

  /** URL of the currently displayed frame's COG.  Opened lazily for tile fetches. */
  currentFrameUrl: string;

  /** Optional `RequestInit` forwarded to `fetch()` when opening this frame's COG (e.g. SAS headers). */
  currentFrameRequestInit?: RequestInit;

  /**
   * When > 0, the sublayer fetches at a coarser zoom level on cache
   * miss and stores the result as a "preview" tile.  Set by the
   * coordinator based on the current interaction mode and quality
   * policy (1 for seek, 2 for scrub, 0 for playing/idle).
   */
  previewBias?: number;

  /** Mutable reference updated by the inner TileLayer's `onViewportLoad` callback. */
  visibleTileRef: { tiles: TileCoord[] };

  /** Optional callback fired whenever the visible tile set changes. */
  onVisibleTilesChange?: () => void;
};

const TIME_SEQ_TILE_LAYER_NAME = "TimeSequenceTileLayer";

/**
 * The persistent sublayer that `TimeCOGLayer` renders.
 *
 * Extends `COGLayer` to inherit GeoTIFF header parsing and tileset
 * descriptor computation (executed once for the first frame and
 * reused).  Overrides three core methods:
 *
 * ### `renderLayers()`
 * Replaces the base `RasterTileLayer.renderLayers` to construct the
 * inner `TileLayer` with a **viewport-aware** `updateTriggers.all`.
 * The `all` key is composed as
 * `${currentFrameId}:${Math.round(viewport.zoom)}`, so that
 * `tileset.reloadAll()` fires on **both** frame changes and zoom
 * changes.  Without the zoom component, tiles from a previous zoom
 * level would persist in the tileset cache when the user zooms out,
 * producing a frozen ghost raster.
 *
 * ### `_getTileDataCallback()`
 * Wraps the user-supplied (or inferred-default) `getTileData` in a
 * cache-aware fetcher with progressive-loading support:
 *
 * 1. Check the shared `SequenceTileCache` for the tile at `(x, y, z)`.
 * 2. On miss, select a coarser COG overview level via
 *    `imageForZ(geotiff, z - bias)` (keeping the same `(x, y)`
 *    coordinates — the tileset descriptor already mapped viewport
 *    space to COG tile coords).  Fall back to `imageForZ(geotiff, z)`
 *    if the biased overview has no tile at those coordinates.
 * 3. Store the result under the original key `(frameId, x, y, z)`
 *    with quality `"preview"` or `"full"`.
 *
 * The COG overview at `z - bias` covers the same spatial area as `z`
 * but at lower pixel resolution — the deck.gl TileLayer renders it in
 * the correct tile extent automatically, producing a blurry preview
 * that is later upgraded to full resolution.
 *
 * ### `_renderTileCallback()`
 * Simple pass-through to the user's `renderTile` or the inferred
 * default so that existing colormap / shader pipelines work
 * unchanged.
 */
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
        all: Math.round(this.context.viewport?.zoom ?? 0),
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
      const { currentFrameId, currentFrameUrl, currentFrameRequestInit, previewBias } = seqProps;
      const { x, y, z } = tile.index;

      const hit = tileCache.get(currentFrameId, x, y, z);

      if (hit) {
        return {
          texture: hit.texture,
          mask: hit.mask,
          byteLength: hit.byteLength,
          width: hit.width,
          height: hit.height,
        } as unknown as DataT;
      }

      tileCache.recordMiss();

      const bias = previewBias ?? 0;
      let quality: TileQuality = bias > 0 ? "preview" : "full";

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

      let image = imageForZ(geotiff, z - bias);

      if (!image || !hasTile(image, x, y)) {
        image = imageForZ(geotiff, z);
        quality = "full";
      }

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
          x,
          y,
          z,
          texture: r.texture,
          mask: r.mask,
          byteLength: r.byteLength ?? 0,
          width: r.width,
          height: r.height,
          quality,
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
