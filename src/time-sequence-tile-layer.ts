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
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import { GeoTIFFRegistry } from "./util/geotiff-registry.js";
import type { SequenceTileCache } from "./sequence-tile-cache.js";
import { decodeGeoTIFFTile } from "./util/tile-utils.js";

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

  /**
   * Optional shared GeoTIFF registry.  When provided, the sublayer
   * uses this registry instead of its own internal `geotiffByUrl`
   * Map, eliminating duplicate COG header fetches between the render
   * path and the background prefetcher.
   */
  geotiffRegistry?: GeoTIFFRegistry;

  onViewportLoad?: ((tiles: Tile2DHeader<Record<string, unknown>>[]) => void);
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
 * inner `TileLayer` with split `updateTriggers`.
 * `getTileData` is keyed on `currentFrameId` so frame changes trigger
 * `tileset.reloadAll()`.  `all` is keyed on `Math.round(viewport.zoom)`
 * so that zoom changes also flush the tileset cache — without this,
 * tiles from a previous zoom level persist when the user zooms out,
 * producing a frozen ghost raster.
 *
 * ### `_getTileDataCallback()`
 * Wraps the user-supplied (or inferred-default) `getTileData` in a
 * cache-aware fetcher with progressive-loading support:
 *
 * 1. Check the shared `SequenceTileCache` for the tile at `(x, y, z)`.
 * 2. On miss, load the exact COG tile for the current `(x, y, z)`.
 *
 * Overview-biased preview reads are intentionally disabled here. The
 * current raster renderer assumes that each tile's pixels already
 * correspond to the current tile's spatial footprint. Substituting a
 * coarser overview tile violates that assumption and produces
 * misregistered preview imagery.
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
    lastFrameId?: string;
  };

  private _localRegistry?: GeoTIFFRegistry;

  initializeState(): void {
    super.initializeState();
    this._localRegistry = new GeoTIFFRegistry();
  }

  finalizeState(context: Parameters<COGLayer<DataT>["finalizeState"]>[0]): void {
    super.finalizeState(context);
  }

  renderLayers(): Layer | null {
    const descriptor = this._tilesetDescriptor();

    if (!descriptor) {
      return null;
    }

    const getTileDataCallback = this._getTileDataCallback();
    const renderTileCallback = this._renderTileCallback();

    if (!getTileDataCallback || !renderTileCallback) {
      return null;
    }
  
    const resolvedDescriptor = descriptor;
    class TilesetFactory extends RasterTileset2D {
      constructor(
        opts: ConstructorParameters<typeof RasterTileset2D>[0],
      ) {
        super(opts, resolvedDescriptor);
      }
    }

    const {
      visibleTileRef, currentFrameId, onVisibleTilesChange, 
      updateTriggers, signal: userSignal, onViewportLoad: userOnViewportLoad 
    } = this.props;

    const base = this as unknown as {
      _renderSubLayers: (
        subProps: Record<string, unknown>,
        desc: TilesetDescriptor,
        rt: (data: DataT) => RenderTileResult | null,
      ) => Layer[];
    };

    return new TileLayer({
      id: `raster-tile-layer-${this.id}`,
      TilesetClass: TilesetFactory,
      getTileData: (tile: TileLoadProps) => {
        return getTileDataCallback(tile, {
          device: this.context.device,
          signal: (
            userSignal && tile.signal
            ? AbortSignal.any([userSignal, tile.signal])
            : (userSignal ?? tile.signal)
          ),
        });
      },
      renderSubLayers: (
        subProps: Record<string, unknown>,
      ): Layer[] => {
        return (base as any)._renderSubLayers(
          subProps,
          resolvedDescriptor,
          renderTileCallback,
        );
      },
      updateTriggers: {
        getTileData: currentFrameId,
        // all: Math.round(this.context.viewport?.zoom ?? 0),
        renderSubLayers: updateTriggers?.renderTile,
      },
      tileSize: this.props.tileSize,
      zoomOffset: this.props.zoomOffset,
      maxZoom: this.props.maxZoom,
      minZoom: this.props.minZoom,
      extent: this.props.extent,
      debounceTime: this.props.debounceTime,
      maxCacheSize: this.props.maxCacheSize,
      maxCacheByteSize: this.props.maxCacheByteSize,
      maxRequests: this.props.maxRequests,
      refinementStrategy: this.props.refinementStrategy ?? "no-overlap",
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
      const { currentFrameId, currentFrameUrl, currentFrameRequestInit } = this.props;
      const { x, y, z } = tile.index;

      const hit = tileCache.get(currentFrameId, x, y, z);

      if (hit) {
        tileCache.markDisplayed(currentFrameId, x, y, z);

        return {
          texture: hit.texture,
          mask: hit.mask,
          byteLength: hit.byteLength,
          width: hit.width,
          height: hit.height,
        } as unknown as DataT;
      }

      tileCache.recordMiss();

      const registry = this.props.geotiffRegistry ?? this._localRegistry!;
      let geotiff = registry.get(currentFrameId);

      if (!geotiff) {
        geotiff = await registry.open(
          currentFrameId,
          currentFrameUrl,
          currentFrameRequestInit,
        );
      }

      const result = await decodeGeoTIFFTile(
        geotiff,
        x,
        y,
        z,
        userFn as (
          img: GeoTIFF | Overview,
          opts: GetTileDataOptions,
        ) => Promise<DataT>,
        {
          device: options.device,
          signal: options.signal,
          pool: this.props.pool,
        },
      );

      if (!result) {
        return null as DataT;
      }

      if (typeof result === "object" && "texture" in result) {
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
          quality: "full",
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
