import type { GraveNode, PharosVilleMap, PharosVilleTile, ShipRiskPlacement, TerrainKind, TileKind } from "./world-types";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { RISK_WATER_REGION_TILES } from "./risk-water-areas";
import { stableUnit } from "./stable-random";

export const PHAROSVILLE_MAP_WIDTH = 56;
export const PHAROSVILLE_MAP_HEIGHT = 56;
export const MAX_TILE_X = PHAROSVILLE_MAP_WIDTH - 1;
export const MAX_TILE_Y = PHAROSVILLE_MAP_HEIGHT - 1;
export const LIGHTHOUSE_TILE = { x: 44, y: 18 } as const;
export const CIVIC_CORE_CENTER = { x: 34, y: 30 } as const;
export const CIVIC_CORE_RADIUS = 7.0;

export const REGION_TILES: Record<ShipRiskPlacement, { x: number; y: number }> = RISK_WATER_REGION_TILES;

export const EVM_BAY_DOCK_TILES = [
  { x: 35, y: 40 },
  { x: 24, y: 42 },
  { x: 34, y: 42 },
  { x: 37, y: 40 },
] as const;

export const OUTER_HARBOR_DOCK_TILES = [
  { x: 45, y: 31 },
  { x: 48, y: 23 },
  { x: 22, y: 30 },
  { x: 41, y: 36 },
  { x: 46, y: 25 },
  { x: 42, y: 35 },
  { x: 36, y: 42 },
  { x: 26, y: 43 },
  { x: 39, y: 37 },
  { x: 27, y: 24 },
] as const;

export const PREFERRED_DOCK_TILES: Record<string, { x: number; y: number }> = {
  ethereum: EVM_BAY_DOCK_TILES[0],
  base: EVM_BAY_DOCK_TILES[1],
  arbitrum: EVM_BAY_DOCK_TILES[2],
  polygon: EVM_BAY_DOCK_TILES[3],
  bsc: OUTER_HARBOR_DOCK_TILES[0],
  tron: OUTER_HARBOR_DOCK_TILES[1],
  solana: OUTER_HARBOR_DOCK_TILES[2],
  aptos: OUTER_HARBOR_DOCK_TILES[3],
};

export const EVM_BAY_CHAIN_IDS = new Set(["ethereum", "base", "arbitrum", "polygon"]);

export const DOCK_TILES = [
  ...EVM_BAY_DOCK_TILES,
  ...OUTER_HARBOR_DOCK_TILES,
];

export const CEMETERY_CENTER = { x: 27.0, y: 34.0 } as const;
export const CEMETERY_RADIUS = { x: 2.7, y: 1.9 } as const;

type GraveMarker = GraveNode["visual"]["marker"];

function ellipseValue(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

const WATER_TERRAIN_KINDS = new Set<TerrainKind>([
  "deep-water",
  "water",
  "alert-water",
  "brackish-water",
  "calm-water",
  "harbor-water",
  "watch-water",
  "warning-water",
  "storm-water",
  "fog-water",
  "ledger-water",
]);

const ELEVATED_TERRAIN_KINDS = new Set<TerrainKind>(["hill", "rock", "cliff"]);

export function isWaterTileKind(kind: TileKind | TerrainKind): boolean {
  return WATER_TERRAIN_KINDS.has(kind as TerrainKind);
}

export function isLandTileKind(kind: TileKind | TerrainKind): boolean {
  return !isWaterTileKind(kind);
}

export function isElevatedTileKind(kind: TileKind | TerrainKind): boolean {
  return ELEVATED_TERRAIN_KINDS.has(kind as TerrainKind);
}

export function isShoreTileKind(kind: TileKind | TerrainKind): boolean {
  return kind === "shore" || kind === "beach";
}

export function isRoadTileKind(kind: TileKind | TerrainKind): boolean {
  return kind === "road";
}

export function tileKindAt(x: number, y: number): TileKind {
  return canonicalTileKind(terrainKindAt(x, y));
}

export function terrainKindAt(x: number, y: number): TerrainKind {
  const island = islandValue(x, y);
  const harbor = harborCoveValue(x, y);
  const approach = harborApproachValue(x, y);
  const headland = lighthouseHeadlandValue(x, y);
  const cemetery = cemeteryValue(x, y);
  const nearIslandEdge = island > 0.82;
  const harborWater = island < 1
    && cemetery > 1.18
    && !isCemeteryCausewayTile(x, y)
    && ((harbor < 0.9 && y > 34 && x < 37) || (approach < 0.94 && y > 42));

  if (isOutOfBounds(x, y) || island >= 1 || harborWater) {
    if (harborWater) return "harbor-water";
    if (isDangerStrait(x, y)) return "storm-water";
    if (isWarningShoals(x, y)) return "warning-water";
    if (isAlertChannel(x, y)) return "alert-water";
    if (isWatchBreakwater(x, y)) return "watch-water";
    if (isDataFog(x, y)) return "brackish-water";
    if (isLedgerMooring(x, y)) return "ledger-water";
    if (isCalmAnchorage(x, y)) return "calm-water";
    if (isDeepSeaShelf(x, y)) return "deep-water";
    return "water";
  }

  if (x === LIGHTHOUSE_TILE.x && y === LIGHTHOUSE_TILE.y) return "hill";
  if (isRoadTile(x, y) && cemetery > 1.08) return "road";
  if (isCivicPlazaTile(x, y)) return "road";
  if (cemetery < 1) return "grass";
  if ((harbor < 1.23 && y > 33 && x < 38) || (approach < 1.2 && y > 42)) return "beach";
  if (headland < 1.04) {
    if (headland > 0.78 || x > LIGHTHOUSE_TILE.x + 3 || y < LIGHTHOUSE_TILE.y - 2) return "cliff";
    if (headland > 0.48) return "rock";
    return "hill";
  }
  if (nearIslandEdge) return "shore";
  if (ellipseValue(x, y, 38.2, 27.8, 8.7, 6.5) < 0.52) return "rock";
  return "grass";
}

function canonicalTileKind(kind: TerrainKind): TileKind {
  if (kind === "deep-water") return "deep-water";
  if (isWaterTileKind(kind)) return "water";
  if (kind === "road") return "road";
  if (kind === "shore" || kind === "beach" || kind === "cliff") return "shore";
  return "land";
}

function islandValue(x: number, y: number): number {
  return Math.min(
    ellipseValue(x, y, 32.6, 31.0, 11.2, 8.2),
    ellipseValue(x, y, 42.8, 21.2, 5.9, 5.0),
    ellipseValue(x, y, 41.8, 27.6, 5.2, 5.3),
    ellipseValue(x, y, 30.2, 40.6, 7.2, 3.7),
    ellipseValue(x, y, 27.2, 40.0, 5.6, 2.0),
    ellipseValue(x, y, CEMETERY_CENTER.x, CEMETERY_CENTER.y, CEMETERY_RADIUS.x + 0.9, CEMETERY_RADIUS.y + 0.65),
  );
}

function lighthouseHeadlandValue(x: number, y: number): number {
  return Math.min(
    ellipseValue(x, y, 43.4, 20.0, 5.8, 4.9),
    ellipseValue(x, y, 45.1, 18.7, 3.7, 3.3),
  );
}

function harborCoveValue(x: number, y: number): number {
  return ellipseValue(x, y, 29.4, 39.8, 5.8, 4.0);
}

function harborApproachValue(x: number, y: number): number {
  return ellipseValue(x, y, 31.6, 43.8, 4.4, 4.8);
}

function isAlertChannel(x: number, y: number): boolean {
  return ellipseValue(x, y, 25.4, 11.8, 7.9, 4.7) < 1
    && x >= 20
    && x <= 33
    && y >= 7
    && y <= 16;
}

function isWarningShoals(x: number, y: number): boolean {
  return ellipseValue(x, y, 38.6, 6.4, 6.4, 4.3) < 1
    && x >= 33
    && x <= 45
    && y >= 2
    && y <= 12;
}

function isDangerStrait(x: number, y: number): boolean {
  return ellipseValue(x, y, 50.0, 4.0, 5.2, 3.2) < 1
    && x >= 44
    && x <= 54
    && y <= 9;
}

function isWatchBreakwater(x: number, y: number): boolean {
  const northwestBelt = ellipseValue(x, y, 14.4, 16.6, 11.6, 7.3) < 1
    && x >= 4
    && x <= 26
    && y >= 8
    && y <= 24;
  const reclaimedNorthwestCorner = ellipseValue(x, y, 6.4, 7.0, 6.8, 4.7) < 1
    && x <= 14
    && y <= 13;
  return northwestBelt || reclaimedNorthwestCorner;
}

function isCalmAnchorage(x: number, y: number): boolean {
  const northwestAnchorage = ellipseValue(x, y, 12.4, 32.6, 16.1, 11.2) < 1
    && x <= 29
    && y >= 22
    && y <= 42;
  const westernBasin = ellipseValue(x, y, 10.8, 40.7, 16.0, 6.4) < 1
    && x >= 2
    && x <= 27
    && y >= 34
    && y <= 47;
  const lowerWestPocket = ellipseValue(x, y, 7.5, 43.2, 10.5, 4.8) < 1
    && x >= 2
    && x <= 22
    && y >= 38
    && y <= 48;

  return northwestAnchorage || westernBasin || lowerWestPocket;
}

function isCemeteryCausewayTile(x: number, y: number): boolean {
  return x >= 25
    && x <= 38
    && y >= 31
    && y <= 38
    && distanceToSegment(x, y, { x: 26.3, y: 35.6 }, { x: 37.4, y: 31.6 }) <= 1.15;
}

function isOutOfBounds(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= PHAROSVILLE_MAP_WIDTH || y >= PHAROSVILLE_MAP_HEIGHT;
}

function isDeepSeaShelf(x: number, y: number): boolean {
  const edge = Math.min(x, y, MAX_TILE_X - x, MAX_TILE_Y - y);
  if (edge <= 0) return true;
  if (edge === 1) {
    return x < 8 || y < 8 || x > MAX_TILE_X - 8 || y > MAX_TILE_Y - 8;
  }
  return false;
}

function isDataFog(x: number, y: number): boolean {
  return ellipseValue(x, y, 50.0, 49.2, 4.8, 3.4) < 1
    && x >= 47
    && x <= 54
    && y >= 46
    && y <= 52;
}

function isLedgerMooring(x: number, y: number): boolean {
  return ellipseValue(x, y, 43.2, 49.0, 4.6, 3.2) < 1
    && x >= 39
    && x <= 47
    && y >= 47
    && y <= 51;
}

function isRoadTile(x: number, y: number): boolean {
  if (isInlandBuildingAnchorTile(x, y)) return false;
  const path = [
    { x: 25, y: 38 },
    { x: 27, y: 35 },
    { x: 30, y: 28 },
    { x: 34, y: 30 },
    { x: 38, y: 31 },
    { x: 36, y: 26 },
    { x: 41, y: 22 },
    { x: 43, y: 19 },
  ];
  return path.some((point, index) => {
    const next = path[index + 1];
    if (!next) return false;
    return distanceToSegment(x, y, point, next) <= 0.62;
  });
}

function isCivicPlazaTile(x: number, y: number): boolean {
  if (isInlandBuildingAnchorTile(x, y)) return false;
  return ellipseValue(x, y, CIVIC_CORE_CENTER.x, CIVIC_CORE_CENTER.y + 1.1, 4.4, 2.6) < 1
    && cemeteryValue(x, y) > 1.08;
}

function isInlandBuildingAnchorTile(x: number, y: number): boolean {
  return (x === 30 && y === 28) || (x === 38 && y === 31);
}

function distanceToSegment(
  x: number,
  y: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - start.x, y - start.y);
  const t = clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(x - (start.x + dx * t), y - (start.y + dy * t));
}

export function nearestWaterTile(tile: { x: number; y: number }, maxRadius = 10): { x: number; y: number } {
  const initialKind = tileKindAt(tile.x, tile.y);
  if (isWaterTileKind(initialKind)) return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const { x, y } = clampMapTile({ x: tile.x + dx, y: tile.y + dy });
        const kind = tileKindAt(x, y);
        if (!isWaterTileKind(kind)) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = { x, y };
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return tile;
}

export function nearestAvailableWaterTile(
  tile: { x: number; y: number },
  occupied: ReadonlySet<string>,
  maxRadius = 12,
): { x: number; y: number } {
  const initialKind = tileKindAt(tile.x, tile.y);
  const initialKey = `${tile.x}.${tile.y}`;
  if (isWaterTileKind(initialKind) && !occupied.has(initialKey)) return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const { x, y } = clampMapTile({ x: tile.x + dx, y: tile.y + dy });
        if (occupied.has(`${x}.${y}`)) continue;
        const kind = tileKindAt(x, y);
        if (!isWaterTileKind(kind)) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = { x, y };
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return nearestWaterTile(tile, maxRadius);
}

export function clampMapTile(tile: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(MAX_TILE_X, tile.x)),
    y: Math.max(0, Math.min(MAX_TILE_Y, tile.y)),
  };
}

export function buildPharosVilleMap(): PharosVilleMap {
  const tiles: PharosVilleTile[] = [];
  let waterTiles = 0;
  for (let y = 0; y < PHAROSVILLE_MAP_HEIGHT; y += 1) {
    for (let x = 0; x < PHAROSVILLE_MAP_WIDTH; x += 1) {
      const terrain = terrainKindAt(x, y);
      const kind = canonicalTileKind(terrain);
      if (isWaterTileKind(kind)) waterTiles += 1;
      tiles.push({ x, y, kind, terrain });
    }
  }
  return {
    width: PHAROSVILLE_MAP_WIDTH,
    height: PHAROSVILLE_MAP_HEIGHT,
    tiles,
    waterRatio: waterTiles / tiles.length,
  };
}

export function graveNodesFromEntries(entries: readonly CemeteryEntry[]): GraveNode[] {
  const placed: Array<{ scale: number; x: number; y: number }> = [];
  return entries.map((entry, index) => {
    const visual = graveVisual(entry, index);
    const tile = cemeteryScatterTile(entry, index, placed, visual.scale);
    placed.push({ ...tile, scale: visual.scale });

    return {
      id: `grave.${entry.id}`,
      kind: "grave",
      label: entry.symbol,
      entry,
      logoSrc: entry.logo ? `/logos/cemetery/${entry.logo}` : null,
      tile,
      visual,
      detailId: `grave.${entry.id}`,
    };
  });
}

function cemeteryScatterTile(
  entry: CemeteryEntry,
  index: number,
  placed: readonly { scale: number; x: number; y: number }[],
  scale: number,
): { x: number; y: number } {
  let bestTile: { x: number; y: number } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const angle = stableUnit(`${entry.id}.angle.${attempt}`) * Math.PI * 2;
    const radius = Math.sqrt(stableUnit(`${entry.id}.radius.${attempt}`)) * 0.96;
    const drift = stableUnit(`${index}.grave.drift`) * 0.34 - 0.17;
    const tile = {
      x: CEMETERY_CENTER.x + Math.cos(angle + drift) * CEMETERY_RADIUS.x * radius,
      y: CEMETERY_CENTER.y + Math.sin(angle - drift) * CEMETERY_RADIUS.y * radius,
    };
    if (cemeteryValue(tile.x, tile.y) > 0.97 || cemeteryReserved(tile) || tileKindAt(tile.x, tile.y) !== "land") continue;
    const nearest = placed.reduce((minimum, grave) => {
      const requiredSpace = 0.36 + (grave.scale + scale) * 0.2;
      const distance = Math.hypot((tile.x - grave.x) * 1.05, (tile.y - grave.y) * 1.45) - requiredSpace;
      return Math.min(minimum, distance);
    }, Number.POSITIVE_INFINITY);
    const edgePenalty = Math.abs(0.58 - radius) * 0.18;
    const score = nearest - edgePenalty - attempt * 0.001;
    if (score > bestScore) {
      bestScore = score;
      bestTile = tile;
    }
    if (nearest > 0.62 && attempt > 16) return tile;
  }
  if (bestTile) return bestTile;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const angle = stableUnit(`${entry.id}.fallback.angle.${attempt}`) * Math.PI * 2;
    const radius = Math.sqrt(stableUnit(`${entry.id}.fallback.radius.${attempt}`)) * 0.72;
    const tile = {
      x: CEMETERY_CENTER.x + Math.cos(angle) * CEMETERY_RADIUS.x * radius,
      y: CEMETERY_CENTER.y + Math.sin(angle) * CEMETERY_RADIUS.y * radius,
    };
    if (tileKindAt(tile.x, tile.y) === "land") return tile;
  }
  return { ...CEMETERY_CENTER };
}

function graveVisual(entry: CemeteryEntry, index: number): GraveNode["visual"] {
  const peakMcap = Math.max(0, entry.peakMcap ?? 0);
  const peakScale = peakMcap > 0 ? Math.min(1, Math.max(0, (Math.log10(peakMcap) - 6) / 4)) : 0;
  const fullScale = 0.72 + peakScale * 0.48 + (stableUnit(`${entry.id}.grave.scale`) - 0.5) * 0.16;
  const scale = clamp(fullScale * 0.36, 0.25, 0.45);
  const marker = graveMarkerFor(entry, index, peakScale);
  return { marker, scale };
}

function graveMarkerFor(entry: CemeteryEntry, index: number, peakScale: number): GraveMarker {
  const largeMemorial = peakScale > 0.72 && stableUnit(`${entry.id}.marker.major`) > 0.42;
  if (entry.causeOfDeath === "regulatory") return "cross";
  if (entry.causeOfDeath === "liquidity-drain") {
    const roll = stableUnit(`${entry.id}.marker.liquidity`);
    if (roll > 0.66) return "ledger";
    return roll > 0.34 ? "tablet" : "headstone";
  }
  if (entry.causeOfDeath === "counterparty-failure") {
    return largeMemorial || stableUnit(`${entry.id}.marker.counterparty`) > 0.38 ? "tablet" : "reliquary";
  }
  if (entry.causeOfDeath === "algorithmic-failure") {
    return largeMemorial || stableUnit(`${entry.id}.marker.algorithmic`) > 0.58 ? "reliquary" : "headstone";
  }
  const markers: GraveMarker[] = ["headstone", "headstone", "tablet", "reliquary"];
  return markers[Math.floor(stableUnit(`${entry.id}.${index}.marker`) * markers.length)] ?? "headstone";
}

function cemeteryValue(x: number, y: number) {
  return ((x - CEMETERY_CENTER.x) / CEMETERY_RADIUS.x) ** 2
    + ((y - CEMETERY_CENTER.y) / CEMETERY_RADIUS.y) ** 2;
}

function cemeteryReserved(tile: { x: number; y: number }) {
  const chapel = ellipseValue(tile.x, tile.y, CEMETERY_CENTER.x - 2.05, CEMETERY_CENTER.y - 1.28, 0.72, 0.54) < 1;
  const memorial = ellipseValue(tile.x, tile.y, CEMETERY_CENTER.x, CEMETERY_CENTER.y, 0.67, 0.49) < 1;
  const northPath = Math.abs(tile.x - (CEMETERY_CENTER.x + Math.sin((tile.y - CEMETERY_CENTER.y) * 1.12) * 0.16)) < 0.17
    && tile.y > CEMETERY_CENTER.y - CEMETERY_RADIUS.y * 0.94
    && tile.y < CEMETERY_CENTER.y + CEMETERY_RADIUS.y * 0.98;
  const crossPath = Math.abs(tile.y - (CEMETERY_CENTER.y + Math.sin((tile.x - CEMETERY_CENTER.x) * 1.05) * 0.12)) < 0.14
    && tile.x > CEMETERY_CENTER.x - CEMETERY_RADIUS.x * 0.92
    && tile.x < CEMETERY_CENTER.x + CEMETERY_RADIUS.x * 0.92;
  return chapel || memorial || northPath || crossPath;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
