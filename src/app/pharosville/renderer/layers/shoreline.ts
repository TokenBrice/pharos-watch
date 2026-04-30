import { waterTerrainStyle, type WaterTerrainStyle, type WaterTextureKind } from "../../systems/palette";
import { TILE_HEIGHT, TILE_WIDTH, tileToScreen } from "../../systems/projection";
import { isWaterTileKind } from "../../systems/world-layout";
import type { PharosVilleTile, TerrainKind } from "../../systems/world-types";
import type { DrawPharosVilleInput, PharosVilleCanvasMotion } from "../render-types";

type CoastEdge = "east" | "north" | "south" | "west";

const EDGE_OFFSETS: Record<CoastEdge, { x: number; y: number }> = {
  east: { x: 1, y: 0 },
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

interface FoamSettings {
  alpha: number;
  dash: number[];
  lineWidth: number;
}

export function drawCoastalWaterDetails({ camera, ctx, height, motion, width, world }: DrawPharosVilleInput) {
  const tilesByKey = new Map(world.map.tiles.map((tile) => [tileKey(tile.x, tile.y), tile]));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const tile of world.map.tiles) {
    const terrain = tileTerrain(tile);
    if (!isWaterTileKind(terrain)) continue;

    const point = tileToScreen(tile, camera);
    if (!isTileInViewport(point.x, point.y, camera.zoom, width, height)) continue;

    const coastEdges = coastalEdgesForTile(tile, tilesByKey);
    if (coastEdges.length === 0) continue;

    const style = waterTerrainStyle(String(terrain)) ?? waterTerrainStyle("water")!;
    drawCoastEdgeWash(ctx, point.x, point.y, camera.zoom, style, coastEdges, tile.x, tile.y);
    drawNearshoreWaterMotif(ctx, point.x, point.y, camera.zoom, style, tile.x, tile.y, motion);
  }
  ctx.restore();
}

function tileKey(x: number, y: number) {
  return `${x}.${y}`;
}

function tileTerrain(tile: PharosVilleTile): TerrainKind {
  return tile.terrain ?? tile.kind;
}

function coastalEdgesForTile(tile: PharosVilleTile, tilesByKey: ReadonlyMap<string, PharosVilleTile>): CoastEdge[] {
  const edges: CoastEdge[] = [];
  for (const edge of Object.keys(EDGE_OFFSETS) as CoastEdge[]) {
    const offset = EDGE_OFFSETS[edge];
    const neighbor = tilesByKey.get(tileKey(tile.x + offset.x, tile.y + offset.y));
    if (!neighbor) continue;
    if (!isWaterTileKind(tileTerrain(neighbor))) edges.push(edge);
  }
  return edges;
}

function isTileInViewport(x: number, y: number, zoom: number, width: number, height: number) {
  const marginX = 46 * zoom;
  const marginY = 28 * zoom;
  return x >= -marginX && x <= width + marginX && y >= -marginY && y <= height + marginY;
}

function drawCoastEdgeWash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  style: WaterTerrainStyle,
  coastEdges: readonly CoastEdge[],
  tileX: number,
  tileY: number,
) {
  const settings = foamSettings(style.texture);
  const width = TILE_WIDTH * zoom;
  const height = TILE_HEIGHT * zoom;
  const jitter = ((tileX * 7 + tileY * 11) % 5 - 2) * 0.45 * zoom;

  for (const edge of coastEdges) {
    const [from, to] = edgePoints(x, y + jitter, width, height, edge, 1.8 * zoom);

    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(4, 7, 10, 0.28)";
    ctx.lineWidth = Math.max(1.5, (settings.lineWidth + 1) * zoom);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y + 1.6 * zoom);
    ctx.quadraticCurveTo(x, y + 2.8 * zoom, to.x, to.y + 1.2 * zoom);
    ctx.stroke();

    ctx.setLineDash(settings.dash.map((value) => value * zoom));
    ctx.strokeStyle = withAlpha(style.wave, settings.alpha);
    ctx.lineWidth = Math.max(1, settings.lineWidth * zoom);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(x, y + (edge === "north" || edge === "west" ? -1.5 : 2.2) * zoom, to.x, to.y);
    ctx.stroke();

    if ((tileX * 3 + tileY * 5 + edge.length) % 3 === 0) {
      ctx.setLineDash([]);
      ctx.strokeStyle = withAlpha(style.accent, settings.alpha * 0.72);
      ctx.lineWidth = Math.max(1, 0.85 * zoom);
      ctx.beginPath();
      ctx.moveTo(from.x * 0.58 + to.x * 0.42, from.y * 0.58 + to.y * 0.42 + 3 * zoom);
      ctx.lineTo(from.x * 0.38 + to.x * 0.62, from.y * 0.38 + to.y * 0.62 + 4.5 * zoom);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function foamSettings(texture: WaterTextureKind): FoamSettings {
  if (texture === "calm") return { alpha: 0.28, dash: [14, 8], lineWidth: 1 };
  if (texture === "watch") return { alpha: 0.34, dash: [7, 5, 2, 5], lineWidth: 1.05 };
  if (texture === "alert") return { alpha: 0.38, dash: [5, 4], lineWidth: 1.15 };
  if (texture === "warning") return { alpha: 0.42, dash: [4, 3, 2, 4], lineWidth: 1.3 };
  if (texture === "storm") return { alpha: 0.5, dash: [8, 3, 2, 3], lineWidth: 1.55 };
  if (texture === "ledger") return { alpha: 0.34, dash: [6, 3, 2, 3], lineWidth: 1.05 };
  if (texture === "harbor") return { alpha: 0.34, dash: [10, 6], lineWidth: 1.05 };
  if (texture === "deep") return { alpha: 0.22, dash: [12, 10], lineWidth: 0.95 };
  return { alpha: 0.31, dash: [11, 7], lineWidth: 1 };
}

function edgePoints(
  x: number,
  y: number,
  width: number,
  height: number,
  edge: CoastEdge,
  inset: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const top = { x, y: y - height / 2 + inset };
  const right = { x: x + width / 2 - inset, y };
  const bottom = { x, y: y + height / 2 - inset };
  const left = { x: x - width / 2 + inset, y };
  if (edge === "north") return [top, right];
  if (edge === "east") return [right, bottom];
  if (edge === "south") return [left, bottom];
  return [top, left];
}

function drawNearshoreWaterMotif(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  style: WaterTerrainStyle,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  const phase = time + tileX * 0.23 + tileY * 0.31;
  const drift = motion.reducedMotion ? 0 : Math.sin(phase * 0.8) * 0.9 * zoom;
  const seed = (tileX * 19 + tileY * 23) % 6;

  ctx.save();
  ctx.strokeStyle = withAlpha(style.accent, 0.28);
  ctx.fillStyle = withAlpha(style.accent, 0.22);
  ctx.lineWidth = Math.max(1, 0.9 * zoom);

  if (style.texture === "calm") {
    drawCalmSandbar(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "watch") {
    drawWatchCrosswind(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "alert") {
    drawAlertCurrentChevron(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "warning") {
    drawWarningShoalFlecks(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "storm") {
    drawStormWhitecap(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "ledger") {
    drawLedgerTally(ctx, x, y + drift, zoom, seed, style);
  } else if (style.texture === "harbor") {
    drawHarborRipples(ctx, x, y + drift, zoom, seed, style);
  } else {
    drawOpenEddy(ctx, x, y + drift, zoom, seed, style);
  }
  ctx.restore();
}

function drawCalmSandbar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.accent, 0.2);
  ctx.lineWidth = Math.max(1, 0.8 * zoom);
  ctx.beginPath();
  ctx.ellipse(x + (seed - 2) * 1.2 * zoom, y + 2 * zoom, 9 * zoom, 2.2 * zoom, -0.08, 0, Math.PI * 2);
  ctx.stroke();
}

function drawWatchCrosswind(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.wave, 0.32);
  ctx.beginPath();
  ctx.moveTo(x - (10 - seed) * zoom, y - 2 * zoom);
  ctx.lineTo(x - 2 * zoom, y + 1 * zoom);
  ctx.moveTo(x + (seed - 1) * zoom, y + 5 * zoom);
  ctx.lineTo(x + 10 * zoom, y + 2 * zoom);
  ctx.stroke();
}

function drawAlertCurrentChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.accent, 0.34);
  ctx.lineWidth = Math.max(1, zoom);
  const offset = (seed - 2) * 0.9 * zoom;
  ctx.beginPath();
  ctx.moveTo(x - 9 * zoom + offset, y - 2 * zoom);
  ctx.lineTo(x - 2 * zoom + offset, y + 2 * zoom);
  ctx.lineTo(x + 6 * zoom + offset, y - 1 * zoom);
  ctx.stroke();
}

function drawWarningShoalFlecks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.fillStyle = withAlpha(style.accent, 0.32);
  for (let index = 0; index < 3; index += 1) {
    const px = x + (index * 5 - 6 + seed * 0.6) * zoom;
    const py = y + ((index % 2) * 4 - 1) * zoom;
    ctx.fillRect(Math.round(px), Math.round(py), Math.max(1, Math.round(2.5 * zoom)), Math.max(1, Math.round(1.4 * zoom)));
  }
}

function drawStormWhitecap(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.wave, 0.48);
  ctx.lineWidth = Math.max(1, 1.25 * zoom);
  const offset = (seed - 2) * zoom;
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom + offset, y - 2 * zoom);
  ctx.lineTo(x - 6 * zoom + offset, y + 1 * zoom);
  ctx.lineTo(x - 1 * zoom + offset, y - 3 * zoom);
  ctx.moveTo(x + 2 * zoom + offset, y + 5 * zoom);
  ctx.lineTo(x + 8 * zoom + offset, y + 1 * zoom);
  ctx.stroke();
}

function drawLedgerTally(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.accent, 0.3);
  ctx.lineWidth = Math.max(1, 0.85 * zoom);
  const startX = x - (7 + seed * 0.3) * zoom;
  ctx.beginPath();
  for (let index = 0; index < 3; index += 1) {
    const px = startX + index * 5 * zoom;
    ctx.moveTo(px, y - 4 * zoom);
    ctx.lineTo(px + 1 * zoom, y + 4 * zoom);
  }
  ctx.moveTo(startX - 1 * zoom, y + 2 * zoom);
  ctx.lineTo(startX + 14 * zoom, y - 1 * zoom);
  ctx.stroke();
}

function drawHarborRipples(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.wave, 0.3);
  ctx.beginPath();
  ctx.moveTo(x - 10 * zoom, y + (seed % 2) * zoom);
  ctx.lineTo(x + 8 * zoom, y + 3 * zoom);
  ctx.moveTo(x - 4 * zoom, y + 6 * zoom);
  ctx.lineTo(x + 7 * zoom, y + 7 * zoom);
  ctx.stroke();
}

function drawOpenEddy(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  seed: number,
  style: WaterTerrainStyle,
) {
  ctx.strokeStyle = withAlpha(style.accent, 0.24);
  ctx.beginPath();
  ctx.ellipse(x + (seed - 2) * zoom, y + 1 * zoom, 7 * zoom, 2.5 * zoom, -0.08, 0.1, Math.PI * 1.6);
  ctx.stroke();
}

function withAlpha(color: string, alpha: number) {
  if (color.startsWith("rgba(")) return color.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
  if (color.startsWith("#")) return hexToRgba(color, alpha);
  return color;
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
