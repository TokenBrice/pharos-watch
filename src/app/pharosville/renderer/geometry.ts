import { areaLabelPlacementForArea } from "../systems/area-labels";
import type { ShipMotionSample } from "../systems/motion";
import { tileToScreen, type IsoCamera, type ScreenPoint } from "../systems/projection";
import type { PharosVilleWorld } from "../systems/world-types";
import type { LoadedPharosVilleAsset } from "./asset-manager";
import { drawableDepth } from "./drawable-pass";

export interface ScreenRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export type WorldSelectableEntity =
  | PharosVilleWorld["lighthouse"]
  | PharosVilleWorld["docks"][number]
  | PharosVilleWorld["ships"][number]
  | PharosVilleWorld["shipClusters"][number]
  | PharosVilleWorld["areas"][number]
  | PharosVilleWorld["graves"][number];

export interface EntityAssetGeometry {
  drawScale: number;
  hitScale: number;
  x: number;
  y: number;
}

export interface EntityDrawGeometry {
  drawScale: number;
  x: number;
  y: number;
}

export interface ResolvedEntityGeometry {
  assetScale: number | null;
  depth: number;
  depthTile: { x: number; y: number };
  drawPoint: ScreenPoint;
  drawScale: number;
  followTile: { x: number; y: number };
  screenPoint: ScreenPoint;
  selectionRect: ScreenRect;
  semanticTile: { x: number; y: number };
  targetRect: ScreenRect;
}

export function entityAssetId(entity: WorldSelectableEntity) {
  if (entity.kind === "dock") return entity.assetId;
  if (entity.kind === "ship") return `ship.${entity.visual.hull}`;
  return null;
}

export function entityScreenPoint(input: {
  camera: IsoCamera;
  entity: WorldSelectableEntity;
  mapWidth?: number;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
}): ScreenPoint {
  const tile = entityFollowTile({
    entity: input.entity,
    mapWidth: input.mapWidth,
    shipMotionSamples: input.shipMotionSamples,
  });
  return tileToScreen(tile, input.camera);
}

export function resolveEntityGeometry(input: {
  asset?: LoadedPharosVilleAsset | null;
  camera: IsoCamera;
  entity: WorldSelectableEntity;
  mapWidth: number;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
}): ResolvedEntityGeometry {
  const followTileValue = entityFollowTile({
    entity: input.entity,
    mapWidth: input.mapWidth,
    shipMotionSamples: input.shipMotionSamples,
  });
  const screenPoint = tileToScreen(followTileValue, input.camera);
  const draw = entityDrawGeometry({
    camera: input.camera,
    entity: input.entity,
    mapWidth: input.mapWidth,
    point: screenPoint,
  });
  const targetRect = input.entity.kind === "area"
    ? areaLabelTargetRect(input.entity, input.camera)
    : input.asset
      ? assetTargetRect({
        asset: input.asset,
        camera: input.camera,
        entity: input.entity,
        mapWidth: input.mapWidth,
        point: screenPoint,
      })
      : fallbackTargetRect(input.entity, input.camera, screenPoint);
  const depthTile = entityDepthTile({
    entity: input.entity,
    mapWidth: input.mapWidth,
    shipMotionSamples: input.shipMotionSamples,
  });

  return {
    assetScale: input.asset ? draw.drawScale * input.asset.entry.displayScale : null,
    depth: drawableDepth(depthTile),
    depthTile,
    drawPoint: { x: draw.x, y: draw.y },
    drawScale: draw.drawScale,
    followTile: followTileValue,
    screenPoint,
    selectionRect: targetRect,
    semanticTile: input.entity.tile,
    targetRect,
  };
}

export function entityFollowTile(input: {
  entity: WorldSelectableEntity;
  mapWidth?: number;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
}) {
  if (input.entity.kind === "ship") return input.shipMotionSamples?.get(input.entity.id)?.tile ?? input.entity.tile;
  if (input.entity.kind === "area") return areaLabelPlacementForArea(input.entity).anchorTile;
  if (input.entity.kind === "dock" && input.mapWidth) return dockDrawTile(input.entity, input.mapWidth);
  return input.entity.tile;
}

export function entityDepthTile(input: {
  entity: WorldSelectableEntity;
  mapWidth?: number;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
}) {
  if (input.entity.kind === "ship") return input.shipMotionSamples?.get(input.entity.id)?.tile ?? input.entity.tile;
  if (input.entity.kind === "dock" && input.mapWidth) return dockDrawTile(input.entity, input.mapWidth);
  if (input.entity.kind === "area") return areaLabelPlacementForArea(input.entity).semanticTile;
  return input.entity.tile;
}

export function entityDrawGeometry(input: {
  camera: IsoCamera;
  entity: WorldSelectableEntity;
  mapWidth: number;
  point: ScreenPoint;
}): EntityDrawGeometry {
  const { camera, entity, mapWidth, point } = input;
  let x = point.x;
  let y = point.y;
  let drawScale = camera.zoom;
  if (entity.kind === "lighthouse") {
    y += 18 * camera.zoom;
    drawScale *= 1.04;
  } else if (entity.kind === "dock") {
    const draw = dockDrawPoint(entity, camera, mapWidth);
    x = draw.x;
    y = draw.y;
    drawScale *= dockRenderScale(entity.size);
  } else if (entity.kind === "ship") {
    y += 12 * camera.zoom;
    drawScale *= entity.visual.scale * 0.7;
  } else if (entity.kind === "grave") {
    y += 2 * camera.zoom;
    drawScale *= 0.47 * entity.visual.scale;
  }

  return {
    drawScale,
    x,
    y,
  };
}

export function entityAssetGeometry(input: {
  asset: LoadedPharosVilleAsset;
  camera: IsoCamera;
  entity: WorldSelectableEntity;
  mapWidth: number;
  point: ScreenPoint;
}): EntityAssetGeometry {
  const draw = entityDrawGeometry(input);
  return {
    ...draw,
    hitScale: draw.drawScale * input.asset.entry.displayScale,
  };
}

export function assetTargetRect(input: {
  asset: LoadedPharosVilleAsset;
  camera: IsoCamera;
  entity: WorldSelectableEntity;
  mapWidth: number;
  point: ScreenPoint;
}): ScreenRect {
  const draw = entityAssetGeometry(input);
  const [hitX, hitY, hitWidth, hitHeight] = input.asset.entry.hitbox;
  return {
    height: Math.max(24, hitHeight * draw.hitScale),
    width: Math.max(24, hitWidth * draw.hitScale),
    x: draw.x - input.asset.entry.anchor[0] * draw.hitScale + hitX * draw.hitScale,
    y: draw.y - input.asset.entry.anchor[1] * draw.hitScale + hitY * draw.hitScale,
  };
}

export function fallbackTargetRect(entity: WorldSelectableEntity, camera: IsoCamera, point: ScreenPoint): ScreenRect {
  const size = targetSize(entity);
  const width = Math.max(24, size.width * camera.zoom);
  const height = Math.max(24, size.height * camera.zoom);
  return {
    height,
    width,
    x: point.x - width / 2,
    y: point.y + size.yOffset * camera.zoom - height / 2,
  };
}

export function areaLabelTargetRect(area: PharosVilleWorld["areas"][number], camera: IsoCamera): ScreenRect {
  const placement = areaLabelPlacementForArea(area);
  const point = tileToScreen(placement.anchorTile, camera);
  const labelScale = Math.max(0.72, camera.zoom);
  const width = Math.max(52, placement.maxWidth * labelScale);
  const height = Math.max(26, placement.hitboxHeight * labelScale);
  const x = placement.align === "left"
    ? point.x
    : placement.align === "right"
      ? point.x - width
      : point.x - width / 2;

  return {
    height,
    width,
    x,
    y: point.y - height / 2,
  };
}

export function dockDrawPoint(
  dock: PharosVilleWorld["docks"][number],
  camera: IsoCamera,
  mapWidth: number,
): ScreenPoint {
  const p = tileToScreen(dockDrawTile(dock, mapWidth), camera);
  return {
    x: p.x,
    y: p.y + 10 * camera.zoom,
  };
}

export function dockDrawTile(dock: PharosVilleWorld["docks"][number], mapWidth: number) {
  const outward = dockOutwardVector(dock.tile, mapWidth);
  const reach = 0.72 + dock.size * 0.075;
  return {
    x: dock.tile.x + outward.x * reach,
    y: dock.tile.y + outward.y * reach,
  };
}

export function dockOutwardVector(tile: { x: number; y: number }, mapWidth: number): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const center = (mapWidth - 1) / 2;
  const dx = tile.x - center;
  const dy = tile.y - center;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx < 0 ? -1 : 1, y: 0 };
  return { x: 0, y: dy < 0 ? -1 : 1 };
}

export function dockRenderScale(size: number): number {
  return Math.max(0.43, Math.min(0.79, (0.66 + size * 0.092) * 0.5));
}

function targetSize(entity: WorldSelectableEntity): { height: number; width: number; yOffset: number } {
  if (entity.kind === "lighthouse") return { height: 224, width: 160, yOffset: -94 };
  if (entity.kind === "dock") return { height: 38, width: 96, yOffset: 0 };
  if (entity.kind === "area") return { height: 28, width: 112, yOffset: 0 };
  if (entity.kind === "ship") return { height: 48, width: 56, yOffset: -16 };
  if (entity.kind === "ship-cluster") return { height: 48, width: 48, yOffset: -12 };
  return { height: 34 * entity.visual.scale, width: 30 * entity.visual.scale, yOffset: -10 * entity.visual.scale };
}
