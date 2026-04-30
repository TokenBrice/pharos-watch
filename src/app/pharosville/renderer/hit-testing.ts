import type { IsoCamera, ScreenPoint } from "../systems/projection";
import type { ShipMotionSample } from "../systems/motion";
import type { PharosVilleWorld } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import { sortWorldDrawables, type WorldDrawable } from "./drawable-pass";
import {
  entityAssetId,
  resolveEntityGeometry,
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

function targetPriorityBoost(entity: WorldSelectableEntity, selectedDetailId: string | null, hoveredDetailId: string | null): number {
  let priority = 0;
  if (entity.kind === "area") priority += 10_000;
  if (entity.detailId === selectedDetailId) priority += 2;
  if (entity.detailId === hoveredDetailId) priority += 1;
  return priority;
}

function visualPriorityForHitTarget(entity: WorldSelectableEntity, priority: number): number {
  // Ethereum's hub body is drawn before the sorted entity pass so ships sail over it.
  // Keep the dock selectable, but do not let its large hub hitbox outrank ships.
  if (entity.kind === "dock" && entity.chainId === "ethereum") return -1;
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
  ];

  const targetRecords = entities.map((entity) => {
    const assetId = entityAssetId(entity);
    const asset = assetId ? input.assets?.get(assetId) ?? null : null;
    const geometry = resolveEntityGeometry({
      asset,
      camera: input.camera,
      entity,
      mapWidth: input.world.map.width,
      shipMotionSamples: input.shipMotionSamples,
    });
    return { entity, geometry };
  });
  const visualPriority = new Map<string, number>();
  sortWorldDrawables(targetRecords.map(({ entity, geometry }): WorldDrawable => ({
    depth: geometry.depth,
    detailId: entity.detailId,
    draw: () => undefined,
    entityId: entity.id,
    kind: entity.kind,
    pass: "body",
    screenBounds: geometry.targetRect,
    tieBreaker: entity.id,
  }))).forEach((drawable, index) => {
    if (drawable.entityId) visualPriority.set(drawable.entityId, index);
  });

  return targetRecords.map(({ entity, geometry }) => {
    return {
      detailId: entity.detailId,
      id: entity.id,
      kind: entity.kind,
      label: entity.label,
      priority: visualPriorityForHitTarget(entity, visualPriority.get(entity.id) ?? 0) * 10
        + targetPriorityBoost(entity, input.selectedDetailId ?? null, input.hoveredDetailId ?? null),
      rect: geometry.targetRect,
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
