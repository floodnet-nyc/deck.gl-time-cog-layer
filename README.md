# deck.gl - Time-COGs: Smooth playback of time-indexed Cloud-Optimized GeoTIFF (COG) sequences

A [deck.gl](https://deck.gl) `CompositeLayer` for smooth playback of time-indexed Cloud-Optimized GeoTIFF (COG) sequences. Designed for weather radar, satellite imagery, and other regularly-sampled raster time series, building upon [@developmentseed/deck.gl-raster](https://developmentseed.org/deck.gl-raster).

```bash
npm install @floodnet/deck.gl-time-cog-layer
```

![Demo](https://raw.githubusercontent.com/floodnet-nyc/deck.gl-time-cog-layer/main/public/timecoglayer.webp)

---

## Quick start

```ts
import { Deck } from "@deck.gl/core";
import { TimeCOGLayer } from "@floodnet/deck.gl-time-cog-layer";

const deck = new Deck({
  layers: [
    new TimeCOGLayer({
      id: "precip",
      data: [
        { time: "2025-10-30T00:00:00Z", url: "/cogs/000.tif" },
        { time: "2025-10-30T00:02:00Z", url: "/cogs/002.tif" },
        { time: "2025-10-30T00:04:00Z", url: "/cogs/004.tif" },
      ],
      currentTime: Date.now(),
      playing: true,
      playbackRate: 60,  // 60× real-time (1 minute per second)
      getTileData: async (image, { device, x, y, signal, pool }) => {
        const tile = await image.fetchTile(x, y, { pool, signal });
        const texture = device.createTexture({ data: tile.array.data, /* ... */ });
        return { texture, width: tile.array.width, height: tile.array.height };
      },
      renderTile: (data) => ({
        renderPipeline: [
          { module: CreateTexture, props: { textureName: data.texture } },
          { module: ColorRamp },
        ],
      }),
    }),
  ],
});


const ColorRamp = {
  name: "precip-color-ramp",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
float rawValue = color.r * 65535.0;
if (rawValue <= 0.0) { discard; }

float t = clamp(rawValue, 0.0, 1.0);
t = pow(t, 0.72);

vec3 c0 = vec3(0.56, 0.77, 0.98);
vec3 c1 = vec3(0.10, 0.95, 0.86);
vec3 c2 = vec3(0.32, 0.98, 0.45);
vec3 c3 = vec3(0.96, 0.84, 0.20);
vec3 c4 = vec3(0.98, 0.38, 0.76);
vec3 c5 = vec3(0.98, 0.75, 0.93);

vec3 ramp;
if (t < 0.18) {        ramp = mix(c0, c1, smoothstep(0.0, 0.18, t));
} else if (t < 0.42) { ramp = mix(c1, c2, smoothstep(0.18, 0.42, t));
} else if (t < 0.68) { ramp = mix(c2, c3, smoothstep(0.42, 0.68, t));
} else if (t < 0.88) { ramp = mix(c3, c4, smoothstep(0.68, 0.88, t));
} else {               ramp = mix(c4, c5, smoothstep(0.88, 1.0, t));
}

float alpha = smoothstep(0.0, 0.06, t) * (0.20 + 0.70 * sqrt(t));
color = vec4(ramp, alpha);
`,
  },
} as const;

```

`getTileData` and `renderTile` follow the same signatures as [`@developmentseed/deck.gl-geotiff`](https://developmentseed.org/deck.gl-raster/api/geotiff/)'s `COGLayer`. Any existing COG render pipeline works unchanged.

### Customizing frame data access

If your data is in a different shape (e.g. a GeoJSON feature collection or API response), use `getTime` and `getUrl` accessors to extract the timestamp and COG URL:

```ts
type Feature = { properties: { timestamp: string; cog_url: string } };

const features: Feature[] = await fetchCatalog();

new TimeCOGLayer({
  data: features,
  getTime: (f) => f.properties.timestamp,
  getUrl:  (f) => f.properties.cog_url,
  currentTime: Date.now(),
  // ...
});
```

All other fields on each item (e.g. `id`, `meta`, `byteSizeHint`) are still picked up automatically if they exist.

If `getTime` or `getUrl` depend on reactive state, signal that through `updateTriggers` so the catalog is re-normalized when they change:

```ts
updateTriggers: {
  getTime: [dependency],
  getUrl:  [dependency],
}
```

---

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `data` | `TFrame[]` | — | Ordered list of frame entries (any shape when `getTime`/`getUrl` are provided) |
| `getTime` | `(frame: TFrame) => number \| string \| Date` | — | Extracts the timestamp from each frame item; falls back to `frame.time` when omitted |
| `getUrl` | `(frame: TFrame) => string \| URL` | — | Extracts the COG URL from each frame item; falls back to `frame.url` when omitted |
| `currentTime` | `number \| string \| Date` | — | Current playback time (epoch ms, ISO-8601, or Date) |
| `playing` | `boolean` | `false` | Whether playback is active |
| `playbackRate` | `number` | `0` | Speed multiplier (e.g. `60` = 1 minute of data per real second) |
| `maxFrameRate` | `number` | `0` | Maximum display frame rate during playback (0 = unlimited) |
| `missingFramePolicy` | `"hold-last" \| "nearest" \| "skip" \| "transparent"` | `"hold-last"` | How to resolve a time between catalog entries |
| `skipMissingFrames` | `boolean` | `false` | When true, frames that fail GeoTIFF open are temporarily excluded from display selection and scheduling |
| `missingFramesWatermark` | `number \| string \| Date` | `undefined` | Only frames at or before this timestamp are eligible for skip-missing exclusion; newer frames keep retrying so real-time ingestion can catch up |
| `bufferPolicy` | `object` | `{ backwardFrames: 2, forwardFrames: 6 }` | How many frames to prefetch ahead / retain behind |
| `cachePolicy` | `object` | `{}` | Tile cache limits — `memoryBytes`, `maxFrames`, `maxTiles` |
| `qualityPolicy` | `object` | `{}` | Progressive loading behaviour — `lowResFirst`, `previewOverviewBias`, `scrubOverviewBias`, `fullResUpgradeIdleMs` |
| `schedulerPolicy` | `object` | `{ maxNetworkRequests: 4 }` | Prefetch concurrency (`maxNetworkRequests`, `maxDecodeTasks`, `maxGpuUploadsPerFrame`), optional cadence snapping (`frameRateSnap`), multiscale temporal bias (`multiscaleLevelPenalty`), and optional scoring weights |
| `descriptorMode` | `"reuse-first" \| "manifest"` | `"reuse-first"` | How the shared tileset descriptor is determined |
| `descriptorManifest` | `object` | — | Pre-declared GeoTIFF structure (required with `descriptorMode: "manifest"`) |
| `getTileData` | `(image, options) => Promise<DataT>` | — | As [COGLayer's `getTileData`](https://developmentseed.org/deck.gl-raster/api/geotiff/) |
| `renderTile` | `(data: DataT) => RenderTileResult` | — | As [COGLayer's `renderTile`](https://developmentseed.org/deck.gl-raster/api/geotiff/) |
| `onFrameDisplayed` | `(frame) => void` | — | Fired when a new frame becomes the display frame |
| `onFrameReady` | `(frame) => void` | — | Fired when the display frame is fully cached at full resolution |
| `onMissingFrame` | `(timeMs) => void` | — | Fired when the requested time has no exact catalog match |
| `onDescriptorMismatch` | `(frame, reason) => void` | — | Fired when `descriptorMode: "manifest"` detects a structural mismatch |
| `onBufferStateChange` | `(state) => void` | — | Fired on buffer state changes |
| `onStats` | `(stats) => void` | — | Fired with combined cache + prefetcher statistics |

All remaining COGLayer props (`opacity`, `maxRequests`, `loadOptions`, `signal`, `pool`, `epsgResolver`, `onGeoTIFFLoad`, `onViewportLoad`, etc.) are forwarded to the underlying `COGLayer`.



---

## How it works

Instead of creating a new `COGLayer` for every frame (which tears down GPU textures and produces a strobing effect), `TimeCOGLayer` renders a single persistent sublayer. Frame changes are communicated through `updateTriggers`, which keeps old tile content visible until new data is ready.

A shared `SequenceTileCache` (keyed by `frameId, x, y, z`) stores decoded GPU textures across frame transitions so that cache hits return instantly. A background `FramePrefetcher` proactively loads tiles for nearby frames within the buffer window, and a shared `GeoTIFFRegistry` eliminates redundant COG header fetches. The prefetcher scores tasks by temporal proximity, playback direction, buffer pressure, and estimated fetch cost — stale tasks are aborted on seek.

---

## API reference

### `TimeCOGFrame`

```ts
type TimeCOGFrame = {
  id?: string;                   // stable identifier (auto-derived if omitted)
  time: number | string | Date;  // timestamp (epoch ms, ISO-8601, or Date)
  url: string | URL;             // COG URL
  requestInit?: RequestInit;     // forwarded to fetch() when opening the COG
  meta?: Record<string, unknown>; // opaque metadata
  byteSizeHint?: number;         // estimated compressed COG size (bytes) — helps the prefetcher prioritise smaller frames
};
```

### `MissingFramePolicy`

```ts
type MissingFramePolicy = "hold-last" | "nearest" | "skip" | "transparent";
```

| Policy | Behaviour |
|---|---|
| `"hold-last"` (default) | Show the most recent frame at or before the requested time. Least visually disruptive. |
| `"nearest"` | Show the closest frame by absolute time difference. |
| `"skip"` | Show nothing (`displayFrame` is `null`). |
| `"transparent"` | Show nothing (`displayFrame` is `null`). |

### `TimeCOGBufferPolicy`

```ts
type TimeCOGBufferPolicy = {
  backwardFrames?: number;  // default 2
  forwardFrames?: number;   // default 6
};
```

### `TimeCOGCachePolicy`

```ts
type TimeCOGCachePolicy = {
  memoryBytes?: number;     // max total GPU bytes
  maxFrames?: number;       // max distinct frames in cache
  maxTiles?: number;  // max individual tile entries
};
```

### `QualityPolicy`

```ts
type QualityPolicy = {
  lowResFirst?: boolean;           // fetch coarse overview tiles first, then refine
  previewOverviewBias?: number;    // levels coarser than ideal visible level for initial preview on seek (default 1)
  scrubOverviewBias?: number;      // additional coarse bias for scrub interactions (default 2)
  fullResUpgradeIdleMs?: number;   // ms of idle time before upgrading from preview to full-res (default 150)
};
```

### `SchedulerPolicy`

```ts
type SchedulerPolicy = {
  maxNetworkRequests?: number;     // default 4 — prefetch concurrency
  maxDecodeTasks?: number;         // max concurrent decode tasks
  maxGpuUploadsPerFrame?: number;  // max GPU uploads per frame
  frameRateSnap?: "off" | "on" | "slower" | "faster"; // default "off"
  multiscaleLevelPenalty?: number; // default 0.5 — pushes coarse temporal buckets later in the schedule
  scoringWeights?: ScoringWeights;  // per-factor scoring weight overrides
};
```

`frameRateSnap` is useful when the playback bucket width implied by
`playbackRate` and `maxFrameRate` is incommensurate with the source frame period
(for example, 3-minute buckets over 2-minute source frames).

- `off`: use the exact requested playback bucket width.
- `on` / `slower`: widen the effective playback bucket to the next whole-number multiple of the representative source frame period. This preserves the `maxFrameRate` cap while producing a more regular cadence.
- `faster`: narrow the effective playback bucket to the previous whole-number multiple of the representative source frame period. This can exceed the requested `maxFrameRate` cap in exchange for a more source-aligned cadence.

### Callbacks

```ts
onFrameDisplayed?: (frame: NormalizedTimeCOGFrame) => void;
onFrameReady?: (frame: NormalizedTimeCOGFrame) => void;
onMissingFrame?: (timeMs: number) => void;
onDescriptorMismatch?: (frame: NormalizedTimeCOGFrame, reason: string) => void;
onBufferStateChange?: (state: TimeCOGBufferState) => void;
onStats?: (stats: TimeCOGStats) => void;
```

---

## Development

```bash
npm install
npm run build          # compile TypeScript
npm test               # build + run tests
npm run dev            # dev server with demo
npm run build:demo     # production demo build
npm run preview        # preview production demo
```
