import type { GraveNode, PharosVilleMap, PharosVilleTile, ShipRiskPlacement, TerrainKind, TileKind } from "./world-types";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";

export const PHAROSVILLE_MAP_WIDTH = 64;
export const PHAROSVILLE_MAP_HEIGHT = 64;
export const LIGHTHOUSE_TILE = { x: 44, y: 18 } as const;

export const REGION_TILES: Record<ShipRiskPlacement, { x: number; y: number }> = {
  "safe-harbor": { x: 29, y: 44 },
  "breakwater-edge": { x: 25, y: 48 },
  "harbor-mouth-watch": { x: 40, y: 45 },
  "outer-rough-water": { x: 49, y: 46 },
  "storm-shelf": { x: 55, y: 53 },
  "data-fog": { x: 10, y: 16 },
  "ledger-mooring": { x: 32, y: 48 },
};

export const EVM_BAY_DOCK_TILES = [
  { x: 28, y: 40 },
  { x: 23, y: 35 },
  { x: 22, y: 41 },
  { x: 35, y: 41 },
] as const;

export const OUTER_HARBOR_DOCK_TILES = [
  { x: 47, y: 32 },
  { x: 31, y: 22 },
  { x: 20, y: 26 },
  { x: 41, y: 39 },
  { x: 48, y: 25 },
  { x: 18, y: 32 },
  { x: 37, y: 45 },
  { x: 36, y: 46 },
  { x: 38, y: 42 },
  { x: 24, y: 47 },
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

export const CEMETERY_CENTER = { x: 36.4, y: 32.8 } as const;
export const CEMETERY_RADIUS = { x: 4.0, y: 2.9 } as const;

type GraveMarker = GraveNode["visual"]["marker"];

function ellipseValue(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

const WATER_TERRAIN_KINDS = new Set<TerrainKind>([
  "deep-water",
  "water",
  "alert-water",
  "harbor-water",
  "warning-water",
  "storm-water",
  "fog-water",
  "frozen-water",
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
    if (isNorthFrozePole(x, y)) return "frozen-water";
    if (isDangerStrait(x, y)) return "storm-water";
    if (isWarningShoals(x, y)) return "warning-water";
    if (isAlertChannel(x, y)) return "alert-water";
    if (isStormShelf(x, y)) return "storm-water";
    if (isDataFog(x, y)) return "fog-water";
    if (x < 8 || y < 8 || x > 55 || y > 55) return "deep-water";
    return "water";
  }

  if (x === LIGHTHOUSE_TILE.x && y === LIGHTHOUSE_TILE.y) return "hill";
  if (isRoadTile(x, y) && cemetery > 1.08) return "road";
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
    ellipseValue(x, y, 31.4, 31.7, 14.4, 10.5),
    ellipseValue(x, y, 42.8, 21.4, 7.4, 6.2),
    ellipseValue(x, y, 42.8, 28.0, 6.1, 6.7),
    ellipseValue(x, y, 28.0, 42.6, 10.8, 5.6),
    ellipseValue(x, y, 25.2, 41.0, 9.6, 2.5),
    ellipseValue(x, y, CEMETERY_CENTER.x, CEMETERY_CENTER.y, CEMETERY_RADIUS.x + 1.0, CEMETERY_RADIUS.y + 0.85),
  );
}

function lighthouseHeadlandValue(x: number, y: number): number {
  return Math.min(
    ellipseValue(x, y, 43.5, 20.2, 6.7, 5.6),
    ellipseValue(x, y, 45.4, 18.8, 4.2, 3.8),
  );
}

function harborCoveValue(x: number, y: number): number {
  return ellipseValue(x, y, 27.0, 40.0, 8.0, 5.5);
}

function harborApproachValue(x: number, y: number): number {
  return ellipseValue(x, y, 30.0, 47.6, 5.8, 7.8);
}

function isAlertChannel(x: number, y: number): boolean {
  return ellipseValue(x, y, 40.4, 45.1, 6.8, 3.5) < 1
    && x >= 36
    && y >= 40;
}

function isWarningShoals(x: number, y: number): boolean {
  return ellipseValue(x, y, 49.4, 46.6, 7.4, 5.4) < 1
    && x >= 43
    && y >= 40;
}

function isDangerStrait(x: number, y: number): boolean {
  return ellipseValue(x, y, 55.4, 53.3, 7.8, 6.7) < 1
    && x >= 48
    && y >= 45;
}

export function isNorthFrozePole(x: number, y: number): boolean {
  return x >= 0
    && y >= 0
    && x + y <= 10
    && Math.abs(x - y) <= 8;
}

function isCemeteryCausewayTile(x: number, y: number): boolean {
  return x >= 17
    && x <= 35
    && y >= 39
    && y <= 44
    && distanceToSegment(x, y, { x: 18.5, y: 42.6 }, { x: 34.2, y: 39.3 }) <= 1.1;
}

function isOutOfBounds(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= PHAROSVILLE_MAP_WIDTH || y >= PHAROSVILLE_MAP_HEIGHT;
}

function isStormShelf(x: number, y: number): boolean {
  return isDangerStrait(x, y);
}

function isDataFog(x: number, y: number): boolean {
  return ellipseValue(x, y, 10.5, 16.4, 10.8, 7.2) < 1;
}

function isRoadTile(x: number, y: number): boolean {
  const path = [
    { x: 19, y: 39 },
    { x: 21, y: 35 },
    { x: 30, y: 33 },
    { x: 37, y: 29 },
    { x: 41, y: 23 },
    { x: 43, y: 19 },
  ];
  return path.some((point, index) => {
    const next = path[index + 1];
    if (!next) return false;
    return distanceToSegment(x, y, point, next) <= 0.62;
  });
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
        const x = Math.max(0, Math.min(PHAROSVILLE_MAP_WIDTH - 1, tile.x + dx));
        const y = Math.max(0, Math.min(PHAROSVILLE_MAP_HEIGHT - 1, tile.y + dy));
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
        const x = Math.max(0, Math.min(PHAROSVILLE_MAP_WIDTH - 1, tile.x + dx));
        const y = Math.max(0, Math.min(PHAROSVILLE_MAP_HEIGHT - 1, tile.y + dy));
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
  return bestTile ?? {
    x: CEMETERY_CENTER.x + stableOffset(`${entry.id}.fallback.x`, 5) * 0.45,
    y: CEMETERY_CENTER.y + stableOffset(`${entry.id}.fallback.y`, 5) * 0.32,
  };
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

function stableUnit(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return hash / 0xffffffff;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function stableOffset(id: string, span: number): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return (hash % (span * 2 + 1)) - span;
}
