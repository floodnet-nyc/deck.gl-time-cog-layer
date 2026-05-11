import type { TileOrigin, TileQuality } from "../sequence-tile-cache.js";

export type TileDiagCellState = {
  quality: TileQuality;
  origin: TileOrigin;
  wasDisplayed: boolean;
};

/**
 * Snapshot of tile state consumed by {@link renderTileDiagnostics}.
 *
 * The snapshot is intentionally detached from the live cache so that
 * diagnostics can evolve independently of the operational code path.
 */
export type TileDiagSnapshot = {
  frameIds: string[];
  allFrameIds: string[];
  playheadIndex: number;
  zoomLevels: number[];
  tileGrid: Record<number, { cols: number; rows: number }>;
  tileStates: Record<string, TileDiagCellState>;
  prefetchedUnusedResidentCount: number;
  prefetchedUnusedResidentBytes: number;
  prefetchedWastedCount: number;
  prefetchedWastedBytes: number;
  prefetchedUsedCount: number;
  prefetchedLoadedCount: number;
  abortedTasks: number;
  scheduledFrameIds: Set<string>;
  inFlightKeys: Set<string>;
};

const COLORS = {
  shownFull: "#4ade80",
  shownPreview: "#60a5fa",
  prefetchedUnusedFull: "#f59e0b",
  prefetchedUnusedPreview: "#3b82f6",
  loading: "#ec4899",
  unscheduled: "#475569",
  scheduledEmpty: "#1c2036",
  empty: "#121525",
  bandFill: "#171a2c",
  bandOutline: "#2a2a4e",
  frameLine: "#232943",
  frameLabel: "#8888aa",
  zoomLabel: "#b4b6d9",
  playhead: "#f472b6",
  bg: "#0f0f1a",
} as const;

const MIN_COL_WIDTH = 6;
const MIN_BAND_HEIGHT = 28;
const BAND_GAP = 10;
const FOOTER_LINES = 3;
const FOOTER_LINE_HEIGHT = 12;
const DETAIL_HEIGHT = 42;
const DETAIL_GAP = 8;
const DETAIL_MIN_COL_WIDTH = 8;

type DiagnosticCanvasState = HTMLCanvasElement & {
  __timeCogHoverRatio?: number;
  __timeCogBound?: boolean;
  __timeCogLastSnapshot?: TileDiagSnapshot;
  __timeCogHoverActive?: boolean;
};

function tileKey(frameId: string, x: number, y: number, z: number): string {
  return `${frameId}:${x}:${y}:${z}`;
}

function colorForTile(state: TileDiagCellState | undefined): string {
  if (!state) {
    return COLORS.scheduledEmpty;
  }

  const prefetchedUnused = state.origin === "prefetch" && !state.wasDisplayed;

  if (state.quality === "full") {
    return prefetchedUnused ? COLORS.prefetchedUnusedFull : COLORS.shownFull;
  }

  return prefetchedUnused ? COLORS.prefetchedUnusedPreview : COLORS.shownPreview;
}

type AggregatedCellState =
  | { kind: "cached"; state: TileDiagCellState }
  | { kind: "loading" }
  | { kind: "unscheduled" }
  | { kind: "scheduled-empty" };

type TimeBin = {
  start: number;
  end: number;
  frameIds: string[];
};

function buildTimeBins(frameIds: string[], maxBins: number): TimeBin[] {
  if (frameIds.length === 0) {
    return [];
  }

  if (frameIds.length <= maxBins) {
    return frameIds.map((frameId, index) => ({
      start: index,
      end: index + 1,
      frameIds: [frameId],
    }));
  }

  const bins: TimeBin[] = [];

  for (let index = 0; index < maxBins; index += 1) {
    const start = Math.floor((index * frameIds.length) / maxBins);
    const end = Math.floor(((index + 1) * frameIds.length) / maxBins);
    const slice = frameIds.slice(start, Math.max(start + 1, end));

    bins.push({
      start,
      end: Math.max(start + 1, end),
      frameIds: slice,
    });
  }

  return bins.filter((bin) => bin.frameIds.length > 0);
}

function priorityForState(state: TileDiagCellState): number {
  if (state.origin === "prefetch" && !state.wasDisplayed && state.quality === "full") {
    return 5;
  }

  if (state.quality === "full") {
    return 4;
  }

  if (state.origin === "prefetch" && !state.wasDisplayed) {
    return 3;
  }

  return 2;
}

function aggregateCellState(
  bin: TimeBin,
  z: number,
  tx: number,
  ty: number,
  state: TileDiagSnapshot,
): AggregatedCellState {
  let bestCached: TileDiagCellState | undefined;
  let bestPriority = Number.NEGATIVE_INFINITY;
  let hasLoading = false;
  let hasScheduled = false;

  for (const frameId of bin.frameIds) {
    const cached = state.tileStates[tileKey(frameId, tx, ty, z)];

    if (cached) {
      const priority = priorityForState(cached);

      if (priority > bestPriority) {
        bestCached = cached;
        bestPriority = priority;
      }

      hasScheduled = true;
      continue;
    }

    const key = tileKey(frameId, tx, ty, z);

    if (state.inFlightKeys.has(key)) {
      hasLoading = true;
      hasScheduled = true;
      continue;
    }

    if (state.scheduledFrameIds.has(frameId)) {
      hasScheduled = true;
    }
  }

  if (bestCached) {
    return { kind: "cached", state: bestCached };
  }

  if (hasLoading) {
    return { kind: "loading" };
  }

  if (hasScheduled) {
    return { kind: "scheduled-empty" };
  }

  return { kind: "unscheduled" };
}

function colorForAggregatedState(state: AggregatedCellState): string {
  if (state.kind === "cached") {
    return colorForTile(state.state);
  }

  if (state.kind === "loading") {
    return COLORS.loading;
  }

  if (state.kind === "unscheduled") {
    return COLORS.unscheduled;
  }

  return COLORS.scheduledEmpty;
}

function summarizePlayhead(frameId: string | undefined, playheadIndex: number): string {
  if (!frameId) {
    return `#${playheadIndex}`;
  }

  const tail = frameId.split("/").at(-1) ?? frameId;
  const shortened = tail.length > 32 ? `...${tail.slice(-29)}` : tail;
  return `#${playheadIndex} ${shortened}`;
}

function computeBandHeights(
  zoomLevels: number[],
  tileGrid: Record<number, { cols: number; rows: number }>,
  gridHeight: number,
  dpr: number,
): number[] {
  const desired = zoomLevels.map((z) => {
    const rows = Math.max(1, tileGrid[z]?.rows ?? 1);
    return Math.max(MIN_BAND_HEIGHT * dpr, rows * 8 * dpr + 8 * dpr);
  });

  const gapTotal = Math.max(0, zoomLevels.length - 1) * BAND_GAP * dpr;
  const desiredTotal = desired.reduce((sum, value) => sum + value, 0) + gapTotal;
  const scale = desiredTotal > gridHeight ? gridHeight / desiredTotal : 1;

  return desired.map((value) => value * scale);
}

/**
 * Render a temporal diagnostic map onto an HTML canvas.
 *
 * Primary axes:
 * - X = time across the full catalog slice.
 * - Y = zoom level bands.
 *
 * Within each `(time, zoom)` cell, x/y tile coordinates are packed as a
 * mini-grid so the primary axes remain temporal and zoom-oriented.
 */
export function renderTileDiagnostics(
  canvas: HTMLCanvasElement,
  state: TileDiagSnapshot,
): void {
  const interactiveCanvas = canvas as DiagnosticCanvasState;
  interactiveCanvas.__timeCogLastSnapshot = state;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width * dpr;
  const h = rect.height * dpr;

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");

  if (!ctx || state.frameIds.length === 0) {
    return;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  const marginLeft = 42 * dpr;
  const marginTop = (22 + DETAIL_HEIGHT + DETAIL_GAP) * dpr;
  const marginRight = 8 * dpr;
  const marginBottom = (FOOTER_LINES * FOOTER_LINE_HEIGHT + 8) * dpr;

  const gridW = w - marginLeft - marginRight;
  const gridH = h - marginTop - marginBottom;
  const maxBins = Math.max(1, Math.floor(gridW / (MIN_COL_WIDTH * dpr)));
  const bins = buildTimeBins(state.frameIds, maxBins);
  const colW = gridW / bins.length;
  const bandHeights = computeBandHeights(state.zoomLevels, state.tileGrid, gridH, dpr);
  const bandGap = BAND_GAP * dpr;
  const playheadBinIndex = bins.findIndex(
    (bin) => state.playheadIndex >= bin.start && state.playheadIndex < bin.end,
  );

  ensureCanvasInteractivity(interactiveCanvas, marginLeft / dpr, marginRight / dpr);

  ctx.font = `${9 * dpr}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const labelInterval = Math.max(1, Math.floor(bins.length / 12));

  for (let col = 0; col < bins.length; col += 1) {
    if (col % labelInterval !== 0 && col !== playheadBinIndex && col !== bins.length - 1) {
      continue;
    }

    const displayIdx = bins[col]?.start ?? 0;
    const x = marginLeft + col * colW + colW / 2;
    ctx.fillStyle = COLORS.frameLabel;
    ctx.fillText(String(displayIdx), x, 4 * dpr);
  }

  renderDetailTimeline(
    ctx,
    state,
    interactiveCanvas.__timeCogHoverActive
      ? (interactiveCanvas.__timeCogHoverRatio ?? 1)
      : playheadRatio(state),
    marginLeft,
    18 * dpr,
    gridW,
    DETAIL_HEIGHT * dpr,
    dpr,
  );

  let bandTop = marginTop;

  for (let bandIndex = state.zoomLevels.length - 1; bandIndex >= 0; bandIndex -= 1) {
    const z = state.zoomLevels[bandIndex] ?? 0;
    const bandHeight = bandHeights[bandIndex] ?? MIN_BAND_HEIGHT * dpr;
    const bandBottom = bandTop + bandHeight;
    const grid = state.tileGrid[z] ?? { cols: 1, rows: 1 };
    const cols = Math.max(1, grid.cols);
    const rows = Math.max(1, grid.rows);
    const innerTop = bandTop + 4 * dpr;
    const innerBottom = bandBottom - 4 * dpr;
    const innerHeight = Math.max(1, innerBottom - innerTop);

    ctx.fillStyle = COLORS.bandFill;
    ctx.fillRect(marginLeft, bandTop, gridW, bandHeight);
    ctx.strokeStyle = COLORS.bandOutline;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(marginLeft, bandTop, gridW, bandHeight);

    ctx.fillStyle = COLORS.zoomLabel;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`z${z}`, marginLeft - 8 * dpr, bandTop + bandHeight / 2);

    for (let frameIdx = 0; frameIdx < bins.length; frameIdx += 1) {
      const bin = bins[frameIdx];

      if (!bin) {
        continue;
      }

      const frameX = marginLeft + frameIdx * colW;

      ctx.strokeStyle = COLORS.frameLine;
      ctx.lineWidth = 0.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(frameX, bandTop);
      ctx.lineTo(frameX, bandBottom);
      ctx.stroke();

      const tileW = colW / cols;
      const tileH = innerHeight / rows;

      for (let ty = 0; ty < rows; ty += 1) {
        for (let tx = 0; tx < cols; tx += 1) {
          const color = colorForAggregatedState(
            aggregateCellState(bin, z, tx, ty, state),
          );

          const x = frameX + tx * tileW + 0.5 * dpr;
          const y = innerTop + ty * tileH + 0.5 * dpr;
          const width = Math.max(0.6 * dpr, tileW - 1 * dpr);
          const height = Math.max(0.6 * dpr, tileH - 1 * dpr);

          ctx.fillStyle = color;
          ctx.fillRect(x, y, width, height);
        }
      }
    }

    bandTop = bandBottom + bandGap;
  }

  const playheadX = marginLeft + Math.max(0, playheadBinIndex) * colW + colW / 2;
  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(playheadX, marginTop);
  ctx.lineTo(playheadX, marginTop + bandHeights.reduce((sum, value) => sum + value, 0) + Math.max(0, state.zoomLevels.length - 1) * bandGap);
  ctx.stroke();

  ctx.fillStyle = COLORS.playhead;
  ctx.beginPath();
  ctx.moveTo(playheadX - 5 * dpr, marginTop - 4 * dpr);
  ctx.lineTo(playheadX + 5 * dpr, marginTop - 4 * dpr);
  ctx.lineTo(playheadX, marginTop - 8 * dpr);
  ctx.closePath();
  ctx.fill();

  renderLegend(ctx, w, h, dpr);
  renderFooter(ctx, state, bins.length, marginLeft, h, dpr);
}

function ensureCanvasInteractivity(
  canvas: DiagnosticCanvasState,
  marginLeftPx: number,
  marginRightPx: number,
): void {
  if (canvas.__timeCogBound) {
    return;
  }

  const updateHover = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const usableLeft = marginLeftPx;
    const usableRight = rect.width - marginRightPx;
    const x = Math.min(Math.max(event.clientX - rect.left, usableLeft), usableRight);
    const width = Math.max(1, usableRight - usableLeft);
    canvas.__timeCogHoverRatio = (x - usableLeft) / width;
    canvas.__timeCogHoverActive = true;
    if (canvas.__timeCogLastSnapshot) {
      renderTileDiagnostics(canvas, canvas.__timeCogLastSnapshot);
    }
  };

  canvas.addEventListener("mousemove", updateHover);
  canvas.addEventListener("mouseenter", updateHover);
  canvas.addEventListener("mouseleave", () => {
    canvas.__timeCogHoverActive = false;
    if (canvas.__timeCogLastSnapshot) {
      renderTileDiagnostics(canvas, canvas.__timeCogLastSnapshot);
    }
  });
  canvas.__timeCogBound = true;
}

function playheadRatio(state: TileDiagSnapshot): number {
  if (state.allFrameIds.length <= 1) {
    return 0;
  }

  return state.playheadIndex / (state.allFrameIds.length - 1);
}

function renderDetailTimeline(
  ctx: CanvasRenderingContext2D,
  state: TileDiagSnapshot,
  hoverRatio: number,
  marginLeft: number,
  top: number,
  width: number,
  height: number,
  dpr: number,
): void {
  const maxDetailFrames = Math.max(1, Math.floor(width / (DETAIL_MIN_COL_WIDTH * dpr)));
  const halfWindow = Math.floor(maxDetailFrames / 2);
  const hoverIndex = Math.min(
    state.allFrameIds.length - 1,
    Math.max(0, Math.floor(hoverRatio * Math.max(0, state.allFrameIds.length - 1))),
  );
  const start = Math.max(0, Math.min(state.allFrameIds.length - maxDetailFrames, hoverIndex - halfWindow));
  const end = Math.min(state.allFrameIds.length, start + maxDetailFrames);
  const frameIds = state.allFrameIds.slice(start, end);
  const zoomLevels = state.zoomLevels.length > 0 ? state.zoomLevels : [0];
  const colW = width / Math.max(1, frameIds.length);
  const rowH = height / Math.max(1, zoomLevels.length);

  ctx.fillStyle = COLORS.bandFill;
  ctx.fillRect(marginLeft, top, width, height);
  ctx.strokeStyle = COLORS.bandOutline;
  ctx.lineWidth = 1 * dpr;
  ctx.strokeRect(marginLeft, top, width, height);

  ctx.font = `${8 * dpr}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = COLORS.frameLabel;
  ctx.fillText(`detail`, marginLeft, top - 2 * dpr);

  for (let rowIndex = zoomLevels.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const z = zoomLevels[rowIndex] ?? 0;
    const rowTop = top + (zoomLevels.length - 1 - rowIndex) * rowH;
    const grid = state.tileGrid[z] ?? { cols: 1, rows: 1 };
    const tileW = colW / Math.max(1, grid.cols);
    const tileH = rowH / Math.max(1, grid.rows);

    for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
      const frameId = frameIds[frameIdx] ?? "";
      const frameX = marginLeft + frameIdx * colW;

      for (let ty = 0; ty < Math.max(1, grid.rows); ty += 1) {
        for (let tx = 0; tx < Math.max(1, grid.cols); tx += 1) {
          const key = tileKey(frameId, tx, ty, z);
          const cached = state.tileStates[key];

          let color = cached
            ? colorForTile(cached)
            : state.inFlightKeys.has(key)
              ? COLORS.loading
              : state.scheduledFrameIds.has(frameId)
                ? COLORS.scheduledEmpty
                : COLORS.unscheduled;

          const x = frameX + tx * tileW + 0.5 * dpr;
          const y = rowTop + ty * tileH + 0.5 * dpr;
          const w = Math.max(0.6 * dpr, tileW - 1 * dpr);
          const h = Math.max(0.6 * dpr, tileH - 1 * dpr);

          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        }
      }
    }
  }

  const hoverFrameX = marginLeft + (hoverIndex - start + 0.5) * colW;
  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(hoverFrameX, top);
  ctx.lineTo(hoverFrameX, top + height);
  ctx.stroke();

  const labelInterval = Math.max(1, Math.floor(frameIds.length / 8));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
    if (frameIdx % labelInterval !== 0 && frameIdx !== hoverIndex - start && frameIdx !== frameIds.length - 1) {
      continue;
    }

    const x = marginLeft + frameIdx * colW + colW / 2;
    ctx.fillStyle = COLORS.frameLabel;
    ctx.fillText(String(start + frameIdx), x, top + height + 2 * dpr);
  }
}

function renderLegend(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): void {
  const items = [
    { color: COLORS.shownFull, label: "shown full" },
    { color: COLORS.prefetchedUnusedFull, label: "unused prefetch full" },
    { color: COLORS.shownPreview, label: "shown preview" },
    { color: COLORS.prefetchedUnusedPreview, label: "unused prefetch preview" },
    { color: COLORS.loading, label: "loading" },
    { color: COLORS.unscheduled, label: "unscheduled" },
    { color: COLORS.scheduledEmpty, label: "scheduled empty" },
  ];

  const legendX = width - 190 * dpr;
  const legendY = height - 38 * dpr;

  ctx.font = `${8 * dpr}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  items.forEach((item, index) => {
    const x = legendX + (index % 2) * 96 * dpr;
    const y = legendY + Math.floor(index / 2) * 12 * dpr;
    ctx.fillStyle = item.color;
    ctx.fillRect(x, y + 1 * dpr, 8 * dpr, 8 * dpr);
    ctx.fillStyle = COLORS.frameLabel;
    ctx.fillText(item.label, x + 12 * dpr, y);
  });
}

function renderFooter(
  ctx: CanvasRenderingContext2D,
  state: TileDiagSnapshot,
  binCount: number,
  marginLeft: number,
  height: number,
  dpr: number,
): void {
  const wastedKb = Math.round(state.prefetchedWastedBytes / 1024);
  const unusedKb = Math.round(state.prefetchedUnusedResidentBytes / 1024);
  const loaded = state.prefetchedLoadedCount;
  const used = state.prefetchedUsedCount;
  const wasted = state.prefetchedWastedCount;
  const useRate = loaded > 0 ? Math.round((used / loaded) * 100) : 0;
  const wasteRate = loaded > 0 ? Math.round((wasted / loaded) * 100) : 0;
  const playheadLabel = summarizePlayhead(
    state.allFrameIds[state.playheadIndex],
    state.playheadIndex,
  );

  ctx.font = `${8 * dpr}px monospace`;
  ctx.fillStyle = COLORS.frameLabel;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  ctx.fillText(
    `${state.allFrameIds.length} frames -> ${binCount} bins | playhead: ${playheadLabel}`,
    marginLeft,
    height - 4 * dpr,
  );

  ctx.fillText(
    `prefetch loaded: ${loaded} | used: ${used} (${useRate}%) | wasted: ${wasted} (${wasteRate}%)`,
    marginLeft,
    height - 16 * dpr,
  );

  ctx.fillText(
    `unused resident: ${state.prefetchedUnusedResidentCount} (${unusedKb} kB) | wasted: ${wastedKb} kB | aborted: ${state.abortedTasks}`,
    marginLeft,
    height - 28 * dpr,
  );
}
