import type { GraveNode, PharosVilleMap, PharosVilleTile, ShipRiskPlacement, TerrainKind, TileKind } from "./world-types";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { RISK_WATER_REGION_TILES } from "./risk-water-areas";
import { stableUnit } from "./stable-random";

export const PHAROSVILLE_MAP_WIDTH = 56;
export const PHAROSVILLE_MAP_HEIGHT = 56;
export const MAX_TILE_X = PHAROSVILLE_MAP_WIDTH - 1;
export const MAX_TILE_Y = PHAROSVILLE_MAP_HEIGHT - 1;
export const LIGHTHOUSE_TILE = { x: 18, y: 28 } as const;
export const CIVIC_CORE_CENTER = { x: 31, y: 31 } as const;
export const CIVIC_CORE_RADIUS = 8.5;
// Chebyshev tile distance: any sea tile within this many tiles of land is rendered
// as generic "water" (no DEWS zone), giving the island a non-attributed halo
// before named edge-water districts begin.
export const ISLAND_PERIPHERY_TILE_DISTANCE = 3;

export const REGION_TILES: Record<ShipRiskPlacement, { x: number; y: number }> = RISK_WATER_REGION_TILES;

export const ETHEREUM_L2_DOCK_CHAIN_IDS = ["base", "arbitrum", "optimism", "polygon", "mantle"] as const;
export const ETHEREUM_HARBOR_PRIORITY_CHAIN_IDS = ["ethereum", ...ETHEREUM_L2_DOCK_CHAIN_IDS] as const;

// Ethereum anchors the east cove while major L2s use smaller extension slips
// wrapping the east and south harbor shelves.
export const EVM_BAY_DOCK_TILES = [
  { x: 45, y: 31 },
  { x: 40, y: 39 },
  { x: 35, y: 43 },
  { x: 44, y: 27 },
  { x: 28, y: 43 },
  { x: 44, y: 35 },
] as const;

// Outer harbors wrap the north, west, south, and east coasts so the
// island reads as a single inhabited harbor ring rather than a dock staircase.
export const OUTER_HARBOR_DOCK_TILES = [
  { x: 16, y: 31 },
  { x: 20, y: 38 },
  { x: 24, y: 22 },
  { x: 39, y: 19 },
  { x: 37, y: 43 },
  { x: 31, y: 19 },
  { x: 18, y: 34 },
  { x: 24, y: 41 },
  { x: 43, y: 36 },
  { x: 32, y: 19 },
] as const;

export const PREFERRED_DOCK_TILES: Record<string, { x: number; y: number }> = {
  ethereum: EVM_BAY_DOCK_TILES[0],
  base: EVM_BAY_DOCK_TILES[1],
  arbitrum: EVM_BAY_DOCK_TILES[2],
  optimism: EVM_BAY_DOCK_TILES[3],
  polygon: EVM_BAY_DOCK_TILES[4],
  mantle: EVM_BAY_DOCK_TILES[5],
  bsc: OUTER_HARBOR_DOCK_TILES[0],
  tron: OUTER_HARBOR_DOCK_TILES[1],
  solana: OUTER_HARBOR_DOCK_TILES[2],
  aptos: OUTER_HARBOR_DOCK_TILES[3],
};

export const EVM_BAY_CHAIN_IDS = new Set<string>(ETHEREUM_HARBOR_PRIORITY_CHAIN_IDS);

export const DOCK_TILES = [
  ...EVM_BAY_DOCK_TILES,
  ...OUTER_HARBOR_DOCK_TILES,
];

// Cemetery remains a separate memorial islet, snapped to the bottom-left edge
// as in the positioning source while staying outside the central island model.
export const CEMETERY_CENTER = { x: 8.0, y: 50.0 } as const;
export const CEMETERY_RADIUS = { x: 3.3, y: 2.1 } as const;
const CEMETERY_ISLAND_RADIUS = { x: 5.4, y: 3.8 } as const;

type GraveMarker = GraveNode["visual"]["marker"];

function ellipseValue(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

const WATER_TERRAIN_KINDS = new Set<TerrainKind>([
  "deep-water",
  "water",
  "alert-water",
  "calm-water",
  "harbor-water",
  "watch-water",
  "warning-water",
  "storm-water",
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
  const lighthouseMountain = lighthouseMountainValue(x, y);
  const cemetery = cemeteryValue(x, y);
  const nearIslandEdge = island > 0.82;

  if (isOutOfBounds(x, y) || island >= 1) {
    const inIslandPeriphery = isWithinIslandPeriphery(x, y);
    if (!inIslandPeriphery && !isLighthouseVisualClearance(x, y)) {
      if (isDangerStrait(x, y)) return "storm-water";
      if (isWarningShoals(x, y)) return "warning-water";
      if (isAlertChannel(x, y)) return "alert-water";
      if (isWatchBreakwater(x, y)) return "watch-water";
      if (isLedgerMooring(x, y)) return "ledger-water";
      if (isCalmAnchorage(x, y)) return "calm-water";
    }
    if (isDeepSeaShelf(x, y)) return "deep-water";
    return "water";
  }

  if (x === LIGHTHOUSE_TILE.x && y === LIGHTHOUSE_TILE.y) return "hill";
  if (cemetery < 1) return "grass";
  if (lighthouseMountain < 1.04) {
    if (lighthouseMountain > 0.78 || y < LIGHTHOUSE_TILE.y - 2) return "cliff";
    if (lighthouseMountain > 0.48) return "rock";
    return "hill";
  }
  if (nearIslandEdge) return "shore";
  if (ellipseValue(x, y, 31.3, 31.2, 7.2, 5.9) < 0.7) return "rock";
  if (ellipseValue(x, y, 39.0, 29.6, 5.8, 5.2) < 0.58) return "rock";
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
    // Main central island.
    ellipseValue(x, y, 31.2, 31.3, 12.4, 10.2),
    // North harbor shelf.
    ellipseValue(x, y, 31.2, 23.9, 8.7, 5.4),
    // West harbor cove.
    ellipseValue(x, y, 23.3, 32.2, 5.8, 7.8),
    // Raised lighthouse mountain shoulder from the generated island overlay.
    ellipseValue(x, y, 18.8, 28.2, 4.4, 3.9),
    // Southern quay shelf.
    ellipseValue(x, y, 31.8, 39.4, 8.8, 4.9),
    // East / Ethereum cove.
    ellipseValue(x, y, 39.3, 31.2, 6.1, 7.0),
    // Northeast harbor shelf.
    ellipseValue(x, y, 39.5, 23.0, 5.5, 4.8),
    // Detached bottom-left cemetery islet.
    ellipseValue(x, y, CEMETERY_CENTER.x, CEMETERY_CENTER.y, CEMETERY_ISLAND_RADIUS.x, CEMETERY_ISLAND_RADIUS.y),
  );
}

function lighthouseMountainValue(x: number, y: number): number {
  return Math.min(
    ellipseValue(x, y, 18.7, 28.35, 4.2, 3.4),
    ellipseValue(x, y, 17.9, 27.55, 3.0, 2.45),
  );
}

function isAlertChannel(x: number, y: number): boolean {
  const value = eastCornerRiskValue(x, y);
  return value >= 0.66 && value < 1.63;
}

function isWarningShoals(x: number, y: number): boolean {
  const value = eastCornerRiskValue(x, y);
  return value >= 0.26 && value < 0.66;
}

function isDangerStrait(x: number, y: number): boolean {
  return eastCornerRiskValue(x, y) < 0.26;
}

function eastCornerRiskValue(x: number, y: number): number {
  return ellipseValue(x, y, 55.0, 0.0, 14.0, 14.0);
}

// Visual buffer around the lighthouse sprite on the generated island mountain:
// keep adjacent water generic so DEWS labels and zone textures do not crowd it.
function isLighthouseVisualClearance(x: number, y: number): boolean {
  return x >= 14 && x <= 24 && y >= 23 && y <= 32;
}

function isWatchBreakwater(x: number, y: number): boolean {
  const topEdge = y <= 6;
  const topBasin = ellipseValue(x, y, 28.0, 4.8, 25.5, 5.8) < 1.05 && y <= 10;
  return topEdge || topBasin;
}

function isCalmAnchorage(x: number, y: number): boolean {
  const leftEdge = x <= 15 && y >= 10 && y <= 49;
  const leftBasin = ellipseValue(x, y, 8.2, 31.0, 15.0, 20.5) < 1.08 && x <= 22 && y >= 10;
  const southBay = x >= 16 && x <= 43 && y >= 45;
  return leftEdge || leftBasin || southBay;
}

function isOutOfBounds(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= PHAROSVILLE_MAP_WIDTH || y >= PHAROSVILLE_MAP_HEIGHT;
}

// Computes whether (x, y) is land WITHOUT consulting the periphery rule, so the
// land mask can be precomputed without recursion.
function isLandTileRaw(x: number, y: number): boolean {
  if (isOutOfBounds(x, y)) return false;
  return islandValue(x, y) < 1;
}

let cachedLandMask: Uint8Array | null = null;

function getLandMask(): Uint8Array {
  if (cachedLandMask) return cachedLandMask;
  const mask = new Uint8Array(PHAROSVILLE_MAP_WIDTH * PHAROSVILLE_MAP_HEIGHT);
  for (let y = 0; y < PHAROSVILLE_MAP_HEIGHT; y += 1) {
    for (let x = 0; x < PHAROSVILLE_MAP_WIDTH; x += 1) {
      if (isLandTileRaw(x, y)) mask[y * PHAROSVILLE_MAP_WIDTH + x] = 1;
    }
  }
  cachedLandMask = mask;
  return mask;
}

function isWithinIslandPeriphery(x: number, y: number): boolean {
  if (isOutOfBounds(x, y)) return false;
  const r = ISLAND_PERIPHERY_TILE_DISTANCE;
  const mask = getLandMask();
  const minX = Math.max(0, Math.floor(x) - r);
  const maxX = Math.min(PHAROSVILLE_MAP_WIDTH - 1, Math.ceil(x) + r);
  const minY = Math.max(0, Math.floor(y) - r);
  const maxY = Math.min(PHAROSVILLE_MAP_HEIGHT - 1, Math.ceil(y) + r);
  for (let ny = minY; ny <= maxY; ny += 1) {
    for (let nx = minX; nx <= maxX; nx += 1) {
      if (mask[ny * PHAROSVILLE_MAP_WIDTH + nx]) return true;
    }
  }
  return false;
}

function isDeepSeaShelf(x: number, y: number): boolean {
  const edge = Math.min(x, y, MAX_TILE_X - x, MAX_TILE_Y - y);
  if (edge <= 0) return true;
  if (edge === 1) {
    return x < 8 || y < 8 || x > MAX_TILE_X - 8 || y > MAX_TILE_Y - 8;
  }
  return false;
}

function isLedgerMooring(x: number, y: number): boolean {
  return ellipseValue(x, y, 55.0, 55.0, 14.0, 14.0) < 1.0;
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
