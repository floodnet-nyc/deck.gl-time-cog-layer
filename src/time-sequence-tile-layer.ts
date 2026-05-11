import type { Device } from "@luma.gl/core";
import type { Layer } from "@deck.gl/core";
import type { _Tileset2DProps, _Tile2DHeader as Tile2DHeader, _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import {
  RasterTileLayer,
  RasterTileset2D,
} from "@developmentseed/deck.gl-raster";
import type { RenderTileResult, TilesetDescriptor } from "@developmentseed/deck.gl-raster";
import type { MinimalTileData } from "@developmentseed/deck.gl-geotiff";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";

/**
 * Custom props injected by {@link TimeCOGLayer} into the persistent
 * sublayer.  These carry the dynamic frame identity, the shared tile
 * cache, and the preview bias so that every `getTileData` invocation can
 * check the cache for the current frame and fall back to coarser preview
 * tiles on miss.
 */
export type TimeSequenceTileLayerProps = {

  getTileData?: (props: TileLoadProps, options: { device: Device; signal?: AbortSignal }) => Promise<any>;

  onViewportLoad?: ((tiles: Tile2DHeader<Record<string, unknown>>[]) => void);
};

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
  static layerName = "TimeSequenceTileLayer";

  declare props: COGLayer<DataT>["props"] & TimeSequenceTileLayerProps;

  renderLayers(): Layer | null {
    const descriptor = this._tilesetDescriptor();
    const getTileData = this._getTileDataCallback();
    const renderTile = this._renderTileCallback();

    if (!descriptor || !getTileData || !renderTile) {
      return null;
    }
    // // Capture the device once so the inner `TilesetFactory` can read
    // // its current effective device-pixel ratio per `getTileIndices`
    // // call. The ratio is sampled lazily so window-drag-between-displays
    // // (or runtime changes to `useDevicePixels`) take effect on the next
    // // traversal. See dev-docs/lod-and-pixel-matching.md § (A).
    // //
    // // We compute drawingBuffer/CSS rather than using
    // // `cssToDeviceRatio()` (deprecated) or the `devicePixelRatio`
    // // property (always reflects the system value, ignoring
    // // `Deck.useDevicePixels`). The drawing-buffer ratio is the
    // // *effective* DPR Deck is rendering at.
    // const device = this.context.device;
    class TilesetFactory extends RasterTileset2D {
      constructor(opts: _Tileset2DProps) {
        super(opts, descriptor!, 
        //   {
        //   getPixelRatio: () => {
        //     const ctx = device.getDefaultCanvasContext();
        //     const [drawingBufferWidth] = ctx.getDrawingBufferSize();
        //     const [cssWidth] = ctx.getCSSSize();
        //     return cssWidth ? drawingBufferWidth / cssWidth : 1;
        //   },
        // }
      );
      }
    }

    const base = this as unknown as {
      _renderSubLayers: (
        subProps: Record<string, unknown>,
        desc: TilesetDescriptor,
        rt: (data: DataT) => RenderTileResult | null,
      ) => Layer[];
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
      onViewportLoad,
    } = this.props;

    return new TileLayer({
      id: `raster-tile-layer-${this.id}`,
      TilesetClass: TilesetFactory,
      getTileData: (tile: TileLoadProps) => {
        return getTileData(tile, {
          device: this.context.device,
          signal: (
            this.props.signal && tile.signal
            ? AbortSignal.any([this.props.signal, tile.signal])
            : (this.props.signal ?? tile.signal)
          ),
        });
      },
      renderSubLayers: (
        subProps: Record<string, unknown>,
      ): Layer[] => {
        return (base as any)._renderSubLayers(
          subProps,
          descriptor,
          renderTile,
        );
      },
      updateTriggers,
      tileSize,
      zoomOffset,
      maxZoom,
      minZoom,
      extent,
      debounceTime,
      maxCacheSize,
      maxCacheByteSize,
      maxRequests,
      // TODO: the current raster renderer doesn't handle mid-flight tile changes
      refinementStrategy: (
        refinementStrategy === 'best-available' || // doesn't work
        refinementStrategy === 'no-overlap'  // doesn't work
        ? 'never' // works (little black flash between zoom levels, but no significant degradation or ghosting)
        : refinementStrategy  // best of luck
      ),
      onViewportLoad,
    });
  }

  protected _getTileDataCallback(): ReturnType<
    RasterTileLayer<DataT>["_getTileDataCallback"]
  > {
    const userFn = this.props.getTileData;

    if (!userFn) {
      return undefined;
    }

    return userFn;
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
