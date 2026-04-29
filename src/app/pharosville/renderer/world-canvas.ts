import type { PharosVilleMotionPlan, ShipMotionSample } from "../systems/motion";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import {
  CEMETERY_CENTER,
  CEMETERY_RADIUS,
  isElevatedTileKind,
  isShoreTileKind,
  isWaterTileKind,
} from "../systems/world-layout";
import type { PharosVilleWorld, TerrainKind } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import type { HitTarget } from "./hit-testing";
import { CAUSE_HEX, type CauseOfDeath } from "@shared/lib/cause-of-death";

const TILE_COLORS: Record<string, string> = {
  beach: "#c7a66c",
  cliff: "#5a625d",
  "deep-water": "#071225",
  "fog-water": "#24314a",
  grass: "#617444",
  "harbor-water": "#1f5f68",
  hill: "#76814d",
  land: "#b89155",
  road: "#7a5938",
  rock: "#6f7369",
  shore: "#aa8755",
  "storm-water": "#0b2236",
  water: "#15375a",
};

const TERRAIN_TEXTURE = {
  cliffFace: "rgba(31, 35, 31, 0.54)",
  foam: "rgba(224, 238, 220, 0.68)",
  grassDark: "rgba(43, 78, 43, 0.44)",
  grassLight: "rgba(168, 177, 103, 0.32)",
  roadLight: "rgba(184, 146, 91, 0.32)",
  rockLight: "rgba(176, 177, 160, 0.24)",
  sandLight: "rgba(237, 204, 137, 0.28)",
  shallow: "rgba(88, 153, 139, 0.22)",
  waterLine: "rgba(175, 225, 220, 0.28)",
} as const;

const LIGHTHOUSE_HEADLAND = {
  cliff: "#4d564e",
  grass: "#6f7d50",
  halo: "rgba(222, 196, 119, 0.16)",
  moss: "#82905b",
  road: "#8e6740",
  shadow: "rgba(10, 12, 12, 0.42)",
  stone: "#7b7d70",
} as const;

const BUILDINGS = [
  [27, 27, "#d6b56b", "#5d3527"],
  [36, 30, "#ead18a", "#6c2f2c"],
  [31, 38, "#b9a066", "#474031"],
  [24, 35, "#dcc078", "#74522f"],
  [40, 35, "#d6b56b", "#566139"],
] as const;

const VILLAGE_LIGHTS = [
  { x: 26.35, y: 27.75, size: 0.72 },
  { x: 35.45, y: 30.55, size: 0.74 },
  { x: 30.75, y: 37.4, size: 0.58 },
  { x: 39.6, y: 34.7, size: 0.62 },
  { x: 24.2, y: 34.65, size: 0.56 },
  { x: 31.7, y: 31.9, size: 0.5 },
] as const;

const BIRDS = [
  { anchorX: -4.2, anchorY: -3.2, radiusX: 3.8, radiusY: 1.4, scale: 1.14, speed: 0.24, phase: 0.1 },
  { anchorX: -1.4, anchorY: -5.2, radiusX: 4.4, radiusY: 1.7, scale: 0.98, speed: 0.2, phase: 1.9 },
  { anchorX: 2.8, anchorY: -4.3, radiusX: 3.2, radiusY: 1.2, scale: 0.9, speed: 0.23, phase: 3.4 },
  { anchorX: -18.5, anchorY: -10.8, radiusX: 8.5, radiusY: 2.2, scale: 0.76, speed: 0.13, phase: 0.6 },
  { anchorX: -29.5, anchorY: 4.4, radiusX: 7.4, radiusY: 1.8, scale: 0.68, speed: 0.15, phase: 2.8 },
  { anchorX: 10.5, anchorY: -15.5, radiusX: 8.8, radiusY: 2.6, scale: 0.72, speed: 0.12, phase: 4.2 },
  { anchorX: 18.2, anchorY: 2.2, radiusX: 6.2, radiusY: 1.6, scale: 0.62, speed: 0.18, phase: 5.3 },
  { anchorX: 7.2, anchorY: -7.6, radiusX: 5.2, radiusY: 1.5, scale: 0.84, speed: 0.19, phase: 2.2 },
  { anchorX: -9.8, anchorY: -8.2, radiusX: 5.8, radiusY: 1.7, scale: 0.82, speed: 0.17, phase: 4.9 },
] as const;

const ATMOSPHERE_BANDS = [
  { alpha: 0.11, rx: 280, ry: 24, tileX: 16, tileY: 13, phase: 0.3 },
  { alpha: 0.08, rx: 230, ry: 19, tileX: 48, tileY: 11, phase: 2.1 },
  { alpha: 0.07, rx: 210, ry: 16, tileX: 53, tileY: 39, phase: 4.4 },
] as const;

const SKY_MOODS = {
  day: {
    horizon: "#d9a65b",
    mist: "rgba(255, 225, 164, 0.22)",
    starAlpha: 0,
    top: "#496f8b",
    waterVeil: "rgba(52, 101, 121, 0.16)",
  },
  night: {
    horizon: "#14294a",
    mist: "rgba(200, 219, 205, 0.12)",
    starAlpha: 0.46,
    top: "#100b12",
    waterVeil: "rgba(7, 9, 16, 0.22)",
  },
} as const;

const SKY_STARS = [
  { x: 0.11, y: 0.1, size: 1.1 },
  { x: 0.18, y: 0.22, size: 0.8 },
  { x: 0.31, y: 0.14, size: 1 },
  { x: 0.44, y: 0.08, size: 0.7 },
  { x: 0.58, y: 0.18, size: 1.2 },
  { x: 0.69, y: 0.09, size: 0.8 },
  { x: 0.83, y: 0.16, size: 1 },
  { x: 0.92, y: 0.26, size: 0.7 },
] as const;

const HEADLAND_TERRAIN_ACCENTS = [
  { dx: -1.6, dy: -0.5, size: 0.76 },
  { dx: -0.9, dy: -1.1, size: 0.92 },
  { dx: 0.2, dy: -1.3, size: 1 },
  { dx: 1.1, dy: -0.8, size: 0.86 },
  { dx: 1.7, dy: 0.1, size: 0.72 },
  { dx: -1.2, dy: 0.7, size: 0.68 },
] as const;

const SHIP_COLORS = {
  "treasury-galleon": "#8a4f2b",
  "chartered-brigantine": "#735233",
  "dao-schooner": "#35606c",
  "crypto-caravel": "#58433a",
  "algo-junk": "#774734",
};

const PENNANTS: Record<string, string> = {
  emerald: "#d7f0df",
  blue: "#d7e6f7",
  cyan: "#d7f0ee",
  gold: "#ffe1a0",
  silver: "#e5e7eb",
  slate: "#c7d0d8",
};

const GRAVE_CAUSE_COLORS: Record<CauseOfDeath, string> = CAUSE_HEX;

type GraveNodeMarker = PharosVilleWorld["graves"][number]["visual"]["marker"];

const CEMETERY_GLOBAL_SCALE = 0.6;
const CEMETERY_CONTEXT_SCALE = 0.82 * CEMETERY_GLOBAL_SCALE;

export interface PharosVilleCanvasMotion {
  plan: PharosVilleMotionPlan;
  reducedMotion: boolean;
  timeSeconds: number;
}

export interface DrawPharosVilleInput {
  assets: PharosVilleAssetManager | null;
  camera: IsoCamera;
  ctx: CanvasRenderingContext2D;
  height: number;
  hoveredTarget: HitTarget | null;
  motion: PharosVilleCanvasMotion;
  selectedTarget: HitTarget | null;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
  targets: readonly HitTarget[];
  width: number;
  world: PharosVilleWorld;
}

export function drawPharosVille(input: DrawPharosVilleInput) {
  const { ctx, height, width } = input;
  ctx.imageSmoothingEnabled = false;
  drawSky(input);

  drawTerrain(input);
  drawAtmosphere(input);
  drawCemeteryGround(input);
  drawLighthouseHeadland(input);
  drawCemeteryContext(input);
  drawBuildings(input);
  drawDocks(input);
  drawDecorativeLights(input);
  drawShips(input);
  drawClusters(input);
  drawGraves(input);
  drawCemeteryMist(input);
  drawLighthouse(input);
  drawBirds(input);
  drawSelection(input);
}

function drawSky({ camera, ctx, height, motion, width, world }: DrawPharosVilleInput) {
  const mood = skyMood(motion);
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, mood.top);
  gradient.addColorStop(0.52, mood.horizon);
  gradient.addColorStop(1, "#070910");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.72;
  const beacon = tileToScreen(world.lighthouse.tile, camera);
  const glow = ctx.createRadialGradient(
    beacon.x,
    beacon.y - 122 * camera.zoom,
    14 * camera.zoom,
    beacon.x,
    beacon.y - 122 * camera.zoom,
    260 * camera.zoom,
  );
  glow.addColorStop(0, "rgba(255, 213, 119, 0.32)");
  glow.addColorStop(0.34, mood.mist);
  glow.addColorStop(1, "rgba(255, 213, 119, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(beacon.x, beacon.y - 122 * camera.zoom, 260 * camera.zoom, 115 * camera.zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = mood.starAlpha;
  ctx.fillStyle = "#f5e7b8";
  for (const star of SKY_STARS) {
    const size = Math.max(1, star.size * camera.zoom);
    ctx.fillRect(Math.round(width * star.x), Math.round(height * star.y), size, size);
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = mood.waterVeil;
  ctx.fillRect(0, Math.round(height * 0.52), width, Math.ceil(height * 0.48));
  ctx.restore();
}

function skyMood(motion: PharosVilleCanvasMotion) {
  if (motion.reducedMotion) return SKY_MOODS.night;
  const cycle = (Math.sin(motion.timeSeconds * 0.018) + 1) / 2;
  return cycle > 0.54 ? SKY_MOODS.day : SKY_MOODS.night;
}

function drawTerrain({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  for (const tile of world.map.tiles) {
    const terrain = tile.terrain ?? tile.kind;
    if (!isWaterTileKind(terrain)) continue;
    const p = tileToScreen(tile, camera);
    drawWaterTile(ctx, p.x, p.y, camera.zoom, terrain, tile.x, tile.y, motion);
  }

  for (const tile of world.map.tiles) {
    const terrain = tile.terrain ?? tile.kind;
    if (isWaterTileKind(terrain)) continue;
    const p = tileToScreen(tile, camera);
    drawLandTile(ctx, p.x, p.y, camera.zoom, terrain, tile.x, tile.y);
  }
}

function terrainColor(kind: TerrainKind) {
  const value = String(kind);
  const directColor = TILE_COLORS[value];
  if (directColor) return directColor;
  if (value.includes("water")) return value.includes("deep") ? "#071225" : "#15375a";
  if (value.includes("road") || value.includes("stair")) return "#7a5938";
  if (value.includes("cliff")) return "#5a625d";
  if (value.includes("rock")) return "#6f7369";
  if (value.includes("hill")) return "#76814d";
  if (value.includes("grass")) return "#617444";
  if (value.includes("beach")) return "#c7a66c";
  return "#b89155";
}

function drawWaterTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  kind: TerrainKind,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const value = String(kind);
  const width = 32 * zoom;
  const height = 16 * zoom;
  drawDiamond(ctx, x, y, width, height, terrainColor(kind));

  if (value === "harbor-water" || value.includes("harbor")) {
    drawDiamond(ctx, x, y + 1 * zoom, width * 0.82, height * 0.72, TERRAIN_TEXTURE.shallow);
  } else if (value === "fog-water" || value.includes("fog")) {
    drawDiamond(ctx, x, y + 1 * zoom, width * 0.9, height * 0.78, "rgba(197, 208, 206, 0.16)");
  } else if (value === "storm-water" || value.includes("storm")) {
    drawDiamond(ctx, x, y + 1 * zoom, width * 0.9, height * 0.78, "rgba(6, 12, 22, 0.24)");
  } else if (value === "deep-water" || value.includes("deep")) {
    drawDiamond(ctx, x, y + 1 * zoom, width * 0.86, height * 0.76, "rgba(2, 6, 15, 0.24)");
  }

  if ((tileX * 13 + tileY * 17) % 5 !== 0) return;
  const wave = motion.reducedMotion
    ? 0.2
    : 0.16 + Math.sin(motion.timeSeconds * 1.25 + tileX * 0.27 + tileY * 0.19) * 0.05;
  ctx.save();
  ctx.strokeStyle = `rgba(186, 231, 225, ${Math.max(0.08, wave)})`;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 9 * zoom, y - 2 * zoom);
  ctx.lineTo(x + 7 * zoom, y + 2 * zoom);
  ctx.stroke();
  if ((tileX + tileY) % 3 === 0) {
    ctx.strokeStyle = TERRAIN_TEXTURE.waterLine;
    ctx.beginPath();
    ctx.moveTo(x - 3 * zoom, y + 4 * zoom);
    ctx.lineTo(x + 10 * zoom, y + 7 * zoom);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLandTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  kind: TerrainKind,
  tileX: number,
  tileY: number,
) {
  const value = String(kind);
  const width = 32 * zoom;
  const height = 16 * zoom;
  drawDiamond(ctx, x, y, width, height, terrainColor(kind));

  if (isElevatedTileKind(kind)) {
    drawTileLowerFacet(ctx, x, y, width, height, value === "cliff" || value.includes("cliff")
      ? TERRAIN_TEXTURE.cliffFace
      : "rgba(54, 63, 45, 0.32)");
  }

  if (isShoreTileKind(kind)) {
    drawShoreFoam(ctx, x, y, zoom, tileX, tileY);
  } else if (value === "road" || value.includes("road") || value.includes("stair")) {
    drawRoadTexture(ctx, x, y, zoom);
  } else if (value === "rock" || value === "cliff" || value.includes("rock") || value.includes("cliff")) {
    drawRockTexture(ctx, x, y, zoom, tileX, tileY);
  } else if ((tileX * 19 + tileY * 23) % 6 === 0) {
    drawGrassTexture(ctx, x, y, zoom, tileX, tileY);
  }
}

function drawTileLowerFacet(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: string) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x - width / 2, y);
  ctx.lineTo(x, y + height / 2);
  ctx.lineTo(x + width / 2, y);
  ctx.lineTo(x, y + height * 0.24);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShoreFoam(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, tileX: number, tileY: number) {
  ctx.save();
  ctx.strokeStyle = TERRAIN_TEXTURE.foam;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  if ((tileX + tileY) % 2 === 0) {
    ctx.moveTo(x - 12 * zoom, y + 1 * zoom);
    ctx.lineTo(x - 2 * zoom, y + 6 * zoom);
  } else {
    ctx.moveTo(x + 2 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 12 * zoom, y + 1 * zoom);
  }
  ctx.stroke();
  ctx.strokeStyle = TERRAIN_TEXTURE.sandLight;
  ctx.beginPath();
  ctx.moveTo(x - 6 * zoom, y - 2 * zoom);
  ctx.lineTo(x + 6 * zoom, y + 1 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawRoadTexture(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number) {
  ctx.save();
  ctx.strokeStyle = TERRAIN_TEXTURE.roadLight;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 10 * zoom, y - 1 * zoom);
  ctx.lineTo(x + 10 * zoom, y + 2 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawRockTexture(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, tileX: number, tileY: number) {
  const offset = ((tileX * 7 + tileY * 11) % 5 - 2) * zoom;
  ctx.save();
  ctx.strokeStyle = TERRAIN_TEXTURE.rockLight;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 7 * zoom + offset, y - 2 * zoom);
  ctx.lineTo(x - 1 * zoom + offset, y + 1 * zoom);
  ctx.lineTo(x + 6 * zoom + offset, y - 1 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawGrassTexture(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, tileX: number, tileY: number) {
  const offset = ((tileX * 5 + tileY * 3) % 7 - 3) * zoom;
  ctx.save();
  ctx.fillStyle = TERRAIN_TEXTURE.grassDark;
  ctx.fillRect(Math.round(x - 2 * zoom + offset), Math.round(y - 1 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(3 * zoom)));
  ctx.fillStyle = TERRAIN_TEXTURE.grassLight;
  ctx.fillRect(Math.round(x + 2 * zoom + offset), Math.round(y + 1 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
  ctx.restore();
}

function drawAtmosphere({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  const mood = skyMood(motion);
  const beacon = tileToScreen(world.lighthouse.tile, camera);
  ctx.save();
  ctx.fillStyle = mood.mist;
  ctx.beginPath();
  ctx.ellipse(beacon.x - 18 * camera.zoom, beacon.y - 92 * camera.zoom, 220 * camera.zoom, 54 * camera.zoom, -0.16, 0, Math.PI * 2);
  ctx.fill();

  for (const band of ATMOSPHERE_BANDS) {
    const p = tileToScreen({ x: band.tileX, y: band.tileY }, camera);
    const drift = Math.sin(time * 0.18 + band.phase) * 12 * camera.zoom;
    ctx.strokeStyle = mood === SKY_MOODS.day
      ? `rgba(255, 230, 181, ${band.alpha + 0.05})`
      : `rgba(200, 219, 205, ${band.alpha})`;
    ctx.lineWidth = Math.max(1, 6.5 * camera.zoom);
    ctx.beginPath();
    ctx.ellipse(p.x + drift, p.y - 18 * camera.zoom, band.rx * camera.zoom, band.ry * camera.zoom, -0.1, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLighthouseHeadland({ camera, ctx, world }: DrawPharosVilleInput) {
  const center = tileToScreen(world.lighthouse.tile, camera);
  const terrain = lighthouseTerrain(world);
  const crownColor = isElevatedTileKind(terrain) ? LIGHTHOUSE_HEADLAND.moss : LIGHTHOUSE_HEADLAND.grass;
  const zoom = camera.zoom;
  ctx.save();

  ctx.fillStyle = LIGHTHOUSE_HEADLAND.halo;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y + 14 * zoom, 118 * zoom, 42 * zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();

  drawDiamond(ctx, center.x, center.y + 30 * zoom, 154 * zoom, 72 * zoom, LIGHTHOUSE_HEADLAND.shadow);
  drawDiamond(ctx, center.x - 2 * zoom, center.y + 20 * zoom, 136 * zoom, 62 * zoom, LIGHTHOUSE_HEADLAND.cliff);
  drawTileLowerFacet(ctx, center.x - 2 * zoom, center.y + 20 * zoom, 136 * zoom, 62 * zoom, "rgba(25, 29, 27, 0.64)");
  drawDiamond(ctx, center.x + 2 * zoom, center.y + 7 * zoom, 110 * zoom, 50 * zoom, crownColor);
  drawDiamond(ctx, center.x + 4 * zoom, center.y - 8 * zoom, 72 * zoom, 33 * zoom, LIGHTHOUSE_HEADLAND.stone);

  for (const accent of HEADLAND_TERRAIN_ACCENTS) {
    const accentPoint = tileToScreen({
      x: world.lighthouse.tile.x + accent.dx,
      y: world.lighthouse.tile.y + accent.dy,
    }, camera);
    const accentFill = isWaterTileKind(terrain)
      ? "rgba(142, 196, 184, 0.22)"
      : isShoreTileKind(terrain)
        ? "rgba(237, 204, 137, 0.28)"
        : "rgba(174, 185, 107, 0.22)";
    drawDiamond(ctx, accentPoint.x, accentPoint.y + 8 * zoom, 34 * zoom * accent.size, 15 * zoom * accent.size, accentFill);
  }

  ctx.strokeStyle = LIGHTHOUSE_HEADLAND.road;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(3, 5.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(center.x + 2 * zoom, center.y - 2 * zoom);
  ctx.lineTo(center.x - 24 * zoom, center.y + 22 * zoom);
  ctx.lineTo(center.x - 54 * zoom, center.y + 29 * zoom);
  ctx.lineTo(center.x - 72 * zoom, center.y + 25 * zoom);
  ctx.stroke();

  ctx.strokeStyle = "rgba(223, 198, 132, 0.3)";
  ctx.lineWidth = Math.max(1, 1.4 * zoom);
  ctx.beginPath();
  ctx.moveTo(center.x - 42 * zoom, center.y + 23 * zoom);
  ctx.lineTo(center.x - 51 * zoom, center.y + 32 * zoom);
  ctx.moveTo(center.x - 23 * zoom, center.y + 13 * zoom);
  ctx.lineTo(center.x - 33 * zoom, center.y + 22 * zoom);
  ctx.moveTo(center.x + 18 * zoom, center.y + 5 * zoom);
  ctx.lineTo(center.x + 48 * zoom, center.y + 18 * zoom);
  ctx.moveTo(center.x - 48 * zoom, center.y + 43 * zoom);
  ctx.lineTo(center.x + 43 * zoom, center.y + 39 * zoom);
  ctx.stroke();
  ctx.restore();
}

function lighthouseTerrain(world: PharosVilleWorld): TerrainKind {
  const tile = world.map.tiles.find((candidate) => (
    candidate.x === world.lighthouse.tile.x && candidate.y === world.lighthouse.tile.y
  ));
  return tile?.terrain ?? tile?.kind ?? "hill";
}

function drawCemeteryGround({ camera, ctx, world }: DrawPharosVilleInput) {
  ctx.save();
  for (const tile of world.map.tiles) {
    if (tile.kind !== "land" && tile.kind !== "shore") continue;
    const value = cemeteryValue(tile.x, tile.y);
    if (value > 1.08) continue;
    const p = tileToScreen(tile, camera);
    const edge = value > 0.78;
    drawDiamond(
      ctx,
      p.x,
      p.y,
      32 * camera.zoom,
      16 * camera.zoom,
      edge ? "rgba(58, 73, 52, 0.54)" : "rgba(39, 60, 44, 0.76)",
    );
    if ((tile.x * 17 + tile.y * 29) % 7 === 0) {
      drawCemeteryTuft(
        ctx,
        p.x + ((tile.x % 3) - 1) * 4 * camera.zoom * CEMETERY_GLOBAL_SCALE,
        p.y + 3 * camera.zoom * CEMETERY_GLOBAL_SCALE,
        camera.zoom * CEMETERY_GLOBAL_SCALE,
      );
    }
  }

  drawCemeteryPath(ctx, camera);
  drawCemeteryFence(ctx, camera);
  ctx.restore();
}

function cemeteryValue(x: number, y: number) {
  return ((x - CEMETERY_CENTER.x) / CEMETERY_RADIUS.x) ** 2
    + ((y - CEMETERY_CENTER.y) / CEMETERY_RADIUS.y) ** 2;
}

function cemeteryContextTile(tile: { x: number; y: number }) {
  return {
    x: CEMETERY_CENTER.x + (tile.x - CEMETERY_CENTER.x) * CEMETERY_CONTEXT_SCALE,
    y: CEMETERY_CENTER.y + (tile.y - CEMETERY_CENTER.y) * CEMETERY_CONTEXT_SCALE,
  };
}

function cemeteryContextTiles(tiles: readonly { x: number; y: number }[]) {
  return tiles.map(cemeteryContextTile);
}

function drawCemeteryPath(ctx: CanvasRenderingContext2D, camera: IsoCamera) {
  const northPath = cemeteryContextTiles([
    { x: 21.25, y: 35.55 },
    { x: 21.75, y: 38.4 },
    { x: 21.6, y: 41.75 },
    { x: 22.15, y: 44.65 },
    { x: 21.7, y: 47.7 },
  ]);
  drawIsoStroke(ctx, camera, northPath, "rgba(86, 75, 58, 0.84)", 10 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, cemeteryContextTiles([
    { x: 14.55, y: 41.7 },
    { x: 17.65, y: 41.32 },
    { x: 21.75, y: 41.78 },
    { x: 25.85, y: 41.35 },
    { x: 29.7, y: 41.85 },
  ]), "rgba(86, 75, 58, 0.7)", 6.5 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, cemeteryContextTiles([
    { x: 16.7, y: 38.95 },
    { x: 18.4, y: 39.6 },
    { x: 19.85, y: 40.65 },
  ]), "rgba(86, 75, 58, 0.66)", 5.8 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, northPath, "rgba(176, 149, 99, 0.42)", 2.5 * CEMETERY_GLOBAL_SCALE);
}

function drawCemeteryFence(ctx: CanvasRenderingContext2D, camera: IsoCamera) {
  const rails = [
    cemeteryContextTiles([
      { x: 14.05, y: 40.2 },
      { x: 16.65, y: 36.7 },
      { x: 20.95, y: 35.2 },
      { x: 25.95, y: 36.15 },
      { x: 30.15, y: 40.25 },
    ]),
    cemeteryContextTiles([
      { x: 14.1, y: 43.35 },
      { x: 17.55, y: 47.25 },
      { x: 22.1, y: 48.05 },
      { x: 26.85, y: 46.25 },
      { x: 30.2, y: 42.75 },
    ]),
  ] as const;

  for (const rail of rails) {
    drawIsoStroke(ctx, camera, rail, "rgba(26, 28, 24, 0.72)", 3 * CEMETERY_GLOBAL_SCALE);
    for (const tile of rail) {
      const p = tileToScreen(tile, camera);
      ctx.fillStyle = "#171a16";
      ctx.fillRect(
        Math.round(p.x - 1 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.round(p.y - 7 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.max(1, Math.round(2 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
        Math.max(3, Math.round(9 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
      );
      ctx.fillStyle = "#556148";
      ctx.fillRect(
        Math.round(p.x - 1 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.round(p.y - 8 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.max(1, Math.round(2 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
        Math.max(1, Math.round(2 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
      );
    }
  }
}

function drawIsoStroke(
  ctx: CanvasRenderingContext2D,
  camera: IsoCamera,
  tiles: readonly { x: number; y: number }[],
  color: string,
  width: number,
) {
  if (tiles.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, width * camera.zoom);
  tiles.forEach((tile, index) => {
    const p = tileToScreen(tile, camera);
    if (index === 0) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

function drawCemeteryTuft(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number) {
  ctx.fillStyle = "rgba(57, 104, 63, 0.7)";
  ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(4 * zoom)));
  ctx.fillStyle = "rgba(34, 73, 45, 0.82)";
  ctx.fillRect(Math.round(x + 1 * zoom), Math.round(y + 1 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(3 * zoom)));
}

function drawCemeteryContext({ camera, ctx }: DrawPharosVilleInput) {
  const contextZoom = camera.zoom * CEMETERY_CONTEXT_SCALE;
  drawCemeteryShrubs(ctx, camera);
  drawMausoleum(ctx, tileToScreen(cemeteryContextTile({ x: 16.85, y: 38.75 }), camera), contextZoom);
  drawMemorialShrine(ctx, tileToScreen(CEMETERY_CENTER, camera), contextZoom);
  drawCemeteryTree(ctx, tileToScreen(cemeteryContextTile({ x: 14.95, y: 39.05 }), camera), contextZoom, false);
  drawCemeteryTree(ctx, tileToScreen(cemeteryContextTile({ x: 29.0, y: 43.35 }), camera), contextZoom, true);
  drawStoneLantern(ctx, tileToScreen(cemeteryContextTile({ x: 24.95, y: 36.65 }), camera), contextZoom);
  drawStoneLantern(ctx, tileToScreen(cemeteryContextTile({ x: 18.65, y: 46.1 }), camera), contextZoom);
}

function drawCemeteryShrubs(ctx: CanvasRenderingContext2D, camera: IsoCamera) {
  const shrubs = [
    { x: 15.35, y: 44.65, size: 0.9 },
    { x: 17.6, y: 36.5, size: 0.72 },
    { x: 20.5, y: 47.0, size: 0.78 },
    { x: 24.8, y: 47.25, size: 0.85 },
    { x: 28.3, y: 38.95, size: 0.7 },
    { x: 28.95, y: 45.0, size: 0.92 },
    { x: 14.7, y: 41.45, size: 0.72 },
    { x: 23.8, y: 35.7, size: 0.68 },
    { x: 16.05, y: 47.1, size: 0.74 },
    { x: 29.25, y: 41.1, size: 0.76 },
  ] as const;
  for (const shrub of shrubs) {
    const p = tileToScreen(cemeteryContextTile(shrub), camera);
    drawShrub(ctx, p.x, p.y + 2 * camera.zoom, camera.zoom * shrub.size * CEMETERY_CONTEXT_SCALE);
  }
}

function drawShrub(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number) {
  ctx.save();
  ctx.fillStyle = "#253f2d";
  ctx.beginPath();
  ctx.ellipse(x, y + 2 * zoom, 9 * zoom, 4 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4f7c45";
  for (let index = 0; index < 3; index += 1) {
    ctx.beginPath();
    ctx.arc(x + (index - 1) * 5 * zoom, y - index * zoom, (4 + index) * zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawMausoleum(ctx: CanvasRenderingContext2D, point: ScreenPoint, zoom: number) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(18, 20, 18, 0.34)";
  ctx.beginPath();
  ctx.ellipse(0, 7, 28, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#465362";
  ctx.fillRect(-18, -32, 36, 28);
  ctx.fillStyle = "#6f8090";
  ctx.fillRect(-14, -29, 28, 23);
  ctx.fillStyle = "#2b3440";
  ctx.fillRect(-7, -18, 14, 14);
  ctx.fillStyle = "#95a3aa";
  ctx.fillRect(-21, -5, 42, 6);
  ctx.fillStyle = "#34424f";
  ctx.beginPath();
  ctx.moveTo(-21, -32);
  ctx.lineTo(0, -48);
  ctx.lineTo(21, -32);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#9aa8af";
  ctx.fillRect(-2, -57, 4, 12);
  ctx.fillRect(-7, -53, 14, 4);
  ctx.restore();
}

function drawMemorialShrine(ctx: CanvasRenderingContext2D, point: ScreenPoint, zoom: number) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(16, 19, 16, 0.32)";
  ctx.beginPath();
  ctx.ellipse(0, 8, 30, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#4b565a";
  ctx.fillRect(-20, -1, 40, 7);
  ctx.fillStyle = "#89958d";
  ctx.fillRect(-16, -7, 32, 7);
  ctx.fillStyle = "#5d6866";
  ctx.fillRect(-14, -27, 28, 22);
  ctx.fillStyle = "#77847d";
  ctx.beginPath();
  ctx.moveTo(-11, -6);
  ctx.lineTo(-11, -20);
  ctx.quadraticCurveTo(-10, -31, 0, -35);
  ctx.quadraticCurveTo(10, -31, 11, -20);
  ctx.lineTo(11, -6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#20282a";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.fillStyle = "#465257";
  ctx.fillRect(-16, -26, 5, 21);
  ctx.fillRect(11, -26, 5, 21);
  ctx.fillStyle = "#9ba69d";
  ctx.fillRect(-8, -15, 16, 2);
  ctx.fillRect(-7, -11, 14, 2);
  ctx.fillStyle = "#d6aa5d";
  ctx.fillRect(-5, -22, 10, 3);
  ctx.restore();
}

function drawCemeteryTree(ctx: CanvasRenderingContext2D, point: ScreenPoint, zoom: number, bare: boolean) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(14, 18, 13, 0.32)";
  ctx.beginPath();
  ctx.ellipse(2, 6, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#513522";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.lineTo(1, -28);
  ctx.stroke();
  ctx.lineWidth = 2;
  for (const branch of bare ? [-1, 1, 2, -2] : [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, -18 + Math.abs(branch) * 2);
    ctx.lineTo(branch * 10, -31 - Math.abs(branch) * 4);
    ctx.stroke();
  }
  if (!bare) {
    ctx.fillStyle = "#5e874c";
    ctx.beginPath();
    ctx.arc(-5, -35, 12, 0, Math.PI * 2);
    ctx.arc(7, -32, 13, 0, Math.PI * 2);
    ctx.arc(1, -45, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStoneLantern(ctx: CanvasRenderingContext2D, point: ScreenPoint, zoom: number) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(14, 17, 14, 0.28)";
  ctx.beginPath();
  ctx.ellipse(0, 5, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#6d7473";
  ctx.fillRect(-2, -12, 4, 15);
  ctx.fillRect(-7, 1, 14, 4);
  ctx.fillStyle = "#8a9492";
  ctx.fillRect(-6, -18, 12, 6);
  ctx.fillStyle = "#d4b663";
  ctx.fillRect(-3, -17, 6, 3);
  ctx.restore();
}

function drawLighthouse({ assets, camera, ctx, motion, world }: DrawPharosVilleInput) {
  const center = tileToScreen(world.lighthouse.tile, camera);
  const assetCenter = { x: center.x, y: center.y + 3 * camera.zoom };
  const lighthouseAsset = assets?.get("landmark.lighthouse");
  const epicZoom = camera.zoom * 1.48;
  const firePoint = lighthouseAsset
    ? lighthouseBeaconPoint(lighthouseAsset, assetCenter, epicZoom)
    : { x: center.x, y: center.y - 148 * camera.zoom };
  if (lighthouseAsset) {
    drawLighthousePedestal(ctx, center, camera.zoom);
    drawAsset(ctx, lighthouseAsset, assetCenter.x, assetCenter.y, epicZoom);
    if (!world.lighthouse.unavailable) drawLighthouseBeam(ctx, firePoint, camera.zoom * 1.35, motion);
    drawLighthouseFire(ctx, firePoint, camera.zoom * 1.32, world.lighthouse.color, motion);
    return;
  }

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.fillStyle = "rgba(10, 12, 12, 0.42)";
  ctx.beginPath();
  ctx.ellipse(2, 3, 34, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d8d0ad";
  ctx.fillRect(-31, -23, 62, 21);
  ctx.fillStyle = "#a99973";
  ctx.fillRect(-24, -35, 48, 14);
  ctx.fillStyle = "#f4f0d2";
  ctx.beginPath();
  ctx.moveTo(-18, -34);
  ctx.lineTo(18, -34);
  ctx.lineTo(12, -134);
  ctx.lineTo(-12, -134);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(92, 82, 60, 0.28)";
  ctx.beginPath();
  ctx.moveTo(5, -34);
  ctx.lineTo(18, -34);
  ctx.lineTo(12, -134);
  ctx.lineTo(3, -134);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#b34b37";
  ctx.fillRect(-14, -109, 28, 11);
  ctx.fillRect(-15, -73, 30, 11);
  ctx.fillStyle = "#28313a";
  ctx.fillRect(-5, -50, 10, 18);
  ctx.fillStyle = "#c89a43";
  ctx.fillRect(-19, -148, 38, 15);
  ctx.fillStyle = "#392e26";
  ctx.fillRect(-24, -153, 48, 6);
  ctx.fillStyle = "#f4e9ad";
  ctx.fillRect(-13, -146, 26, 10);
  ctx.fillStyle = "#723927";
  ctx.beginPath();
  ctx.moveTo(-20, -153);
  ctx.lineTo(0, -172);
  ctx.lineTo(20, -153);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = world.lighthouse.color;
  ctx.beginPath();
  ctx.arc(0, -150, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (!world.lighthouse.unavailable) drawLighthouseBeam(ctx, firePoint, camera.zoom * 1.35, motion);
  drawLighthouseFire(ctx, firePoint, camera.zoom * 1.32, world.lighthouse.color, motion);
}

function drawLighthousePedestal(ctx: CanvasRenderingContext2D, center: ScreenPoint, zoom: number) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(10, 12, 12, 0.34)";
  ctx.beginPath();
  ctx.ellipse(0, 4, 42, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8e8978";
  ctx.fillRect(-30, -20, 60, 20);
  ctx.fillStyle = "#c9bea0";
  ctx.fillRect(-23, -30, 46, 12);
  ctx.restore();
}

function lighthouseBeaconPoint(
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>>,
  center: ScreenPoint,
  zoom: number,
): ScreenPoint {
  const scale = asset.entry.displayScale * zoom;
  return {
    x: center.x + (asset.entry.width / 2 - asset.entry.anchor[0]) * scale,
    y: center.y - (asset.entry.anchor[1] - 30) * scale,
  };
}

function drawLighthouseFire(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  zoom: number,
  psiColor: string,
  motion: PharosVilleCanvasMotion,
) {
  const flickerSpeed = motion.plan.lighthouseFireFlickerPerSecond;
  const flicker = motion.reducedMotion ? 0 : Math.sin(motion.timeSeconds * 14 * flickerSpeed) * 0.12
    + Math.sin(motion.timeSeconds * 21 * flickerSpeed) * 0.06;
  const scale = zoom * (1 + flicker);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(scale, scale);

  ctx.globalAlpha = 0.42;
  ctx.fillStyle = psiColor;
  ctx.beginPath();
  ctx.ellipse(0, 3, 24, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.55;
  ctx.fillStyle = psiColor;
  ctx.beginPath();
  ctx.arc(0, -6, 15, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
  drawPixelFlame(ctx, [
    [-11, 2],
    [-7, -11],
    [-3, -6],
    [0, -25],
    [5, -8],
    [10, -14],
    [13, 2],
    [6, 10],
    [-5, 10],
  ], psiColor);
  drawPixelFlame(ctx, [
    [-6, 4],
    [-3, -8],
    [0, -18],
    [4, -7],
    [8, 4],
    [3, 9],
    [-3, 9],
  ], "#ffcc62");
  drawPixelFlame(ctx, [
    [-3, 5],
    [0, -8],
    [4, 5],
    [0, 8],
  ], "#fff2a8");

  ctx.fillStyle = "#4b2d1d";
  ctx.fillRect(-12, 8, 24, 5);
  ctx.fillStyle = "#9a5a2a";
  ctx.fillRect(-9, 6, 18, 3);
  ctx.restore();
}

function drawLighthouseBeam(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  zoom: number,
  motion: PharosVilleCanvasMotion,
) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  const pulse = 0.11 + Math.sin(time * 0.7) * 0.025;
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.fillStyle = "#f5d176";
  ctx.beginPath();
  ctx.moveTo(point.x + 4 * zoom, point.y - 2 * zoom);
  ctx.lineTo(point.x + 250 * zoom, point.y - 74 * zoom);
  ctx.lineTo(point.x + 228 * zoom, point.y + 28 * zoom);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = pulse * 0.72;
  ctx.fillStyle = "#fff1bb";
  ctx.beginPath();
  ctx.moveTo(point.x - 5 * zoom, point.y);
  ctx.lineTo(point.x - 168 * zoom, point.y - 42 * zoom);
  ctx.lineTo(point.x - 154 * zoom, point.y + 25 * zoom);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 0.24;
  ctx.fillStyle = "#ffe2a0";
  ctx.beginPath();
  ctx.ellipse(point.x, point.y - 2 * zoom, 58 * zoom, 24 * zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPixelFlame(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
}

function drawBuildings({ camera, ctx }: DrawPharosVilleInput) {
  for (const [x, y, color, roof] of BUILDINGS) {
    const p = tileToScreen({ x, y }, camera);
    drawBuilding(ctx, p.x, p.y, color, roof, camera.zoom);
  }
}

function drawDecorativeLights({ camera, ctx, motion }: DrawPharosVilleInput) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  for (const light of VILLAGE_LIGHTS) {
    const p = tileToScreen(light, camera);
    drawLamp(ctx, p.x, p.y, camera.zoom * light.size, time + light.x * 0.31 + light.y * 0.17);
  }
}

function drawLamp(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, phase: number) {
  const glow = 0.22 + Math.sin(phase * 1.6) * 0.04;
  ctx.save();
  ctx.fillStyle = `rgba(255, 197, 95, ${glow})`;
  ctx.beginPath();
  ctx.ellipse(x, y - 7 * zoom, 12 * zoom, 7 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3f2d1f";
  ctx.fillRect(Math.round(x - zoom), Math.round(y - 12 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(4, Math.round(12 * zoom)));
  ctx.fillStyle = "#f5c766";
  ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y - 14 * zoom), Math.max(2, Math.round(4 * zoom)), Math.max(2, Math.round(3 * zoom)));
  ctx.restore();
}

function drawDocks({ assets, camera, ctx, world }: DrawPharosVilleInput) {
  ctx.strokeStyle = "#6d4c2f";
  ctx.lineWidth = 5;
  for (const dock of world.docks) {
    const p = tileToScreen(dock.tile, camera);
    const reach = (26 + dock.size * 6) * camera.zoom;
    const dockAsset = assets?.get(dock.assetId) ?? assets?.get("dock.wooden-pier");
    const dockScale = dockRenderScale(dock.size);
    if (dockAsset) {
      drawAsset(
        ctx,
        dockAsset,
        p.x + (dock.tile.x < 32 ? -reach * 0.25 : reach * 0.25),
        p.y + 10 * camera.zoom,
        camera.zoom * dockScale,
      );
    } else {
      ctx.lineWidth = (3 + dock.size) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (dock.tile.x < 32 ? -reach : reach), p.y + 10);
      ctx.stroke();
    }
  }
}

function dockRenderScale(size: number): number {
  return Math.max(0.43, Math.min(0.79, (0.66 + size * 0.092) * 0.5));
}

function drawShips({ assets, camera, ctx, motion, selectedTarget, shipMotionSamples, world }: DrawPharosVilleInput) {
  for (const ship of world.ships) {
    const sample = shipMotionSamples?.get(ship.id) ?? null;
    const p = tileToScreen(sample?.tile ?? ship.tile, camera);
    const phase = motion.plan.shipPhases.get(ship.id) ?? 0;
    const animated = !motion.reducedMotion && motion.plan.animatedShipIds.has(ship.id);
    const bob = animated ? Math.round(Math.sin(motion.timeSeconds * 0.7 + phase) * 2 * camera.zoom) : 0;
    const drawsWake = !motion.reducedMotion
      && (
        motion.plan.effectShipIds.has(ship.id)
        || selectedTarget?.id === ship.id
        || motion.plan.moverShipIds.has(ship.id)
      );
    if (drawsWake) {
      const changeIntensity = Math.min(1, Math.abs(ship.change24hPct ?? 0) * 18 + 0.2);
      const sampleIntensity = sample?.wakeIntensity ?? 0;
      const intensity = Math.max(sampleIntensity, motion.plan.moverShipIds.has(ship.id) ? changeIntensity : 0.18);
      drawWake(ctx, p.x, p.y + 8 * camera.zoom + bob, camera.zoom, intensity, sample?.heading ?? { x: -1, y: 0 });
    }

    const shipAsset = assets?.get(`ship.${ship.visual.hull}`);
    if (shipAsset) {
      const assetScale = camera.zoom * ship.visual.scale * 0.7;
      const drawY = p.y + 12 * camera.zoom + bob;
      drawAsset(ctx, shipAsset, p.x, drawY, assetScale);
      drawSailLogo({
        ctx,
        logo: assets?.getLogo(ship.logoSrc) ?? null,
        mark: ship.symbol,
        radius: 5.5 * assetScale,
        x: p.x + 9 * assetScale,
        y: drawY - 29 * assetScale,
      });
    } else {
      const proceduralScale = camera.zoom * ship.visual.scale;
      const drawY = p.y - 4 * camera.zoom + bob;
      drawShip(
        ctx,
        p.x,
        drawY,
        ship.visual.scale,
        PENNANTS[ship.visual.pennant] ?? PENNANTS.slate,
        SHIP_COLORS[ship.visual.hull],
        camera.zoom,
      );
      drawSailLogo({
        ctx,
        logo: assets?.getLogo(ship.logoSrc) ?? null,
        mark: ship.symbol,
        radius: 4.2 * proceduralScale,
        x: p.x + 7 * proceduralScale,
        y: drawY - 10 * proceduralScale,
      });
    }
  }
}

function drawClusters({ camera, ctx, world }: DrawPharosVilleInput) {
  for (const cluster of world.shipClusters) {
    const p = tileToScreen(cluster.tile, camera);
    const radius = Math.min(18, 7 + Math.sqrt(cluster.count) * 2) * camera.zoom;
    ctx.fillStyle = "rgba(255, 204, 98, 0.85)";
    ctx.beginPath();
    ctx.arc(p.x, p.y - 4, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#061721";
    ctx.font = `700 ${Math.max(10, 10 * camera.zoom)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(String(cluster.count), p.x, p.y);
    ctx.textAlign = "start";
  }
}

function drawGraves({ assets, camera, ctx, hoveredTarget, selectedTarget, world }: DrawPharosVilleInput) {
  for (const grave of world.graves) {
    const p = tileToScreen(grave.tile, camera);
    const causeColor = GRAVE_CAUSE_COLORS[grave.entry.causeOfDeath] ?? GRAVE_CAUSE_COLORS.abandoned;
    const emphasized = hoveredTarget?.id === grave.id || selectedTarget?.id === grave.id;
    const graveZoom = camera.zoom * grave.visual.scale;
    drawGraveShadow(ctx, p.x, p.y + 2 * camera.zoom, graveZoom, causeColor, emphasized);
    drawProceduralGrave(
      ctx,
      p.x,
      p.y,
      camera.zoom,
      causeColor,
      grave.visual.marker,
      grave.visual.scale,
      grave.entry.causeOfDeath,
    );
    drawGraveLogo({
      ctx,
      causeColor,
      emphasized,
      logo: assets?.getLogo(grave.logoSrc) ?? null,
      mark: grave.label,
      radius: Math.max(1.1, 2.55 * camera.zoom * Math.sqrt(grave.visual.scale)),
      x: p.x,
      y: p.y - (8.1 * grave.visual.scale + markerLogoOffset(grave.visual.marker)) * camera.zoom,
    });
  }
}

function drawGraveShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  causeColor: string,
  emphasized: boolean,
) {
  ctx.save();
  ctx.fillStyle = emphasized ? `${causeColor}66` : "rgba(13, 18, 14, 0.38)";
  ctx.beginPath();
  ctx.ellipse(x, y + 5 * zoom, 12 * zoom, 5 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function markerLogoOffset(marker: GraveNodeMarker) {
  if (marker === "cross") return 2.4;
  if (marker === "tablet") return 1.1;
  if (marker === "reliquary") return 1.7;
  if (marker === "ledger") return -0.8;
  return -0.2;
}

const GRAVE_STONE = {
  cap: "#9aa49a",
  dark: "#35413f",
  face: "#748078",
  highlight: "rgba(224, 232, 215, 0.28)",
  moss: "#416c3f",
  outline: "#1b2021",
  side: "#52605c",
  weather: "rgba(17, 23, 21, 0.26)",
} as const;

function drawProceduralGrave(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  causeColor: string,
  marker: GraveNodeMarker,
  markerScale: number,
  causeOfDeath: CauseOfDeath,
) {
  ctx.save();
  ctx.translate(x, y + 2 * zoom);
  ctx.scale(zoom * markerScale, zoom * markerScale);
  ctx.scale(1.1, 1.06);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawGraveTufts(ctx, marker);
  if (marker === "cross") {
    drawCrossMarker(ctx, causeColor, causeOfDeath);
  } else if (marker === "reliquary") {
    drawReliquaryMarker(ctx, causeColor, causeOfDeath);
  } else if (marker === "tablet") {
    drawTabletMarker(ctx, causeColor, causeOfDeath);
  } else if (marker === "ledger") {
    drawLedgerMarker(ctx, causeColor, causeOfDeath);
  } else {
    drawHeadstoneMarker(ctx, causeColor, causeOfDeath);
  }
  ctx.restore();
}

function drawHeadstoneMarker(ctx: CanvasRenderingContext2D, causeColor: string, causeOfDeath: CauseOfDeath) {
  drawGraveBase(ctx, 19);
  drawStonePolygon(ctx, [[8.2, -4], [10.8, -6], [10.8, -13.2], [8.2, -12.6]], GRAVE_STONE.side);

  ctx.beginPath();
  ctx.moveTo(-8.2, -4);
  ctx.lineTo(-8.2, -12.6);
  ctx.quadraticCurveTo(-7.6, -18.6, 0, -19.8);
  ctx.quadraticCurveTo(7.6, -18.6, 8.2, -12.6);
  ctx.lineTo(8.2, -4);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.face);

  drawStoneHighlight(ctx, -4.8, -15, 9.6);
  drawWeatherCracks(ctx, "headstone");
  drawCausePlaque(ctx, -5.6, -8.3, 11.2, 3.4, causeColor, causeOfDeath);
}

function drawTabletMarker(ctx: CanvasRenderingContext2D, causeColor: string, causeOfDeath: CauseOfDeath) {
  drawGraveBase(ctx, 22);
  drawStonePolygon(ctx, [[8.8, -4.4], [11.6, -6.4], [11.6, -20.6], [8.8, -19]], GRAVE_STONE.side);

  ctx.beginPath();
  ctx.moveTo(-8.8, -4.4);
  ctx.lineTo(-8.8, -20.8);
  ctx.lineTo(5.6, -20.8);
  ctx.lineTo(8.8, -18.4);
  ctx.lineTo(8.8, -4.4);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.face);

  drawStonePolygon(ctx, [[-8.8, -20.8], [-5.5, -20.8], [-8.8, -17.8]], GRAVE_STONE.dark, "rgba(27, 32, 33, 0.74)");
  drawStoneHighlight(ctx, -5.2, -15.6, 10.2);
  drawStoneHighlight(ctx, -4.3, -12.9, 8.2);
  drawWeatherCracks(ctx, "tablet");
  drawCausePlaque(ctx, -6, -8.9, 12, 3.3, causeColor, causeOfDeath);
}

function drawReliquaryMarker(ctx: CanvasRenderingContext2D, causeColor: string, causeOfDeath: CauseOfDeath) {
  drawGraveBase(ctx, 24);

  ctx.beginPath();
  ctx.moveTo(-10.4, -4.4);
  ctx.lineTo(-10.4, -14.4);
  ctx.quadraticCurveTo(-9.7, -21.2, 0, -23.8);
  ctx.quadraticCurveTo(9.7, -21.2, 10.4, -14.4);
  ctx.lineTo(10.4, -4.4);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.dark);

  ctx.beginPath();
  ctx.moveTo(-6.8, -4.6);
  ctx.lineTo(-6.8, -13.2);
  ctx.quadraticCurveTo(-6, -18.2, 0, -20.4);
  ctx.quadraticCurveTo(6, -18.2, 6.8, -13.2);
  ctx.lineTo(6.8, -4.6);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.face, "rgba(27, 32, 33, 0.8)");

  drawStonePolygon(ctx, [[-11.6, -4.2], [-8.2, -4.2], [-8.2, -15.2], [-11.6, -14.1]], GRAVE_STONE.side);
  drawStonePolygon(ctx, [[8.2, -4.2], [11.6, -4.2], [11.6, -14.1], [8.2, -15.2]], GRAVE_STONE.side);
  drawStoneHighlight(ctx, -4.3, -14, 8.6);
  drawWeatherCracks(ctx, "reliquary");
  drawCausePlaque(ctx, -5.9, -8.8, 11.8, 3.4, causeColor, causeOfDeath);
}

function drawCrossMarker(ctx: CanvasRenderingContext2D, causeColor: string, causeOfDeath: CauseOfDeath) {
  drawGraveBase(ctx, 19);
  drawGraveBase(ctx, 13, -4.2);

  ctx.beginPath();
  ctx.moveTo(-3.4, -23);
  ctx.lineTo(3.4, -23);
  ctx.lineTo(3.4, -17.6);
  ctx.lineTo(10.2, -18.2);
  ctx.lineTo(10.2, -12.8);
  ctx.lineTo(3.4, -12.8);
  ctx.lineTo(3.4, -4.4);
  ctx.lineTo(-3.4, -4.4);
  ctx.lineTo(-3.4, -12.8);
  ctx.lineTo(-10.2, -12.8);
  ctx.lineTo(-10.2, -18.2);
  ctx.lineTo(-3.4, -17.6);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.face);

  drawStonePolygon(ctx, [[3.4, -23], [5.8, -21.3], [5.8, -16.4], [10.2, -16.4], [10.2, -12.8], [3.4, -12.8]], GRAVE_STONE.side, "rgba(27, 32, 33, 0.74)");
  drawWeatherCracks(ctx, "cross");
  drawCausePlaque(ctx, -5.8, -7.5, 11.6, 3.2, causeColor, causeOfDeath);
}

function drawLedgerMarker(ctx: CanvasRenderingContext2D, causeColor: string, causeOfDeath: CauseOfDeath) {
  drawGraveBase(ctx, 21);
  drawStonePolygon(ctx, [[8.8, -4.2], [11.4, -6.1], [11.4, -16.6], [8.8, -15.7]], GRAVE_STONE.side);

  ctx.beginPath();
  ctx.moveTo(-8.8, -4.2);
  ctx.lineTo(-8.8, -17.4);
  ctx.lineTo(8.8, -16.1);
  ctx.lineTo(8.8, -4.2);
  ctx.closePath();
  fillStone(ctx, GRAVE_STONE.face);

  drawStoneHighlight(ctx, -5.4, -12.8, 10.8);
  drawStoneHighlight(ctx, -4.5, -10.1, 9.2);
  drawWeatherCracks(ctx, "ledger");
  drawCausePlaque(ctx, -6.2, -7.7, 12.4, 3.3, causeColor, causeOfDeath);
}

function drawGraveBase(ctx: CanvasRenderingContext2D, width: number, y = 0) {
  const half = width / 2;
  drawStonePolygon(ctx, [[-half, y - 1.5], [half, y - 1.5], [half + 2.4, y + 0.8], [-half + 2.2, y + 2.8]], GRAVE_STONE.dark);
  drawStonePolygon(ctx, [[-half + 2.2, y - 3.8], [half - 2.2, y - 3.8], [half + 1.5, y - 1.5], [-half, y - 1.5]], GRAVE_STONE.cap);
  drawStonePolygon(ctx, [[half - 2.2, y - 3.8], [half + 1.5, y - 1.5], [half + 2.4, y + 0.8], [half, y - 1.5]], GRAVE_STONE.side, "rgba(27, 32, 33, 0.78)");
}

function drawGraveTufts(ctx: CanvasRenderingContext2D, marker: GraveNodeMarker) {
  const left = marker === "ledger" ? -12 : -11;
  const right = marker === "ledger" ? 11 : 10;
  ctx.save();
  ctx.strokeStyle = GRAVE_STONE.moss;
  ctx.lineWidth = 1.1;
  for (const [tuftX, tuftY, height] of [[left, 3.3, 3.8], [left + 2.4, 2.6, 2.7], [right, 3.1, 3.4], [right - 2.7, 2.4, 2.5]] as const) {
    ctx.beginPath();
    ctx.moveTo(tuftX, tuftY);
    ctx.lineTo(tuftX - 1.6, tuftY - height);
    ctx.moveTo(tuftX, tuftY);
    ctx.lineTo(tuftX + 1.4, tuftY - height * 0.86);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStonePolygon(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<readonly [number, number]>,
  fill: string,
  stroke: string = GRAVE_STONE.outline,
) {
  ctx.beginPath();
  points.forEach(([pointX, pointY], index) => {
    if (index === 0) ctx.moveTo(pointX, pointY);
    else ctx.lineTo(pointX, pointY);
  });
  ctx.closePath();
  fillStone(ctx, fill, stroke);
}

function fillStone(ctx: CanvasRenderingContext2D, fill: string, stroke: string = GRAVE_STONE.outline) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 0.95;
  ctx.stroke();
}

function drawStoneHighlight(ctx: CanvasRenderingContext2D, x: number, y: number, width: number) {
  ctx.save();
  ctx.strokeStyle = GRAVE_STONE.highlight;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width * 0.56, y - 0.7);
  ctx.moveTo(x + width * 0.2, y + 3.1);
  ctx.lineTo(x + width, y + 2.1);
  ctx.stroke();
  ctx.restore();
}

function drawWeatherCracks(ctx: CanvasRenderingContext2D, marker: GraveNodeMarker) {
  ctx.save();
  ctx.strokeStyle = GRAVE_STONE.weather;
  ctx.lineWidth = 0.85;
  ctx.beginPath();
  if (marker === "cross") {
    ctx.moveTo(-0.8, -22.4);
    ctx.lineTo(1.1, -19.6);
    ctx.lineTo(-0.5, -17.6);
  } else if (marker === "ledger") {
    ctx.moveTo(3.2, -14.2);
    ctx.lineTo(1.1, -11.7);
    ctx.lineTo(3, -9.4);
  } else {
    ctx.moveTo(2.4, -20.2);
    ctx.lineTo(0.8, -17.8);
    ctx.lineTo(2.2, -15.4);
    ctx.moveTo(-4.2, -12.2);
    ctx.lineTo(-1.4, -13.2);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCausePlaque(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  causeColor: string,
  causeOfDeath: CauseOfDeath,
) {
  const chipWidth = Math.max(2.6, Math.min(3.8, height * 0.92));
  const chipHeight = Math.max(4.2, Math.min(6.3, width * 0.48));
  const chipX = x + width / 2 - chipWidth / 2;
  const chipY = y + height / 2 - chipHeight / 2;
  ctx.save();
  roundedRectPath(ctx, chipX, chipY, chipWidth, chipHeight, 1.2);
  ctx.fillStyle = hexToRgba(causeColor, 0.88);
  ctx.fill();
  ctx.strokeStyle = "rgba(15, 17, 17, 0.65)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.translate(chipX + chipWidth / 2, chipY + chipHeight / 2);
  drawCauseGlyph(ctx, causeOfDeath, Math.min(chipWidth, chipHeight));
  ctx.restore();
}

function drawCauseGlyph(ctx: CanvasRenderingContext2D, causeOfDeath: CauseOfDeath, size: number) {
  const span = Math.max(1.8, size * 0.54);
  ctx.save();
  ctx.strokeStyle = "rgba(15, 17, 17, 0.72)";
  ctx.fillStyle = "rgba(15, 17, 17, 0.72)";
  ctx.lineWidth = 0.62;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (causeOfDeath === "algorithmic-failure") {
    ctx.moveTo(-span, -0.5);
    ctx.lineTo(-span * 0.35, 0.55);
    ctx.lineTo(span * 0.15, -0.55);
    ctx.lineTo(span, 0.55);
    ctx.stroke();
  } else if (causeOfDeath === "liquidity-drain") {
    ctx.moveTo(0, -span * 0.75);
    ctx.lineTo(0, span * 0.6);
    ctx.moveTo(-span * 0.52, span * 0.1);
    ctx.lineTo(0, span * 0.65);
    ctx.lineTo(span * 0.52, span * 0.1);
    ctx.stroke();
  } else if (causeOfDeath === "counterparty-failure") {
    ctx.rect(-span * 0.75, -span * 0.55, span * 1.5, span * 1.1);
    ctx.moveTo(-span * 0.25, -span * 0.55);
    ctx.lineTo(-span * 0.25, span * 0.55);
    ctx.stroke();
  } else if (causeOfDeath === "regulatory") {
    ctx.moveTo(0, -span * 0.8);
    ctx.lineTo(0, span * 0.78);
    ctx.moveTo(-span * 0.7, -span * 0.16);
    ctx.lineTo(span * 0.7, -span * 0.16);
    ctx.stroke();
  } else {
    ctx.moveTo(-span * 0.7, 0);
    ctx.lineTo(span * 0.7, 0);
    ctx.stroke();
  }
  ctx.restore();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawGraveLogo(input: {
  causeColor: string;
  ctx: CanvasRenderingContext2D;
  emphasized: boolean;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  mark: string;
  radius: number;
  x: number;
  y: number;
}) {
  const { causeColor, ctx, emphasized, logo, mark, radius, x, y } = input;
  const safeRadius = Math.max(2, radius);
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  if (emphasized) {
    ctx.fillStyle = `${causeColor}55`;
    ctx.beginPath();
    ctx.arc(0, 0, safeRadius + 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#e9dfcb";
  ctx.strokeStyle = "#17131a";
  ctx.lineWidth = Math.max(0.75, safeRadius * 0.2);
  ctx.beginPath();
  ctx.arc(0, 0, safeRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = causeColor;
  ctx.lineWidth = Math.max(0.65, safeRadius * 0.14);
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, safeRadius - 0.75), 0, Math.PI * 2);
  ctx.stroke();

  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, safeRadius - 1.1), 0, Math.PI * 2);
    ctx.clip();
    const size = Math.round(Math.max(2, (safeRadius - 1.1) * 2));
    ctx.drawImage(logo.image, -size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = "#17212b";
    ctx.font = `700 ${Math.max(4, safeRadius * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.slice(0, 2).toUpperCase(), 0, 0.35);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function drawCemeteryMist({ camera, ctx, motion }: DrawPharosVilleInput) {
  const drift = motion.reducedMotion ? 0 : Math.sin(motion.timeSeconds * 0.38) * 8 * camera.zoom;
  const bands = [
    { alpha: 0.13, rx: 45, ry: 4.2, tile: { x: 18.9, y: 44.8 } },
    { alpha: 0.1, rx: 58, ry: 4.2, tile: { x: 22.8, y: 45.4 } },
    { alpha: 0.09, rx: 42, ry: 3.6, tile: { x: 26.7, y: 39.2 } },
    { alpha: 0.08, rx: 37, ry: 3, tile: { x: 17.25, y: 39.0 } },
  ] as const;

  ctx.save();
  for (const band of bands) {
    const p = tileToScreen(cemeteryContextTile(band.tile), camera);
    ctx.strokeStyle = `rgba(205, 218, 194, ${band.alpha})`;
    ctx.lineWidth = Math.max(1, 3 * camera.zoom);
    ctx.beginPath();
    ctx.ellipse(p.x + drift, p.y, band.rx * camera.zoom, band.ry * camera.zoom, -0.08, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBirds({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  const origin = world.lighthouse.tile;
  ctx.save();
  for (const bird of BIRDS) {
    const angle = time * bird.speed + bird.phase;
    const tile = {
      x: origin.x + bird.anchorX + Math.cos(angle) * bird.radiusX,
      y: origin.y + bird.anchorY + Math.sin(angle) * bird.radiusY,
    };
    const p = tileToScreen(tile, camera);
    const wing = motion.reducedMotion ? 0.34 : 0.34 + Math.sin(time * 5.2 + bird.phase) * 0.18;
    drawBird(ctx, p.x, p.y - 46 * camera.zoom * bird.scale, camera.zoom * bird.scale, wing, Math.cos(angle));
  }
  ctx.restore();
}

function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, wing: number, bank: number) {
  const direction = bank >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(direction, 1);
  ctx.strokeStyle = "rgba(241, 235, 207, 0.86)";
  ctx.lineWidth = Math.max(1, 1.8 * zoom);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-12 * zoom, 0);
  ctx.quadraticCurveTo(-6 * zoom, -13 * zoom * wing, -1 * zoom, 0);
  ctx.quadraticCurveTo(6 * zoom, -13 * zoom * wing, 13 * zoom, -1 * zoom);
  ctx.stroke();

  ctx.fillStyle = "rgba(24, 30, 31, 0.74)";
  ctx.beginPath();
  ctx.ellipse(1 * zoom, 1 * zoom, 3.2 * zoom, 1.6 * zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(27, 35, 37, 0.38)";
  ctx.lineWidth = Math.max(1, 1.1 * zoom);
  ctx.beginPath();
  ctx.moveTo(-5 * zoom, 1 * zoom);
  ctx.lineTo(6 * zoom, 1 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawSelection({ ctx, hoveredTarget, selectedTarget }: DrawPharosVilleInput) {
  if (hoveredTarget) drawSelectionRing(ctx, hoveredTarget, "rgba(128, 214, 206, 0.85)");
  if (selectedTarget) drawSelectionRing(ctx, selectedTarget, "rgba(255, 204, 98, 0.95)");
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - height / 2);
  ctx.lineTo(x + width / 2, y);
  ctx.lineTo(x, y + height / 2);
  ctx.lineTo(x - width / 2, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, roof: string, zoom: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = color;
  ctx.fillRect(-8, -22, 16, 18);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(-10, -22);
  ctx.lineTo(0, -34);
  ctx.lineTo(10, -22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, sail: string, hull: string, zoom: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * zoom, scale * zoom);
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(14, 0);
  ctx.lineTo(8, 8);
  ctx.lineTo(-9, 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#271b12";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#5c4932";
  ctx.fillRect(-1, -22, 2, 23);
  ctx.fillStyle = sail;
  ctx.beginPath();
  ctx.moveTo(1, -21);
  ctx.lineTo(1, -3);
  ctx.lineTo(14, -6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSailLogo(input: {
  ctx: CanvasRenderingContext2D;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  mark: string;
  radius: number;
  x: number;
  y: number;
}) {
  const { ctx, logo, mark, radius, x, y } = input;
  const safeRadius = Math.max(2.5, radius);
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.fillStyle = "rgba(247, 244, 218, 0.92)";
  ctx.strokeStyle = "#2b1c12";
  ctx.lineWidth = Math.max(1, safeRadius * 0.18);
  ctx.beginPath();
  ctx.arc(0, 0, safeRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, safeRadius - 1), 0, Math.PI * 2);
    ctx.clip();
    const size = Math.round((safeRadius - 1) * 2);
    ctx.drawImage(logo.image, -size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = "#102333";
    ctx.font = `700 ${Math.max(5, safeRadius * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.slice(0, 2).toUpperCase(), 0, 0.4);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function drawSelectionRing(ctx: CanvasRenderingContext2D, target: HitTarget, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(target.rect.x, target.rect.y, target.rect.width, target.rect.height);
}

function drawAsset(
  ctx: CanvasRenderingContext2D,
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>>,
  x: number,
  y: number,
  scale: number,
) {
  const { entry, image } = asset;
  const width = entry.width * entry.displayScale * scale;
  const height = entry.height * entry.displayScale * scale;
  ctx.drawImage(
    image,
    Math.round(x - entry.anchor[0] * entry.displayScale * scale),
    Math.round(y - entry.anchor[1] * entry.displayScale * scale),
    Math.round(width),
    Math.round(height),
  );
}

function drawWake(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  intensity: number,
  heading: { x: number; y: number },
) {
  const headingMagnitude = Math.hypot(heading.x, heading.y);
  const forward = headingMagnitude > 0
    ? { x: heading.x / headingMagnitude, y: heading.y / headingMagnitude }
    : { x: -1, y: 0 };
  const wakeDirection = { x: -forward.x, y: -forward.y };
  const cross = { x: -forward.y, y: forward.x };
  ctx.save();
  ctx.strokeStyle = `rgba(186, 231, 225, ${0.26 + intensity * 0.16})`;
  ctx.lineWidth = Math.max(1, zoom);
  for (let index = 0; index < 3; index += 1) {
    const offset = index * 7 * zoom;
    const baseDistance = (16 + offset) * zoom;
    const spread = (4 + index * 2) * zoom;
    const length = (12 + index * 3) * zoom;
    ctx.beginPath();
    ctx.moveTo(
      x + wakeDirection.x * baseDistance + cross.x * spread,
      y + wakeDirection.y * baseDistance + cross.y * spread,
    );
    ctx.lineTo(
      x + wakeDirection.x * (baseDistance + length) + cross.x * spread * 1.45,
      y + wakeDirection.y * (baseDistance + length) + cross.y * spread * 1.45,
    );
    ctx.stroke();
  }
  ctx.restore();
}
