import type { PharosVilleMotionPlan, ShipMotionSample } from "../systems/motion";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import { CEMETERY_CENTER, CEMETERY_RADIUS } from "../systems/world-layout";
import type { PharosVilleWorld, TileKind } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import type { HitTarget } from "./hit-testing";
import { CAUSE_HEX, type CauseOfDeath } from "@shared/lib/cause-of-death";

const TILE_COLORS: Record<TileKind, string> = {
  "deep-water": "#071225",
  water: "#15375a",
  shore: "#9d7f50",
  land: "#c5a766",
  road: "#7a5938",
};

const BUILDINGS = [
  [27, 27, "#d6b56b", "#5d3527"],
  [36, 30, "#ead18a", "#6c2f2c"],
  [31, 38, "#b9a066", "#474031"],
  [24, 35, "#dcc078", "#74522f"],
  [40, 35, "#d6b56b", "#566139"],
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
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#100b12");
  gradient.addColorStop(0.48, "#14294a");
  gradient.addColorStop(1, "#070910");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  drawTerrain(input);
  drawCemeteryGround(input);
  drawCemeteryContext(input);
  drawBuildings(input);
  drawDocks(input);
  drawShips(input);
  drawClusters(input);
  drawGraves(input);
  drawCemeteryMist(input);
  drawLighthouse(input);
  drawSelection(input);
}

function drawTerrain({ camera, ctx, motion, world }: DrawPharosVilleInput) {
  for (const tile of world.map.tiles) {
    const p = tileToScreen(tile, camera);
    drawDiamond(ctx, p.x, p.y, 32 * camera.zoom, 16 * camera.zoom, TILE_COLORS[tile.kind]);
    if (tile.kind === "water" && (tile.x + tile.y) % 9 === 0) {
      const shimmer = motion.reducedMotion
        ? 0.22
        : 0.16 + Math.sin(motion.timeSeconds * 1.3 + tile.x * 0.2 + tile.y * 0.15) * 0.05;
      ctx.fillStyle = `rgba(186, 231, 225, ${Math.max(0.08, shimmer)})`;
      ctx.fillRect(p.x - 7 * camera.zoom, p.y - 1, 14 * camera.zoom, Math.max(1, camera.zoom));
    }
  }
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
  const lighthouseAsset = assets?.get("landmark.lighthouse");
  const firePoint = lighthouseAsset
    ? lighthouseBeaconPoint(lighthouseAsset, center, camera.zoom)
    : { x: center.x, y: center.y - 88 * camera.zoom };
  if (lighthouseAsset) {
    drawAsset(ctx, lighthouseAsset, center.x, center.y, camera.zoom);
    drawLighthouseFire(ctx, firePoint, camera.zoom, world.lighthouse.color, motion);
    return;
  }

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.fillStyle = "#f4f0d2";
  ctx.fillRect(-14, -76, 28, 62);
  ctx.fillStyle = "#d8d0ad";
  ctx.fillRect(-19, -17, 38, 15);
  ctx.fillStyle = "#a97b34";
  ctx.fillRect(-10, -88, 20, 12);
  ctx.fillStyle = world.lighthouse.color;
  ctx.beginPath();
  ctx.arc(0, -90, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawLighthouseFire(ctx, firePoint, camera.zoom, world.lighthouse.color, motion);
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
    const bob = animated ? Math.round(Math.sin(motion.timeSeconds * 2.2 + phase) * 2 * camera.zoom) : 0;
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
