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
import type { NormalizedTimeCOGFrame, TimeCOGFrame } from "../src/index.js";
import { TimeCOGLayer, normalizeFrameCatalog } from "../src/index.js";
import { renderTileDiagnostics } from "../src/tile-diagnostics.js";
import "./style.css";

const DISPLAY_OPACITY = 0.86;
const PRECIP_MAX_RAW_VALUE = 200;
const PLAY_SPEEDS = [0.5, 1, 2, 5, 10, 30, 60, 120].map((s) => s * 60);
const DEFAULT_SPEED = 30 * 60;


type PrecipTileData = MinimalTileData & {
  byteLength: number;
  texture: Texture;
  mask?: Texture;
};

const PrecipColorRamp = {
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

type PrecipIndex = {
  features: Array<{
    properties: {
      time: string;
      url: string;
    };
  }>;
};

function padRowsToAlignment(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): { data: Uint8Array | Uint16Array; bytesPerRow: number } {
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
    data: data instanceof Uint16Array ? new Uint16Array(dstBytes.buffer) : dstBytes,
    bytesPerRow,
  };
}

async function getPrecipTileData(
  image: GeoTIFF | Overview,
  { device, x, y, signal, pool }: GetTileDataOptions,
): Promise<PrecipTileData> {
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

  const data = array.data as Uint8Array | Uint16Array;
  const format = geotiffTexture.inferTextureFormat(1, [16], [1]);
  const texture = device.createTexture({
    format,
    width,
    height,
    sampler: {
      minFilter: "linear",
      magFilter: "linear",
    },
  });
  const upload = padRowsToAlignment(data, width, height, 2);
  texture.writeData(upload.data, { bytesPerRow: upload.bytesPerRow });
  let maskTexture: Texture | undefined;
  let byteLength = data.byteLength;

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

function renderPrecipTile(data: PrecipTileData): RenderTileResult {
  const renderPipeline: RasterModule[] = [
    {
      module: CreateTexture,
      props: {
        textureName: data.texture,
      },
    },
    {
      module: PrecipColorRamp,
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

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element");
}

app.innerHTML = `
  <div id="deck"></div>
  <aside id="controls">
    <strong>TimeCOGLayer demo</strong>
    <div id="playback">
      <button id="play" type="button" title="Play / Pause">&#9654;</button>
      <select id="speed">
        ${PLAY_SPEEDS.map((s) => `<option value="${s}"${s === DEFAULT_SPEED ? " selected" : ""}>${s/60}min/s</option>`).join("")}
      </select>
    </div>
    <label>
      Frame
      <input id="frame" type="range" min="0" max="0" value="0" />
    </label>
    <output id="time"></output>
    <output id="stats"></output>
    <canvas id="diagnostics" width="480" height="200"></canvas>
  </aside>
`;

const playButton = document.querySelector<HTMLButtonElement>("#play");
const speedSelect = document.querySelector<HTMLSelectElement>("#speed");
const frameInput = document.querySelector<HTMLInputElement>("#frame");
const timeOutput = document.querySelector<HTMLOutputElement>("#time");
const statsOutput = document.querySelector<HTMLOutputElement>("#stats");
const diagnosticsCanvas = document.querySelector<HTMLCanvasElement>("#diagnostics");

if (!playButton || !speedSelect || !frameInput || !timeOutput || !statsOutput) {
  throw new Error("Missing demo controls");
}

const index = await fetch("/precip_cog_index.json").then((response) => {
  if (!response.ok) {
    throw new Error(`Failed to load precip index: ${response.status}`);
  }

  return response.json() as Promise<PrecipIndex>;
});

const frames: TimeCOGFrame[] = index.features.map((feature) => {
  const sourceUrl = new URL(feature.properties.url);

  return {
    time: feature.properties.time,
    url: `/cogs/${sourceUrl.pathname.split("/").at(-1)}`,
  };
});
const catalog = normalizeFrameCatalog(frames);
let selectedFrame = catalog[0] as NormalizedTimeCOGFrame | undefined;

frameInput.max = String(Math.max(0, catalog.length - 1));

const timeSpan = catalog.length > 1 ? catalog[catalog.length - 1].timeMs - catalog[0].timeMs : 0;

let playing = false;
let playbackRate = DEFAULT_SPEED;
let lastFrameTime: number | null = null;
let lastFrameIndex = 0;
let animFrameId: number | null = null;

const deck = new Deck({
  parent: document.querySelector<HTMLDivElement>("#deck") ?? undefined,
  initialViewState: {
    longitude: -74.006,
    latitude: 40.7128,
    zoom: 7,
    pitch: 0,
    bearing: 0,
  },
  controller: true,
  layers: [],
});

let timeLayer: TimeCOGLayer | null = null;

function renderDiagnostics(): void {
  if (!timeLayer || !diagnosticsCanvas) {
    return;
  }

  try {
    const snapshot = timeLayer.getDiagnosticSnapshot();

    if (snapshot.frameIds.length > 0) {
      renderTileDiagnostics(diagnosticsCanvas, snapshot);
    }
  } catch {
    // Layer not yet initialized — retry next frame
  }
}

function render(): void {
  if (!selectedFrame) {
    return;
  }

  timeOutput.value = new Date(selectedFrame.timeMs).toISOString();

  timeLayer = new TimeCOGLayer({
    id: "time-cog-layer-demo",
        frames,
        currentTime: selectedFrame.timeMs,
        playing,
        playbackRate,
        getTileData: getPrecipTileData,
        renderTile: renderPrecipTile,
        opacity: DISPLAY_OPACITY,
        missingFramePolicy: "nearest",
        qualityPolicy: {
          lowResFirst: false,
        },
        bufferPolicy: {
          backwardFrames: 1,
          forwardFrames: 3,
        },
        cachePolicy: {
          maxFrames: 120,
        },
    onStats: (stats) => {
      statsOutput.value = `${stats.readyFrameCount}/${stats.frameCount} ready, ${stats.scheduledFrameCount} scheduled`;
    },
  });

  deck.setProps({
    layers: [
      new TileLayer({
        id: "basemap",
        data: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        tileSize: 256,
        minZoom: 0,
        maxZoom: 19,
        renderSubLayers: (props) => {
          const {
            bbox: { west, south, east, north },
          } = props.tile;
          return new BitmapLayer(props, {
            data: null,
            image: props.data as string,
            bounds: [west, south, east, north],
          });
        },
      }),
      timeLayer,
    ],
  });

  requestAnimationFrame(() => renderDiagnostics());
}

function updateSliderFromTime(timeMs: number): void {
  let sliderIndex = 0;
  for (let i = 0; i < catalog.length; i += 1) {
    if (catalog[i].timeMs <= timeMs) {
      sliderIndex = i;
    } else {
      break;
    }
  }
  frameInput.value = String(sliderIndex);
}

function startPlayback(): void {
  playing = true;
  lastFrameTime = null;
  playButton.innerHTML = "&#9646;&#9646;";
  render();

  function tick(now: number): void {
    if (!playing) return;

    if (lastFrameTime !== null) {
      const deltaMs = now - lastFrameTime;
      const advanceMs = deltaMs * playbackRate;

      if (selectedFrame) {
        let newTimeMs = selectedFrame.timeMs + advanceMs;

        if (newTimeMs >= catalog[catalog.length - 1].timeMs) {
          newTimeMs = catalog[0].timeMs;
        } else if (newTimeMs < catalog[0].timeMs) {
          newTimeMs = catalog[catalog.length - 1].timeMs;
        }

        const nearestIndex = findNearestFrameIndex(newTimeMs);
        selectedFrame = catalog[nearestIndex];
        if (nearestIndex !== lastFrameIndex) {
          // console.log(`Advancing to frame ${nearestIndex} at time ${new Date(selectedFrame.timeMs).toISOString()}`);
          updateSliderFromTime(newTimeMs);
          render();
          lastFrameTime = now;
        }
        lastFrameIndex = nearestIndex;
      }
    }
    else {
      lastFrameTime = now;
    }
    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

function stopPlayback(): void {
  playing = false;
  playButton.innerHTML = "&#9654;";
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  render();
}

function findNearestFrameIndex(timeMs: number): number {
  let best = 0;
  let bestDiff = Math.abs(catalog[0].timeMs - timeMs);
  for (let i = 1; i < catalog.length; i += 1) {
    const diff = Math.abs(catalog[i].timeMs - timeMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

playButton.addEventListener("click", () => {
  if (playing) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

speedSelect.addEventListener("change", () => {
  playbackRate = Number(speedSelect.value);
  if (playing) {
    lastFrameTime = null;
    render();
  }
});

frameInput.addEventListener("input", () => {
  selectedFrame = catalog[Number(frameInput.value)];
  render();
});

render();
