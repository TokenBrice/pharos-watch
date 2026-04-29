import type { IsoCamera, ScreenPoint } from "../systems/projection";
import { tileToScreen } from "../systems/projection";
import type { ShipMotionSample } from "../systems/motion";
import type { PharosVilleWorld } from "../systems/world-types";
import type { PharosVilleAssetManager, LoadedPharosVilleAsset } from "./asset-manager";

export interface HitTarget {
  detailId: string;
  id: string;
  kind: string;
  label: string;
  priority: number;
  rect: { height: number; width: number; x: number; y: number };
}

type SelectableEntity =
  | PharosVilleWorld["lighthouse"]
  | PharosVilleWorld["docks"][number]
  | PharosVilleWorld["ships"][number]
  | PharosVilleWorld["shipClusters"][number]
  | PharosVilleWorld["graves"][number];

function targetSize(entity: SelectableEntity): { height: number; width: number; yOffset: number } {
  if (entity.kind === "lighthouse") return { height: 190, width: 96, yOffset: -82 };
  if (entity.kind === "dock") return { height: 38, width: 96, yOffset: 0 };
  if (entity.kind === "ship") return { height: 48, width: 56, yOffset: -16 };
  if (entity.kind === "ship-cluster") return { height: 48, width: 48, yOffset: -12 };
  return { height: 34 * entity.visual.scale, width: 30 * entity.visual.scale, yOffset: -10 * entity.visual.scale };
}

function assetIdForEntity(entity: SelectableEntity) {
  if (entity.kind === "lighthouse") return "landmark.lighthouse";
  if (entity.kind === "dock") return entity.assetId;
  if (entity.kind === "ship") return `ship.${entity.visual.hull}`;
  return null;
}

function assetDrawPoint(input: {
  asset: LoadedPharosVilleAsset;
  camera: IsoCamera;
  entity: SelectableEntity;
  mapWidth: number;
  point: ScreenPoint;
}) {
  const { asset, camera, entity, mapWidth, point } = input;
  let x = point.x;
  let y = point.y;
  let scale = camera.zoom * asset.entry.displayScale;
  if (entity.kind === "lighthouse") {
    y += 3 * camera.zoom;
    scale *= 1.48;
  } else if (entity.kind === "dock") {
    const reach = (26 + entity.size * 6) * camera.zoom;
    x += entity.tile.x < mapWidth / 2 ? -reach * 0.25 : reach * 0.25;
    y += 10 * camera.zoom;
    scale *= dockRenderScale(entity.size);
  } else if (entity.kind === "ship") {
    y += 12 * camera.zoom;
    scale *= entity.visual.scale * 0.7;
  } else if (entity.kind === "grave") {
    y += 2 * camera.zoom;
    scale *= 0.47 * entity.visual.scale;
  }
  return { scale, x, y };
}

function dockRenderScale(size: number): number {
  return Math.max(0.43, Math.min(0.79, (0.66 + size * 0.092) * 0.5));
}

function assetTargetRect(input: {
  asset: LoadedPharosVilleAsset;
  camera: IsoCamera;
  entity: SelectableEntity;
  mapWidth: number;
  point: ScreenPoint;
}): HitTarget["rect"] {
  const { asset, camera, entity, mapWidth, point } = input;
  const draw = assetDrawPoint({ asset, camera, entity, mapWidth, point });
  const [hitX, hitY, hitWidth, hitHeight] = asset.entry.hitbox;
  return {
    height: Math.max(24, hitHeight * draw.scale),
    width: Math.max(24, hitWidth * draw.scale),
    x: draw.x - asset.entry.anchor[0] * draw.scale + hitX * draw.scale,
    y: draw.y - asset.entry.anchor[1] * draw.scale + hitY * draw.scale,
  };
}

function targetPriority(entity: SelectableEntity, selectedDetailId: string | null, hoveredDetailId: string | null): number {
  let priority = 0;
  if (entity.detailId === selectedDetailId) priority += 32;
  if (entity.detailId === hoveredDetailId) priority += 24;
  if (entity.kind === "ship") priority += 500;
  if (entity.kind === "lighthouse") priority += 450;
  if (entity.kind === "dock") priority += 350;
  if (entity.kind === "ship-cluster") priority += 300;
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
  const entities: SelectableEntity[] = [
    input.world.lighthouse,
    ...input.world.docks,
    ...input.world.ships,
    ...input.world.shipClusters,
    ...input.world.graves,
  ];

  return entities.map((entity) => {
    const tile = entity.kind === "ship"
      ? input.shipMotionSamples?.get(entity.id)?.tile ?? entity.tile
      : entity.tile;
    const point = tileToScreen(tile, input.camera);
    const assetId = assetIdForEntity(entity);
    const asset = assetId ? input.assets?.get(assetId) ?? null : null;
    const size = targetSize(entity);
    return {
      detailId: entity.detailId,
      id: entity.id,
      kind: entity.kind,
      label: entity.label,
      priority: targetPriority(entity, input.selectedDetailId ?? null, input.hoveredDetailId ?? null),
      rect: asset ? assetTargetRect({
        asset,
        camera: input.camera,
        entity,
        mapWidth: input.world.map.width,
        point,
      }) : {
        height: Math.max(24, size.height * input.camera.zoom),
        width: Math.max(24, size.width * input.camera.zoom),
        x: point.x - Math.max(24, size.width * input.camera.zoom) / 2,
        y: point.y + size.yOffset * input.camera.zoom - Math.max(24, size.height * input.camera.zoom) / 2,
      },
    };
  });
}

export function hitTest(targets: readonly HitTarget[], point: ScreenPoint): HitTarget | null {
  return targets
    .filter((target) => (
      point.x >= target.rect.x
      && point.x <= target.rect.x + target.rect.width
      && point.y >= target.rect.y
      && point.y <= target.rect.y + target.rect.height
    ))
    .toSorted((a, b) => b.priority - a.priority)[0] ?? null;
}
