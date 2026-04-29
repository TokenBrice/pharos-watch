import { shipWaterPathKey, type ShipWaterPath } from "../../systems/motion";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../../systems/projection";
import type { PharosVilleWorld } from "../../systems/world-types";
import { dockDrawPoint } from "../geometry";
import type { HitTarget } from "../hit-testing";
import type { DrawPharosVilleInput, PharosVilleCanvasMotion } from "../render-types";

export function drawSelection(input: DrawPharosVilleInput): number {
  const { ctx, hoveredTarget, selectedTarget } = input;
  let drawableCount = 0;
  if (hasSelectedRelationships(selectedTarget)) {
    drawSelectedRelationships(input, selectedTarget);
    drawableCount += 1;
  }
  if (hoveredTarget) {
    drawSelectionRing(ctx, hoveredTarget, "rgba(128, 214, 206, 0.85)");
    drawableCount += 1;
  }
  if (selectedTarget) {
    drawSelectionRing(ctx, selectedTarget, "rgba(255, 204, 98, 0.95)");
    drawableCount += 1;
  }
  return drawableCount;
}

export function selectionDrawableCount(input: {
  hoveredTarget: HitTarget | null;
  selectedTarget: HitTarget | null;
}): number {
  return (hasSelectedRelationships(input.selectedTarget) ? 1 : 0)
    + (input.hoveredTarget ? 1 : 0)
    + (input.selectedTarget ? 1 : 0);
}

function hasSelectedRelationships(target: HitTarget | null): target is HitTarget {
  return target?.kind === "ship" || target?.kind === "dock";
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
  const homePoint = homeDock ? dockDrawPoint(homeDock, camera, world.map.width) : null;
  const route = motion.plan.shipRoutes.get(ship.id) ?? null;
  const homeStop = homeDock && route
    ? route.dockStops.find((stop) => stop.dockId === homeDock.id) ?? null
    : null;
  const homePath = route && homeStop
    ? route.waterPaths.get(shipWaterPathKey(route.riskTile, homeStop.mooringTile))
    : null;
  const pulse = relationshipPulse(motion);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([7 * camera.zoom, 6 * camera.zoom]);
  if (homePath) {
    drawRelationshipWaterPath(ctx, homePath, camera, "rgba(255, 224, 160, 0.38)");
  } else if (route?.openWaterPatrol) {
    drawRelationshipWaterPath(ctx, route.openWaterPatrol.outbound, camera, "rgba(255, 224, 160, 0.34)");
    drawRelationshipWaterPath(ctx, route.openWaterPatrol.inbound, camera, "rgba(255, 224, 160, 0.24)");
  } else if (homePoint) {
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

  const dockPoint = dockDrawPoint(dock, camera, world.map.width);
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

function drawRelationshipWaterPath(
  ctx: CanvasRenderingContext2D,
  path: ShipWaterPath,
  camera: IsoCamera,
  color: string,
) {
  if (path.points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.6 * camera.zoom);
  ctx.beginPath();
  path.points.forEach((point, index) => {
    const screen = tileToScreen(point, camera);
    if (index === 0) ctx.moveTo(screen.x, screen.y);
    else ctx.lineTo(screen.x, screen.y);
  });
  ctx.stroke();
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
    ctx.fillRect(
      Math.round(x - radius * 0.55),
      Math.round(y - radius * 0.55),
      Math.round(radius * 1.1),
      Math.round(radius * 1.1),
    );
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

function drawSelectionRing(ctx: CanvasRenderingContext2D, target: HitTarget, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(target.rect.x, target.rect.y, target.rect.width, target.rect.height);
}
