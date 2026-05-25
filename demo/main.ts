import { Deck } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";
import type { GetTileDataOptions, MinimalTileData } from "@developmentseed/deck.gl-geotiff";
import { texture as geotiffTexture } from "@developmentseed/deck.gl-geotiff";
import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import type { RasterModule } from "@developmentseed/deck.gl-raster/gpu-modules";
import { CreateTexture, MaskTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { TimeCOGLayer, type TimeCOGStats } from "../src/index.js";
import { renderTileDiagnostics } from "../src/util/tile-diagnostics.js";
import "./style.css";

/* --------------------------------- Options -------------------------------- */

const PRECIP_MAX_RAW_VALUE = 200;
const PLAY_SPEEDS = [0.5, 1, 2, 5, 10, 30, 45, 60, 120].map((s) => s * 60);
const DEFAULT_SPEED = 30 * 60;
const COG_INTERVAL_MS = Number(import.meta.env.VITE_COG_INTERVAL_MS ?? 2 * 60 * 1000);
const COG_BASE_URL = `${import.meta.env.VITE_COG_BASE_URL || "/cogs/"}`;
const DEFAULT_FROM = "2025-10-30T12:00:00Z";
const DEFAULT_TO = "2025-10-31T12:00:00Z";
const BASEMAP_URL = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
const INITIAL_VIEW_STATE = {
  longitude: -74.006,
  latitude: 40.7128,
  zoom: 7,
  pitch: 0,
  bearing: 0,
} as const;


type CatalogFrame = number;
type DataFormat = Uint8Array | Uint16Array | Float32Array;

type TileData = MinimalTileData & {
  byteLength: number;
  texture: Texture;
  mask?: Texture;
};

type DemoState = {
  currentTimeMs: number | null;
  playing: boolean;
  playbackRate: number;
  lastFrameTime: number | null;
  animFrameId: number | null;
  timeLayer: TimeCOGLayer<CatalogFrame> | null;
};

/* ----------------------------- Tile Functions ----------------------------- */

const ColorRamp = {
  name: "precip-color-ramp",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
float rawValue = color.r * 65535.0;
if (rawValue <= 0.0) {
  discard;
}

float t = clamp(rawValue / ${PRECIP_MAX_RAW_VALUE.toFixed(1)}, 0.0, 1.0);
t = pow(t, 0.72);

vec3 c0 = vec3(0.56, 0.77, 0.98);
vec3 c1 = vec3(0.10, 0.95, 0.86);
vec3 c2 = vec3(0.32, 0.98, 0.45);
vec3 c3 = vec3(0.96, 0.84, 0.20);
vec3 c4 = vec3(0.98, 0.38, 0.76);
vec3 c5 = vec3(0.98, 0.75, 0.93);

vec3 ramp;
if (t < 0.18) {
  ramp = mix(c0, c1, smoothstep(0.0, 0.18, t));
} else if (t < 0.42) {
  ramp = mix(c1, c2, smoothstep(0.18, 0.42, t));
} else if (t < 0.68) {
  ramp = mix(c2, c3, smoothstep(0.42, 0.68, t));
} else if (t < 0.88) {
  ramp = mix(c3, c4, smoothstep(0.68, 0.88, t));
} else {
  ramp = mix(c4, c5, smoothstep(0.88, 1.0, t));
}

float alpha = smoothstep(0.0, 0.06, t) * (0.20 + 0.70 * sqrt(t));
color = vec4(ramp, alpha);
`,
  },
} as const;


function padRowsToAlignment(
  data: DataFormat,
  width: number,
  height: number,
  bytesPerPixel: number,
): { data: DataFormat; bytesPerRow: number } {
  const rowBytes = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(rowBytes / 4) * 4;

  if (bytesPerRow === rowBytes) {
    return { data, bytesPerRow };
  }

  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dstBytes = new Uint8Array(bytesPerRow * height);

  for (let row = 0; row < height; row += 1) {
    dstBytes.set(src.subarray(row * rowBytes, (row + 1) * rowBytes), row * bytesPerRow);
  }

  return {
    data:
      data instanceof Uint16Array ? new Uint16Array(dstBytes.buffer)
      : data instanceof Float32Array ? new Float32Array(dstBytes.buffer)
      : dstBytes,
    bytesPerRow,
  };
}

async function getTileData(
  image: GeoTIFF | Overview,
  { device, x, y, signal, pool }: GetTileDataOptions,
): Promise<TileData> {
  const tile = await image.fetchTile(x, y, {
    boundless: false,
    pool,
    signal,
  });
  const { array } = tile;
  const { width, height, mask } = array;

  if (array.layout === "band-separate") {
    throw new Error("Band-separate precipitation tiles are not supported.");
  }

  const data = array.data as DataFormat;
  const { samplesPerPixel, bitsPerSample, sampleFormat } = image.cachedTags;
  const format = geotiffTexture.inferTextureFormat(samplesPerPixel, bitsPerSample, sampleFormat);
  const texture = device.createTexture({
    format,
    width,
    height,
    sampler: {
      minFilter: "linear",
      magFilter: "linear",
    },
  });

  if (!bitsPerSample.every((bits) => bits === bitsPerSample[0])) {
    throw new Error("Mixed bitsPerSample values are not supported.");
  }

  if (bitsPerSample[0] % 8 !== 0) {
    throw new Error("Sub-byte sample sizes are not supported.");
  }

  const upload = padRowsToAlignment(data, width, height, (bitsPerSample[0] / 8) * samplesPerPixel);
  texture.writeData(upload.data, { bytesPerRow: upload.bytesPerRow });
  let byteLength = data.byteLength;

  let maskTexture: Texture | undefined;
  if (mask) {
    maskTexture = device.createTexture({
      format: "r8unorm",
      width,
      height,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
      },
    });
    const maskUpload = padRowsToAlignment(mask, width, height, 1);
    maskTexture.writeData(maskUpload.data, { bytesPerRow: maskUpload.bytesPerRow });
    byteLength += mask.byteLength;
  }

  return {
    texture,
    mask: maskTexture,
    byteLength,
    width,
    height,
  };
}

function renderTile(data: TileData): RenderTileResult {
  const renderPipeline: RasterModule[] = [
    {
      module: CreateTexture,
      props: {
        textureName: data.texture,
      },
    },
    {
      module: ColorRamp,
    },
  ];

  if (data.mask) {
    renderPipeline.push({
      module: MaskTexture,
      props: {
        maskTexture: data.mask,
      },
    });
  }

  return { renderPipeline };
}


function createTimeLayer(frames: number[], { playing, playbackRate }: DemoState): TimeCOGLayer<CatalogFrame> | null {
  const currentTime = state.currentTimeMs;

  return currentTime == undefined ? null : new TimeCOGLayer({
    id: "time-cog-layer-demo",
    data: frames,
    getTime: (timeMs) => timeMs,
    getUrl: (timeMs: number) => `${COG_BASE_URL}${formatUtcTimestamp(timeMs)}.tif`,
    currentTime,
    playing,
    playbackRate,
    getTileData,
    renderTile,
    opacity: 0.86,
    missingFramePolicy: "nearest",
    maxFrameRate: 15,
    qualityPolicy: {
      lowResFirst: false,
    },
    bufferPolicy: {
      backwardFrames: playing ? 0 : 2,
      forwardFrames: playing ? 16 : 8,
    },
    schedulerPolicy: {
      maxNetworkRequests: 16,
      frameRateSnap: "slower",
    },
    skipMissingFrames: true,
    missingFramesWatermark: Date.now() - 60 * 60 * 1000,
    scrubBucketingPolicy: {
      enabled: true,
    },
    onStats: (stats: TimeCOGStats) => {
      ui.statsOutput.value =
        `${stats.readyFrameCount}/${stats.frameCount} ready, ` +
        `${stats.scheduledFrameCount} scheduled | ` +
        `prefetch used: ${Math.round(stats.prefetchedUseRate * 100)}% | ` +
        `waste: ${stats.prefetchedWastedCount} (` + 
        `${Math.round(stats.prefetchedWasteRate * 100)}%, ` +
        `${Math.round(stats.prefetchedWastedBytes / 1024)} kB)`;
    },
  });
}

/* --------------------------- Catalog Generation --------------------------- */


const range = (from: number, to: number, interval: number): number[] => {
  const result = [];
  for (let i = from; i <= to; i += interval) { result.push(i); }
  return result;
};

const pad2 = (value: number) => String(value).padStart(2, "0");
const formatUtcTimestamp = (timeMs: number) => {
  const time = new Date(timeMs);
  return [
    time.getUTCFullYear(), pad2(time.getUTCMonth() + 1), pad2(time.getUTCDate()), "T", 
    pad2(time.getUTCHours()), pad2(time.getUTCMinutes()), pad2(time.getUTCSeconds()), "Z",
  ].join("");
};

/* ----------------------------------- UI ----------------------------------- */

function createDemoUI(): {
  deckRoot: HTMLDivElement;
  playButton: HTMLButtonElement;
  speedSelect: HTMLSelectElement;
  frameInput: HTMLInputElement;
  timeOutput: HTMLOutputElement;
  statsOutput: HTMLOutputElement;
  diagnosticsCanvas: HTMLCanvasElement;
} {
  const app = document.querySelector<HTMLDivElement>("#app")!;

  app.innerHTML = `
    <div id="deck"></div>
    <aside id="controls">
      <div id="playback">
        <button id="play" type="button" title="Play / Pause">&#9654;</button>
        <select id="speed">
          ${PLAY_SPEEDS.map((s) => `<option value="${s}"${s === DEFAULT_SPEED ? " selected" : ""}>${s / 60}min/s</option>`).join("")}
        </select>
        <output id="stats"></output>
        <output id="time"></output>
      </div>
      <label>
        <input id="frame" type="range" min="0" max="0" value="0" />
      </label>
      <canvas id="diagnostics" width="480" height="150"></canvas>
    </aside>
  `;

  return {
    deckRoot: document.querySelector<HTMLDivElement>("#deck")!,
    playButton: document.querySelector<HTMLButtonElement>("#play")!,
    speedSelect: document.querySelector<HTMLSelectElement>("#speed")!,
    frameInput: document.querySelector<HTMLInputElement>("#frame")!,
    timeOutput: document.querySelector<HTMLOutputElement>("#time")!,
    statsOutput: document.querySelector<HTMLOutputElement>("#stats")!,
    diagnosticsCanvas: document.querySelector<HTMLCanvasElement>("#diagnostics")!,
  };
}

function render(): void {
  if (frames.length === 0) {
    return;
  }

  ui.timeOutput.value = state.currentTimeMs === null ? "" : new Date(state.currentTimeMs).toISOString();
  ui.frameInput.value = state.currentTimeMs === null ? "" : String(state.currentTimeMs);

  state.timeLayer = createTimeLayer(frames, state);

  deck.setProps({
    layers: [
      new TileLayer({
        id: "basemap",
        data: BASEMAP_URL,
        tileSize: 256,
        minZoom: 0,
        maxZoom: 19,
        renderSubLayers: (props) => {
          const {
            boundingBox: [[west, south], [east, north]],
          } = props.tile;
          return new BitmapLayer(props, {
            data: undefined,
            image: props.data as string,
            bounds: [west, south, east, north],
          });
        },
      }),
      ...(state.timeLayer ? [state.timeLayer] : []),
    ],
  });

  requestAnimationFrame(() => {
    try {
      if (state.timeLayer) { renderTileDiagnostics(ui.diagnosticsCanvas, state.timeLayer.getDiagnosticSnapshot()); }
    } catch { } // Layer not yet initialized; retry on the next render pass.
  });
}

const query = new URLSearchParams(window.location.search);
const fromTime = query.get("from") ? Date.parse(query.get("from")!) : new Date(DEFAULT_FROM).getTime();
const toTime = query.get("to") ? Date.parse(query.get("to")!) : new Date(DEFAULT_TO).getTime();
const interval = Math.max(1, Math.round(Number(query.get('interval') ?? COG_INTERVAL_MS)) / COG_INTERVAL_MS) * COG_INTERVAL_MS;
const playbackRate = Number(query.get("speed") ?? DEFAULT_SPEED);
const frames = range(fromTime, toTime, interval);
const state: DemoState = {
  currentTimeMs: fromTime,
  playing: false,
  playbackRate: playbackRate,
  lastFrameTime: null,
  animFrameId: null,
  timeLayer: null,
};

const ui = createDemoUI();
ui.frameInput.min = String(fromTime);
ui.frameInput.max = String(toTime);
ui.frameInput.step = String(interval);
ui.frameInput.value = state.currentTimeMs === null ? "" : String(state.currentTimeMs);

const deck = new Deck({
  parent: ui.deckRoot,
  initialViewState: INITIAL_VIEW_STATE,
  controller: true,
  layers: [],
});

/* -------------------------------- Playback -------------------------------- */

function startPlayback(): void {
  state.playing = true;
  state.lastFrameTime = null;
  ui.playButton.innerHTML = "&#9646;&#9646;";
  render();

  function tick(now: number): void {
    if (!state.playing || state.currentTimeMs === null) {
      return;
    }

    if (state.lastFrameTime == null) {
      state.lastFrameTime = now;
    } else if (now !== state.lastFrameTime) {
      const nextTimeMs = state.currentTimeMs + (now - state.lastFrameTime) * state.playbackRate;
      state.currentTimeMs = nextTimeMs >= toTime ? fromTime : nextTimeMs < fromTime ? toTime : nextTimeMs;
      render();
      state.lastFrameTime = now;
    }
    state.animFrameId = requestAnimationFrame(tick);
  }

  state.animFrameId = requestAnimationFrame(tick);
}

function stopPlayback(): void {
  state.playing = false;
  ui.playButton.innerHTML = "&#9654;";

  if (state.animFrameId !== null) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }

  render();
}

ui.playButton.addEventListener("click", () => {
  state.playing ? stopPlayback() : startPlayback();
});

ui.speedSelect.addEventListener("change", () => {
  state.playbackRate = Number(ui.speedSelect.value);
  if (state.playing) {
    state.lastFrameTime = null;
    render();
  }
});

ui.frameInput.addEventListener("input", () => {
  state.currentTimeMs = Number(ui.frameInput.value);
  render();
});

render();
