import type { SequenceTileCache } from "./sequence-tile-cache.js";

/**
 * Snapshot of tile state consumed by {@link renderTileDiagnostics}.
 *
 * The snapshot bundles the shared cache, visible tile coordinates,
 * the catalog, and a playhead position so that the diagnostic canvas
 * can render a complete temporal minimap.
 */
export type TileDiagSnapshot = {
  tileCache: SequenceTileCache;
  visibleTiles: { x: number; y: number; z: number }[];
  frameIds: string[];
  allFrameIds: string[];
  playheadIndex: number;
  maxZoom: number;
  tileGrid: Record<number, { maxX: number; maxY: number }>;
};

const COLORS = {
  cachedFull: "#4ade80",
  cachedPreview: "#60a5fa",
  visible: "#facc15",
  missing: "#ef4444",
  empty: "#1a1a2e",
  gridLine: "#2a2a4e",
  frameLabel: "#8888aa",
  zoomLabel: "#8888aa",
  playhead: "#f472b6",
  bg: "#0f0f1a",
};

/**
 * Render a tile-state minimap onto an HTML canvas.
 *
 * **Axes:**
 * - **X axis** = time (frame columns from the catalog window).
 * - **Y axis** = zoom level (coarsest at bottom, finest at top).
 * - **Color**  = per-tile state (green = cached full, blue = cached
 *   preview, red = visible-but-loading, dark = not loaded).
 *
 * A pink playhead line marks the current display frame.  Frame index
 * labels are shown every ~10 columns.  A legend and summary text
 * (`past: N cached | future: N prefetched`) answer the two key
 * operational questions: how far ahead are we, and how far back do we
 * retain.
 */
export function renderTileDiagnostics(
  canvas: HTMLCanvasElement,
  state: TileDiagSnapshot,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width * dpr;
  const h = rect.height * dpr;

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  const frameIds = state.frameIds;
  const maxZoom = state.maxZoom || 2;
  const zoomLevels: number[] = [];

  for (let z = 0; z <= maxZoom; z += 1) {
    zoomLevels.push(z);
  }

  if (frameIds.length === 0) {
    return;
  }

  const marginLeft = 28 * dpr;
  const marginTop = 18 * dpr;
  const marginRight = 4 * dpr;
  const marginBottom = 22 * dpr;

  const gridW = w - marginLeft - marginRight;
  const gridH = h - marginTop - marginBottom;

  const colW = Math.max(1 * dpr, gridW / frameIds.length);
  const rowH = gridH / zoomLevels.length;

  ctx.font = `${9 * dpr}px monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let row = 0; row < zoomLevels.length; row += 1) {
    const z = zoomLevels[row] ?? 0;
    const y = marginTop + (zoomLevels.length - 1 - row) * rowH + rowH / 2;

    ctx.fillStyle = COLORS.zoomLabel;
    ctx.fillText(`z${z}`, marginLeft - 6 * dpr, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let col = 0; col < frameIds.length; col += 1) {
    const tileKey = frameIds[col] ?? "";
    const displayIdx = state.allFrameIds.indexOf(tileKey);
    const labelInterval = Math.max(1, Math.floor(frameIds.length / 10));

    if (col % labelInterval === 0 || col === frameIds.length - 1 || col === state.playheadIndex) {
      const x = marginLeft + col * colW + colW / 2;

      ctx.fillStyle = COLORS.frameLabel;
      ctx.fillText(`${displayIdx}`, x, marginTop - 14 * dpr);
    }
  }

  for (let row = 0; row < zoomLevels.length; row += 1) {
    const z = zoomLevels[row] ?? 0;
    const grid = state.tileGrid[z] ?? { maxX: 0, maxY: 0 };
    const cols = Math.max(1, grid.maxX + 1);
    const rows = Math.max(1, grid.maxY + 1);

    for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
      const frameId = frameIds[frameIdx] ?? "";

      for (let ty = 0; ty < rows; ty += 1) {
        for (let tx = 0; tx < cols; tx += 1) {
          const cached = state.tileCache.get(frameId, tx, ty, z);
          const visible = state.visibleTiles.some(
            (v) => v.x === tx && v.y === ty && v.z === z,
          );

          let color = COLORS.empty;

          if (cached) {
            color =
              cached.quality === "full"
                ? COLORS.cachedFull
                : COLORS.cachedPreview;
          } else if (visible) {
            color = COLORS.missing;
          }

          const cellX =
            marginLeft +
            frameIdx * colW +
            (tx / cols) * colW +
            0.5 * dpr;
          const cellW = Math.max(0.3 * dpr, (colW / cols) - 1 * dpr);
          const cellY =
            marginTop +
            (zoomLevels.length - 1 - row) * rowH +
            (ty / rows) * rowH +
            0.5 * dpr;
          const cellH = Math.max(0.3 * dpr, (rowH / rows) - 1 * dpr);

          ctx.fillStyle = color;
          ctx.fillRect(cellX, cellY, cellW, cellH);
        }
      }
    }
  }

  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 0.5 * dpr;

  for (let row = 0; row <= zoomLevels.length; row += 1) {
    const y = marginTop + row * rowH;

    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(w - marginRight, y);
    ctx.stroke();
  }

  const playheadX = marginLeft + state.playheadIndex * colW + colW / 2;

  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 1.5 * dpr;

  ctx.beginPath();
  ctx.moveTo(playheadX, marginTop);
  ctx.lineTo(playheadX, h - marginBottom);
  ctx.stroke();

  ctx.fillStyle = COLORS.playhead;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  ctx.beginPath();
  ctx.moveTo(playheadX - 5 * dpr, marginTop - 4 * dpr);
  ctx.lineTo(playheadX + 5 * dpr, marginTop - 4 * dpr);
  ctx.lineTo(playheadX, marginTop - 8 * dpr);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  const legendX = w - 120 * dpr;
  const legendY = h - marginBottom - 46 * dpr;

  ctx.font = `${8 * dpr}px monospace`;

  const items = [
    { color: COLORS.cachedFull, label: "cached full" },
    { color: COLORS.cachedPreview, label: "cached preview" },
    { color: COLORS.missing, label: "visible, loading" },
    { color: COLORS.empty, label: "not loaded" },
  ];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const ix = legendX + (i % 2) * 70 * dpr;
    const iy = legendY + Math.floor(i / 2) * 14 * dpr;

    ctx.fillStyle = item.color;
    ctx.fillRect(ix, iy, 10 * dpr, 8 * dpr);
    ctx.fillStyle = COLORS.frameLabel;
    ctx.fillText(item.label, ix + 14 * dpr, iy + 1 * dpr);
  }

  ctx.fillStyle = COLORS.frameLabel;

  const indicatorText =
    `${state.allFrameIds.length} frames | ` +
    `playhead: ${state.allFrameIds[state.allFrameIds.indexOf(state.frameIds[state.playheadIndex] ?? "")] ?? "?"}`;

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(indicatorText, marginLeft, h - 4 * dpr);

  const cachedFrames = buildCachedFrameSet(state);
  const pastCached = countCachedBefore(state, state.playheadIndex, cachedFrames);
  const futureCached = countCachedAfter(state, state.playheadIndex, cachedFrames);

  ctx.fillText(
    `past: ${pastCached} cached | future: ${futureCached} prefetched`,
    marginLeft + 200 * dpr,
    h - 4 * dpr,
  );
}

function buildCachedFrameSet(state: TileDiagSnapshot): Set<string> {
  const set = new Set<string>();

  for (const [, tile] of state.tileCache.entries()) {
    set.add(tile.frameId);
  }

  return set;
}

function countCachedBefore(
  state: TileDiagSnapshot,
  playheadIndex: number,
  cachedFrames: Set<string>,
): number {
  let count = 0;

  for (let i = playheadIndex - 1; i >= 0; i -= 1) {
    const frameId = state.frameIds[i];

    if (!frameId) {
      break;
    }

    if (cachedFrames.has(frameId)) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

function countCachedAfter(
  state: TileDiagSnapshot,
  playheadIndex: number,
  cachedFrames: Set<string>,
): number {
  let count = 0;

  for (let i = playheadIndex + 1; i < state.frameIds.length; i += 1) {
    const frameId = state.frameIds[i];

    if (!frameId) {
      break;
    }

    if (cachedFrames.has(frameId)) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}
