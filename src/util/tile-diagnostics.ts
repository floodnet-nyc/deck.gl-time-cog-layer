import type { SequenceTileCache, TileOrigin, TileQuality } from "../sequence-tile-cache.js";
import type { FramePrefetcher } from "../frame-prefetcher.js";
import type { NormalizedTimeCOGFrame } from "../types.js";

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
  visibleTiles: { x: number; y: number; z: number }[];
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
const BAND_GAP = 16;
const FOOTER_LINES = 4;
const FOOTER_LINE_HEIGHT = 12;
const DETAIL_HEIGHT = 42;
const DETAIL_GAP = 8;
const DETAIL_MIN_COL_WIDTH = 14;
const OVERVIEW_CELL_GAP = 1;
const OVERVIEW_BAND_PADDING = 6;

type DiagnosticCanvasState = HTMLCanvasElement & {
  __timeCogHoverRatio?: number;
  __timeCogBound?: boolean;
  __timeCogLastSnapshot?: TileDiagSnapshot;
  __timeCogHoverActive?: boolean;
  __timeCogPointerX?: number;
  __timeCogPointerY?: number;
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

function formatBinLabel(bin: TimeBin): string {
  if (bin.end <= bin.start + 1) {
    return String(bin.start);
  }

  return `${bin.start}-${bin.end - 1}`;
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

type FocusedTile = {
  frameIndex: number;
  frameId: string;
  z: number;
  x: number;
  y: number;
  cached?: TileDiagCellState;
  inFlight: boolean;
  scheduled: boolean;
};

function computeBandHeights(
  zoomLevels: number[],
  gridHeight: number,
  dpr: number,
): number[] {
  const desired = zoomLevels.map(() => MIN_BAND_HEIGHT * dpr);

  const gapTotal = Math.max(0, zoomLevels.length - 1) * BAND_GAP * dpr;
  const desiredTotal = desired.reduce((sum, value) => sum + value, 0) + gapTotal;
  const scale = desiredTotal > gridHeight ? gridHeight / desiredTotal : 1;

  return desired.map((value) => value * scale);
}

function tileSlotsForZoom(
  z: number,
  visibleTiles: { x: number; y: number; z: number }[],
  tileGrid: Record<number, { cols: number; rows: number }>,
): Array<{ x: number; y: number }> {
  const visible = visibleTiles
    .filter((tile) => tile.z === z)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ x, y }) => ({ x, y }));

  if (visible.length > 0) {
    return visible;
  }

  const grid = tileGrid[z] ?? { cols: 1, rows: 1 };
  const slots: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < Math.max(1, grid.rows); y += 1) {
    for (let x = 0; x < Math.max(1, grid.cols); x += 1) {
      slots.push({ x, y });
    }
  }

  return slots;
}

function cellStateForFrame(
  frameId: string,
  z: number,
  tx: number,
  ty: number,
  state: TileDiagSnapshot,
): AggregatedCellState {
  const cached = state.tileStates[tileKey(frameId, tx, ty, z)];

  if (cached) {
    return { kind: "cached", state: cached };
  }

  if (state.inFlightKeys.has(tileKey(frameId, tx, ty, z))) {
    return { kind: "loading" };
  }

  if (state.scheduledFrameIds.has(frameId)) {
    return { kind: "scheduled-empty" };
  }

  return { kind: "unscheduled" };
}

function renderStackedCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: string[],
  dpr: number,
): void {
  if (colors.length === 0) {
    return;
  }

  const segmentHeight = height / colors.length;

  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index];

    if (!color) {
      continue;
    }

    const segmentY = y + index * segmentHeight;
    const segmentH = Math.max(0.6 * dpr, segmentHeight - OVERVIEW_CELL_GAP * dpr);

    ctx.fillStyle = color;
    ctx.fillRect(x, segmentY, width, segmentH);
  }
}

/**
 * Build a detached diagnostic snapshot of the tile cache state for
 * the minimap renderer.
 */
export function buildTileDiagSnapshot(
  tileCache: SequenceTileCache,
  prefetcher: FramePrefetcher,
  catalog: readonly NormalizedTimeCOGFrame[],
  displayFrame: NormalizedTimeCOGFrame | null,
  visibleTiles: readonly { x: number; y: number; z: number }[],
  scheduledFrames: readonly NormalizedTimeCOGFrame[],
  windowSize?: number,
): TileDiagSnapshot {
  const empty: TileDiagSnapshot = {
    frameIds: [],
    allFrameIds: [],
    playheadIndex: 0,
    zoomLevels: [],
    visibleTiles: [],
    tileGrid: {},
    tileStates: {},
    prefetchedUnusedResidentCount: 0,
    prefetchedUnusedResidentBytes: 0,
    prefetchedWastedCount: 0,
    prefetchedWastedBytes: 0,
    prefetchedUsedCount: 0,
    prefetchedLoadedCount: 0,
    abortedTasks: 0,
    scheduledFrameIds: new Set<string>(),
    inFlightKeys: new Set<string>(),
  };

  if (!tileCache) {
    return empty;
  }

  const tileStats = tileCache.stats();
  const prefetchStats = prefetcher.stats();

  const tileGrid: Record<number, { cols: number; rows: number }> = {};
  const tileStates: TileDiagSnapshot["tileStates"] = {};
  const tiles = visibleTiles ?? [];

  for (const v of tiles) {
    if (!tileGrid[v.z]) {
      tileGrid[v.z] = { cols: v.x + 1, rows: v.y + 1 };
    } else {
      tileGrid[v.z]!.cols = Math.max(tileGrid[v.z]!.cols, v.x + 1);
      tileGrid[v.z]!.rows = Math.max(tileGrid[v.z]!.rows, v.y + 1);
    }
  }

  for (const [, tile] of tileCache.entries()) {
    tileStates[`${tile.frameId}:${tile.x}:${tile.y}:${tile.z}`] = {
      quality: tile.quality,
      origin: tile.origin,
      wasDisplayed: tile.wasDisplayed,
    };

    if (!tileGrid[tile.z]) {
      tileGrid[tile.z] = { cols: tile.x + 1, rows: tile.y + 1 };
    } else if (tiles.length === 0) {
      tileGrid[tile.z]!.cols = Math.max(tileGrid[tile.z]!.cols, tile.x + 1);
      tileGrid[tile.z]!.rows = Math.max(tileGrid[tile.z]!.rows, tile.y + 1);
    }
  }

  const allFrameIds = catalog.map((f) => f.id);
  const displayId = displayFrame?.id;
  const playheadInCatalog = displayId
    ? allFrameIds.indexOf(displayId)
    : 0;
  const hasWindow = typeof windowSize === "number" && windowSize > 0;
  const halfWindow = hasWindow ? Math.floor(windowSize / 2) : 0;
  const winStart = hasWindow
    ? Math.max(0, playheadInCatalog - halfWindow)
    : 0;
  const winEnd = hasWindow
    ? Math.min(allFrameIds.length, winStart + windowSize)
    : allFrameIds.length;
  const frameIds = allFrameIds.slice(winStart, winEnd);
  const playheadIndex = Math.max(0, playheadInCatalog - winStart);
  const zoomLevels = Object.keys(tileGrid)
    .map(Number)
    .sort((a, b) => a - b);

  return {
    frameIds,
    allFrameIds,
    playheadIndex,
    zoomLevels,
    visibleTiles: [...tiles],
    tileGrid,
    tileStates,
    prefetchedUnusedResidentCount: tileStats.prefetchedUnusedResidentCount,
    prefetchedUnusedResidentBytes: tileStats.prefetchedUnusedResidentBytes,
    prefetchedWastedCount: tileStats.prefetchedWastedCount,
    prefetchedWastedBytes: tileStats.prefetchedWastedBytes,
    prefetchedUsedCount: tileStats.prefetchedUsedCount,
    prefetchedLoadedCount: tileStats.prefetchedLoadedCount,
    abortedTasks: prefetchStats.totalAborted,
    scheduledFrameIds: new Set(scheduledFrames.map((f) => f.id)),
    inFlightKeys: new Set(prefetcher.getInFlightKeys()),
  };
}

/**
 * Render a temporal diagnostic map onto an HTML canvas.
 *
 * Primary axes:
 * - X = time across the full catalog slice.
 * - Y = zoom level bands.
 *
 * Within each `(time, zoom)` cell, tile coordinates are packed into a
 * vertical strip so the primary axes remain temporal and zoom-oriented.
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
  const bandHeights = computeBandHeights(state.zoomLevels, gridH, dpr);
  const bandGap = BAND_GAP * dpr;
  const playheadBinIndex = bins.findIndex(
    (bin) => state.playheadIndex >= bin.start && state.playheadIndex < bin.end,
  );

  ensureCanvasInteractivity(interactiveCanvas, marginLeft / dpr, marginRight / dpr);

  ctx.font = `${9 * dpr}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const labelInterval = Math.max(1, Math.floor(bins.length / 10));

  renderDetailTimeline(
    ctx,
    interactiveCanvas,
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

  for (let col = 0; col < bins.length; col += 1) {
    if (col % labelInterval !== 0 && col !== playheadBinIndex && col !== bins.length - 1) {
      continue;
    }

    const bin = bins[col];

    if (!bin) {
      continue;
    }

    const x = marginLeft + col * colW + colW / 2;
    ctx.fillStyle = COLORS.frameLabel;
    ctx.fillText(formatBinLabel(bin), x, marginTop - 14 * dpr);
  }

  let bandTop = marginTop;

  ctx.font = `${8 * dpr}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = COLORS.frameLabel;
  ctx.fillText(`overview (time bins)`, marginLeft, marginTop - 2 * dpr);

  for (let bandIndex = state.zoomLevels.length - 1; bandIndex >= 0; bandIndex -= 1) {
    const z = state.zoomLevels[bandIndex] ?? 0;
    const bandHeight = bandHeights[bandIndex] ?? MIN_BAND_HEIGHT * dpr;
    const bandBottom = bandTop + bandHeight;
    const slots = tileSlotsForZoom(z, state.visibleTiles, state.tileGrid);
    const innerTop = bandTop + OVERVIEW_BAND_PADDING * dpr;
    const innerBottom = bandBottom - OVERVIEW_BAND_PADDING * dpr;
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

      renderStackedCell(
        ctx,
        frameX + 0.5 * dpr,
        innerTop + 0.5 * dpr,
        Math.max(0.6 * dpr, colW - 1 * dpr),
        Math.max(0.6 * dpr, innerHeight - 1 * dpr),
        slots.map((slot) => colorForAggregatedState(
          aggregateCellState(bin, z, slot.x, slot.y, state),
        )),
        dpr,
      );
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
    canvas.__timeCogPointerX = event.clientX - rect.left;
    canvas.__timeCogPointerY = event.clientY - rect.top;
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
  canvas: DiagnosticCanvasState,
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
  const focusedTile = resolveFocusedTile(
    canvas,
    state,
    frameIds,
    start,
    zoomLevels,
    marginLeft / dpr,
    top / dpr,
    width / dpr,
    height / dpr,
  );

  ctx.fillStyle = COLORS.bandFill;
  ctx.fillRect(marginLeft, top, width, height);
  ctx.strokeStyle = COLORS.bandOutline;
  ctx.lineWidth = 1 * dpr;
  ctx.strokeRect(marginLeft, top, width, height);

  ctx.font = `${8 * dpr}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = COLORS.frameLabel;
  ctx.fillText(`detail (raw frames)`, marginLeft, top - 2 * dpr);
  if (focusedTile) {
    ctx.textAlign = "right";
    ctx.fillText(
      describeFocusedTile(focusedTile),
      marginLeft + width,
      top - 2 * dpr,
    );
  }

  for (let rowIndex = zoomLevels.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const z = zoomLevels[rowIndex] ?? 0;
    const rowTop = top + (zoomLevels.length - 1 - rowIndex) * rowH;
    const slots = tileSlotsForZoom(z, state.visibleTiles, state.tileGrid);
    const cellTop = rowTop + 0.5 * dpr;
    const cellHeight = Math.max(0.6 * dpr, rowH - 1 * dpr);

    for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
      const frameId = frameIds[frameIdx] ?? "";
      const frameX = marginLeft + frameIdx * colW;
      renderStackedCell(
        ctx,
        frameX + 0.5 * dpr,
        cellTop,
        Math.max(0.6 * dpr, colW - 1 * dpr),
        cellHeight,
        slots.map((slot) => colorForAggregatedState(
          cellStateForFrame(frameId, z, slot.x, slot.y, state),
        )),
        dpr,
      );
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
    ctx.fillText(String(start + frameIdx), x, 4 * dpr);
  }
}

function resolveFocusedTile(
  canvas: DiagnosticCanvasState,
  state: TileDiagSnapshot,
  frameIds: string[],
  start: number,
  zoomLevels: number[],
  leftPx: number,
  topPx: number,
  widthPx: number,
  heightPx: number,
): FocusedTile | null {
  if (frameIds.length === 0 || zoomLevels.length === 0) {
    return null;
  }

  if (
    canvas.__timeCogHoverActive &&
    typeof canvas.__timeCogPointerX === "number" &&
    typeof canvas.__timeCogPointerY === "number"
  ) {
    const xPx = canvas.__timeCogPointerX;
    const yPx = canvas.__timeCogPointerY;

    if (xPx >= leftPx && xPx <= leftPx + widthPx && yPx >= topPx && yPx <= topPx + heightPx) {
      const frameLocal = Math.min(
        frameIds.length - 1,
        Math.max(0, Math.floor(((xPx - leftPx) / Math.max(1, widthPx)) * frameIds.length)),
      );
      const zoomLocal = Math.min(
        zoomLevels.length - 1,
        Math.max(0, Math.floor(((yPx - topPx) / Math.max(1, heightPx)) * zoomLevels.length)),
      );
      const z = zoomLevels[zoomLevels.length - 1 - zoomLocal] ?? zoomLevels[0] ?? 0;
      const rowHeight = heightPx / zoomLevels.length;
      const slots = tileSlotsForZoom(z, state.visibleTiles, state.tileGrid);
      const slotLocal = Math.min(
        Math.max(1, slots.length) - 1,
        Math.max(
          0,
          Math.floor((((yPx - topPx) % Math.max(1, rowHeight)) / Math.max(1, rowHeight)) * Math.max(1, slots.length)),
        ),
      );
      const slot = slots[slotLocal] ?? { x: 0, y: 0 };
      const frameId = frameIds[frameLocal] ?? "";
      const key = tileKey(frameId, slot.x, slot.y, z);

      return {
        frameIndex: start + frameLocal,
        frameId,
        z,
        x: slot.x,
        y: slot.y,
        cached: state.tileStates[key],
        inFlight: state.inFlightKeys.has(key),
        scheduled: state.scheduledFrameIds.has(frameId),
      };
    }
  }

  const frameIndex = Math.min(frameIds.length - 1, Math.max(0, state.playheadIndex - start));
  const frameId = frameIds[frameIndex] ?? "";
  const visible = [...state.visibleTiles]
    .sort((a, b) => b.z - a.z)[0];
  const z = visible?.z ?? zoomLevels.at(-1) ?? 0;
  const slots = tileSlotsForZoom(z, state.visibleTiles, state.tileGrid);
  const fallbackSlot = slots[Math.floor((Math.max(1, slots.length) - 1) / 2)] ?? { x: 0, y: 0 };
  const x = visible?.x ?? fallbackSlot.x;
  const y = visible?.y ?? fallbackSlot.y;
  const key = tileKey(frameId, x, y, z);

  return {
    frameIndex: start + frameIndex,
    frameId,
    z,
    x,
    y,
    cached: state.tileStates[key],
    inFlight: state.inFlightKeys.has(key),
    scheduled: state.scheduledFrameIds.has(frameId),
  };
}

function describeFocusedTile(tile: FocusedTile): string {
  const state = tile.cached
    ? tile.cached.origin === "prefetch" && !tile.cached.wasDisplayed
      ? `${tile.cached.quality} prefetch`
      : `${tile.cached.quality} shown`
    : tile.inFlight
      ? "loading"
      : tile.scheduled
        ? "scheduled empty"
        : "unscheduled";

  return `focus f${tile.frameIndex} z${tile.z} (${tile.x},${tile.y}) ${state}`;
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

  ctx.fillText(
    `in-flight: ${state.inFlightKeys.size}`,
    marginLeft,
    height - 40 * dpr,
  );
}
