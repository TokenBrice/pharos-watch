import type { PharosVilleMotionPlan, ShipMotionSample } from "../systems/motion";
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
