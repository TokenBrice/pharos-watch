import { areaLabelPlacementForArea } from "../systems/area-labels";
import { DEWS_AREA_LABEL_COLORS, waterTerrainStyle, type WaterTerrainStyle } from "../systems/palette";
import { TILE_HEIGHT, TILE_WIDTH, tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import {
  CEMETERY_CENTER,
  CEMETERY_RADIUS,
  ETHEREUM_L2_DOCK_CHAIN_IDS,
  isElevatedTileKind,
  isShoreTileKind,
  isWaterTileKind,
} from "../systems/world-layout";
import type { PharosVilleWorld, TerrainKind } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import {
  drawableDepth,
  drawablePassCounts,
  sortWorldDrawables,
  type WorldDrawable,
  type WorldDrawablePass,
} from "./drawable-pass";
import { dockDrawPoint, dockOutwardVector, entityAssetId, resolveEntityGeometry, type WorldSelectableEntity } from "./geometry";
import { drawSelection } from "./layers/selection";
import { drawCoastalWaterDetails } from "./layers/shoreline";
import type { DrawPharosVilleInput, PharosVilleCanvasMotion, PharosVilleRenderMetrics } from "./render-types";
import { CAUSE_HEX, type CauseOfDeath } from "@shared/lib/cause-of-death";

const TILE_COLORS: Record<string, string> = {
  beach: "#d5b873",
  cliff: "#2e4052",
  grass: "#4f8a52",
  hill: "#6f9958",
  land: "#6d8450",
  road: "#ad8050",
  rock: "#526776",
  shore: "#caa467",
};

const TERRAIN_TEXTURE = {
  beachPebble: "rgba(82, 67, 47, 0.16)",
  cliffFace: "rgba(19, 26, 34, 0.62)",
  foam: "rgba(232, 243, 233, 0.76)",
  grassDark: "rgba(28, 76, 49, 0.52)",
  grassLight: "rgba(172, 211, 132, 0.34)",
  grassMid: "rgba(78, 138, 82, 0.36)",
  groundGrain: "rgba(35, 37, 27, 0.2)",
  mossShadow: "rgba(43, 58, 38, 0.26)",
  roadLight: "rgba(184, 146, 91, 0.32)",
  roadShadow: "rgba(53, 39, 26, 0.22)",
  rockLight: "rgba(176, 177, 160, 0.24)",
  sandLight: "rgba(237, 204, 137, 0.28)",
} as const;

const TERRAIN_ASSET_BY_KIND: Partial<Record<TerrainKind, string>> = {
  "alert-water": "terrain.harbor-water",
  "calm-water": "terrain.harbor-water",
  "deep-water": "terrain.deep-water",
  "harbor-water": "terrain.harbor-water",
  "ledger-water": "terrain.harbor-water",
  "storm-water": "terrain.storm-water",
  "warning-water": "terrain.storm-water",
  "watch-water": "terrain.harbor-water",
  beach: "terrain.shore",
  cliff: "terrain.shore",
  grass: "terrain.land",
  hill: "terrain.land",
  land: "terrain.land",
  road: "terrain.road",
  rock: "terrain.land",
  shore: "terrain.shore",
  water: "terrain.harbor-water",
};

const TERRAIN_ASSET_SCALE = 0.5;

const LIGHTHOUSE_HEADLAND = {
  cliff: "#2e4052",
  grass: "#4f8a52",
  halo: "rgba(255, 200, 87, 0.2)",
  moss: "#6f9958",
  shadow: "rgba(10, 12, 12, 0.42)",
  stone: "#9f9278",
} as const;

const LIGHTHOUSE_SPRITE_CROP = {
  anchorX: 38,
  anchorY: 206,
  beaconX: 38,
  beaconY: 50,
  bottomOffsetY: 4,
  scale: 1.04,
  sourceHeight: 206,
  sourceWidth: 64,
  sourceX: 122,
  sourceY: 0,
} as const;

const VILLAGE_LIGHTS = [
  { x: 16.7, y: 29.4, size: 0.52 },
  { x: 18.4, y: 27.9, size: 0.58 },
  { x: 19.8, y: 29.0, size: 0.48 },
  { x: 20.8, y: 30.8, size: 0.44 },
  { x: 24.6, y: 23.4, size: 0.42 },
  { x: 28.8, y: 22.3, size: 0.46 },
  { x: 30.1, y: 31.8, size: 0.54 },
  { x: 33.2, y: 30.1, size: 0.5 },
  { x: 35.4, y: 42.5, size: 0.48 },
  { x: 37.2, y: 29.5, size: 0.52 },
  { x: 41.1, y: 28.9, size: 0.5 },
  { x: 44.2, y: 33.7, size: 0.52 },
] as const;

const LIGHTHOUSE_SURF = [
  { x: 14.7, y: 27.8, length: 20, phase: 5.1, tilt: 0.12 },
  { x: 15.6, y: 28.8, length: 26, phase: 0.1, tilt: -0.14 },
  { x: 16.7, y: 31.8, length: 34, phase: 1.7, tilt: 0.02 },
  { x: 17.8, y: 33.0, length: 29, phase: 4.8, tilt: 0.18 },
  { x: 19.8, y: 33.1, length: 38, phase: 2.6, tilt: 0.16 },
  { x: 22.4, y: 31.8, length: 30, phase: 3.4, tilt: -0.12 },
  { x: 21.1, y: 25.4, length: 24, phase: 4.1, tilt: 0.1 },
  { x: 23.0, y: 27.0, length: 22, phase: 5.7, tilt: -0.18 },
] as const;

const LIGHTHOUSE_REFLECTIONS = [
  { alpha: 0.2, length: 54, offsetX: -6, offsetY: 72, phase: 0.2 },
  { alpha: 0.16, length: 42, offsetX: 12, offsetY: 91, phase: 1.6 },
  { alpha: 0.13, length: 31, offsetX: -22, offsetY: 108, phase: 2.8 },
  { alpha: 0.11, length: 26, offsetX: 28, offsetY: 119, phase: 3.5 },
  { alpha: 0.1, length: 34, offsetX: -36, offsetY: 134, phase: 4.4 },
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

type SceneryPropKind =
  | "barrel"
  | "beacon"
  | "bollards"
  | "buoy"
  | "crate-stack"
  | "cypress"
  | "grass-tuft"
  | "harbor-lamp"
  | "mooring-posts"
  | "net-rack"
  | "palm"
  | "reed-bed"
  | "reef"
  | "rock"
  | "rope-coil"
  | "sea-wall"
  | "signal-post"
  | "skiff"
  | "stone-steps"
  | "timber-pile";

interface SceneryProp {
  id: string;
  kind: SceneryPropKind;
  scale?: number;
  tile: { x: number; y: number };
}

const SCENERY_PROPS: readonly SceneryProp[] = [
  { id: "north-buoy", kind: "buoy", tile: { x: 31.2, y: 16.8 }, scale: 0.78 },
  { id: "north-signal", kind: "signal-post", tile: { x: 36.8, y: 18.7 }, scale: 0.72 },
  { id: "north-net-rack", kind: "net-rack", tile: { x: 28.3, y: 22.1 }, scale: 0.7 },
  { id: "north-rope", kind: "rope-coil", tile: { x: 33.1, y: 21.7 }, scale: 0.62 },
  { id: "north-timber", kind: "timber-pile", tile: { x: 38.8, y: 21.9 }, scale: 0.68 },
  { id: "north-grass", kind: "grass-tuft", tile: { x: 24.2, y: 24.1 }, scale: 0.74 },
  { id: "watch-reef-1", kind: "reef", tile: { x: 4.5, y: 23.6 }, scale: 0.84 },
  { id: "watch-reef-2", kind: "reef", tile: { x: 10.4, y: 40.6 }, scale: 0.74 },
  { id: "watch-buoy", kind: "buoy", tile: { x: 13.8, y: 31.8 }, scale: 0.76 },
  { id: "watch-reeds", kind: "reed-bed", tile: { x: 14.7, y: 28.8 }, scale: 0.64 },
  { id: "watch-rocks", kind: "rock", tile: { x: 12.2, y: 35.6 }, scale: 0.62 },
  { id: "west-lamp", kind: "harbor-lamp", tile: { x: 18.7, y: 31.5 }, scale: 0.78 },
  { id: "west-seawall", kind: "sea-wall", tile: { x: 18.5, y: 34.4 }, scale: 0.82 },
  { id: "west-mooring", kind: "mooring-posts", tile: { x: 17.2, y: 33.2 }, scale: 0.78 },
  { id: "west-barrels", kind: "barrel", tile: { x: 20.1, y: 35.3 }, scale: 0.64 },
  { id: "west-steps", kind: "stone-steps", tile: { x: 19.1, y: 30.0 }, scale: 0.7 },
  { id: "south-skiff", kind: "skiff", tile: { x: 31.4, y: 45.7 }, scale: 0.82 },
  { id: "south-bollards", kind: "bollards", tile: { x: 35.6, y: 42.4 }, scale: 0.82 },
  { id: "south-rope", kind: "rope-coil", tile: { x: 27.9, y: 42.3 }, scale: 0.68 },
  { id: "south-net", kind: "net-rack", tile: { x: 30.6, y: 43.4 }, scale: 0.66 },
  { id: "south-reeds", kind: "reed-bed", tile: { x: 24.7, y: 43.3 }, scale: 0.68 },
  { id: "south-cypress", kind: "cypress", tile: { x: 38.7, y: 39.7 }, scale: 0.58 },
  { id: "east-lamp", kind: "harbor-lamp", tile: { x: 45.8, y: 31.6 }, scale: 0.88 },
  { id: "east-crates", kind: "crate-stack", tile: { x: 44.6, y: 34.8 }, scale: 0.82 },
  { id: "east-seawall", kind: "sea-wall", tile: { x: 45.7, y: 33.2 }, scale: 0.92 },
  { id: "east-mooring", kind: "mooring-posts", tile: { x: 43.6, y: 29.4 }, scale: 0.82 },
  { id: "east-steps", kind: "stone-steps", tile: { x: 41.8, y: 36.2 }, scale: 0.7 },
  { id: "east-rope", kind: "rope-coil", tile: { x: 39.3, y: 38.4 }, scale: 0.58 },
  { id: "east-net", kind: "net-rack", tile: { x: 46.1, y: 29.1 }, scale: 0.58 },
  { id: "alert-beacon", kind: "beacon", tile: { x: 39.8, y: 50.4 }, scale: 0.9 },
  { id: "alert-reeds", kind: "reed-bed", tile: { x: 36.4, y: 49.2 }, scale: 0.6 },
  { id: "warning-reef-1", kind: "reef", tile: { x: 48.4, y: 48.4 }, scale: 0.82 },
  { id: "warning-reef-2", kind: "rock", tile: { x: 50.2, y: 50.2 }, scale: 0.68 },
  { id: "warning-buoy", kind: "buoy", tile: { x: 47.2, y: 45.7 }, scale: 0.72 },
  { id: "danger-buoy-1", kind: "buoy", tile: { x: 54.0, y: 38.6 }, scale: 0.84 },
  { id: "danger-buoy-2", kind: "signal-post", tile: { x: 55.0, y: 44.0 }, scale: 0.82 },
  { id: "danger-reef", kind: "reef", tile: { x: 52.5, y: 47.2 }, scale: 0.72 },
  { id: "civic-bollards", kind: "bollards", tile: { x: 31.2, y: 31.5 }, scale: 0.86 },
  { id: "civic-crates", kind: "crate-stack", tile: { x: 29.2, y: 30.0 }, scale: 0.62 },
  { id: "civic-rope", kind: "rope-coil", tile: { x: 33.9, y: 32.6 }, scale: 0.62 },
  { id: "civic-lamp-east", kind: "harbor-lamp", tile: { x: 36.0, y: 32.8 }, scale: 0.66 },
  { id: "cemetery-lamp", kind: "harbor-lamp", tile: { x: 8.4, y: 47.0 }, scale: 0.72 },
  { id: "cemetery-rock", kind: "rock", tile: { x: 12.2, y: 51.4 }, scale: 0.66 },
  { id: "cemetery-cypress", kind: "cypress", tile: { x: 10.4, y: 47.8 }, scale: 0.52 },
  { id: "cemetery-reeds", kind: "reed-bed", tile: { x: 6.2, y: 48.2 }, scale: 0.52 },
  { id: "lighthouse-wall", kind: "sea-wall", tile: { x: 20.6, y: 30.1 }, scale: 0.74 },
  { id: "lighthouse-lamp", kind: "harbor-lamp", tile: { x: 17.2, y: 29.0 }, scale: 0.7 },
  { id: "lighthouse-grass", kind: "grass-tuft", tile: { x: 16.7, y: 27.0 }, scale: 0.72 },
  { id: "lighthouse-cypress", kind: "cypress", tile: { x: 20.8, y: 27.2 }, scale: 0.56 },
] as const;

const SKY_MOODS = {
  dawn: {
    horizon: "#d07d55",
    lower: "#0d2035",
    mist: "rgba(255, 211, 154, 0.22)",
    moonAlpha: 0.12,
    starAlpha: 0.16,
    sunAlpha: 0.54,
    top: "#223b57",
    waterVeil: "rgba(42, 97, 112, 0.16)",
  },
  day: {
    horizon: "#d9ad67",
    lower: "#123a53",
    mist: "rgba(255, 225, 164, 0.18)",
    moonAlpha: 0,
    starAlpha: 0,
    sunAlpha: 0.8,
    top: "#496f8b",
    waterVeil: "rgba(43, 128, 132, 0.14)",
  },
  dusk: {
    horizon: "#d36e56",
    lower: "#0b1222",
    mist: "rgba(246, 177, 126, 0.22)",
    moonAlpha: 0.34,
    starAlpha: 0.28,
    sunAlpha: 0.34,
    top: "#151a32",
    waterVeil: "rgba(16, 86, 99, 0.2)",
  },
  night: {
    horizon: "#183154",
    lower: "#050812",
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

const SHIP_SAIL_MARKS: Record<PharosVilleWorld["ships"][number]["visual"]["hull"], { height: number; width: number; x: number; y: number }> = {
  "algo-junk": { height: 11, width: 13, x: 8, y: -28 },
  "chartered-brigantine": { height: 11, width: 13, x: 9, y: -29 },
  "crypto-caravel": { height: 10, width: 12, x: 8, y: -26 },
  "dao-schooner": { height: 10, width: 12, x: 8, y: -27 },
  "treasury-galleon": { height: 12, width: 14, x: 10, y: -31 },
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

const GRAVE_ASSET_IDS: Record<GraveNodeMarker, string> = {
  cross: "prop.regulatory-obelisk",
  headstone: "prop.memorial-headstone",
  ledger: "prop.ledger-slab",
  reliquary: "prop.reliquary-marker",
  tablet: "prop.ledger-slab",
};

const GRAVE_ASSET_SCALE: Record<GraveNodeMarker, number> = {
  cross: 0.6,
  headstone: 0.64,
  ledger: 0.7,
  reliquary: 0.58,
  tablet: 0.68,
};

const GRAVE_LOGO_OFFSET: Record<GraveNodeMarker, number> = {
  cross: 13.2,
  headstone: 8.6,
  ledger: 5.7,
  reliquary: 10.4,
  tablet: 6.2,
};

const CEMETERY_GLOBAL_SCALE = 0.6;
const CEMETERY_CONTEXT_SCALE = 0.82 * CEMETERY_GLOBAL_SCALE;
const CEMETERY_CONTEXT_SOURCE_CENTER = { x: 22.15, y: 41.7 } as const;

const ETHEREUM_HARBOR_SIGNS = [
  {
    accent: "#d9b974",
    chainIds: ["ethereum"],
    label: "Ethereum Harbor",
    maxWidth: 136,
    rotation: -0.035,
    tile: { x: 41.4, y: 28.6 },
  },
  {
    accent: "#88ccc1",
    chainIds: ETHEREUM_L2_DOCK_CHAIN_IDS,
    label: "L2 Bay",
    maxWidth: 76,
    rotation: 0.035,
    tile: { x: 35.9, y: 34.8 },
  },
] as const;

const CEMETERY_SURFACE = {
  grass: "rgba(90, 126, 72, 0.72)",
  grassEdge: "rgba(64, 96, 63, 0.56)",
  limestone: "rgba(198, 183, 142, 0.58)",
  limestoneCore: "rgba(220, 202, 154, 0.44)",
  limestoneEdge: "rgba(111, 93, 67, 0.7)",
  path: "rgba(151, 122, 79, 0.74)",
  pathLight: "rgba(232, 200, 136, 0.42)",
  post: "#3a2a1d",
  postCap: "#d2aa61",
  quayDark: "rgba(24, 38, 39, 0.74)",
  quayFoam: "rgba(194, 231, 222, 0.42)",
} as const;

const CENTRAL_ISLAND_MODEL_TILE = { x: 31.5, y: 41.3 } as const;
const CENTRAL_ISLAND_MODEL_SCALE = 1.45;

export type { DrawPharosVilleInput, PharosVilleCanvasMotion, PharosVilleRenderMetrics } from "./render-types";

export function drawPharosVille(input: DrawPharosVilleInput): PharosVilleRenderMetrics {
  const { ctx } = input;
  ctx.imageSmoothingEnabled = false;
  drawSky(input);

  const visibleTileCount = drawTerrain(input);
  drawCoastalWaterDetails(input);
  drawAtmosphere(input);
  drawCentralIslandModel(input);
  drawHarborDistrictGround(input);
  drawBackgroundedHarborDocks(input);
  drawEthereumHarborExtensions(input);
  if (!input.world.lighthouse.unavailable) drawLighthouseSeaGlow(input);
  drawLighthouseSurf(input);
  drawCemeteryGround(input);
  drawLighthouseHeadland(input);
  drawCemeteryContext(input);
  const entityMetrics = drawEntityPass(input);
  drawWaterAreaLabels(input);
  drawEthereumHarborSigns(input);
  drawDecorativeLights(input);
  drawCemeteryMist(input);
  drawBirds(input);
  const selectionDrawableCount = drawSelection(input);
  const drawableCounts = {
    ...entityMetrics.drawableCounts,
    selection: selectionDrawableCount,
  };
  return {
    drawableCount: entityMetrics.drawableCount + selectionDrawableCount,
    drawableCounts,
    movingShipCount: Array.from(input.shipMotionSamples?.values() ?? [])
      .filter((sample) => sample.state !== "idle" && sample.state !== "risk-drift" && sample.state !== "moored").length,
    visibleTileCount,
  };
}

function drawCentralIslandModel({ assets, camera, ctx }: DrawPharosVilleInput) {
  const islandAsset = assets?.get("overlay.central-island") ?? null;
  if (!islandAsset) return;
  const point = tileToScreen(CENTRAL_ISLAND_MODEL_TILE, camera);
  ctx.save();
  ctx.globalAlpha = 0.88;
  drawAsset(
    ctx,
    islandAsset,
    point.x,
    point.y + 10 * camera.zoom,
    camera.zoom * CENTRAL_ISLAND_MODEL_SCALE,
  );
  ctx.restore();
}

function drawBackgroundedHarborDocks(input: DrawPharosVilleInput) {
  for (const dock of input.world.docks) {
    if (isBackgroundedHarborDock(dock)) drawDockBody(input, dock);
  }
}

function isBackgroundedHarborDock(dock: PharosVilleWorld["docks"][number]) {
  return dock.chainId === "ethereum";
}

function drawEntityPass(input: DrawPharosVilleInput): Pick<PharosVilleRenderMetrics, "drawableCount" | "drawableCounts"> {
  const drawables: WorldDrawable[] = [
    ...SCENERY_PROPS.map((prop) => sceneryDrawable(input, prop)),
    ...input.world.docks.flatMap((dock) => [
      ...(isBackgroundedHarborDock(dock) ? [] : [entityDrawable(input, dock, "body", () => drawDockBody(input, dock))]),
      entityDrawable(input, dock, "overlay", () => drawDockOverlay(input, dock)),
    ]),
    ...input.world.ships.flatMap((ship) => [
      entityDrawable(input, ship, "underlay", () => drawShipWake(input, ship)),
      entityDrawable(input, ship, "body", () => drawShipBody(input, ship)),
      entityDrawable(input, ship, "overlay", () => drawShipOverlay(input, ship)),
    ]),
    ...input.world.shipClusters.flatMap((cluster) => [
      entityDrawable(input, cluster, "body", () => drawClusterBody(input, cluster)),
      entityDrawable(input, cluster, "overlay", () => drawClusterOverlay(input, cluster)),
    ]),
    ...input.world.graves.flatMap((grave) => [
      entityDrawable(input, grave, "underlay", () => drawGraveUnderlay(input, grave)),
      entityDrawable(input, grave, "body", () => drawGraveBody(input, grave)),
      entityDrawable(input, grave, "overlay", () => drawGraveOverlay(input, grave)),
    ]),
    entityDrawable(input, input.world.lighthouse, "body", () => drawLighthouseBody(input)),
    entityDrawable(input, input.world.lighthouse, "overlay", () => drawLighthouseOverlay(input)),
  ];

  const sorted = sortWorldDrawables(drawables);
  for (const drawable of sorted) drawable.draw(input.ctx);
  return {
    drawableCount: sorted.length,
    drawableCounts: drawablePassCounts(sorted),
  };
}

function sceneryDrawable(input: DrawPharosVilleInput, prop: SceneryProp): WorldDrawable {
  const p = tileToScreen(prop.tile, input.camera);
  const size = 26 * (prop.scale ?? 1) * input.camera.zoom;
  return {
    depth: drawableDepth(prop.tile),
    draw: () => drawSceneryProp(input, prop),
    entityId: prop.id,
    kind: "scenery",
    pass: "body",
    screenBounds: {
      height: size,
      width: size,
      x: p.x - size / 2,
      y: p.y - size / 2,
    },
    tieBreaker: prop.id,
  };
}

function entityDrawable(
  input: DrawPharosVilleInput,
  entity: WorldSelectableEntity,
  pass: WorldDrawablePass,
  draw: () => void,
): WorldDrawable {
  const asset = assetForEntity(input, entity);
  const geometry = resolveEntityGeometry({
    asset,
    camera: input.camera,
    entity,
    mapWidth: input.world.map.width,
    shipMotionSamples: input.shipMotionSamples,
  });
  return {
    depth: geometry.depth,
    detailId: entity.detailId,
    draw,
    entityId: entity.id,
    kind: entity.kind,
    pass,
    screenBounds: geometry.selectionRect,
    tieBreaker: entity.id,
  };
}

function assetForEntity(input: DrawPharosVilleInput, entity: WorldSelectableEntity) {
  if (entity.kind === "dock") return input.assets?.get(entity.assetId) ?? input.assets?.get("dock.wooden-pier") ?? null;
  const assetId = entityAssetId(entity);
  return assetId ? input.assets?.get(assetId) ?? null : null;
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
    ? 0.58
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

function drawTerrain({ assets, camera, ctx, height, motion, width, world }: DrawPharosVilleInput) {
  let visibleTileCount = 0;
  for (const tile of world.map.tiles) {
    const terrain = tile.terrain ?? tile.kind;
    if (!isWaterTileKind(terrain)) continue;
    const p = tileToScreen(tile, camera);
    if (!isTileInViewport(p, camera.zoom, width, height)) continue;
    visibleTileCount += 1;
    drawWaterTile(ctx, p.x, p.y, camera.zoom, terrain, tile.x, tile.y, motion, terrainAssetFor(assets, terrain));
  }

  for (const tile of world.map.tiles) {
    const terrain = tile.terrain ?? tile.kind;
    if (isWaterTileKind(terrain)) continue;
    const p = tileToScreen(tile, camera);
    if (!isTileInViewport(p, camera.zoom, width, height)) continue;
    visibleTileCount += 1;
    drawLandTile(ctx, p.x, p.y, camera.zoom, terrain, tile.x, tile.y, terrainAssetFor(assets, terrain));
  }
  return visibleTileCount;
}

function terrainAssetFor(assets: PharosVilleAssetManager | null, terrain: TerrainKind) {
  const assetId = TERRAIN_ASSET_BY_KIND[terrain] ?? null;
  return assetId ? assets?.get(assetId) ?? null : null;
}

function isTileInViewport(point: ScreenPoint, zoom: number, width: number, height: number) {
  const marginX = 36 * zoom;
  const marginY = 22 * zoom;
  return (
    point.x >= -marginX
    && point.x <= width + marginX
    && point.y >= -marginY
    && point.y <= height + marginY
  );
}

function terrainColor(kind: TerrainKind) {
  const value = String(kind);
  const waterStyle = waterTerrainStyle(value);
  if (waterStyle) return waterStyle.base;
  const directColor = TILE_COLORS[value];
  if (directColor) return directColor;
  if (value.includes("water")) return value.includes("deep") ? "#050d1b" : "#153d63";
  if (value.includes("road") || value.includes("stair")) return TILE_COLORS.road;
  if (value.includes("cliff")) return TILE_COLORS.cliff;
  if (value.includes("rock")) return TILE_COLORS.rock;
  if (value.includes("hill")) return TILE_COLORS.hill;
  if (value.includes("grass")) return TILE_COLORS.grass;
  if (value.includes("beach")) return TILE_COLORS.beach;
  return TILE_COLORS.land;
}

function withAlpha(color: string, alpha: number) {
  if (color.startsWith("rgba(")) return color.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
  if (color.startsWith("#")) return hexToRgba(color, alpha);
  return color;
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
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>> | null,
) {
  const value = String(kind);
  const width = 32 * zoom;
  const height = 16 * zoom;
  const style = waterTerrainStyle(value) ?? waterTerrainStyle("water")!;
  if (asset) {
    drawTerrainAsset(ctx, asset, x, y, zoom);
    drawDiamond(ctx, x, y, width, height, withAlpha(style.base, 0.34));
  } else {
    drawDiamond(ctx, x, y, width, height, style.base);
  }
  drawWaterDepthOverlay(ctx, x, y, zoom, width, height, tileX, tileY, style.inner);
  drawWaterTerrainTexture(ctx, x, y, zoom, style, tileX, tileY, motion);

  if ((tileX * 13 + tileY * 17) % 5 !== 0) return;
  const wave = motion.reducedMotion
    ? 0.2
    : 0.16 + Math.sin(motion.timeSeconds * 1.25 + tileX * 0.27 + tileY * 0.19) * 0.05;
  ctx.save();
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.08, wave));
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 9 * zoom, y - 2 * zoom);
  ctx.lineTo(x + 7 * zoom, y + 2 * zoom);
  ctx.stroke();
  if ((tileX + tileY) % 3 === 0) {
    ctx.strokeStyle = withAlpha(style.accent, 0.26);
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
  style: WaterTerrainStyle,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
) {
  const { texture } = style;
  if (texture === "alert") {
    drawAlertChannelTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "calm") {
    drawCalmWaterTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "deep") {
    drawDeepSeaTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "harbor") {
    drawHarborWaterTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "ledger") {
    drawLedgerWaterTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "storm") {
    drawDangerStraitTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "watch") {
    drawWatchWaterTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  if (texture === "warning") {
    drawWarningShoalTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
    return;
  }
  drawOpenWaterTexture(ctx, x, y, zoom, tileX, tileY, motion, style);
}

function drawLedgerWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
  style: WaterTerrainStyle,
) {
  const ledgerPulse = motion.reducedMotion ? 0.18 : 0.15 + Math.sin(motion.timeSeconds * 0.62 + tileX * 0.25 + tileY * 0.37) * 0.04;
  ctx.save();
  if ((tileX + tileY) % 2 === 0) {
    drawMooringRule(ctx, x, y, zoom, -10, -2, 9, 3, style.accent, 0.16);
    drawMooringRule(ctx, x, y, zoom, -8, 5, 7, 8, style.wave, 0.18);
  }
  if ((tileX * 5 + tileY * 11) % 6 === 0) {
    ctx.strokeStyle = withAlpha(style.accent, 0.24);
    ctx.lineWidth = Math.max(1, 0.75 * zoom);
    ctx.strokeRect(
      Math.round(x - 4 * zoom),
      Math.round(y - 1 * zoom),
      Math.max(2, Math.round(8 * zoom)),
      Math.max(1, Math.round(4 * zoom)),
    );
  }
  ctx.strokeStyle = withAlpha(style.accent, Math.max(0.12, ledgerPulse));
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y - 2 * zoom);
  ctx.lineTo(x + 10 * zoom, y + 3 * zoom);
  ctx.moveTo(x - 8 * zoom, y + 5 * zoom);
  ctx.lineTo(x + 7 * zoom, y + 8 * zoom);
  ctx.stroke();
  if ((tileX * 7 + tileY * 5) % 5 === 0) {
    ctx.fillStyle = withAlpha(style.wave, 0.24);
    drawDiamond(ctx, x - 1 * zoom, y + 2 * zoom, 8 * zoom, 3 * zoom, ctx.fillStyle);
  }
  if ((tileX * 3 + tileY) % 7 === 0) {
    drawDepthSounding(ctx, x + 6 * zoom, y + 1 * zoom, zoom, style.accent, 0.22);
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
  style: WaterTerrainStyle,
) {
  const pulse = motion.reducedMotion ? 0.16 : 0.13 + Math.sin(motion.timeSeconds * 0.85 + tileX * 0.23 + tileY * 0.17) * 0.04;
  ctx.save();
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.1, pulse));
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
    const reflection = withAlpha(style.accent, 0.24);
    ctx.fillStyle = reflection;
    drawDiamond(ctx, x + 2 * zoom, y + 2 * zoom, 8 * zoom, 3 * zoom, reflection);
  }
  ctx.restore();
}

function drawCalmWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
  style: WaterTerrainStyle,
) {
  const hush = motion.reducedMotion ? 0.13 : 0.11 + Math.sin(motion.timeSeconds * 0.48 + tileX * 0.19 + tileY * 0.13) * 0.025;
  ctx.save();
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.08, hush));
  ctx.lineWidth = Math.max(1, 0.85 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 12 * zoom, y + 3 * zoom);
  ctx.quadraticCurveTo(x - 2 * zoom, y + 1.5 * zoom, x + 11 * zoom, y + 3 * zoom);
  if ((tileX * 11 + tileY * 5) % 5 === 0) {
    ctx.moveTo(x - 5 * zoom, y - 1 * zoom);
    ctx.quadraticCurveTo(x, y - 2 * zoom, x + 6 * zoom, y - 1 * zoom);
  }
  ctx.stroke();
  if ((tileX * 7 + tileY * 3) % 8 === 0) {
    drawDepthSounding(ctx, x - 5 * zoom, y + 1 * zoom, zoom, style.accent, 0.18);
  }
  if ((tileX + tileY) % 6 === 0) {
    const reflection = withAlpha(style.accent, 0.2);
    ctx.fillStyle = reflection;
    drawDiamond(ctx, x, y + 2 * zoom, 9 * zoom, 2.5 * zoom, reflection);
  }
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
  style: WaterTerrainStyle,
) {
  if ((tileX * 5 + tileY * 7) % 6 !== 0) return;
  const glint = motion.reducedMotion ? 0.08 : 0.06 + Math.sin(motion.timeSeconds * 0.6 + tileX * 0.2 + tileY * 0.31) * 0.025;
  ctx.save();
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.04, glint));
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 8 * zoom, y);
  ctx.lineTo(x + 6 * zoom, y + 3 * zoom);
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
  style: WaterTerrainStyle,
) {
  const pulse = motion.reducedMotion ? 0.16 : 0.14 + Math.sin(motion.timeSeconds * 1.1 + tileX * 0.31) * 0.04;
  ctx.save();
  const drift = motion.reducedMotion ? 0 : Math.sin(motion.timeSeconds * 0.7 + tileY * 0.23) * 1.5 * zoom;
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.12, pulse - 0.03));
  ctx.lineWidth = Math.max(1, 0.9 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 12 * zoom + drift, y + 4 * zoom);
  ctx.quadraticCurveTo(x - 4 * zoom + drift, y - 3 * zoom, x + 10 * zoom + drift, y);
  if ((tileX + tileY) % 3 === 0) {
    ctx.moveTo(x - 8 * zoom - drift, y + 8 * zoom);
    ctx.quadraticCurveTo(x - 2 * zoom - drift, y + 3 * zoom, x + 8 * zoom - drift, y + 6 * zoom);
  }
  ctx.stroke();
  ctx.strokeStyle = withAlpha(style.accent, Math.max(0.16, pulse));
  ctx.lineWidth = Math.max(1, 1.1 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 10 * zoom, y - 3 * zoom);
  ctx.lineTo(x + 9 * zoom, y + 2 * zoom);
  if ((tileX + tileY) % 2 === 0) {
    ctx.moveTo(x - 3 * zoom, y + 5 * zoom);
    ctx.lineTo(x + 8 * zoom, y + 8 * zoom);
  }
  ctx.stroke();
  if ((tileX * 13 + tileY * 5) % 7 === 0) {
    drawCurrentWakeMark(ctx, x, y, zoom, style.accent, 0.28);
  }
  ctx.restore();
}

function drawWatchWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
  style: WaterTerrainStyle,
) {
  const crosswind = motion.reducedMotion ? 0.16 : 0.14 + Math.sin(motion.timeSeconds * 0.95 + tileY * 0.29) * 0.04;
  ctx.save();
  if ((tileX * 7 + tileY * 2) % 4 !== 1) {
    ctx.strokeStyle = withAlpha(style.accent, 0.16);
    ctx.lineWidth = Math.max(1, 0.8 * zoom);
    ctx.setLineDash([2.8 * zoom, 3.4 * zoom]);
    ctx.beginPath();
    ctx.moveTo(x - 13 * zoom, y - 1 * zoom);
    ctx.lineTo(x + 11 * zoom, y + 5 * zoom);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.12, crosswind));
  ctx.lineWidth = Math.max(1, zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y + 1 * zoom);
  ctx.lineTo(x - 3 * zoom, y - 1 * zoom);
  ctx.lineTo(x + 7 * zoom, y + 2 * zoom);
  if ((tileX * 3 + tileY * 7) % 3 === 0) {
    ctx.moveTo(x - 7 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 9 * zoom, y + 5 * zoom);
  }
  ctx.stroke();
  if ((tileX + tileY * 5) % 7 === 0) {
    drawBreakwaterFoam(ctx, x, y, zoom, style.wave, 0.22);
  }
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
  style: WaterTerrainStyle,
) {
  const chop = motion.reducedMotion ? 0.2 : 0.18 + Math.sin(motion.timeSeconds * 1.6 + tileY * 0.37) * 0.05;
  ctx.save();
  if ((tileX + tileY) % 2 === 0) {
    const shoalFill = withAlpha(style.accent, 0.22);
    drawDiamond(ctx, x + 1 * zoom, y + 1 * zoom, 18 * zoom, 7 * zoom, shoalFill);
    ctx.strokeStyle = withAlpha(style.wave, 0.18);
    ctx.lineWidth = Math.max(1, 0.75 * zoom);
    ctx.beginPath();
    ctx.moveTo(x - 7 * zoom, y + 1 * zoom);
    ctx.lineTo(x + 7 * zoom, y + 4 * zoom);
    ctx.moveTo(x - 3 * zoom, y - 2 * zoom);
    ctx.lineTo(x + 10 * zoom, y + 1 * zoom);
    ctx.stroke();
  }
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.16, chop));
  ctx.lineWidth = Math.max(1, 1.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y - 2 * zoom);
  ctx.lineTo(x - 4 * zoom, y + 2 * zoom);
  ctx.lineTo(x + 3 * zoom, y - 1 * zoom);
  ctx.moveTo(x + 3 * zoom, y + 5 * zoom);
  ctx.lineTo(x + 11 * zoom, y + 8 * zoom);
  ctx.stroke();
  if ((tileX * 5 + tileY * 7) % 4 === 0) {
    ctx.fillStyle = withAlpha(style.accent, 0.3);
    ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y + 1 * zoom), Math.max(1, Math.round(4 * zoom)), Math.max(1, Math.round(2 * zoom)));
  }
  if ((tileX * 11 + tileY * 13) % 9 === 0) {
    drawDepthSounding(ctx, x + 7 * zoom, y + 3 * zoom, zoom, style.wave, 0.26);
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
  style: WaterTerrainStyle,
) {
  const whitecap = motion.reducedMotion ? 0.22 : 0.18 + Math.sin(motion.timeSeconds * 2.1 + tileX * 0.43 + tileY * 0.29) * 0.08;
  ctx.save();
  if ((tileX * 3 + tileY * 5) % 4 !== 2) {
    ctx.strokeStyle = "rgba(7, 12, 21, 0.34)";
    ctx.lineWidth = Math.max(1, 1.25 * zoom);
    ctx.beginPath();
    ctx.moveTo(x - 13 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 12 * zoom, y - 5 * zoom);
    ctx.stroke();
  }
  ctx.strokeStyle = withAlpha(style.wave, Math.max(0.14, whitecap));
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
    ctx.strokeStyle = withAlpha(style.accent, 0.22);
    ctx.lineWidth = Math.max(1, 0.85 * zoom);
    ctx.beginPath();
    ctx.moveTo(x - 8 * zoom, y + 1 * zoom);
    ctx.lineTo(x - 3 * zoom, y - 3 * zoom);
    ctx.lineTo(x + 2 * zoom, y + 1 * zoom);
    ctx.moveTo(x + 4 * zoom, y + 6 * zoom);
    ctx.lineTo(x + 9 * zoom, y + 2 * zoom);
    ctx.lineTo(x + 13 * zoom, y + 5 * zoom);
    ctx.stroke();
  }
  if ((tileX * 7 + tileY * 11) % 8 === 0) {
    ctx.fillStyle = withAlpha(style.wave, 0.18);
    ctx.fillRect(Math.round(x - 1 * zoom), Math.round(y - 5 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
    ctx.fillRect(Math.round(x + 5 * zoom), Math.round(y + 3 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
  }
  ctx.restore();
}

function drawOpenWaterTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  tileX: number,
  tileY: number,
  motion: PharosVilleCanvasMotion,
  style: WaterTerrainStyle,
) {
  if ((tileX * 7 + tileY * 13) % 4 !== 0) return;
  const drift = motion.reducedMotion ? 0.12 : 0.1 + Math.sin(motion.timeSeconds * 0.72 + tileX * 0.17 + tileY * 0.21) * 0.03;
  ctx.save();
  ctx.strokeStyle = withAlpha(style.accent, Math.max(0.08, drift));
  ctx.lineWidth = Math.max(1, 0.9 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y + 1 * zoom);
  ctx.lineTo(x - 2 * zoom, y + 4 * zoom);
  ctx.lineTo(x + 9 * zoom, y + 1 * zoom);
  if ((tileX + tileY) % 5 === 0) {
    ctx.moveTo(x - 5 * zoom, y - 4 * zoom);
    ctx.lineTo(x + 7 * zoom, y - 1 * zoom);
  }
  ctx.stroke();
  ctx.restore();
}

function drawMooringRule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  alpha: number,
) {
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.lineWidth = Math.max(1, 0.75 * zoom);
  ctx.beginPath();
  ctx.moveTo(x + fromX * zoom, y + fromY * zoom);
  ctx.lineTo(x + toX * zoom, y + toY * zoom);
  ctx.stroke();
}

function drawDepthSounding(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  color: string,
  alpha: number,
) {
  ctx.save();
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.fillStyle = withAlpha(color, alpha * 0.82);
  ctx.lineWidth = Math.max(1, 0.65 * zoom);
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1.4, 2.2 * zoom), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillRect(
    Math.round(x - 0.8 * zoom),
    Math.round(y - 0.8 * zoom),
    Math.max(1, Math.round(1.6 * zoom)),
    Math.max(1, Math.round(1.6 * zoom)),
  );
  ctx.restore();
}

function drawCurrentWakeMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  color: string,
  alpha: number,
) {
  ctx.save();
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.lineWidth = Math.max(1, 0.8 * zoom);
  ctx.beginPath();
  ctx.moveTo(x + 2 * zoom, y - 5 * zoom);
  ctx.lineTo(x + 8 * zoom, y - 1 * zoom);
  ctx.lineTo(x + 2 * zoom, y + 3 * zoom);
  ctx.moveTo(x - 5 * zoom, y - 2 * zoom);
  ctx.lineTo(x + 1 * zoom, y + 2 * zoom);
  ctx.lineTo(x - 5 * zoom, y + 6 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawBreakwaterFoam(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  color: string,
  alpha: number,
) {
  ctx.save();
  ctx.strokeStyle = withAlpha(color, alpha);
  ctx.lineWidth = Math.max(1, 0.9 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 12 * zoom, y + 5 * zoom);
  ctx.quadraticCurveTo(x - 8 * zoom, y + 1 * zoom, x - 4 * zoom, y + 5 * zoom);
  ctx.quadraticCurveTo(x, y + 9 * zoom, x + 4 * zoom, y + 5 * zoom);
  ctx.quadraticCurveTo(x + 8 * zoom, y + 1 * zoom, x + 12 * zoom, y + 5 * zoom);
  ctx.stroke();
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
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>> | null,
) {
  const value = String(kind);
  const width = 32 * zoom;
  const height = 16 * zoom;
  if (asset) {
    drawTerrainAsset(ctx, asset, x, y, zoom);
    drawDiamond(ctx, x, y, width, height, withAlpha(terrainColor(kind), value === "road" ? 0.36 : 0.24));
  } else {
    drawDiamond(ctx, x, y, width, height, terrainColor(kind));
  }
  drawGroundGrain(ctx, x, y, zoom, value, tileX, tileY);

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
  } else if (value === "grass" || value === "hill" || value === "land" || (tileX * 19 + tileY * 23) % 6 === 0) {
    drawGrassTexture(ctx, x, y, zoom, tileX, tileY);
  }
}

function drawTerrainAsset(
  ctx: CanvasRenderingContext2D,
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>>,
  x: number,
  y: number,
  zoom: number,
) {
  const scale = zoom * TERRAIN_ASSET_SCALE;
  drawAsset(ctx, asset, x, y + TILE_HEIGHT * zoom * 0.46, scale);
}

function drawGroundGrain(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  value: string,
  tileX: number,
  tileY: number,
) {
  if (value === "road" || value.includes("road") || value.includes("stair")) return;
  if (value === "rock" || value === "cliff" || value.includes("rock") || value.includes("cliff")) return;
  const offset = ((tileX * 11 + tileY * 5) % 5 - 2) * zoom;
  ctx.save();
  if (value === "beach" || value === "shore") {
    ctx.fillStyle = TERRAIN_TEXTURE.beachPebble;
    ctx.fillRect(Math.round(x - 4 * zoom + offset), Math.round(y + 1 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
    if ((tileX + tileY) % 3 === 0) {
      ctx.strokeStyle = TERRAIN_TEXTURE.sandLight;
      ctx.lineWidth = Math.max(1, 0.8 * zoom);
      ctx.beginPath();
      ctx.moveTo(x - 9 * zoom, y - 2 * zoom);
      ctx.lineTo(x + 7 * zoom, y + 1 * zoom);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  ctx.strokeStyle = TERRAIN_TEXTURE.mossShadow;
  ctx.lineWidth = Math.max(1, 0.8 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 9 * zoom + offset, y + 2 * zoom);
  ctx.lineTo(x - 2 * zoom + offset, y + 5 * zoom);
  if ((tileX * 3 + tileY * 7) % 2 === 0) {
    ctx.moveTo(x + 1 * zoom - offset, y - 3 * zoom);
    ctx.lineTo(x + 8 * zoom - offset, y);
  }
  ctx.stroke();
  if ((tileX * 17 + tileY * 19) % 4 === 0) {
    ctx.fillStyle = TERRAIN_TEXTURE.groundGrain;
    drawDiamond(ctx, x + 2 * zoom, y + 2 * zoom, 7 * zoom, 3 * zoom, ctx.fillStyle);
  }
  ctx.restore();
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
  ctx.strokeStyle = TERRAIN_TEXTURE.roadShadow;
  ctx.lineWidth = Math.max(1, 1.8 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 11 * zoom, y + 2 * zoom);
  ctx.lineTo(x + 9 * zoom, y + 5 * zoom);
  ctx.stroke();
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
  ctx.fillStyle = TERRAIN_TEXTURE.grassMid;
  ctx.fillRect(Math.round(x - 5 * zoom - offset * 0.4), Math.round(y + 2 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
  ctx.fillStyle = TERRAIN_TEXTURE.grassLight;
  ctx.fillRect(Math.round(x + 2 * zoom + offset), Math.round(y + 1 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(2 * zoom)));
  ctx.restore();
}

function drawAtmosphere({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  const mood = skyState(motion).mood;
  const beacon = tileToScreen(world.lighthouse.tile, camera);
  ctx.save();
  ctx.fillStyle = mood.mist;
  ctx.beginPath();
  ctx.ellipse(beacon.x - 18 * camera.zoom, beacon.y - 92 * camera.zoom, 220 * camera.zoom, 54 * camera.zoom, -0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHarborDistrictGround({ camera, ctx }: DrawPharosVilleInput) {
  ctx.save();
  drawDistrictPad(ctx, camera, { x: 31.2, y: 22.6 }, 118, 38, "rgba(66, 62, 53, 0.38)", "rgba(204, 177, 116, 0.24)");
  drawDistrictPad(ctx, camera, { x: 20.4, y: 33.5 }, 92, 44, "rgba(66, 62, 53, 0.42)", "rgba(204, 177, 116, 0.26)");
  drawDistrictPad(ctx, camera, { x: 33.0, y: 41.6 }, 128, 42, "rgba(66, 62, 53, 0.46)", "rgba(204, 177, 116, 0.28)");
  drawDistrictPad(ctx, camera, { x: 44.6, y: 31.8 }, 98, 42, "rgba(66, 62, 53, 0.5)", "rgba(204, 177, 116, 0.3)");

  drawSeawallRun(ctx, camera, [
    { x: 23.0, y: 24.3 },
    { x: 29.4, y: 20.1 },
    { x: 36.3, y: 20.0 },
    { x: 43.0, y: 25.5 },
  ]);
  drawSeawallRun(ctx, camera, [
    { x: 45.0, y: 30.0 },
    { x: 44.5, y: 35.2 },
    { x: 39.2, y: 41.0 },
    { x: 31.5, y: 44.4 },
  ]);
  drawSeawallRun(ctx, camera, [
    { x: 28.5, y: 44.0 },
    { x: 22.0, y: 38.8 },
    { x: 18.5, y: 33.4 },
    { x: 20.0, y: 27.3 },
  ]);
  ctx.restore();
}

function drawEthereumHarborExtensions({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  const ethereumDock = world.docks.find((dock) => dock.chainId === "ethereum") ?? null;
  if (!ethereumDock) return;

  const extensionDocks = ETHEREUM_L2_DOCK_CHAIN_IDS
    .map((chainId) => world.docks.find((dock) => dock.chainId === chainId) ?? null)
    .filter((dock): dock is PharosVilleWorld["docks"][number] => dock != null);
  if (extensionDocks.length === 0) return;

  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  const anchor = dockDrawPoint(ethereumDock, camera, world.map.width);
  ctx.save();
  drawDistrictPad(ctx, camera, { x: 41.8, y: 34.8 }, 118, 36, "rgba(54, 49, 44, 0.38)", "rgba(204, 177, 116, 0.2)");
  for (const [index, dock] of extensionDocks.entries()) {
    const point = dockDrawPoint(dock, camera, world.map.width);
    drawRollupExtensionCauseway(ctx, anchor, point, camera.zoom, index, extensionDocks.length, time);
    drawRollupExtensionSlip(ctx, point, camera.zoom, dock.size, index, time);
  }
  drawRollupHubMark(ctx, anchor, camera.zoom, extensionDocks.length, time);
  ctx.restore();
}

function drawRollupExtensionCauseway(
  ctx: CanvasRenderingContext2D,
  from: ScreenPoint,
  to: ScreenPoint,
  zoom: number,
  index: number,
  total: number,
  time: number,
) {
  const side = index - (total - 1) / 2;
  const bend = Math.max(-26, Math.min(26, side * 9)) * zoom;
  const midX = (from.x + to.x) / 2 + bend;
  const midY = (from.y + to.y) / 2 - (12 + Math.abs(side) * 2.5) * zoom;
  const pulse = 0.22 + Math.sin(time * 0.85 + index * 0.7) * 0.04;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(5, 8, 10, 0.34)";
  ctx.lineWidth = Math.max(2.2, 5.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y + 1.5 * zoom);
  ctx.quadraticCurveTo(midX, midY + 3 * zoom, to.x, to.y + 1.5 * zoom);
  ctx.stroke();

  ctx.strokeStyle = "rgba(176, 153, 104, 0.72)";
  ctx.lineWidth = Math.max(1.4, 2.6 * zoom);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y - 1 * zoom);
  ctx.quadraticCurveTo(midX, midY, to.x, to.y - 1 * zoom);
  ctx.stroke();

  ctx.strokeStyle = `rgba(128, 214, 206, ${pulse})`;
  ctx.lineWidth = Math.max(1, 1.1 * zoom);
  ctx.setLineDash([4 * zoom, 5 * zoom]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y - 3 * zoom);
  ctx.quadraticCurveTo(midX, midY - 2 * zoom, to.x, to.y - 3 * zoom);
  ctx.stroke();
  ctx.restore();
}

function drawRollupExtensionSlip(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  zoom: number,
  dockSize: number,
  index: number,
  time: number,
) {
  const scale = Math.max(0.72, zoom);
  const width = (34 + dockSize * 0.8) * scale;
  const height = (12 + dockSize * 0.28) * scale;
  const shimmer = 0.2 + Math.sin(time * 0.72 + index) * 0.035;
  ctx.save();
  drawDiamond(ctx, point.x, point.y + 12 * scale, width * 1.35, height * 1.45, "rgba(5, 8, 10, 0.26)");
  drawDiamond(ctx, point.x, point.y + 9 * scale, width, height, "rgba(73, 67, 55, 0.54)");
  drawDiamond(ctx, point.x, point.y + 6 * scale, width * 0.68, height * 0.58, "rgba(211, 184, 126, 0.28)");
  ctx.strokeStyle = `rgba(128, 214, 206, ${shimmer})`;
  ctx.lineWidth = Math.max(1, 0.9 * scale);
  ctx.beginPath();
  ctx.moveTo(point.x - width * 0.3, point.y + 8 * scale);
  ctx.lineTo(point.x - width * 0.04, point.y + 10.5 * scale);
  ctx.moveTo(point.x + width * 0.08, point.y + 10.5 * scale);
  ctx.lineTo(point.x + width * 0.32, point.y + 8 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawRollupHubMark(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  zoom: number,
  extensionCount: number,
  time: number,
) {
  const scale = Math.max(0.72, zoom);
  const pulse = 0.24 + Math.sin(time * 0.64) * 0.035;
  ctx.save();
  ctx.globalAlpha = extensionCount > 0 ? 1 : 0.5;
  ctx.strokeStyle = `rgba(128, 214, 206, ${pulse})`;
  ctx.lineWidth = Math.max(1, 1.2 * scale);
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + 4 * scale, 26 * scale, 8 * scale, -0.08, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 224, 160, 0.24)";
  drawDiamond(ctx, point.x, point.y + 4 * scale, 14 * scale, 6 * scale, ctx.fillStyle);
  ctx.restore();
}

function drawDistrictPad(
  ctx: CanvasRenderingContext2D,
  camera: IsoCamera,
  tile: { x: number; y: number },
  width: number,
  height: number,
  fill: string,
  top: string,
) {
  const p = tileToScreen(tile, camera);
  const zoom = camera.zoom;
  drawDiamond(ctx, p.x, p.y + 10 * zoom, width * zoom, height * zoom, "rgba(5, 7, 9, 0.26)");
  drawDiamond(ctx, p.x, p.y + 6 * zoom, width * zoom * 0.92, height * zoom * 0.82, fill);
  drawDiamond(ctx, p.x, p.y + 1 * zoom, width * zoom * 0.76, height * zoom * 0.5, top);
  drawDistrictPaving(ctx, p.x, p.y + 1 * zoom, width * zoom * 0.76, height * zoom * 0.5, zoom);
}

function drawSeawallRun(ctx: CanvasRenderingContext2D, camera: IsoCamera, tiles: readonly { x: number; y: number }[]) {
  const points = tiles.map((tile) => tileToScreen(tile, camera));
  const [firstPoint, ...rest] = points;
  if (!firstPoint) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(7, 9, 12, 0.42)";
  ctx.lineWidth = Math.max(3, 6 * camera.zoom);
  ctx.beginPath();
  ctx.moveTo(firstPoint.x, firstPoint.y + 4 * camera.zoom);
  for (const point of rest) ctx.lineTo(point.x, point.y + 4 * camera.zoom);
  ctx.stroke();

  ctx.strokeStyle = "rgba(176, 153, 104, 0.76)";
  ctx.lineWidth = Math.max(2, 3.6 * camera.zoom);
  ctx.beginPath();
  ctx.moveTo(firstPoint.x, firstPoint.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.stroke();

  ctx.strokeStyle = "rgba(239, 221, 169, 0.42)";
  ctx.lineWidth = Math.max(1, 1.2 * camera.zoom);
  ctx.beginPath();
  ctx.moveTo(firstPoint.x - 3 * camera.zoom, firstPoint.y - 2 * camera.zoom);
  for (const point of rest) ctx.lineTo(point.x - 3 * camera.zoom, point.y - 2 * camera.zoom);
  ctx.stroke();

  for (const [index, point] of points.entries()) {
    if (index % 2 !== 0 && index !== points.length - 1) continue;
    drawDiamond(
      ctx,
      point.x,
      point.y - 1.2 * camera.zoom,
      10 * camera.zoom,
      4.2 * camera.zoom,
      "rgba(218, 197, 145, 0.38)",
    );
  }
  ctx.restore();
}

function drawDistrictPaving(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
) {
  ctx.save();
  ctx.strokeStyle = "rgba(55, 39, 25, 0.24)";
  ctx.lineWidth = Math.max(1, 0.8 * zoom);
  for (const ratio of [-0.28, -0.08, 0.12, 0.31]) {
    const span = width * (0.43 - Math.abs(ratio) * 0.46);
    ctx.beginPath();
    ctx.moveTo(x - span, y + ratio * height);
    ctx.lineTo(x + span, y + ratio * height + 2 * zoom);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(235, 213, 160, 0.18)";
  for (const ratio of [-0.2, 0.04, 0.26]) {
    const span = width * (0.28 - Math.abs(ratio) * 0.26);
    ctx.beginPath();
    ctx.moveTo(x - span, y + ratio * height - 2 * zoom);
    ctx.lineTo(x - span * 0.2, y + ratio * height + 1 * zoom);
    ctx.moveTo(x + span * 0.22, y + ratio * height - 1 * zoom);
    ctx.lineTo(x + span, y + ratio * height + 2 * zoom);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(247, 214, 138, 0.08)";
  drawDiamond(ctx, x, y - 1 * zoom, width * 0.46, height * 0.28, ctx.fillStyle);
  ctx.restore();
}

function drawLighthouseSeaGlow({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  const beacon = tileToScreen(world.lighthouse.tile, camera);
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const reflection of LIGHTHOUSE_REFLECTIONS) {
    const pulse = motion.reducedMotion ? 0 : Math.sin(time * 0.8 + reflection.phase) * 0.035;
    const x = beacon.x + reflection.offsetX * camera.zoom;
    const y = beacon.y + reflection.offsetY * camera.zoom;
    const gradient = ctx.createLinearGradient(
      x - reflection.length * camera.zoom * 0.48,
      y - 5 * camera.zoom,
      x + reflection.length * camera.zoom * 0.48,
      y + 5 * camera.zoom,
    );
    gradient.addColorStop(0, "rgba(255, 200, 87, 0)");
    gradient.addColorStop(0.48, `rgba(255, 200, 87, ${Math.max(0.08, reflection.alpha + pulse)})`);
    gradient.addColorStop(1, "rgba(255, 200, 87, 0)");
    ctx.strokeStyle = gradient;
    ctx.lineWidth = Math.max(1, 2.4 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(x - reflection.length * camera.zoom * 0.45, y);
    ctx.lineTo(x + reflection.length * camera.zoom * 0.45, y + 4 * camera.zoom);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLighthouseSurf({ camera, ctx, motion }: DrawPharosVilleInput) {
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  ctx.save();
  ctx.lineCap = "round";
  for (const surf of LIGHTHOUSE_SURF) {
    const p = tileToScreen(surf, camera);
    const wash = motion.reducedMotion ? 0.66 : 0.58 + Math.sin(time * 1.4 + surf.phase) * 0.12;
    ctx.strokeStyle = `rgba(232, 243, 233, ${wash})`;
    ctx.lineWidth = Math.max(1, 1.8 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(p.x - surf.length * camera.zoom * 0.5, p.y);
    ctx.quadraticCurveTo(
      p.x,
      p.y + surf.tilt * surf.length * camera.zoom,
      p.x + surf.length * camera.zoom * 0.5,
      p.y + 4 * camera.zoom,
    );
    ctx.stroke();

    ctx.strokeStyle = "rgba(130, 216, 204, 0.26)";
    ctx.lineWidth = Math.max(1, 0.9 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(p.x - surf.length * camera.zoom * 0.35, p.y + 5 * camera.zoom);
    ctx.lineTo(p.x + surf.length * camera.zoom * 0.32, p.y + 8 * camera.zoom);
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
  ctx.ellipse(center.x - 2 * zoom, center.y + 10 * zoom, 70 * zoom, 24 * zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();

  drawDiamond(ctx, center.x - 2 * zoom, center.y + 19 * zoom, 88 * zoom, 38 * zoom, LIGHTHOUSE_HEADLAND.shadow);
  drawDiamond(ctx, center.x - 2 * zoom, center.y + 11 * zoom, 74 * zoom, 30 * zoom, LIGHTHOUSE_HEADLAND.cliff);
  drawTileLowerFacet(ctx, center.x - 2 * zoom, center.y + 11 * zoom, 74 * zoom, 30 * zoom, "rgba(25, 29, 27, 0.54)");
  drawDiamond(ctx, center.x - 1 * zoom, center.y + 1 * zoom, 58 * zoom, 22 * zoom, crownColor);
  drawDiamond(ctx, center.x, center.y - 5 * zoom, 42 * zoom, 16 * zoom, LIGHTHOUSE_HEADLAND.stone);

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

  ctx.restore();
}

function lighthouseTerrain(world: PharosVilleWorld): TerrainKind {
  const tile = world.map.tiles.find((candidate) => (
    candidate.x === world.lighthouse.tile.x && candidate.y === world.lighthouse.tile.y
  ));
  return tile?.terrain ?? tile?.kind ?? "hill";
}

function drawCemeteryGround({ assets, camera, ctx, world }: DrawPharosVilleInput) {
  ctx.save();
  for (const tile of world.map.tiles) {
    if (tile.kind !== "land" && tile.kind !== "shore") continue;
    const value = cemeteryValue(tile.x, tile.y);
    if (value > 1.08) continue;
    const p = tileToScreen(tile, camera);
    const edge = value > 0.78;
    const inner = value < 0.52;
    drawDiamond(
      ctx,
      p.x,
      p.y,
      32 * camera.zoom,
      16 * camera.zoom,
      edge ? CEMETERY_SURFACE.grassEdge : CEMETERY_SURFACE.grass,
    );
    if (!edge) {
      drawDiamond(
        ctx,
        p.x,
        p.y + 1 * camera.zoom,
        26 * camera.zoom,
        12 * camera.zoom,
        inner ? CEMETERY_SURFACE.limestoneCore : CEMETERY_SURFACE.limestone,
      );
    }
    if ((tile.x * 17 + tile.y * 29) % 7 === 0) {
      drawCemeteryTuft(
        ctx,
        p.x + ((tile.x % 3) - 1) * 4 * camera.zoom * CEMETERY_GLOBAL_SCALE,
        p.y + 3 * camera.zoom * CEMETERY_GLOBAL_SCALE,
        camera.zoom * CEMETERY_GLOBAL_SCALE,
      );
    }
  }

  drawCemeteryQuayEdge(ctx, camera);
  drawCemeteryPath(ctx, camera);
  const terraceAsset = assets?.get("prop.memorial-terrace") ?? null;
  if (terraceAsset) {
    const terracePoint = tileToScreen(CEMETERY_CENTER, camera);
    drawAsset(
      ctx,
      terraceAsset,
      terracePoint.x,
      terracePoint.y + 7 * camera.zoom * CEMETERY_GLOBAL_SCALE,
      camera.zoom * 0.92,
    );
  }
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
  drawIsoStroke(ctx, camera, northPath, CEMETERY_SURFACE.path, 10 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, cemeteryContextTiles([
    { x: 14.55, y: 41.7 },
    { x: 17.65, y: 41.32 },
    { x: 21.75, y: 41.78 },
    { x: 25.85, y: 41.35 },
    { x: 29.7, y: 41.85 },
  ]), CEMETERY_SURFACE.limestoneEdge, 6.5 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, cemeteryContextTiles([
    { x: 16.7, y: 38.95 },
    { x: 18.4, y: 39.6 },
    { x: 19.85, y: 40.65 },
  ]), CEMETERY_SURFACE.limestoneEdge, 5.8 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, northPath, CEMETERY_SURFACE.pathLight, 2.5 * CEMETERY_GLOBAL_SCALE);
}

function drawCemeteryQuayEdge(ctx: CanvasRenderingContext2D, camera: IsoCamera) {
  const lowerEdge = cemeteryContextTiles([
    { x: 14.35, y: 44.0 },
    { x: 17.75, y: 47.9 },
    { x: 22.2, y: 48.8 },
    { x: 27.3, y: 46.85 },
    { x: 30.6, y: 42.95 },
  ]);
  const upperEdge = cemeteryContextTiles([
    { x: 14.1, y: 40.05 },
    { x: 16.8, y: 36.25 },
    { x: 21.1, y: 34.95 },
    { x: 26.2, y: 35.9 },
    { x: 30.45, y: 40.08 },
  ]);
  drawIsoStroke(ctx, camera, lowerEdge, CEMETERY_SURFACE.quayDark, 7 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, upperEdge, CEMETERY_SURFACE.limestoneEdge, 4.5 * CEMETERY_GLOBAL_SCALE);
  drawIsoStroke(ctx, camera, lowerEdge, CEMETERY_SURFACE.quayFoam, 1.6 * CEMETERY_GLOBAL_SCALE);
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
    drawIsoStroke(ctx, camera, rail, "rgba(63, 53, 38, 0.74)", 3 * CEMETERY_GLOBAL_SCALE);
    for (const tile of rail) {
      const p = tileToScreen(tile, camera);
      ctx.fillStyle = CEMETERY_SURFACE.post;
      ctx.fillRect(
        Math.round(p.x - 1 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.round(p.y - 7 * camera.zoom * CEMETERY_GLOBAL_SCALE),
        Math.max(1, Math.round(2 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
        Math.max(3, Math.round(9 * camera.zoom * CEMETERY_GLOBAL_SCALE)),
      );
      ctx.fillStyle = CEMETERY_SURFACE.postCap;
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
  ctx.fillStyle = "rgba(78, 126, 68, 0.58)";
  ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y), Math.max(1, Math.round(2 * zoom)), Math.max(1, Math.round(4 * zoom)));
  ctx.fillStyle = "rgba(45, 88, 56, 0.64)";
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
  ctx.fillStyle = "#314f37";
  ctx.beginPath();
  ctx.ellipse(x, y + 2 * zoom, 9 * zoom, 4 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#6f8f58";
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
  ctx.fillStyle = "#6f6f64";
  ctx.fillRect(-18, -32, 36, 28);
  ctx.fillStyle = "#b7aa88";
  ctx.fillRect(-14, -29, 28, 23);
  ctx.fillStyle = "#4e4030";
  ctx.fillRect(-7, -18, 14, 14);
  ctx.fillStyle = "#d3bf86";
  ctx.fillRect(-21, -5, 42, 6);
  ctx.fillStyle = "#7b5a3f";
  ctx.beginPath();
  ctx.moveTo(-21, -32);
  ctx.lineTo(0, -48);
  ctx.lineTo(21, -32);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#d9c58c";
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

  ctx.fillStyle = "#6c6554";
  ctx.fillRect(-20, -1, 40, 7);
  ctx.fillStyle = "#d4c089";
  ctx.fillRect(-16, -7, 32, 7);
  ctx.fillStyle = "#8e836a";
  ctx.fillRect(-14, -27, 28, 22);
  ctx.fillStyle = "#c7b78f";
  ctx.beginPath();
  ctx.moveTo(-11, -6);
  ctx.lineTo(-11, -20);
  ctx.quadraticCurveTo(-10, -31, 0, -35);
  ctx.quadraticCurveTo(10, -31, 11, -20);
  ctx.lineTo(11, -6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#3b3023";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.fillStyle = "#71664f";
  ctx.fillRect(-16, -26, 5, 21);
  ctx.fillRect(11, -26, 5, 21);
  ctx.fillStyle = "#eee0a8";
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
  ctx.strokeStyle = "#5b3a24";
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
    ctx.fillStyle = "#78915b";
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
  ctx.fillStyle = "#91846b";
  ctx.fillRect(-2, -12, 4, 15);
  ctx.fillRect(-7, 1, 14, 4);
  ctx.fillStyle = "#c9b88a";
  ctx.fillRect(-6, -18, 12, 6);
  ctx.fillStyle = "#d4b663";
  ctx.fillRect(-3, -17, 6, 3);
  ctx.restore();
}

function lighthouseRenderState({ assets, camera, world }: DrawPharosVilleInput) {
  const center = tileToScreen(world.lighthouse.tile, camera);
  const lighthouseAsset = assets?.get("landmark.lighthouse");
  const spriteScale = camera.zoom * LIGHTHOUSE_SPRITE_CROP.scale;
  const spriteAnchor = {
    x: center.x,
    y: center.y + LIGHTHOUSE_SPRITE_CROP.bottomOffsetY * camera.zoom,
  };
  const firePoint = lighthouseAsset
    ? {
      x: spriteAnchor.x + (LIGHTHOUSE_SPRITE_CROP.beaconX - LIGHTHOUSE_SPRITE_CROP.anchorX) * spriteScale,
      y: spriteAnchor.y + (LIGHTHOUSE_SPRITE_CROP.beaconY - LIGHTHOUSE_SPRITE_CROP.anchorY) * spriteScale,
    }
    : { x: center.x, y: center.y - 148 * camera.zoom };
  return { center, firePoint, lighthouseAsset, spriteAnchor, spriteScale };
}

function drawLighthouseBody(input: DrawPharosVilleInput) {
  const { camera, ctx, world } = input;
  const { center, lighthouseAsset, spriteAnchor, spriteScale } = lighthouseRenderState(input);
  if (lighthouseAsset) {
    drawLighthouseAssetCrop(ctx, lighthouseAsset, spriteAnchor.x, spriteAnchor.y, spriteScale);
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
}

function drawLighthouseAssetCrop(
  ctx: CanvasRenderingContext2D,
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>>,
  anchorX: number,
  anchorY: number,
  scale: number,
) {
  ctx.drawImage(
    asset.image,
    LIGHTHOUSE_SPRITE_CROP.sourceX,
    LIGHTHOUSE_SPRITE_CROP.sourceY,
    LIGHTHOUSE_SPRITE_CROP.sourceWidth,
    LIGHTHOUSE_SPRITE_CROP.sourceHeight,
    Math.round(anchorX - LIGHTHOUSE_SPRITE_CROP.anchorX * scale),
    Math.round(anchorY - LIGHTHOUSE_SPRITE_CROP.anchorY * scale),
    Math.round(LIGHTHOUSE_SPRITE_CROP.sourceWidth * scale),
    Math.round(LIGHTHOUSE_SPRITE_CROP.sourceHeight * scale),
  );
}

function drawLighthouseOverlay(input: DrawPharosVilleInput) {
  const { camera, ctx, motion, world } = input;
  const { firePoint, lighthouseAsset } = lighthouseRenderState(input);
  if (!world.lighthouse.unavailable) drawLighthouseBeam(ctx, firePoint, camera.zoom * 1.35, motion);
  if (lighthouseAsset) return;
  drawLighthouseFire(ctx, firePoint, camera.zoom * 1.32, world.lighthouse.color, motion);
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
  ctx.globalCompositeOperation = "lighter";
  const halo = ctx.createRadialGradient(x, y - 9 * zoom, 1 * zoom, x, y - 9 * zoom, 22 * zoom);
  halo.addColorStop(0, `rgba(247, 214, 138, ${glow * 0.9})`);
  halo.addColorStop(0.46, `rgba(212, 154, 62, ${glow * 0.28})`);
  halo.addColorStop(1, "rgba(212, 154, 62, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.ellipse(x, y - 8 * zoom, 22 * zoom, 12 * zoom, -0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(255, 197, 95, ${glow})`;
  ctx.beginPath();
  ctx.ellipse(x, y - 7 * zoom, 12 * zoom, 7 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3f2d1f";
  ctx.fillRect(Math.round(x - zoom), Math.round(y - 12 * zoom), Math.max(1, Math.round(2 * zoom)), Math.max(4, Math.round(12 * zoom)));
  ctx.fillStyle = "#f5c766";
  ctx.fillRect(Math.round(x - 2 * zoom), Math.round(y - 14 * zoom), Math.max(2, Math.round(4 * zoom)), Math.max(2, Math.round(3 * zoom)));
  ctx.strokeStyle = `rgba(247, 214, 138, ${glow * 0.58})`;
  ctx.lineWidth = Math.max(1, 0.85 * zoom);
  ctx.beginPath();
  ctx.moveTo(x - 8 * zoom, y + 2 * zoom);
  ctx.lineTo(x + 9 * zoom, y + 4 * zoom);
  ctx.stroke();
  ctx.restore();
}

function dockRenderState({ assets, camera, world }: DrawPharosVilleInput, dock: PharosVilleWorld["docks"][number]) {
  const dockAsset = assets?.get(dock.assetId) ?? assets?.get("dock.wooden-pier");
  const geometry = resolveEntityGeometry({
    asset: dockAsset,
    camera,
    entity: dock,
    mapWidth: world.map.width,
  });
  const harbor = geometry.drawPoint;
  return { dockAsset, geometry, harbor };
}

function drawDockBody(input: DrawPharosVilleInput, dock: PharosVilleWorld["docks"][number]) {
  const { camera, ctx } = input;
  const p = tileToScreen(dock.tile, camera);
  const { dockAsset, geometry, harbor } = dockRenderState(input, dock);
  drawDockQuayUnderlay(ctx, dock, harbor, camera.zoom);
  if (dockAsset) {
    drawAsset(
      ctx,
      dockAsset,
      harbor.x,
      harbor.y,
      geometry.drawScale,
    );
  } else {
    ctx.strokeStyle = "#6d4c2f";
    ctx.lineWidth = (3 + dock.size) * camera.zoom;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(harbor.x, harbor.y);
    ctx.stroke();
  }
}

function drawDockQuayUnderlay(
  ctx: CanvasRenderingContext2D,
  dock: PharosVilleWorld["docks"][number],
  point: ScreenPoint,
  zoom: number,
) {
  const size = Math.max(0, dock.size);
  const width = (58 + size * 0.75) * zoom;
  const height = (22 + size * 0.18) * zoom;
  ctx.save();
  drawDiamond(ctx, point.x, point.y + 9 * zoom, width * 1.14, height * 1.12, "rgba(5, 8, 10, 0.36)");
  drawDiamond(ctx, point.x, point.y + 5 * zoom, width, height, "rgba(83, 75, 58, 0.72)");
  drawDiamond(ctx, point.x, point.y + 1 * zoom, width * 0.78, height * 0.62, "rgba(211, 184, 126, 0.5)");
  ctx.strokeStyle = "rgba(57, 38, 23, 0.32)";
  ctx.lineWidth = Math.max(1, 0.9 * zoom);
  ctx.beginPath();
  ctx.moveTo(point.x - width * 0.31, point.y + height * 0.02);
  ctx.lineTo(point.x + width * 0.31, point.y + height * 0.12);
  ctx.moveTo(point.x - width * 0.18, point.y - height * 0.09);
  ctx.lineTo(point.x + width * 0.2, point.y - height * 0.02);
  ctx.stroke();
  ctx.fillStyle = "rgba(247, 214, 138, 0.09)";
  drawDiamond(ctx, point.x + width * 0.04, point.y - height * 0.04, width * 0.34, height * 0.22, ctx.fillStyle);
  ctx.strokeStyle = "rgba(232, 243, 233, 0.34)";
  ctx.lineWidth = Math.max(1, 1.2 * zoom);
  ctx.beginPath();
  ctx.moveTo(point.x - width * 0.42, point.y + height * 0.1);
  ctx.lineTo(point.x - width * 0.08, point.y + height * 0.34);
  ctx.moveTo(point.x + width * 0.14, point.y + height * 0.34);
  ctx.lineTo(point.x + width * 0.42, point.y + height * 0.1);
  ctx.stroke();
  ctx.restore();
}

function drawDockOverlay(input: DrawPharosVilleInput, dock: PharosVilleWorld["docks"][number]) {
  const { assets, camera, ctx, hoveredTarget, selectedTarget, world } = input;
  const { harbor } = dockRenderState(input, dock);
  drawHarborFlag({
    accent: dockHealthColor(dock.healthBand),
    ctx,
    dock,
    emphasized: hoveredTarget?.detailId === dock.detailId || selectedTarget?.detailId === dock.detailId,
    logo: assets?.getLogo(dock.logoSrc) ?? null,
    mapWidth: world.map.width,
    outward: dockOutwardVector(dock.tile, world.map.width),
    x: harbor.x,
    y: harbor.y - 12 * camera.zoom,
    zoom: camera.zoom,
  });
}

function dockHealthColor(healthBand: PharosVilleWorld["docks"][number]["healthBand"]) {
  if (healthBand === "robust" || healthBand === "healthy") return "#78b689";
  if (healthBand === "mixed") return "#dfb95a";
  if (healthBand === "fragile") return "#d98b54";
  if (healthBand === "concentrated") return "#c9675c";
  return "#9fb0aa";
}

function drawWaterAreaLabels({ camera, ctx, world }: DrawPharosVilleInput) {
  for (const area of world.areas) {
    const placement = areaLabelPlacementForArea(area);
    const p = tileToScreen(placement.anchorTile, camera);
    const accent = area.band ? dewsAreaColor(area.band) : riskWaterAreaColor(area.riskZone);
    drawCartographicWaterLabel({
      accent,
      align: placement.align,
      ctx,
      label: area.label,
      maxWidth: placement.maxWidth,
      rotation: placement.rotation,
      x: p.x,
      y: p.y,
      zoom: camera.zoom,
    });
  }
}

function drawEthereumHarborSigns({ camera, ctx, world }: DrawPharosVilleInput) {
  const renderedChainIds = new Set(world.docks.map((dock) => dock.chainId));
  for (const sign of ETHEREUM_HARBOR_SIGNS) {
    if (!sign.chainIds.some((chainId) => renderedChainIds.has(chainId))) continue;
    const p = tileToScreen(sign.tile, camera);
    drawCartographicWaterLabel({
      accent: sign.accent,
      align: "center",
      ctx,
      label: sign.label,
      maxWidth: sign.maxWidth,
      rotation: sign.rotation,
      x: p.x,
      y: p.y,
      zoom: camera.zoom,
    });
  }
}

function dewsAreaColor(band: NonNullable<PharosVilleWorld["areas"][number]["band"]>) {
  return DEWS_AREA_LABEL_COLORS[band];
}

function riskWaterAreaColor(zone: PharosVilleWorld["areas"][number]["riskZone"]) {
  if (zone === "ledger") return "#d9b974";
  return "#d8b56a";
}

function drawCartographicWaterLabel(input: {
  accent: string;
  align: "center" | "left" | "right";
  ctx: CanvasRenderingContext2D;
  label: string;
  maxWidth: number;
  rotation: number;
  x: number;
  y: number;
  zoom: number;
}) {
  const { accent, align, ctx, label, maxWidth, rotation, x, y, zoom } = input;
  const scale = Math.max(0.72, zoom);
  const fontSize = Math.max(8, Math.round(8.6 * scale));
  const text = label.toUpperCase();
  const width = maxWidth * scale;

  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(rotation);
  ctx.font = `700 ${fontSize}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const plaqueWidth = Math.min(width, ctx.measureText(text).width + 16 * scale);
  const plaqueX = align === "left" ? -3 * scale : align === "right" ? -plaqueWidth + 3 * scale : -plaqueWidth / 2;
  ctx.globalAlpha = 0.46;
  drawSignBoard(ctx, plaqueX, -8.4 * scale, plaqueWidth, 16.8 * scale, scale * 0.72, "rgba(74, 50, 27, 0.5)", "rgba(15, 10, 7, 0.76)");
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(plaqueX - 4 * scale, 0);
  ctx.lineTo(plaqueX - 10 * scale, -4 * scale);
  ctx.lineTo(plaqueX - 8 * scale, 4 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(plaqueX + plaqueWidth + 4 * scale, 0);
  ctx.lineTo(plaqueX + plaqueWidth + 10 * scale, -4 * scale);
  ctx.lineTo(plaqueX + plaqueWidth + 8 * scale, 4 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.88;
  ctx.strokeStyle = "rgba(5, 10, 17, 0.7)";
  ctx.lineWidth = Math.max(1.2, 2.2 * scale);
  ctx.strokeText(text, 0, 0, width);
  ctx.fillStyle = "rgba(238, 218, 169, 0.78)";
  ctx.fillText(text, 0, 0, width);

  const metrics = ctx.measureText(text);
  const measuredWidth = Math.min(width, metrics.width);
  const lineStart = align === "left" ? 0 : align === "right" ? -measuredWidth : -measuredWidth / 2;
  const lineEnd = align === "left" ? measuredWidth : align === "right" ? 0 : measuredWidth / 2;
  ctx.globalAlpha = 0.48;
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, 0.9 * scale);
  ctx.beginPath();
  ctx.moveTo(lineStart, 8.2 * scale);
  ctx.lineTo(lineEnd, 8.2 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawHarborFlag(input: {
  accent: string;
  ctx: CanvasRenderingContext2D;
  dock: PharosVilleWorld["docks"][number];
  emphasized: boolean;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  mapWidth: number;
  outward: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  x: number;
  y: number;
  zoom: number;
}) {
  const { accent, ctx, dock, emphasized, logo, mapWidth, outward, x, y, zoom } = input;
  const scale = Math.max(0.72, zoom);
  const flagScale = scale * 1.65;
  const side = outward.x === 0 ? (dock.tile.x < (mapWidth - 1) / 2 ? -1 : 1) : -outward.x;
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

function drawSceneryProp(input: DrawPharosVilleInput, prop: SceneryProp) {
  const { camera, ctx, motion } = input;
  const p = tileToScreen(prop.tile, camera);
  const scale = camera.zoom * (prop.scale ?? 1);
  const time = motion.reducedMotion ? 0 : motion.timeSeconds;
  ctx.save();
  if (prop.kind === "buoy") {
    const bob = Math.sin(time * 0.9 + prop.tile.x) * 1.2 * scale;
    drawBuoy(ctx, p.x, p.y + bob, scale);
  } else if (prop.kind === "harbor-lamp") {
    drawLamp(ctx, p.x, p.y, scale, time * 0.9 + prop.tile.y);
  } else if (prop.kind === "crate-stack") {
    drawCrateStack(ctx, p.x, p.y, scale);
  } else if (prop.kind === "barrel") {
    drawBarrels(ctx, p.x, p.y, scale);
  } else if (prop.kind === "bollards") {
    drawBollards(ctx, p.x, p.y, scale);
  } else if (prop.kind === "cypress") {
    drawCypress(ctx, p.x, p.y, scale);
  } else if (prop.kind === "grass-tuft") {
    drawCoastalGrass(ctx, p.x, p.y, scale);
  } else if (prop.kind === "mooring-posts") {
    drawMooringPosts(ctx, p.x, p.y, scale);
  } else if (prop.kind === "net-rack") {
    drawNetRack(ctx, p.x, p.y, scale);
  } else if (prop.kind === "palm") {
    drawPalm(ctx, p.x, p.y, scale);
  } else if (prop.kind === "reed-bed") {
    drawReedBed(ctx, p.x, p.y, scale);
  } else if (prop.kind === "reef") {
    drawReef(ctx, p.x, p.y, scale);
  } else if (prop.kind === "rock") {
    drawHarborRock(ctx, p.x, p.y, scale);
  } else if (prop.kind === "rope-coil") {
    drawRopeCoil(ctx, p.x, p.y, scale);
  } else if (prop.kind === "sea-wall") {
    drawSeaWallPiece(ctx, p.x, p.y, scale);
  } else if (prop.kind === "signal-post" || prop.kind === "beacon") {
    drawSignalPost(ctx, p.x, p.y, scale, prop.kind === "beacon");
  } else if (prop.kind === "skiff") {
    drawMiniSkiff(ctx, p.x, p.y, scale);
  } else if (prop.kind === "stone-steps") {
    drawStoneSteps(ctx, p.x, p.y, scale);
  } else if (prop.kind === "timber-pile") {
    drawTimberPile(ctx, p.x, p.y, scale);
  }
  ctx.restore();
}

function drawBuoy(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "rgba(7, 10, 12, 0.26)";
  ctx.beginPath();
  ctx.ellipse(x, y + 5 * scale, 8 * scale, 2.6 * scale, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d9b974";
  ctx.fillRect(Math.round(x - 2.5 * scale), Math.round(y - 8 * scale), Math.max(1, Math.round(5 * scale)), Math.max(1, Math.round(13 * scale)));
  ctx.fillStyle = "#b95437";
  ctx.fillRect(Math.round(x - 3 * scale), Math.round(y - 4 * scale), Math.max(1, Math.round(6 * scale)), Math.max(1, Math.round(4 * scale)));
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(Math.round(x - 2.5 * scale), Math.round(y - 8 * scale), Math.max(1, Math.round(5 * scale)), Math.max(1, Math.round(13 * scale)));
}

function drawCrateStack(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  const crates = [[-8, -4, "#6f4a2c"], [0, -6, "#8a6840"], [-2, -14, "#6d4c2f"]] as const;
  ctx.fillStyle = "rgba(7, 10, 12, 0.26)";
  drawDiamond(ctx, x, y + 4 * scale, 25 * scale, 9 * scale, ctx.fillStyle);
  for (const [dx, dy, fill] of crates) {
    ctx.fillStyle = fill;
    ctx.fillRect(Math.round(x + dx * scale), Math.round(y + dy * scale), Math.max(1, Math.round(10 * scale)), Math.max(1, Math.round(8 * scale)));
    ctx.strokeStyle = "#2d1b10";
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.strokeRect(Math.round(x + dx * scale), Math.round(y + dy * scale), Math.max(1, Math.round(10 * scale)), Math.max(1, Math.round(8 * scale)));
  }
}

function drawBarrels(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  for (const [dx, dy] of [[-5, 0], [2, -2], [6, 2]] as const) {
    ctx.fillStyle = "#745133";
    ctx.beginPath();
    ctx.ellipse(x + dx * scale, y + dy * scale, 4 * scale, 6 * scale, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2d1b10";
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.stroke();
    ctx.strokeStyle = "rgba(230, 198, 130, 0.38)";
    ctx.beginPath();
    ctx.moveTo(x + (dx - 3) * scale, y + dy * scale);
    ctx.lineTo(x + (dx + 3) * scale, y + dy * scale);
    ctx.stroke();
  }
}

function drawBollards(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  for (const offset of [-12, -4, 4, 12]) {
    ctx.fillStyle = "#231811";
    ctx.fillRect(Math.round(x + offset * scale), Math.round(y - 8 * scale), Math.max(1, Math.round(3 * scale)), Math.max(1, Math.round(10 * scale)));
    ctx.fillStyle = "#d49a3e";
    ctx.fillRect(Math.round(x + offset * scale), Math.round(y - 9 * scale), Math.max(1, Math.round(3 * scale)), Math.max(1, Math.round(2 * scale)));
  }
  ctx.strokeStyle = "rgba(69, 45, 25, 0.86)";
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  ctx.moveTo(x - 10 * scale, y - 4 * scale);
  ctx.lineTo(x + 14 * scale, y - 3 * scale);
  ctx.stroke();
}

function drawCypress(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "rgba(7, 10, 12, 0.26)";
  drawDiamond(ctx, x + 1 * scale, y + 4 * scale, 18 * scale, 7 * scale, ctx.fillStyle);
  ctx.fillStyle = "#5b3a24";
  ctx.fillRect(Math.round(x - 1.5 * scale), Math.round(y - 22 * scale), Math.max(1, Math.round(3 * scale)), Math.max(1, Math.round(24 * scale)));
  ctx.fillStyle = "#243f2d";
  ctx.beginPath();
  ctx.moveTo(x, y - 38 * scale);
  ctx.quadraticCurveTo(x - 11 * scale, y - 24 * scale, x - 6 * scale, y - 9 * scale);
  ctx.lineTo(x + 7 * scale, y - 8 * scale);
  ctx.quadraticCurveTo(x + 10 * scale, y - 25 * scale, x, y - 38 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(135, 159, 98, 0.34)";
  ctx.beginPath();
  ctx.moveTo(x - 1 * scale, y - 33 * scale);
  ctx.quadraticCurveTo(x - 6 * scale, y - 22 * scale, x - 3 * scale, y - 13 * scale);
  ctx.lineTo(x + 1 * scale, y - 14 * scale);
  ctx.quadraticCurveTo(x + 3 * scale, y - 25 * scale, x - 1 * scale, y - 33 * scale);
  ctx.fill();
}

function drawCoastalGrass(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.strokeStyle = "#314f37";
  ctx.lineWidth = Math.max(1, 1.2 * scale);
  for (const [dx, height, lean] of [[-7, 13, -3], [-3, 17, 1], [1, 14, 4], [5, 11, 2], [8, 15, -2]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + dx * scale, y + 4 * scale);
    ctx.quadraticCurveTo(x + (dx + lean * 0.4) * scale, y - height * 0.45 * scale, x + (dx + lean) * scale, y - height * scale);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(176, 196, 121, 0.42)";
  ctx.beginPath();
  ctx.moveTo(x - 6 * scale, y - 2 * scale);
  ctx.lineTo(x + 5 * scale, y + 2 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawMooringPosts(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.24)";
  drawDiamond(ctx, x, y + 5 * scale, 30 * scale, 9 * scale, ctx.fillStyle);
  for (const offset of [-10, 0, 10]) {
    ctx.fillStyle = "#2f2117";
    ctx.fillRect(Math.round(x + offset * scale - 1.5 * scale), Math.round(y - 15 * scale), Math.max(1, Math.round(3 * scale)), Math.max(1, Math.round(18 * scale)));
    ctx.fillStyle = "#8a6840";
    ctx.fillRect(Math.round(x + offset * scale - 2 * scale), Math.round(y - 16 * scale), Math.max(1, Math.round(4 * scale)), Math.max(1, Math.round(3 * scale)));
  }
  ctx.strokeStyle = "rgba(116, 81, 51, 0.9)";
  ctx.lineWidth = Math.max(1, 1.2 * scale);
  ctx.beginPath();
  ctx.moveTo(x - 10 * scale, y - 9 * scale);
  ctx.quadraticCurveTo(x, y - 4 * scale, x + 10 * scale, y - 9 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawNetRack(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.22)";
  drawDiamond(ctx, x, y + 5 * scale, 28 * scale, 8 * scale, ctx.fillStyle);
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  ctx.beginPath();
  ctx.moveTo(x - 10 * scale, y + 2 * scale);
  ctx.lineTo(x - 10 * scale, y - 24 * scale);
  ctx.moveTo(x + 10 * scale, y + 2 * scale);
  ctx.lineTo(x + 10 * scale, y - 22 * scale);
  ctx.moveTo(x - 12 * scale, y - 17 * scale);
  ctx.lineTo(x + 12 * scale, y - 15 * scale);
  ctx.stroke();

  ctx.strokeStyle = "rgba(184, 165, 124, 0.62)";
  ctx.lineWidth = Math.max(1, 0.8 * scale);
  for (let index = 0; index < 4; index += 1) {
    const offset = -8 + index * 5;
    ctx.beginPath();
    ctx.moveTo(x + offset * scale, y - 16.5 * scale);
    ctx.lineTo(x + (offset - 2) * scale, y - 5 * scale);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x - 9 * scale, y - 11 * scale);
  ctx.lineTo(x + 9 * scale, y - 9 * scale);
  ctx.moveTo(x - 8 * scale, y - 6 * scale);
  ctx.lineTo(x + 8 * scale, y - 4 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawPalm(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.strokeStyle = "#4f331f";
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.beginPath();
  ctx.moveTo(x, y + 3 * scale);
  ctx.lineTo(x + 4 * scale, y - 25 * scale);
  ctx.stroke();
  ctx.strokeStyle = "#2f7e48";
  ctx.lineWidth = Math.max(2, 3.2 * scale);
  for (const angle of [-0.9, -0.45, 0.05, 0.5, 0.95]) {
    ctx.beginPath();
    ctx.moveTo(x + 4 * scale, y - 25 * scale);
    ctx.lineTo(x + 4 * scale + Math.cos(angle) * 15 * scale, y - 25 * scale + Math.sin(angle) * 9 * scale);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(7, 10, 12, 0.24)";
  drawDiamond(ctx, x + 1 * scale, y + 4 * scale, 18 * scale, 7 * scale, ctx.fillStyle);
}

function drawReedBed(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.strokeStyle = "#314f37";
  ctx.lineWidth = Math.max(1, 1.05 * scale);
  for (const [dx, height, lean] of [[-9, 16, -2], [-5, 20, 1], [-1, 14, 2], [4, 18, -1], [8, 13, 3]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + dx * scale, y + 5 * scale);
    ctx.quadraticCurveTo(x + (dx + lean * 0.5) * scale, y - height * 0.5 * scale, x + (dx + lean) * scale, y - height * scale);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(223, 185, 90, 0.72)";
  ctx.fillRect(Math.round(x - 6 * scale), Math.round(y - 15 * scale), Math.max(1, Math.round(2 * scale)), Math.max(1, Math.round(4 * scale)));
  ctx.fillRect(Math.round(x + 5 * scale), Math.round(y - 12 * scale), Math.max(1, Math.round(2 * scale)), Math.max(1, Math.round(4 * scale)));
  ctx.strokeStyle = "rgba(186, 231, 225, 0.26)";
  ctx.beginPath();
  ctx.moveTo(x - 12 * scale, y + 5 * scale);
  ctx.lineTo(x + 11 * scale, y + 7 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawReef(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "rgba(232, 243, 233, 0.52)";
  for (const [dx, dy, w] of [[-7, -1, 11], [4, 2, 13], [0, -5, 8]] as const) {
    ctx.beginPath();
    ctx.ellipse(x + dx * scale, y + dy * scale, w * scale, 2.6 * scale, -0.18, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHarborRock(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "#526776";
  drawDiamond(ctx, x, y, 17 * scale, 8 * scale, ctx.fillStyle);
  ctx.fillStyle = "rgba(19, 26, 34, 0.48)";
  drawDiamond(ctx, x + 3 * scale, y + 3 * scale, 15 * scale, 6 * scale, ctx.fillStyle);
}

function drawRopeCoil(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.22)";
  drawDiamond(ctx, x, y + 4 * scale, 20 * scale, 7 * scale, ctx.fillStyle);
  ctx.strokeStyle = "#b58a4a";
  ctx.lineWidth = Math.max(1, 1.15 * scale);
  for (const radius of [8, 5.6, 3.2]) {
    ctx.beginPath();
    ctx.ellipse(x, y - 2 * scale, radius * scale, radius * 0.48 * scale, -0.08, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "#5e3d23";
  ctx.beginPath();
  ctx.moveTo(x + 6 * scale, y + 1 * scale);
  ctx.lineTo(x + 13 * scale, y + 3 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawSeaWallPiece(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "rgba(28, 31, 29, 0.62)";
  drawDiamond(ctx, x, y + 5 * scale, TILE_WIDTH * 1.2 * scale, TILE_HEIGHT * 0.72 * scale, ctx.fillStyle);
  ctx.fillStyle = "rgba(159, 146, 120, 0.78)";
  drawDiamond(ctx, x, y, TILE_WIDTH * scale, TILE_HEIGHT * 0.58 * scale, ctx.fillStyle);
}

function drawSignalPost(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, lit: boolean) {
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  ctx.beginPath();
  ctx.moveTo(x, y + 3 * scale);
  ctx.lineTo(x, y - 22 * scale);
  ctx.stroke();
  ctx.fillStyle = lit ? "#f7d68a" : "#d49a3e";
  ctx.fillRect(Math.round(x - 3 * scale), Math.round(y - 23 * scale), Math.max(1, Math.round(6 * scale)), Math.max(1, Math.round(6 * scale)));
  if (lit) {
    ctx.fillStyle = "rgba(247, 214, 138, 0.24)";
    ctx.beginPath();
    ctx.ellipse(x, y - 20 * scale, 11 * scale, 5 * scale, -0.08, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMiniSkiff(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.fillStyle = "rgba(7, 10, 12, 0.24)";
  drawDiamond(ctx, x, y + 6 * scale, 26 * scale, 8 * scale, ctx.fillStyle);
  ctx.fillStyle = "#5b3423";
  ctx.beginPath();
  ctx.moveTo(x - 12 * scale, y);
  ctx.lineTo(x + 12 * scale, y);
  ctx.lineTo(x + 6 * scale, y + 7 * scale);
  ctx.lineTo(x - 7 * scale, y + 7 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#25170f";
  ctx.lineWidth = Math.max(1, scale);
  ctx.stroke();
  ctx.fillStyle = "#efe5c6";
  ctx.beginPath();
  ctx.moveTo(x, y - 17 * scale);
  ctx.lineTo(x, y - 2 * scale);
  ctx.lineTo(x + 10 * scale, y - 5 * scale);
  ctx.closePath();
  ctx.fill();
}

function drawStoneSteps(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.24)";
  drawDiamond(ctx, x + 1 * scale, y + 6 * scale, 28 * scale, 9 * scale, ctx.fillStyle);
  const stones = [
    { dx: -6, dy: -4, w: 20 },
    { dx: -2, dy: 1, w: 24 },
    { dx: 2, dy: 6, w: 28 },
  ] as const;
  for (const stone of stones) {
    ctx.fillStyle = "#9f9278";
    drawDiamond(ctx, x + stone.dx * scale, y + stone.dy * scale, stone.w * scale, 5.6 * scale, ctx.fillStyle);
    ctx.strokeStyle = "rgba(35, 28, 20, 0.48)";
    ctx.lineWidth = Math.max(1, 0.7 * scale);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTimberPile(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.24)";
  drawDiamond(ctx, x, y + 5 * scale, 28 * scale, 8 * scale, ctx.fillStyle);
  for (const [dx, dy, length] of [[-7, -4, 20], [-2, 0, 24], [4, -8, 18]] as const) {
    ctx.strokeStyle = "#6a4a2e";
    ctx.lineWidth = Math.max(2, 3.2 * scale);
    ctx.beginPath();
    ctx.moveTo(x + dx * scale, y + dy * scale);
    ctx.lineTo(x + (dx + length) * scale, y + (dy + 2) * scale);
    ctx.stroke();
    ctx.strokeStyle = "rgba(230, 198, 130, 0.36)";
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.beginPath();
    ctx.moveTo(x + (dx + 1) * scale, y + (dy - 1) * scale);
    ctx.lineTo(x + (dx + length - 2) * scale, y + (dy + 1) * scale);
    ctx.stroke();
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

function shipRenderState(input: DrawPharosVilleInput, ship: PharosVilleWorld["ships"][number]) {
  const { assets, camera, motion, selectedTarget, shipMotionSamples, world } = input;
  const sample = shipMotionSamples?.get(ship.id) ?? null;
  const shipAsset = assets?.get(`ship.${ship.visual.hull}`);
  const geometry = resolveEntityGeometry({
    asset: shipAsset,
    camera,
    entity: ship,
    mapWidth: world.map.width,
    shipMotionSamples,
  });
  const p = geometry.screenPoint;
  const phase = motion.plan.shipPhases.get(ship.id) ?? 0;
  const animated = !motion.reducedMotion && motion.plan.animatedShipIds.has(ship.id);
  const bob = animated ? Math.round(Math.sin(motion.timeSeconds * 0.7 + phase) * 2 * camera.zoom) : 0;
  const selected = selectedTarget?.id === ship.id;
  return { bob, geometry, p, sample, selected, shipAsset };
}

function drawShipWake(input: DrawPharosVilleInput, ship: PharosVilleWorld["ships"][number]) {
  const { camera, ctx, motion } = input;
  const { bob, geometry, p, sample, selected } = shipRenderState(input, ship);
  drawShipContactShadow(ctx, geometry.drawPoint.x, geometry.drawPoint.y + bob, geometry.drawScale);
  const drawsWake = !motion.reducedMotion
    && (
      motion.plan.effectShipIds.has(ship.id)
      || selected
      || motion.plan.moverShipIds.has(ship.id)
    );
  if (drawsWake) {
    const changeIntensity = Math.min(1, Math.abs(ship.change24hPct ?? 0) * 18 + 0.2);
    const sampleIntensity = sample?.wakeIntensity ?? 0;
    const intensity = Math.max(sampleIntensity, motion.plan.moverShipIds.has(ship.id) ? changeIntensity : 0.18);
    drawWake(ctx, p.x, p.y + 8 * camera.zoom + bob, camera.zoom, intensity, sample?.heading ?? { x: -1, y: 0 });
  }
}

function drawShipContactShadow(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.fillStyle = "rgba(4, 8, 10, 0.28)";
  ctx.beginPath();
  ctx.ellipse(x, y - 2 * scale, 30 * scale, 8.5 * scale, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(169, 224, 213, 0.16)";
  ctx.lineWidth = Math.max(1, 1.1 * scale);
  ctx.beginPath();
  ctx.moveTo(x - 25 * scale, y + 2 * scale);
  ctx.lineTo(x + 20 * scale, y + 3.5 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawShipBody(input: DrawPharosVilleInput, ship: PharosVilleWorld["ships"][number]) {
  const { camera, ctx } = input;
  const { bob, geometry, p, shipAsset } = shipRenderState(input, ship);
  if (shipAsset) {
    const drawY = geometry.drawPoint.y + bob;
    drawAsset(ctx, shipAsset, geometry.drawPoint.x, drawY, geometry.drawScale);
  } else {
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
  }
}

function drawShipOverlay(input: DrawPharosVilleInput, ship: PharosVilleWorld["ships"][number]) {
  const { assets, camera, ctx } = input;
  const { bob, geometry, p, selected, shipAsset } = shipRenderState(input, ship);
  if (shipAsset) {
    const drawY = geometry.drawPoint.y + bob;
    if (selected) drawSelectedShipOutline(ctx, geometry.drawPoint.x, drawY, geometry.drawScale);
    const mark = SHIP_SAIL_MARKS[ship.visual.hull];
    drawSailLogo({
      ctx,
      logo: assets?.getLogo(ship.logoSrc) ?? null,
      mark: ship.symbol,
      height: mark.height * geometry.drawScale,
      width: mark.width * geometry.drawScale,
      x: geometry.drawPoint.x + mark.x * geometry.drawScale,
      y: drawY + mark.y * geometry.drawScale,
    });
    drawShipSignalOverlay(ctx, ship.visual.overlay, geometry.drawPoint.x - 17 * geometry.drawScale, drawY - 36 * geometry.drawScale, geometry.drawScale);
  } else {
    const proceduralScale = camera.zoom * ship.visual.scale;
    const drawY = p.y - 4 * camera.zoom + bob;
    if (selected) drawSelectedShipOutline(ctx, p.x, drawY, proceduralScale * 0.7);
    drawSailLogo({
      ctx,
      logo: assets?.getLogo(ship.logoSrc) ?? null,
      mark: ship.symbol,
      height: 8 * proceduralScale,
      width: 10 * proceduralScale,
      x: p.x + 7 * proceduralScale,
      y: drawY - 10 * proceduralScale,
    });
    drawShipSignalOverlay(ctx, ship.visual.overlay, p.x - 10 * proceduralScale, drawY - 20 * proceduralScale, proceduralScale);
  }
}

function drawSelectedShipOutline(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 229, 160, 0.92)";
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.beginPath();
  ctx.ellipse(x, y - 18 * scale, 34 * scale, 23 * scale, -0.08, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function clusterRenderState({ camera, world }: DrawPharosVilleInput, cluster: PharosVilleWorld["shipClusters"][number]) {
  const geometry = resolveEntityGeometry({
    camera,
    entity: cluster,
    mapWidth: world.map.width,
  });
  const p = geometry.screenPoint;
  const radius = Math.min(18, 7 + Math.sqrt(cluster.count) * 2) * camera.zoom;
  return { p, radius };
}

function drawClusterBody(input: DrawPharosVilleInput, cluster: PharosVilleWorld["shipClusters"][number]) {
  const { camera, ctx } = input;
  const { p, radius } = clusterRenderState(input, cluster);
  ctx.save();
  ctx.fillStyle = "rgba(7, 10, 12, 0.26)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 8 * camera.zoom, radius * 1.45, radius * 0.46, -0.08, 0, Math.PI * 2);
  ctx.fill();

  const boats = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(cluster.count))));
  for (let index = 0; index < boats; index += 1) {
    const angle = (Math.PI * 2 * index) / boats - 0.45;
    const boatX = p.x + Math.cos(angle) * radius * 0.58;
    const boatY = p.y + Math.sin(angle) * radius * 0.28;
    drawClusterBoat(ctx, boatX, boatY, camera.zoom * (0.55 + (index % 2) * 0.08), index);
  }
  ctx.restore();
}

function drawClusterOverlay(input: DrawPharosVilleInput, cluster: PharosVilleWorld["shipClusters"][number]) {
  const { camera, ctx } = input;
  const { p, radius } = clusterRenderState(input, cluster);
  ctx.save();
  const scale = Math.max(0.78, camera.zoom);
  const mastX = p.x + radius * 0.72;
  const mastY = p.y - radius * 0.42;
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, 1.2 * scale);
  ctx.beginPath();
  ctx.moveTo(mastX, mastY + 15 * scale);
  ctx.lineTo(mastX, mastY - 12 * scale);
  ctx.stroke();
  drawSignBoard(ctx, mastX + 7 * scale, mastY - 15 * scale, 25 * scale, 15 * scale, scale * 0.8, "#d9b974", "#2e1e14");
  ctx.fillStyle = "#061721";
  ctx.font = `800 ${Math.max(8, 8.5 * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(cluster.count), mastX + 19.5 * scale, mastY - 7.5 * scale, 20 * scale);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

function drawClusterBoat(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, index: number) {
  ctx.fillStyle = index % 2 === 0 ? "#6d3d26" : "#3b5361";
  ctx.beginPath();
  ctx.moveTo(x - 10 * scale, y + 2 * scale);
  ctx.lineTo(x + 10 * scale, y + 1 * scale);
  ctx.lineTo(x + 5 * scale, y + 7 * scale);
  ctx.lineTo(x - 6 * scale, y + 7 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#24170f";
  ctx.lineWidth = Math.max(1, 0.9 * scale);
  ctx.stroke();
  ctx.fillStyle = index % 3 === 0 ? "#f0ead2" : "#e3d4ae";
  ctx.beginPath();
  ctx.moveTo(x, y - 16 * scale);
  ctx.lineTo(x, y);
  ctx.lineTo(x + (index % 2 === 0 ? 8 : -8) * scale, y - 4 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function graveRenderState(input: DrawPharosVilleInput, grave: PharosVilleWorld["graves"][number]) {
  const { camera, hoveredTarget, selectedTarget, world } = input;
  const geometry = resolveEntityGeometry({
    camera,
    entity: grave,
    mapWidth: world.map.width,
  });
  const p = geometry.screenPoint;
  const causeColor = GRAVE_CAUSE_COLORS[grave.entry.causeOfDeath] ?? GRAVE_CAUSE_COLORS.abandoned;
  const emphasized = hoveredTarget?.id === grave.id || selectedTarget?.id === grave.id;
  const graveZoom = camera.zoom * grave.visual.scale;
  return { causeColor, emphasized, geometry, graveZoom, p };
}

function drawGraveUnderlay(input: DrawPharosVilleInput, grave: PharosVilleWorld["graves"][number]) {
  const { ctx } = input;
  const { causeColor, emphasized, geometry, graveZoom } = graveRenderState(input, grave);
  drawGraveShadow(ctx, geometry.drawPoint.x, geometry.drawPoint.y, graveZoom, causeColor, emphasized);
}

function drawGraveBody(input: DrawPharosVilleInput, grave: PharosVilleWorld["graves"][number]) {
  const { assets, camera, ctx } = input;
  const { causeColor, emphasized, geometry, p } = graveRenderState(input, grave);
  const graveAsset = assets?.get(GRAVE_ASSET_IDS[grave.visual.marker]) ?? null;
  if (graveAsset) {
    ctx.save();
    ctx.globalAlpha = emphasized || grave.visual.scale >= 0.41 ? 1 : 0.84;
    drawAsset(
      ctx,
      graveAsset,
      geometry.drawPoint.x,
      geometry.drawPoint.y + graveAssetYOffset(grave.visual.marker, camera.zoom),
      camera.zoom * grave.visual.scale * GRAVE_ASSET_SCALE[grave.visual.marker],
    );
    ctx.restore();
    drawGraveCauseChip(
      ctx,
      geometry.drawPoint.x,
      geometry.drawPoint.y - (GRAVE_LOGO_OFFSET[grave.visual.marker] + 3.4) * camera.zoom * grave.visual.scale,
      causeColor,
      camera.zoom * grave.visual.scale,
    );
    return;
  }
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
}

function graveAssetYOffset(marker: GraveNodeMarker, zoom: number) {
  if (marker === "ledger" || marker === "tablet") return 3.2 * zoom;
  if (marker === "reliquary") return 1.2 * zoom;
  return 1.8 * zoom;
}

function drawGraveCauseChip(ctx: CanvasRenderingContext2D, x: number, y: number, causeColor: string, scale: number) {
  ctx.save();
  ctx.fillStyle = hexToRgba(causeColor, 0.68);
  ctx.strokeStyle = "rgba(52, 42, 28, 0.58)";
  ctx.lineWidth = Math.max(0.7, 0.8 * scale);
  roundedRectPath(ctx, x - 2.9 * scale, y - 1.6 * scale, 5.8 * scale, 3.2 * scale, 1.1 * scale);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawGraveOverlay(input: DrawPharosVilleInput, grave: PharosVilleWorld["graves"][number]) {
  const { assets, camera, ctx } = input;
  const { causeColor, emphasized, geometry } = graveRenderState(input, grave);
  const major = grave.visual.scale >= 0.41;
  if (!emphasized && !major) return;
  drawGraveLogo({
    ctx,
    causeColor,
    emphasized,
    major,
    logo: assets?.getLogo(grave.logoSrc) ?? null,
    mark: grave.label,
    radius: Math.max(1, 2.05 * camera.zoom * Math.sqrt(grave.visual.scale)),
    x: geometry.drawPoint.x,
    y: geometry.drawPoint.y - GRAVE_LOGO_OFFSET[grave.visual.marker] * camera.zoom * grave.visual.scale,
  });
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
  major: boolean;
  mark: string;
  radius: number;
  x: number;
  y: number;
}) {
  const { causeColor, ctx, emphasized, logo, major, mark, radius, x, y } = input;
  const safeRadius = Math.max(2, radius);
  const plaqueWidth = safeRadius * 2.1;
  const plaqueHeight = safeRadius * 1.55;
  const plaqueAlpha = emphasized ? 0.95 : major ? 0.76 : 0.54;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  if (emphasized) {
    ctx.fillStyle = hexToRgba(causeColor, 0.22);
    ctx.beginPath();
    ctx.ellipse(0, 1.2 * safeRadius, safeRadius * 2.2, safeRadius * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  roundedRectPath(ctx, -plaqueWidth / 2, -plaqueHeight / 2, plaqueWidth, plaqueHeight, Math.max(1, safeRadius * 0.28));
  ctx.fillStyle = `rgba(226, 208, 166, ${plaqueAlpha})`;
  ctx.fill();
  ctx.strokeStyle = "rgba(47, 35, 24, 0.7)";
  ctx.lineWidth = Math.max(0.65, safeRadius * 0.13);
  ctx.stroke();

  if (emphasized || major) {
    ctx.strokeStyle = hexToRgba(causeColor, emphasized ? 0.78 : 0.48);
    ctx.lineWidth = Math.max(0.55, safeRadius * 0.1);
    roundedRectPath(
      ctx,
      -plaqueWidth / 2 + safeRadius * 0.16,
      -plaqueHeight / 2 + safeRadius * 0.16,
      plaqueWidth - safeRadius * 0.32,
      plaqueHeight - safeRadius * 0.32,
      Math.max(1, safeRadius * 0.22),
    );
    ctx.stroke();
  }

  if (logo) {
    ctx.save();
    roundedRectPath(
      ctx,
      -plaqueWidth * 0.34,
      -plaqueHeight * 0.36,
      plaqueWidth * 0.68,
      plaqueHeight * 0.72,
      Math.max(1, safeRadius * 0.2),
    );
    ctx.clip();
    ctx.globalAlpha = emphasized ? 0.95 : major ? 0.82 : 0.68;
    const size = Math.round(Math.max(2, Math.min(plaqueWidth * 0.68, plaqueHeight * 0.72)));
    ctx.drawImage(logo.image, -size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = `rgba(23, 33, 43, ${emphasized ? 0.88 : 0.62})`;
    ctx.font = `700 ${Math.max(4, safeRadius * 0.74)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.slice(0, 2).toUpperCase(), 0, 0.3, plaqueWidth * 0.64);
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
  height: number;
  logo: ReturnType<PharosVilleAssetManager["getLogo"]>;
  mark: string;
  width: number;
  x: number;
  y: number;
}) {
  const { ctx, height, logo, mark, width, x, y } = input;
  const safeWidth = Math.max(5, width);
  const safeHeight = Math.max(5, height);
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.fillStyle = "rgba(247, 244, 218, 0.84)";
  ctx.strokeStyle = "rgba(43, 28, 18, 0.72)";
  ctx.lineWidth = Math.max(1, safeWidth * 0.08);
  ctx.beginPath();
  ctx.moveTo(-safeWidth * 0.42, -safeHeight * 0.48);
  ctx.lineTo(safeWidth * 0.42, -safeHeight * 0.36);
  ctx.lineTo(safeWidth * 0.36, safeHeight * 0.34);
  ctx.lineTo(-safeWidth * 0.36, safeHeight * 0.48);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (logo) {
    ctx.save();
    roundedRectPath(ctx, -safeWidth * 0.32, -safeHeight * 0.34, safeWidth * 0.64, safeHeight * 0.68, Math.max(1, safeWidth * 0.1));
    ctx.clip();
    const size = Math.round(Math.min(safeWidth, safeHeight) * 0.78);
    ctx.drawImage(logo.image, -size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = "#102333";
    ctx.font = `800 ${Math.max(5, Math.min(safeHeight * 0.72, safeWidth * 0.48))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.slice(0, 2).toUpperCase(), 0, 0.4, safeWidth * 0.66);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

function drawShipSignalOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: PharosVilleWorld["ships"][number]["visual"]["overlay"],
  x: number,
  y: number,
  scale: number,
) {
  if (overlay === "none") return;
  const color = overlay === "nav" ? "#d9b974" : overlay === "yield" ? "#78b689" : "#9fb0aa";
  ctx.save();
  ctx.strokeStyle = "#2f2117";
  ctx.lineWidth = Math.max(1, 1 * scale);
  ctx.beginPath();
  ctx.moveTo(x, y + 10 * scale);
  ctx.lineTo(x, y - 8 * scale);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 8 * scale);
  ctx.lineTo(x + 10 * scale, y - 5 * scale);
  ctx.lineTo(x + 7 * scale, y);
  ctx.lineTo(x, y - 1 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (overlay === "nav") {
    ctx.fillStyle = "rgba(255, 241, 191, 0.48)";
    ctx.beginPath();
    ctx.ellipse(x + 5 * scale, y - 3 * scale, 6 * scale, 2.4 * scale, -0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
