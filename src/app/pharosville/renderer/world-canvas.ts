import type { PharosVilleMotionPlan, ShipMotionSample } from "../systems/motion";
import { waterTerrainStyle } from "../systems/palette";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import {
  CEMETERY_CENTER,
  CEMETERY_RADIUS,
  isElevatedTileKind,
  isShoreTileKind,
  isWaterTileKind,
  MAX_TILE_X,
  MAX_TILE_Y,
} from "../systems/world-layout";
import type { PharosVilleWorld, TerrainKind } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import type { HitTarget } from "./hit-testing";
import { CAUSE_HEX, type CauseOfDeath } from "@shared/lib/cause-of-death";

const TILE_COLORS: Record<string, string> = {
  beach: "#c7a66c",
  cliff: "#5a625d",
  grass: "#617444",
  hill: "#76814d",
  land: "#b89155",
  road: "#7a5938",
  rock: "#6f7369",
  shore: "#aa8755",
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
  shoal: "rgba(219, 177, 104, 0.24)",
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

const VILLAGE_LIGHTS = [
  { x: 30.1, y: 31.8, size: 0.54 },
  { x: 33.2, y: 30.1, size: 0.5 },
  { x: 37.2, y: 29.5, size: 0.52 },
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
  dawn: {
    horizon: "#c9824e",
    lower: "#10182a",
    mist: "rgba(255, 213, 158, 0.2)",
    moonAlpha: 0.12,
    starAlpha: 0.16,
    sunAlpha: 0.54,
    top: "#253d5a",
    waterVeil: "rgba(62, 86, 108, 0.14)",
  },
  day: {
    horizon: "#d9ad67",
    lower: "#173654",
    mist: "rgba(255, 225, 164, 0.2)",
    moonAlpha: 0,
    starAlpha: 0,
    sunAlpha: 0.8,
    top: "#496f8b",
    waterVeil: "rgba(52, 101, 121, 0.16)",
  },
  dusk: {
    horizon: "#b86f4d",
    lower: "#101425",
    mist: "rgba(246, 177, 126, 0.18)",
    moonAlpha: 0.34,
    starAlpha: 0.28,
    sunAlpha: 0.34,
    top: "#1b2d4f",
    waterVeil: "rgba(32, 55, 83, 0.18)",
  },
  night: {
    horizon: "#14294a",
    lower: "#070910",
    mist: "rgba(200, 219, 205, 0.12)",
    moonAlpha: 0.74,
    starAlpha: 0.58,
    sunAlpha: 0,
    top: "#100b12",
    waterVeil: "rgba(7, 9, 16, 0.22)",
  },
} as const;

const SKY_STARS = [
  { x: 0.11, y: 0.1, size: 1.1 },
  { x: 0.14, y: 0.31, size: 0.7 },
  { x: 0.18, y: 0.22, size: 0.8 },
  { x: 0.23, y: 0.07, size: 0.6 },
  { x: 0.31, y: 0.14, size: 1 },
  { x: 0.36, y: 0.28, size: 0.65 },
  { x: 0.44, y: 0.08, size: 0.7 },
  { x: 0.51, y: 0.24, size: 0.9 },
  { x: 0.58, y: 0.18, size: 1.2 },
  { x: 0.63, y: 0.06, size: 0.6 },
  { x: 0.69, y: 0.09, size: 0.8 },
  { x: 0.75, y: 0.25, size: 0.75 },
  { x: 0.83, y: 0.16, size: 1 },
  { x: 0.92, y: 0.26, size: 0.7 },
] as const;

const SKY_CONSTELLATIONS = [
  [0, 2],
  [2, 4],
  [4, 7],
  [8, 10],
  [10, 11],
  [11, 13],
] as const;

const SKY_CLOUDS = [
  { alpha: 0.22, rx: 170, ry: 18, x: 0.2, y: 0.36 },
  { alpha: 0.16, rx: 210, ry: 22, x: 0.62, y: 0.33 },
  { alpha: 0.14, rx: 140, ry: 16, x: 0.84, y: 0.43 },
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
const CEMETERY_CONTEXT_SOURCE_CENTER = { x: 22.15, y: 41.7 } as const;

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
  const { ctx } = input;
  ctx.imageSmoothingEnabled = false;
  drawSky(input);

  drawTerrain(input);
  drawAtmosphere(input);
  drawCemeteryGround(input);
  drawLighthouseHeadland(input);
  drawCemeteryContext(input);
  drawThematicBuildings(input);
  drawDocks(input);
  drawAreaSigns(input);
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
  const state = skyState(motion);
  const mood = state.mood;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, mood.top);
  gradient.addColorStop(0.52, mood.horizon);
  gradient.addColorStop(1, mood.lower);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  drawCelestialArc(ctx, width, height, camera.zoom, state);
  drawSun(ctx, width, height, camera.zoom, state);
  drawMoon(ctx, width, height, camera.zoom, state);
  drawStars(ctx, width, height, camera.zoom, state, motion);
  drawSkyClouds(ctx, width, height, camera.zoom, state, motion);

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

  ctx.globalAlpha = 1;
  ctx.fillStyle = mood.waterVeil;
  ctx.fillRect(0, Math.round(height * 0.52), width, Math.ceil(height * 0.48));
  ctx.restore();
}

function skyState(motion: PharosVilleCanvasMotion) {
  const progress = motion.reducedMotion
    ? 0.82
    : ((motion.timeSeconds * 0.006) % 1 + 1) % 1;
  const mood = progress < 0.18
    ? SKY_MOODS.dawn
    : progress < 0.48
      ? SKY_MOODS.day
      : progress < 0.64
        ? SKY_MOODS.dusk
        : SKY_MOODS.night;
  return { mood, progress };
}

function skyPathPoint(width: number, height: number, progress: number, phaseOffset = 0) {
  const angle = (progress + phaseOffset) * Math.PI * 2;
  return {
    x: width * (0.5 + Math.cos(angle - Math.PI) * 0.38),
    y: height * (0.29 + Math.sin(angle - Math.PI) * 0.19),
  };
}

function drawCelestialArc(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  state: ReturnType<typeof skyState>,
) {
  ctx.save();
  ctx.strokeStyle = `rgba(246, 225, 176, ${0.08 + state.mood.starAlpha * 0.08})`;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.setLineDash([8 * zoom, 10 * zoom]);
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.32, width * 0.38, height * 0.17, -0.05, Math.PI * 1.02, Math.PI * 1.98);
  ctx.stroke();
  ctx.restore();
}

function drawSun(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  state: ReturnType<typeof skyState>,
) {
  if (state.mood.sunAlpha <= 0) return;
  const point = skyPathPoint(width, height, state.progress);
  const radius = 18 * zoom;
  ctx.save();
  const glow = ctx.createRadialGradient(point.x, point.y, radius * 0.3, point.x, point.y, radius * 4.6);
  glow.addColorStop(0, `rgba(255, 220, 128, ${0.56 * state.mood.sunAlpha})`);
  glow.addColorStop(0.42, `rgba(255, 164, 90, ${0.2 * state.mood.sunAlpha})`);
  glow.addColorStop(1, "rgba(255, 164, 90, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius * 4.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = state.mood.sunAlpha;
  ctx.fillStyle = "#ffd36f";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 244, 190, 0.58)";
  ctx.beginPath();
  ctx.arc(point.x - 5 * zoom, point.y - 6 * zoom, radius * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMoon(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  state: ReturnType<typeof skyState>,
) {
  if (state.mood.moonAlpha <= 0) return;
  const point = skyPathPoint(width, height, state.progress, 0.5);
  const radius = 14 * zoom;
  ctx.save();
  const glow = ctx.createRadialGradient(point.x, point.y, radius * 0.5, point.x, point.y, radius * 4.2);
  glow.addColorStop(0, `rgba(220, 231, 220, ${0.32 * state.mood.moonAlpha})`);
  glow.addColorStop(1, "rgba(220, 231, 220, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius * 4.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = state.mood.moonAlpha;
  ctx.fillStyle = "#e5dcc0";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(point.x + radius * 0.44, point.y - radius * 0.08, radius * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(229, 220, 192, 0.26)";
  ctx.beginPath();
  ctx.arc(point.x - radius * 0.3, point.y - radius * 0.22, radius * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  state: ReturnType<typeof skyState>,
  motion: PharosVilleCanvasMotion,
) {
  if (state.mood.starAlpha <= 0) return;
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  ctx.save();
  ctx.globalAlpha = state.mood.starAlpha;
  ctx.strokeStyle = "rgba(245, 231, 184, 0.22)";
  ctx.lineWidth = Math.max(1, zoom * 0.75);
  for (const [from, to] of SKY_CONSTELLATIONS) {
    const start = SKY_STARS[from];
    const end = SKY_STARS[to];
    if (!start || !end) continue;
    ctx.beginPath();
    ctx.moveTo(width * start.x, height * start.y);
    ctx.lineTo(width * end.x, height * end.y);
    ctx.stroke();
  }

  for (const [index, star] of SKY_STARS.entries()) {
    const twinkle = motion.reducedMotion ? 1 : 0.78 + Math.sin(time * 0.9 + index * 1.7) * 0.22;
    const size = Math.max(1, star.size * zoom * twinkle);
    const x = Math.round(width * star.x);
    const y = Math.round(height * star.y);
    ctx.fillStyle = index % 4 === 0 ? "#fff3c7" : "#e9f0d8";
    ctx.fillRect(x, y, size, size);
    if (star.size > 0.95) {
      ctx.fillRect(x - Math.round(size), y, size, Math.max(1, size * 0.45));
      ctx.fillRect(x, y - Math.round(size), Math.max(1, size * 0.45), size);
    }
  }
  ctx.restore();
}

function drawSkyClouds(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  state: ReturnType<typeof skyState>,
  motion: PharosVilleCanvasMotion,
) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  ctx.save();
  for (const cloud of SKY_CLOUDS) {
    const drift = Math.sin(time * 0.035 + cloud.x * 8) * 22 * zoom;
    ctx.strokeStyle = state.mood.mist.replace(/[\d.]+\)$/, `${cloud.alpha})`);
    ctx.lineWidth = Math.max(1, 5 * zoom);
    ctx.beginPath();
    ctx.ellipse(width * cloud.x + drift, height * cloud.y, cloud.rx * zoom, cloud.ry * zoom, -0.08, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
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
  const waterStyle = waterTerrainStyle(value);
  if (waterStyle) return waterStyle.base;
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
  const style = waterTerrainStyle(value) ?? waterTerrainStyle("water")!;
  drawDiamond(ctx, x, y, width, height, style.base);
  drawWaterDepthOverlay(ctx, x, y, zoom, width, height, tileX, tileY, style.inner);
  drawWaterTerrainTexture(ctx, x, y, zoom, style.texture, tileX, tileY, motion);

  if ((tileX * 13 + tileY * 17) % 5 !== 0) return;
  const wave = motion.reducedMotion
    ? 0.2
    : 0.16 + Math.sin(motion.timeSeconds * 1.25 + tileX * 0.27 + tileY * 0.19) * 0.05;
  ctx.save();
  ctx.strokeStyle = style.wave.replace(/[\d.]+\)$/, `${Math.max(0.08, wave)})`);
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

function drawWaterDepthOverlay(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  width: number,
  height: number,
  tileX: number,
  tileY: number,
  fill: string,
) {
  drawDiamond(ctx, x, y + 1 * zoom, width * 0.88, height * 0.76, fill);
  const shimmer = ((tileX * 11 + tileY * 7) % 9 - 4) / 4;
  if (shimmer === 0) return;
  ctx.save();
  const overlayFill = shimmer > 0
    ? `rgba(218, 236, 224, ${0.018 * shimmer})`
    : `rgba(1, 8, 18, ${-0.018 * shimmer})`;
  ctx.fillStyle = overlayFill;
  drawDiamond(ctx, x, y, width * 0.98, height * 0.9, overlayFill);
  ctx.restore();
}

function drawWaterTerrainTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  texture: NonNullable<ReturnType<typeof waterTerrainStyle>>["texture"],
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  if (texture === "alert") {
    drawAlertChannelTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "brackish") {
    drawBrackishWaterTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "deep") {
    drawDeepSeaTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "fog") {
    drawFogWaterTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "frozen") {
    drawNorthFrozeWaterTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "harbor") {
    drawHarborWaterTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "storm") {
    drawDangerStraitTexture(ctx, x, y, zoom, tileX, tileY, motion);
    return;
  }
  if (texture === "warning") {
    drawWarningShoalTexture(ctx, x, y, zoom, tileX, tileY, motion);
  }
}

function drawNorthFrozeWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const frost = motion.reducedMotion ? 0.24 : 0.2 + Math.sin(motion.timeSeconds * 0.9 + tileX * 0.31 + tileY * 0.41) * 0.06;
  ctx.save();
  ctx.strokeStyle = `rgba(210, 244, 255, ${Math.max(0.14, frost)})`;
  ctx.lineWidth = Math.max(1, 1.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 12 * zoom, y - 3 * zoom);
  ctx.lineTo(x - 3 * zoom, y + 1 * zoom);
  ctx.lineTo(x + 8 * zoom, y - 2 * zoom);
  ctx.moveTo(x - 7 * zoom, y + 6 * zoom);
  ctx.lineTo(x + 3 * zoom, y + 3 * zoom);
  ctx.lineTo(x + 12 * zoom, y + 7 * zoom);
  ctx.stroke();
  if ((tileX * 3 + tileY * 5) % 4 === 0) {
    ctx.fillStyle = "rgba(226, 250, 255, 0.3)";
    ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y), Math.max(1, Math.round(4 * zoom)), Math.max(1, Math.round(2 * zoom)));
  }
  ctx.restore();
}

function drawHarborWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const pulse = motion.reducedMotion ? 0.16 : 0.13 + Math.sin(motion.timeSeconds * 0.85 + tileX * 0.23 + tileY * 0.17) * 0.04;
  ctx.save();
  ctx.strokeStyle = `rgba(199, 232, 219, ${Math.max(0.08, pulse)})`;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 10 * zoom, y + 2 * zoom);
  ctx.lineTo(x + 8 * zoom, y + 5 * zoom);
  if ((tileX + tileY) % 3 === 0) {
    ctx.moveTo(x - 5 * zoom, y - 2 * zoom);
    ctx.lineTo(x + 5 * zoom, y + 1 * zoom);
  }
  ctx.stroke();
  if ((tileX * 7 + tileY * 5) % 6 === 0) {
    const reflection = "rgba(154, 205, 184, 0.2)";
    ctx.fillStyle = reflection;
    drawDiamond(ctx, x + 2 * zoom, y + 2 * zoom, 8 * zoom, 3 * zoom, reflection);
  }
  ctx.restore();
}

function drawBrackishWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const murk = motion.reducedMotion ? 0.18 : 0.16 + Math.sin(motion.timeSeconds * 0.55 + tileX * 0.41) * 0.04;
  ctx.save();
  ctx.fillStyle = `rgba(80, 91, 57, ${Math.max(0.1, murk)})`;
  if ((tileX * 3 + tileY * 11) % 4 === 0) {
    drawDiamond(ctx, x - 3 * zoom, y + 2 * zoom, 10 * zoom, 4 * zoom, ctx.fillStyle);
  }
  ctx.strokeStyle = "rgba(146, 164, 126, 0.2)";
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 9 * zoom, y + 5 * zoom);
  ctx.lineTo(x - 3 * zoom, y + 1 * zoom);
  ctx.lineTo(x + 4 * zoom, y + 5 * zoom);
  if ((tileX + tileY) % 2 === 0) {
    ctx.moveTo(x + 7 * zoom, y - 2 * zoom);
    ctx.lineTo(x + 11 * zoom, y + 1 * zoom);
  }
  ctx.stroke();
  ctx.restore();
}

function drawDeepSeaTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  if ((tileX * 5 + tileY * 7) % 6 !== 0) return;
  const glint = motion.reducedMotion ? 0.08 : 0.06 + Math.sin(motion.timeSeconds * 0.6 + tileX * 0.2 + tileY * 0.31) * 0.025;
  ctx.save();
  ctx.strokeStyle = `rgba(117, 153, 184, ${Math.max(0.035, glint)})`;
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 8 * zoom, y);
  ctx.lineTo(x + 6 * zoom, y + 3 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawFogWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const veil = motion.reducedMotion ? 0.16 : 0.12 + Math.sin(motion.timeSeconds * 0.42 + tileY * 0.33) * 0.04;
  ctx.save();
  ctx.strokeStyle = `rgba(205, 216, 211, ${Math.max(0.08, veil)})`;
  ctx.lineWidth = Math.max(1, 1.4 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 13 * zoom, y - 1 * zoom);
  ctx.lineTo(x + 12 * zoom, y + 3 * zoom);
  if ((tileX * 5 + tileY * 3) % 5 === 0) {
    ctx.moveTo(x - 7 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 8 * zoom, y + 8 * zoom);
  }
  ctx.stroke();
  ctx.restore();
}

function drawAlertChannelTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const pulse = motion.reducedMotion ? 0.16 : 0.14 + Math.sin(motion.timeSeconds * 1.1 + tileX * 0.31) * 0.04;
  ctx.save();
  ctx.strokeStyle = `rgba(236, 202, 112, ${pulse})`;
  ctx.lineWidth = Math.max(1, 1.1 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 10 * zoom, y - 3 * zoom);
  ctx.lineTo(x + 9 * zoom, y + 2 * zoom);
  if ((tileX + tileY) % 2 === 0) {
    ctx.moveTo(x - 3 * zoom, y + 5 * zoom);
    ctx.lineTo(x + 8 * zoom, y + 8 * zoom);
  }
  ctx.stroke();
  ctx.restore();
}

function drawWarningShoalTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const chop = motion.reducedMotion ? 0.2 : 0.18 + Math.sin(motion.timeSeconds * 1.6 + tileY * 0.37) * 0.05;
  ctx.save();
  ctx.strokeStyle = `rgba(226, 217, 177, ${chop})`;
  ctx.lineWidth = Math.max(1, 1.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y - 2 * zoom);
  ctx.lineTo(x - 4 * zoom, y + 2 * zoom);
  ctx.lineTo(x + 3 * zoom, y - 1 * zoom);
  ctx.moveTo(x + 3 * zoom, y + 5 * zoom);
  ctx.lineTo(x + 11 * zoom, y + 8 * zoom);
  ctx.stroke();
  if ((tileX * 5 + tileY * 7) % 4 === 0) {
    ctx.fillStyle = TERRAIN_TEXTURE.shoal;
    ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y + 1 * zoom), Math.max(1, Math.round(4 * zoom)), Math.max(1, Math.round(2 * zoom)));
  }
  ctx.restore();
}

function drawDangerStraitTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const whitecap = motion.reducedMotion ? 0.22 : 0.18 + Math.sin(motion.timeSeconds * 2.1 + tileX * 0.43 + tileY * 0.29) * 0.08;
  ctx.save();
  ctx.strokeStyle = `rgba(224, 236, 226, ${Math.max(0.12, whitecap)})`;
  ctx.lineWidth = Math.max(1, 1.4 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 12 * zoom, y - 4 * zoom);
  ctx.lineTo(x - 6 * zoom, y - 1 * zoom);
  ctx.lineTo(x - 1 * zoom, y - 5 * zoom);
  ctx.moveTo(x + 2 * zoom, y + 4 * zoom);
  ctx.lineTo(x + 8 * zoom, y + 7 * zoom);
  ctx.lineTo(x + 13 * zoom, y + 3 * zoom);
  ctx.stroke();
  if ((tileX + tileY) % 3 === 0) {
    ctx.strokeStyle = "rgba(7, 12, 21, 0.34)";
    ctx.beginPath();
    ctx.moveTo(x - 13 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 12 * zoom, y - 5 * zoom);
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
  const mood = skyState(motion).mood;
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
    x: CEMETERY_CENTER.x + (tile.x - CEMETERY_CONTEXT_SOURCE_CENTER.x) * CEMETERY_CONTEXT_SCALE,
    y: CEMETERY_CENTER.y + (tile.y - CEMETERY_CONTEXT_SOURCE_CENTER.y) * CEMETERY_CONTEXT_SCALE,
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

function drawThematicBuildings({ assets, camera, ctx, motion, world }: DrawPharosVilleInput) {
  const buildings = [...world.buildings].toSorted((a, b) => (
    a.tile.x + a.tile.y - (b.tile.x + b.tile.y)
      || a.tile.y - b.tile.y
      || a.id.localeCompare(b.id)
  ));
  for (const building of buildings) {
    const point = tileToScreen(building.tile, camera);
    const drawPoint = { x: point.x, y: point.y + 4 * camera.zoom };
    const asset = assets?.get(building.assetId);
    const assetScale = camera.zoom * 0.58 * building.visual.scale;
    drawBuildingStatusGlow(ctx, building, drawPoint, camera.zoom);
    if (asset) {
      drawAsset(ctx, asset, drawPoint.x, drawPoint.y, assetScale);
    } else {
      drawFallbackDataBuilding(ctx, building, drawPoint, camera.zoom);
    }
    drawBuildingProceduralEffects(ctx, building, drawPoint, camera.zoom, motion);
  }
}

function drawBuildingStatusGlow(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
) {
  const intensity = Math.max(building.visual.intensity, building.visual.secondaryIntensity, building.visual.tertiaryIntensity);
  ctx.save();
  ctx.globalAlpha = 0.16 + intensity * 0.22;
  ctx.fillStyle = hexToRgba(building.visual.accent, 0.7);
  ctx.beginPath();
  ctx.ellipse(point.x, point.y - 11 * zoom, 46 * zoom, 18 * zoom, -0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFallbackDataBuilding(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = "rgba(8, 11, 12, 0.35)";
  ctx.beginPath();
  ctx.ellipse(0, 3, 32, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d2bf86";
  roundedRectPath(ctx, -26, -54, 52, 44, 3);
  ctx.fill();
  ctx.fillStyle = building.visual.accent;
  ctx.fillRect(-18, -62, 36, 10);
  ctx.fillStyle = "#3c2a1d";
  ctx.fillRect(-7, -21, 14, 21);
  ctx.restore();
}

function drawBuildingProceduralEffects(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  motion: PharosVilleCanvasMotion,
) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  if (building.buildingType === "mint-burn-foundry") {
    drawFoundryEffects(ctx, building, point, zoom, time, motion.reducedMotion);
  } else if (building.buildingType === "exit-route-gatehouse") {
    drawGatehouseEffects(ctx, building, point, zoom, time, motion.reducedMotion);
  } else if (building.buildingType === "yield-orchard-moonwell") {
    drawYieldOrchardEffects(ctx, building, point, zoom, time, motion.reducedMotion);
  } else {
    drawDependencyLoomEffects(ctx, building, point, zoom, time, motion.reducedMotion);
  }
  drawBuildingDataFog(ctx, building, point, zoom, time);
}

function drawFoundryEffects(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  time: number,
  reducedMotion: boolean,
) {
  const activity = building.status === "stale" || building.status === "unavailable" ? building.visual.intensity * 0.28 : building.visual.intensity;
  const mint = building.visual.secondaryIntensity;
  const burn = building.visual.tertiaryIntensity;
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);

  ctx.fillStyle = `rgba(255, 105, 38, ${0.18 + burn * 0.45})`;
  ctx.beginPath();
  ctx.ellipse(21, -43, 17 + burn * 6, 10 + burn * 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 202, 85, ${0.16 + mint * 0.34})`;
  ctx.beginPath();
  ctx.ellipse(-11, -29, 24 + mint * 8, 8 + mint * 3, -0.15, 0, Math.PI * 2);
  ctx.fill();

  const thump = reducedMotion ? 0 : Math.max(0, Math.sin(time * (2.5 + activity * 4))) * 3 * activity;
  ctx.fillStyle = "#51341d";
  ctx.fillRect(-25, -49 + thump, 20, 5);
  ctx.fillStyle = "#d8a642";
  ctx.fillRect(-20, -44 + thump, 10, 11 - thump * 0.6);

  const sparkCount = Math.round(2 + mint * 8);
  ctx.fillStyle = "#ffe08b";
  for (let index = 0; index < sparkCount; index += 1) {
    const phase = reducedMotion ? 0.45 : (time * (0.9 + mint) + index * 0.21) % 1;
    const x = -5 + index * 4 - phase * 13;
    const y = -36 - phase * 24 + Math.sin(index * 1.7) * 4;
    ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
  }

  const smokeCount = Math.round(2 + activity * 5);
  for (let index = 0; index < smokeCount; index += 1) {
    const phase = reducedMotion ? index / Math.max(1, smokeCount) : (time * 0.22 + index * 0.18) % 1;
    ctx.fillStyle = `rgba(122, 126, 118, ${0.2 * (1 - phase) + 0.06})`;
    ctx.beginPath();
    ctx.ellipse(-28 - phase * 8 + Math.sin(index) * 3, -72 - phase * 29, 6 + phase * 5, 4 + phase * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGatehouseEffects(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  time: number,
  reducedMotion: boolean,
) {
  const depth = building.status === "deep-exit" ? 1 : building.status === "thin-exit" ? 0.32 : building.visual.intensity;
  const wheel = building.status === "stale" || building.status === "unavailable" ? 0.08 : building.visual.secondaryIntensity;
  const warning = building.status === "concentrated" ? 1 : building.visual.tertiaryIntensity;
  const angle = reducedMotion ? 0.3 : time * (1 + wheel * 4);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);

  ctx.fillStyle = `rgba(52, 150, 158, ${0.18 + depth * 0.36})`;
  ctx.beginPath();
  ctx.ellipse(0, -16, 42, 13 + depth * 6, 0, 0, Math.PI * 2);
  ctx.fill();

  const opening = building.status === "deep-exit" ? 16 : building.status === "concentrated" ? 8 : building.status === "thin-exit" ? 5 : 1;
  ctx.strokeStyle = "#4e3824";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-opening, -43);
  ctx.lineTo(-24, -20);
  ctx.moveTo(opening, -43);
  ctx.lineTo(24, -20);
  ctx.stroke();

  ctx.save();
  ctx.translate(-31, -42);
  ctx.rotate(angle);
  ctx.strokeStyle = "#6b4a2e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  for (let index = 0; index < 6; index += 1) {
    const spoke = index * Math.PI / 3;
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(spoke) * 12, Math.sin(spoke) * 12);
  }
  ctx.stroke();
  ctx.restore();

  const lanternColor = building.status === "concentrated" ? "#f47c56" : building.status === "thin-exit" ? "#e3b95f" : "#8ce4ce";
  ctx.fillStyle = hexToRgba(lanternColor, 0.24 + warning * 0.28);
  ctx.beginPath();
  ctx.arc(31, -52, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = lanternColor;
  ctx.fillRect(29, -54, 4, 5);
  ctx.restore();
}

function drawYieldOrchardEffects(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  time: number,
  reducedMotion: boolean,
) {
  const coverage = building.visual.intensity;
  const sources = building.visual.secondaryIntensity;
  const warning = building.visual.tertiaryIntensity;
  const angle = reducedMotion ? 0.4 : time * (0.7 + sources * 2.2);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);

  ctx.fillStyle = `rgba(107, 209, 157, ${0.18 + coverage * 0.28})`;
  ctx.beginPath();
  ctx.arc(16, -39, 18 + coverage * 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c8f2d3";
  ctx.fillRect(12, -42, 8, 8);

  ctx.save();
  ctx.translate(-30, -70);
  ctx.rotate(angle);
  ctx.strokeStyle = "#f2e2a4";
  ctx.lineWidth = 2;
  for (let index = 0; index < 4; index += 1) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(18, 0);
    ctx.stroke();
  }
  ctx.restore();

  const glintCount = Math.round(3 + sources * 7);
  for (let index = 0; index < glintCount; index += 1) {
    const phase = reducedMotion ? 0.35 : (time * 0.32 + index * 0.19) % 1;
    const x = -20 + (index % 5) * 10;
    const y = -32 - Math.floor(index / 5) * 11;
    ctx.fillStyle = index % 3 === 0 && warning > 0.25 ? "#e9b45f" : `rgba(245, 229, 122, ${0.2 + phase * 0.45})`;
    ctx.fillRect(Math.round(x), Math.round(y - phase * 3), 2, 2);
  }

  ctx.strokeStyle = `rgba(128, 201, 180, ${0.16 + coverage * 0.3})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, -23);
  ctx.quadraticCurveTo(0, -12, -28, -17);
  ctx.moveTo(21, -24);
  ctx.quadraticCurveTo(37, -13, 44, -25);
  ctx.stroke();
  ctx.restore();
}

function drawDependencyLoomEffects(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  time: number,
  reducedMotion: boolean,
) {
  const edgeActivity = building.visual.intensity;
  const concentration = building.visual.secondaryIntensity;
  const dependents = building.visual.tertiaryIntensity;
  const angle = reducedMotion ? 0.2 : time * (0.45 + edgeActivity * 1.5);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(zoom, zoom);

  for (const gear of [{ x: -24, y: -51, r: 12, dir: 1 }, { x: 22, y: -38, r: 10, dir: -1 }]) {
    ctx.save();
    ctx.translate(gear.x, gear.y);
    ctx.rotate(angle * gear.dir);
    ctx.strokeStyle = `rgba(224, 195, 145, ${0.35 + edgeActivity * 0.38})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, gear.r, 0, Math.PI * 2);
    for (let index = 0; index < 8; index += 1) {
      const spoke = index * Math.PI / 4;
      ctx.moveTo(Math.cos(spoke) * 4, Math.sin(spoke) * 4);
      ctx.lineTo(Math.cos(spoke) * gear.r, Math.sin(spoke) * gear.r);
    }
    ctx.stroke();
    ctx.restore();
  }

  const threadAlpha = 0.2 + Math.max(edgeActivity, concentration, dependents) * 0.42;
  ctx.strokeStyle = `rgba(194, 160, 255, ${threadAlpha})`;
  ctx.lineWidth = 1.5;
  for (let index = 0; index < 5; index += 1) {
    const offset = index * 7;
    ctx.beginPath();
    ctx.moveTo(-35 + offset, -21 - index);
    ctx.quadraticCurveTo(-6 + offset * 0.25, -54 - concentration * 16, 33 - offset * 0.15, -31 - index * 2);
    ctx.stroke();
    const phase = reducedMotion ? 0.5 : (time * (0.22 + edgeActivity * 0.28) + index * 0.17) % 1;
    ctx.fillStyle = `rgba(231, 220, 255, ${0.24 + dependents * 0.42})`;
    ctx.beginPath();
    ctx.arc(-35 + offset + phase * 58, -21 - index - Math.sin(phase * Math.PI) * (18 + concentration * 10), 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBuildingDataFog(
  ctx: CanvasRenderingContext2D,
  building: PharosVilleWorld["buildings"][number],
  point: ScreenPoint,
  zoom: number,
  time: number,
) {
  if (building.visual.dataFogIntensity <= 0) return;
  ctx.save();
  ctx.globalAlpha = building.visual.dataFogIntensity;
  ctx.fillStyle = "rgba(193, 207, 203, 0.24)";
  for (let index = 0; index < 3; index += 1) {
    const phase = (time * 0.08 + index * 0.3) % 1;
    ctx.beginPath();
    ctx.ellipse(
      point.x - 32 * zoom + index * 31 * zoom + phase * 10 * zoom,
      point.y - (13 + index * 4) * zoom,
      30 * zoom,
      8 * zoom,
      -0.08,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
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

function drawDocks({ assets, camera, ctx, hoveredTarget, selectedTarget, world }: DrawPharosVilleInput) {
  ctx.strokeStyle = "#6d4c2f";
  ctx.lineWidth = 5;
  for (const dock of world.docks) {
    const p = tileToScreen(dock.tile, camera);
    const harbor = dockDrawPoint(dock, camera);
    const dockAsset = assets?.get(dock.assetId) ?? assets?.get("dock.wooden-pier");
    const dockScale = dockRenderScale(dock.size);
    if (dockAsset) {
      drawAsset(
        ctx,
        dockAsset,
        harbor.x,
        harbor.y,
        camera.zoom * dockScale,
      );
    } else {
      ctx.lineWidth = (3 + dock.size) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(harbor.x, harbor.y);
      ctx.stroke();
    }
    drawHarborFlag({
      accent: dockHealthColor(dock.healthBand),
      ctx,
      dock,
      emphasized: hoveredTarget?.detailId === dock.detailId || selectedTarget?.detailId === dock.detailId,
      logo: assets?.getLogo(dock.logoSrc) ?? null,
      outward: dockOutwardVector(dock.tile),
      x: harbor.x,
      y: harbor.y - 12 * camera.zoom,
      zoom: camera.zoom,
    });
  }
}

function dockDrawPoint(dock: PharosVilleWorld["docks"][number], camera: IsoCamera): ScreenPoint {
  const outward = dockOutwardVector(dock.tile);
  const reach = 0.72 + dock.size * 0.075;
  const p = tileToScreen({
    x: dock.tile.x + outward.x * reach,
    y: dock.tile.y + outward.y * reach,
  }, camera);
  return {
    x: p.x,
    y: p.y + 10 * camera.zoom,
  };
}

function dockOutwardVector(tile: { x: number; y: number }): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const dx = tile.x - MAX_TILE_X / 2;
  const dy = tile.y - MAX_TILE_Y / 2;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx < 0 ? -1 : 1, y: 0 };
  return { x: 0, y: dy < 0 ? -1 : 1 };
}

function dockRenderScale(size: number): number {
  return Math.max(0.43, Math.min(0.79, (0.66 + size * 0.092) * 0.5));
}

function dockHealthColor(healthBand: PharosVilleWorld["docks"][number]["healthBand"]) {
  if (healthBand === "robust" || healthBand === "healthy") return "#78b689";
  if (healthBand === "mixed") return "#dfb95a";
  if (healthBand === "fragile") return "#d98b54";
  if (healthBand === "concentrated") return "#c9675c";
  return "#9fb0aa";
}

function drawAreaSigns({ camera, ctx, world }: DrawPharosVilleInput) {
  for (const area of world.areas) {
    const p = tileToScreen(area.tile, camera);
    const accent = area.visual?.accent ?? (area.band ? dewsAreaColor(area.band) : "#d8b56a");
    drawWaterAreaPost(ctx, p.x, p.y, area.label, area.count ?? null, camera.zoom, accent);
  }
}

function dewsAreaColor(band: NonNullable<PharosVilleWorld["areas"][number]["band"]>) {
  if (band === "DANGER") return "#d85645";
  if (band === "WARNING") return "#e08d45";
  if (band === "ALERT") return "#e0b84c";
  if (band === "WATCH") return "#83b98a";
  return "#8fc7bb";
}

function drawHarborFlag(input: {
  accent: string;
  ctx: CanvasRenderingContext2D;
  dock: PharosVilleWorld["docks"][number];
  emphasized: boolean;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  outward: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  x: number;
  y: number;
  zoom: number;
}) {
  const { accent, ctx, dock, emphasized, logo, outward, x, y, zoom } = input;
  const scale = Math.max(0.72, zoom);
  const flagScale = scale * 1.65;
  const side = outward.x === 0 ? (dock.tile.x < MAX_TILE_X / 2 ? -1 : 1) : -outward.x;
  const direction = side < 0 ? -1 : 1;
  const mastX = x + side * (22 + dock.size * 0.55) * scale;
  const mastBaseY = y - (5 + dock.size * 0.55) * scale;
  const flagWidth = (20 + (emphasized ? 3 : 0)) * flagScale;
  const flagHeight = (13 + (emphasized ? 1 : 0)) * flagScale;
  const mastTopY = mastBaseY - flagHeight - (15 + (emphasized ? 3 : 0)) * scale;
  const flagY = mastTopY + 2 * scale;

  ctx.save();
  ctx.lineJoin = "miter";

  ctx.fillStyle = "rgba(7, 10, 13, 0.32)";
  ctx.beginPath();
  ctx.ellipse(mastX + direction * flagWidth * 0.24, mastBaseY + 4 * scale, 9 * flagScale, 2.8 * flagScale, -0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#231811";
  ctx.lineWidth = Math.max(1, 1.15 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(mastX), Math.round(mastBaseY));
  ctx.lineTo(Math.round(mastX), Math.round(mastTopY - 2 * scale));
  ctx.stroke();

  ctx.strokeStyle = "#7d603a";
  ctx.lineWidth = Math.max(1, 0.8 * scale);
  ctx.beginPath();
  ctx.moveTo(Math.round(mastX + direction * 0.6 * scale), Math.round(mastBaseY - 1 * scale));
  ctx.lineTo(Math.round(mastX + direction * 0.6 * scale), Math.round(mastTopY - 2 * scale));
  ctx.stroke();

  ctx.fillStyle = hexToRgba(accent, emphasized ? 0.94 : 0.78);
  ctx.beginPath();
  ctx.moveTo(mastX, flagY);
  ctx.lineTo(mastX + direction * flagWidth, flagY + 2 * scale);
  ctx.lineTo(mastX + direction * (flagWidth - 5 * flagScale), flagY + flagHeight * 0.5);
  ctx.lineTo(mastX + direction * flagWidth, flagY + flagHeight - 2 * scale);
  ctx.lineTo(mastX, flagY + flagHeight);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, 0.85 * scale);
  ctx.stroke();

  drawDockFlagCrest({
    accent,
    ctx,
    logo,
    mark: dockFlagMark(dock),
    radius: flagHeight * 0.32,
    x: mastX + direction * flagWidth * 0.44,
    y: flagY + flagHeight * 0.52,
  });

  if (emphasized) {
    drawDockNameRibbon(ctx, dock.label, mastX + direction * 14 * flagScale, mastTopY - 15 * scale, scale);
  }
  ctx.restore();
}

function drawDockFlagCrest(input: {
  accent: string;
  ctx: CanvasRenderingContext2D;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  mark: string;
  radius: number;
  x: number;
  y: number;
}) {
  const { accent, ctx, logo, mark, radius, x, y } = input;
  const safeRadius = Math.max(3, radius);
  const width = safeRadius * 1.9;
  const height = safeRadius * 1.72;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));

  ctx.fillStyle = "rgba(248, 231, 190, 0.72)";
  ctx.strokeStyle = "rgba(47, 33, 23, 0.62)";
  ctx.lineWidth = Math.max(1, safeRadius * 0.1);
  ctx.beginPath();
  ctx.moveTo(-width * 0.42, -height * 0.42);
  ctx.lineTo(width * 0.42, -height * 0.42);
  ctx.quadraticCurveTo(width * 0.5, -height * 0.06, width * 0.32, height * 0.17);
  ctx.lineTo(0, height * 0.46);
  ctx.lineTo(-width * 0.32, height * 0.17);
  ctx.quadraticCurveTo(-width * 0.5, -height * 0.06, -width * 0.42, -height * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = hexToRgba(accent, 0.56);
  ctx.lineWidth = Math.max(1, safeRadius * 0.08);
  ctx.beginPath();
  ctx.moveTo(-width * 0.28, -height * 0.25);
  ctx.quadraticCurveTo(0, -height * 0.32, width * 0.28, -height * 0.25);
  ctx.stroke();

  if (logo) {
    ctx.save();
    roundedRectPath(ctx, -safeRadius * 0.68, -safeRadius * 0.68, safeRadius * 1.36, safeRadius * 1.36, safeRadius * 0.22);
    ctx.clip();
    ctx.globalAlpha = 0.92;
    const size = Math.max(2, Math.round(safeRadius * 1.36));
    ctx.drawImage(logo.image, -size / 2, -size / 2, size, size);
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = hexToRgba(accent, 0.1);
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255, 244, 214, 0.22)";
    ctx.lineWidth = Math.max(1, safeRadius * 0.07);
    ctx.beginPath();
    ctx.moveTo(-safeRadius * 0.72, -safeRadius * 0.12);
    ctx.quadraticCurveTo(0, -safeRadius * 0.25, safeRadius * 0.72, -safeRadius * 0.08);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.fillStyle = "#152334";
    ctx.font = `800 ${Math.max(4, safeRadius * (mark.length > 2 ? 0.72 : 0.96))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.slice(0, 3).toUpperCase(), 0, 0.35);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function drawDockNameRibbon(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, scale: number) {
  const fontSize = Math.max(7, Math.round(7.4 * scale));
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const width = Math.min(82 * scale, Math.max(34 * scale, ctx.measureText(label).width + 11 * scale));
  const height = 13 * scale;
  const left = x - width / 2;
  const top = y - height / 2;
  ctx.globalAlpha = 0.88;
  drawSignBoard(ctx, left, top, width, height, scale * 0.82, "#654323", "#2e1e14");
  ctx.fillStyle = "#f7e5ba";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawFittedText(ctx, label, x, y + 0.7 * scale, width - 7 * scale, fontSize, 5.8 * scale, "700");
  ctx.restore();
}

function dockFlagMark(dock: PharosVilleWorld["docks"][number]) {
  const explicit: Record<string, string> = {
    aptos: "APT",
    arbitrum: "ARB",
    avalanche: "AVAX",
    base: "B",
    bsc: "BSC",
    ethereum: "ETH",
    hyperliquid: "HYPE",
    polygon: "POL",
    solana: "SOL",
    tron: "TRX",
  };
  if (explicit[dock.chainId]) return explicit[dock.chainId];
  const words = dock.label
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(" ")
    .filter(Boolean);
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 3);
  return (words[0] ?? dock.chainId).slice(0, 3);
}

function drawWaterAreaPost(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  count: number | null,
  zoom: number,
  accent: string,
) {
  const scale = Math.max(0.8, zoom);
  const fontSize = Math.max(7, Math.round(7.7 * scale));
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const countText = count == null ? "" : String(count);
  const countWidth = countText ? Math.max(15 * scale, ctx.measureText(countText).width + 8 * scale) : 0;
  const labelWidth = ctx.measureText(label).width;
  const width = Math.min(124 * scale, Math.max(54 * scale, labelWidth + countWidth + 20 * scale));
  const height = 17 * scale;
  const top = y - 38 * scale;
  const left = x - width / 2;

  ctx.fillStyle = "rgba(5, 12, 18, 0.36)";
  ctx.beginPath();
  ctx.ellipse(x + 1 * scale, y + 2 * scale, width * 0.23, 4 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#2e2118";
  ctx.fillRect(Math.round(x - 1.3 * scale), Math.round(top + 5 * scale), Math.max(2, Math.round(2.6 * scale)), Math.max(14, Math.round(39 * scale)));
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(x + 1.5 * scale, top + 2 * scale);
  ctx.lineTo(x + 14 * scale, top + 7 * scale);
  ctx.lineTo(x + 1.5 * scale, top + 12 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#2a1a12";
  ctx.lineWidth = Math.max(1, scale * 0.9);
  ctx.stroke();

  drawSignBoard(ctx, left, top + 13 * scale, width, height, scale, "#6d4a2c", "#3f2a1c");
  ctx.fillStyle = "rgba(234, 207, 137, 0.15)";
  ctx.fillRect(Math.round(left + 4 * scale), Math.round(top + 17 * scale), Math.round(width - 8 * scale), Math.max(1, Math.round(2 * scale)));

  const textMaxWidth = width - (countText ? countWidth + 18 * scale : 12 * scale);
  ctx.fillStyle = "#f3deb1";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  drawFittedText(ctx, label, left + 7 * scale, top + 13 * scale + height * 0.58, textMaxWidth, fontSize, 6.5 * scale, "700");

  if (countText) {
    const badgeX = left + width - countWidth / 2 - 5 * scale;
    const badgeY = top + 13 * scale + height * 0.55;
    roundedRectPath(ctx, badgeX - countWidth / 2, badgeY - 6.5 * scale, countWidth, 13 * scale, 3 * scale);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = "#2b1c14";
    ctx.stroke();
    ctx.fillStyle = "#17120d";
    ctx.textAlign = "center";
    drawFittedText(ctx, countText, badgeX, badgeY + 0.3 * scale, countWidth - 4 * scale, fontSize, 6 * scale, "800");
  }

  ctx.restore();
}

function drawSignBoard(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  scale: number,
  face: string,
  edge: string,
) {
  ctx.fillStyle = edge;
  ctx.fillRect(Math.round(left - 2 * scale), Math.round(top + 2 * scale), Math.round(width + 4 * scale), Math.round(height - 1 * scale));
  ctx.fillStyle = face;
  ctx.fillRect(Math.round(left), Math.round(top), Math.round(width), Math.round(height));
  ctx.fillStyle = "rgba(39, 24, 15, 0.26)";
  ctx.fillRect(Math.round(left), Math.round(top + height * 0.48), Math.round(width), Math.max(1, Math.round(scale)));
}

function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
  minFontSize: number,
  weight: string,
) {
  let nextSize = fontSize;
  while (nextSize > minFontSize) {
    ctx.font = `${weight} ${Math.round(nextSize)}px ui-sans-serif, system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    nextSize -= 0.5;
  }
  ctx.fillText(text, x, y, maxWidth);
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

function drawSelection(input: DrawPharosVilleInput) {
  const { ctx, hoveredTarget, selectedTarget } = input;
  if (selectedTarget) drawSelectedRelationships(input, selectedTarget);
  if (hoveredTarget) drawSelectionRing(ctx, hoveredTarget, "rgba(128, 214, 206, 0.85)");
  if (selectedTarget) drawSelectionRing(ctx, selectedTarget, "rgba(255, 204, 98, 0.95)");
}

function drawSelectedRelationships(input: DrawPharosVilleInput, target: HitTarget) {
  if (target.kind === "ship") {
    const ship = input.world.ships.find((candidate) => candidate.id === target.id);
    if (ship) drawSelectedShipRelationships(input, ship);
  } else if (target.kind === "dock") {
    const dock = input.world.docks.find((candidate) => candidate.id === target.id);
    if (dock) drawSelectedDockRelationships(input, dock);
  }
}

function drawSelectedShipRelationships(
  { camera, ctx, motion, shipMotionSamples, world }: DrawPharosVilleInput,
  ship: PharosVilleWorld["ships"][number],
) {
  const sample = shipMotionSamples?.get(ship.id) ?? null;
  const currentPoint = tileToScreen(sample?.tile ?? ship.tile, camera);
  const riskPoint = tileToScreen(ship.riskTile, camera);
  const homeDock = ship.homeDockChainId
    ? world.docks.find((dock) => dock.chainId === ship.homeDockChainId) ?? null
    : null;
  const homePoint = homeDock ? dockDrawPoint(homeDock, camera) : null;
  const pulse = relationshipPulse(motion);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([7 * camera.zoom, 6 * camera.zoom]);
  if (homePoint) {
    drawRelationshipLine(ctx, currentPoint, homePoint, camera.zoom, "rgba(255, 224, 160, 0.42)");
  }
  drawRelationshipLine(ctx, currentPoint, riskPoint, camera.zoom, "rgba(229, 106, 71, 0.36)");
  ctx.setLineDash([]);

  if (homePoint) {
    drawRelationshipMarker(ctx, homePoint.x, homePoint.y - 9 * camera.zoom, camera.zoom, "home", "#ffe0a0", pulse);
  }
  drawRelationshipMarker(ctx, riskPoint.x, riskPoint.y - 2 * camera.zoom, camera.zoom, "risk", "#e56a47", pulse);
  drawRelationshipMarker(ctx, currentPoint.x, currentPoint.y + 8 * camera.zoom, camera.zoom, "current", "#80d6ce", pulse);
  ctx.restore();
}

function drawSelectedDockRelationships(
  { camera, ctx, motion, shipMotionSamples, world }: DrawPharosVilleInput,
  dock: PharosVilleWorld["docks"][number],
) {
  const visibleShips = world.ships
    .filter((ship) => ship.chainPresence.some((presence) => presence.chainId === dock.chainId && presence.hasRenderedDock))
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, 10);
  if (visibleShips.length === 0) return;

  const dockPoint = dockDrawPoint(dock, camera);
  const pulse = relationshipPulse(motion);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([4 * camera.zoom, 7 * camera.zoom]);
  for (const ship of visibleShips) {
    const shipPoint = tileToScreen(shipMotionSamples?.get(ship.id)?.tile ?? ship.tile, camera);
    drawRelationshipLine(ctx, dockPoint, shipPoint, camera.zoom, "rgba(128, 214, 206, 0.28)");
    drawRelationshipMarker(ctx, shipPoint.x, shipPoint.y + 8 * camera.zoom, camera.zoom * 0.78, "ship", "#80d6ce", pulse);
  }
  ctx.setLineDash([]);
  drawRelationshipMarker(ctx, dockPoint.x, dockPoint.y - 9 * camera.zoom, camera.zoom, "home", "#ffe0a0", pulse);
  ctx.restore();
}

function relationshipPulse(motion: PharosVilleCanvasMotion) {
  if (motion.reducedMotion) return 1;
  return 0.84 + Math.sin(motion.timeSeconds * 2.2) * 0.16;
}

function drawRelationshipLine(
  ctx: CanvasRenderingContext2D,
  from: ScreenPoint,
  to: ScreenPoint,
  zoom: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.45 * zoom);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function drawRelationshipMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  kind: "current" | "home" | "risk" | "ship",
  color: string,
  pulse: number,
) {
  const radius = (kind === "ship" ? 5 : kind === "current" ? 7 : 8) * zoom;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.beginPath();
  ctx.arc(x, y, radius * pulse, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 0.92;
  ctx.fillStyle = color;
  if (kind === "risk") {
    drawDiamond(ctx, x, y, radius * 1.3, radius * 1.3, color);
  } else if (kind === "home") {
    ctx.fillRect(Math.round(x - radius * 0.55), Math.round(y - radius * 0.55), Math.round(radius * 1.1), Math.round(radius * 1.1));
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.44, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
