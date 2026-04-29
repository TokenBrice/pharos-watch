import type { IsoCamera, ScreenPoint } from "../systems/projection";
import type { ShipMotionSample } from "../systems/motion";
import type { PharosVilleWorld } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import {
  areaLabelTargetRect,
  assetTargetRect,
  entityAssetId,
  entityScreenPoint,
  fallbackTargetRect,
  type WorldSelectableEntity,
} from "./geometry";

export interface HitTarget {
  detailId: string;
  id: string;
  kind: string;
  label: string;
  priority: number;
  rect: { height: number; width: number; x: number; y: number };
}

function targetPriority(entity: WorldSelectableEntity, selectedDetailId: string | null, hoveredDetailId: string | null): number {
  let priority = 0;
  if (entity.detailId === selectedDetailId) priority += 32;
  if (entity.detailId === hoveredDetailId) priority += 24;
  if (entity.kind === "ship") priority += 500;
  if (entity.kind === "lighthouse") priority += 450;
  if (entity.kind === "building") priority += 400;
  if (entity.kind === "dock") priority += 350;
  if (entity.kind === "ship-cluster") priority += 300;
  if (entity.kind === "area") priority += 250;
  priority += entity.tile.x + entity.tile.y;
  return priority;
}

export function collectHitTargets(input: {
  assets?: Pick<PharosVilleAssetManager, "get"> | null;
  camera: IsoCamera;
  hoveredDetailId?: string | null;
  selectedDetailId?: string | null;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
  world: PharosVilleWorld;
}): HitTarget[] {
  const entities: WorldSelectableEntity[] = [
    input.world.lighthouse,
    ...input.world.docks,
    ...input.world.ships,
    ...input.world.shipClusters,
    ...input.world.areas,
    ...input.world.graves,
    ...input.world.buildings,
  ];

  return entities.map((entity) => {
    const point = entityScreenPoint({
      camera: input.camera,
      entity,
      mapWidth: input.world.map.width,
      shipMotionSamples: input.shipMotionSamples,
    });
    const assetId = entityAssetId(entity);
    const asset = assetId ? input.assets?.get(assetId) ?? null : null;
    return {
      detailId: entity.detailId,
      id: entity.id,
      kind: entity.kind,
      label: entity.label,
      priority: targetPriority(entity, input.selectedDetailId ?? null, input.hoveredDetailId ?? null),
      rect: entity.kind === "area" ? areaLabelTargetRect(entity, input.camera) : asset ? assetTargetRect({
        asset,
        camera: input.camera,
        entity,
        mapWidth: input.world.map.width,
        point,
      }) : fallbackTargetRect(entity, input.camera, point),
    };
  });
}

export function hitTest(targets: readonly HitTarget[], point: ScreenPoint): HitTarget | null {
  let bestTarget: HitTarget | null = null;
  for (const target of targets) {
    const containsPoint = (
      point.x >= target.rect.x
      && point.x <= target.rect.x + target.rect.width
      && point.y >= target.rect.y
      && point.y <= target.rect.y + target.rect.height
    );
    if (!containsPoint) continue;
    if (!bestTarget || target.priority > bestTarget.priority) bestTarget = target;
  }
  return bestTarget;
}
