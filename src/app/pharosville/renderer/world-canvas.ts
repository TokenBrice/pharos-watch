import type { PharosVilleMotionPlan } from "../systems/motion";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import type { PharosVilleWorld, TileKind } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import type { HitTarget } from "./hit-testing";

const TILE_COLORS: Record<TileKind, string> = {
  "deep-water": "#061a2b",
  water: "#0d5f70",
  shore: "#b8af7f",
  land: "#d3c89a",
  road: "#9b835d",
};

const BUILDINGS = [
  [27, 27, "#d8cfaa", "#6f4e37"],
  [36, 30, "#efe4ba", "#7b3f35"],
  [31, 38, "#cbbd8e", "#5d5548"],
  [24, 35, "#e5d9ad", "#8a6841"],
  [40, 35, "#d8cfaa", "#6a7546"],
] as const;

const SHIP_COLORS = {
  "treasury-galleon": "#8a4f2b",
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
  targets: readonly HitTarget[];
  width: number;
  world: PharosVilleWorld;
}

export function drawPharosVille(input: DrawPharosVilleInput) {
  const { ctx, height, width } = input;
  ctx.imageSmoothingEnabled = false;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#082337");
  gradient.addColorStop(0.55, "#0c4a5b");
  gradient.addColorStop(1, "#061721");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  drawTerrain(input);
  drawLighthouse(input);
  drawBuildings(input);
  drawDocks(input);
  drawShips(input);
  drawClusters(input);
  drawGraves(input);
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

function drawLighthouse({ assets, camera, ctx, motion, world }: DrawPharosVilleInput) {
  const center = tileToScreen(world.lighthouse.tile, camera);
  const beamAngle = motion.reducedMotion
    ? -0.23
    : -0.34 + Math.sin(motion.timeSeconds * motion.plan.lighthouseSweepRadiansPerSecond) * 0.26;
  const beamLength = 260 * camera.zoom;
  const beamEnd = {
    x: center.x + Math.cos(beamAngle) * beamLength,
    y: center.y - 88 * camera.zoom + Math.sin(beamAngle) * beamLength * 0.58,
  };
  const lighthouseAsset = assets?.get("landmark.lighthouse");
  if (lighthouseAsset) {
    drawAsset(ctx, lighthouseAsset, center.x, center.y, camera.zoom);
    strokeLighthouseBeam(
      ctx,
      world.lighthouse.color,
      16 * camera.zoom,
      { x: center.x, y: center.y - 88 * camera.zoom },
      beamEnd,
    );
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
  ctx.strokeStyle = "rgba(255, 204, 98, 0.35)";
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(0, -88);
  ctx.lineTo((beamEnd.x - center.x) / camera.zoom, (beamEnd.y - center.y) / camera.zoom);
  ctx.stroke();
  ctx.restore();
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
    const dockAsset = assets?.get("dock.wooden-pier");
    if (dockAsset) {
      drawAsset(
        ctx,
        dockAsset,
        p.x + (dock.tile.x < 32 ? -reach * 0.25 : reach * 0.25),
        p.y + 10 * camera.zoom,
        camera.zoom * Math.max(0.7, dock.size / 5),
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

function drawShips({ assets, camera, ctx, motion, world }: DrawPharosVilleInput) {
  for (const ship of world.ships) {
    const p = tileToScreen(ship.tile, camera);
    const phase = motion.plan.shipPhases.get(ship.id) ?? 0;
    const animated = !motion.reducedMotion && motion.plan.animatedShipIds.has(ship.id);
    const bob = animated ? Math.round(Math.sin(motion.timeSeconds * 2.2 + phase) * 2 * camera.zoom) : 0;
    if (!motion.reducedMotion && motion.plan.moverShipIds.has(ship.id)) {
      const intensity = Math.min(1, Math.abs(ship.change24hPct ?? 0) * 18 + 0.2);
      drawWake(ctx, p.x, p.y + 8 * camera.zoom + bob, camera.zoom, intensity);
    }

    const shipAsset = assets?.get(`ship.${ship.visual.hull}`);
    if (shipAsset) {
      drawAsset(ctx, shipAsset, p.x, p.y + 12 * camera.zoom + bob, camera.zoom * ship.visual.scale * 0.7);
    } else {
      drawShip(
        ctx,
        p.x,
        p.y - 4 * camera.zoom + bob,
        ship.visual.scale,
        PENNANTS[ship.visual.pennant] ?? PENNANTS.slate,
        SHIP_COLORS[ship.visual.hull],
        camera.zoom,
      );
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

function drawGraves({ assets, camera, ctx, world }: DrawPharosVilleInput) {
  ctx.fillStyle = "#4d584c";
  const tombstoneAsset = assets?.get("prop.tombstone");
  for (const grave of world.graves) {
    const p = tileToScreen(grave.tile, camera);
    if (tombstoneAsset) {
      drawAsset(ctx, tombstoneAsset, p.x, p.y + 2 * camera.zoom, camera.zoom * 0.54);
    } else {
      ctx.fillRect(p.x - 3 * camera.zoom, p.y - 8 * camera.zoom, 6 * camera.zoom, 9 * camera.zoom);
      ctx.fillRect(p.x - 5 * camera.zoom, p.y, 10 * camera.zoom, 2 * camera.zoom);
    }
  }
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

function drawWake(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, intensity: number) {
  ctx.save();
  ctx.strokeStyle = `rgba(186, 231, 225, ${0.26 + intensity * 0.16})`;
  ctx.lineWidth = Math.max(1, zoom);
  for (let index = 0; index < 3; index += 1) {
    const offset = index * 7 * zoom;
    ctx.beginPath();
    ctx.moveTo(x - (16 + offset) * zoom, y + (4 + index * 2) * zoom);
    ctx.lineTo(x - (28 + offset) * zoom, y + (8 + index * 3) * zoom);
    ctx.stroke();
  }
  ctx.restore();
}

function strokeLighthouseBeam(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
  from: ScreenPoint,
  to: ScreenPoint,
) {
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}
