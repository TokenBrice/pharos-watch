import type { GraveNode, PharosVilleMap, PharosVilleTile, ShipRiskPlacement, TerrainKind, TileKind } from "./world-types";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { RISK_WATER_REGION_TILES } from "./risk-water-areas";
import { stableUnit } from "./stable-random";

export const PHAROSVILLE_MAP_WIDTH = 56;
export const PHAROSVILLE_MAP_HEIGHT = 56;
export const MAX_TILE_X = PHAROSVILLE_MAP_WIDTH - 1;
export const MAX_TILE_Y = PHAROSVILLE_MAP_HEIGHT - 1;
export const LIGHTHOUSE_TILE = { x: 38, y: 22 } as const;
export const CIVIC_CORE_CENTER = { x: 34, y: 30 } as const;
export const CIVIC_CORE_RADIUS = 7.0;
// Chebyshev tile distance: any sea tile within this many tiles of land is rendered
// as generic "water" (no DEWS zone), giving the island a 3–6 tile non-attributed
// halo before zone water begins.
export const ISLAND_PERIPHERY_TILE_DISTANCE = 5;

export const REGION_TILES: Record<ShipRiskPlacement, { x: number; y: number }> = RISK_WATER_REGION_TILES;

export const EVM_BAY_DOCK_TILES = [
  { x: 35, y: 40 },
  { x: 24, y: 42 },
  { x: 34, y: 42 },
  { x: 39, y: 40 },
] as const;

export const OUTER_HARBOR_DOCK_TILES = [
  { x: 49, y: 30 },
  { x: 48, y: 23 },
  { x: 21, y: 25 },
  { x: 38, y: 42 },
  { x: 47, y: 25 },
  { x: 46, y: 35 },
  { x: 36, y: 43 },
  { x: 26, y: 43 },
  { x: 20, y: 38 },
  { x: 47, y: 34 },
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
    ellipseValue(x, y, 32.4, 31.2, 15.0, 10.4),
    ellipseValue(x, y, 40.6, 22.3, 7.7, 6.1),
    ellipseValue(x, y, 42.0, 28.6, 7.1, 6.4),
    ellipseValue(x, y, 30.2, 40.5, 8.4, 4.6),
    ellipseValue(x, y, 25.6, 38.0, 6.5, 3.3),
    ellipseValue(x, y, 21.6, 32.6, 3.6, 2.8),
    ellipseValue(x, y, 47.8, 32.2, 3.3, 2.8),
    ellipseValue(x, y, CEMETERY_CENTER.x, CEMETERY_CENTER.y, CEMETERY_RADIUS.x + 1.2, CEMETERY_RADIUS.y + 0.95),
  );
}

function lighthouseHeadlandValue(x: number, y: number): number {
  return Math.min(
    ellipseValue(x, y, 40.6, 22.1, 7.2, 5.6),
    ellipseValue(x, y, 39.4, 21.2, 4.4, 3.9),
  );
}

function harborCoveValue(x: number, y: number): number {
  return ellipseValue(x, y, 29.4, 39.8, 5.8, 4.0);
}

function harborApproachValue(x: number, y: number): number {
  return ellipseValue(x, y, 31.6, 43.8, 4.4, 4.8);
}

// East-corner anchor (55, 0) — DANGER/WARNING/ALERT are concentric arcs around it.
const RISK_ARC_CENTER = { x: 55, y: 0 } as const;
const DANGER_ARC_RADIUS = 7;
const WARNING_ARC_RADIUS = 11;
const ALERT_ARC_RADIUS = 17.5;

function riskArcDistance(x: number, y: number): number {
  return Math.hypot(RISK_ARC_CENTER.x - x, RISK_ARC_CENTER.y - y);
}

function isAlertChannel(x: number, y: number): boolean {
  const d = riskArcDistance(x, y);
  return d >= WARNING_ARC_RADIUS && d < ALERT_ARC_RADIUS;
}

function isWarningShoals(x: number, y: number): boolean {
  const d = riskArcDistance(x, y);
  return d >= DANGER_ARC_RADIUS && d < WARNING_ARC_RADIUS;
}

function isDangerStrait(x: number, y: number): boolean {
  return riskArcDistance(x, y) < DANGER_ARC_RADIUS;
}

// Visual buffer around the lighthouse sprite — taller than its tile-space ellipse,
// so we exclude this rectangle from zone-water rendering to give the lighthouse breathing room.
function isLighthouseVisualClearance(x: number, y: number): boolean {
  return x >= 35 && x <= 41 && y >= 16 && y <= 22;
}

// Spans the y=0 north edge from the upper-left corner up to the ALERT outer arc
// boundary, plus a north basin extending into the map. The (0, 0) corner stays
// deep-water decoration.
function isWatchBreakwater(x: number, y: number): boolean {
  if (x === 0 && y === 0) return false;
  if (riskArcDistance(x, y) < ALERT_ARC_RADIUS) return false;
  const northBasin = ellipseValue(x, y, 16.4, 6.4, 22.0, 8.6) < 1.08 && y <= 15;
  const topEdge = x >= 0 && x <= 38 && y >= 0 && y <= 11;
  return northBasin || topEdge;
}

// Wraps the lower-left of the diamond from upper-left mid-band to bottom-left.
function isCalmAnchorage(x: number, y: number): boolean {
  const westBasin = ellipseValue(x, y, 7.6, 34.4, 18.4, 22.5) < 1.1;
  const lowerReach = ellipseValue(x, y, 15.0, 49.0, 13.0, 9.6) < 1.05;
  const westEdge = x >= 0 && x <= 7 && y >= 14 && y <= 55;
  return westEdge || westBasin || lowerReach;
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

// Computes whether (x, y) is land WITHOUT consulting the periphery rule, so the
// land mask can be precomputed without recursion.
function isLandTileRaw(x: number, y: number): boolean {
  if (isOutOfBounds(x, y)) return false;
  if (islandValue(x, y) >= 1) return false;
  const cemetery = cemeteryValue(x, y);
  if (cemetery <= 1.18) return true;
  if (isCemeteryCausewayTile(x, y)) return true;
  const harbor = harborCoveValue(x, y);
  const approach = harborApproachValue(x, y);
  const harborWater = (harbor < 0.9 && y > 34 && x < 37) || (approach < 0.94 && y > 42);
  return !harborWater;
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
  // Extends from the original south-mooring ellipse all the way to the diamond's
  // south apex (55, 55) so the bottom corner reads as Ledger Mooring water.
  const mooring = ellipseValue(x, y, 43.2, 49.0, 4.6, 3.2) < 1
    && x >= 39
    && x <= 47
    && y >= 47
    && y <= 51;
  const southWedge = x + y >= 92
    && x >= 40
    && y >= 40
    && x <= MAX_TILE_X
    && y <= MAX_TILE_Y;
  const southEdgeAttachment = x >= 41
    && x <= MAX_TILE_X
    && y >= 51
    && y <= MAX_TILE_Y;
  return mooring || southWedge || southEdgeAttachment;
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
