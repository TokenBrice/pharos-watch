import type {
  PegSummaryResponse,
  ReportCardsResponse,
  StablecoinData,
  StablecoinListResponse,
  StabilityIndexResponse,
  StressSignalsAllResponse,
  BlacklistSummaryResponse,
  DexLiquidityMap,
  MintBurnFlowsResponse,
  RedemptionBackstopsResponse,
  YieldRankingsResponse,
} from "@shared/types";
import type { ChainsResponse } from "@shared/types/chains";
import { ACTIVE_IDS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { getCirculatingRaw } from "@shared/lib/supply";
import { PSI_HEX_COLORS } from "@shared/lib/psi-colors";
import { buildPegSummaryCoinMap, buildReportCardMap } from "@/lib/stablecoin-lookups";
import { logosById } from "@/lib/logos";
import { buildChainDocks } from "./chain-docks";
import { clusterLongTailShips } from "./clustering";
import {
  detailForCluster,
  detailForBuilding,
  detailForDock,
  detailForGrave,
  detailForLighthouse,
  detailForShip,
} from "./detail-model";
import { buildDataBuildings } from "./data-buildings";
import { buildPharosVilleMap, graveNodesFromEntries, isWaterTileKind, LIGHTHOUSE_TILE, nearestAvailableWaterTile, nearestWaterTile, REGION_TILES, stableOffset, terrainKindAt, tileKindAt } from "./world-layout";
import { getRecentChange } from "./recent-change";
import { resolveShipRiskPlacement } from "./risk-placement";
import { resolveShipVisual } from "./ship-visuals";
import { buildVisualCueRegistry } from "./visual-cue-registry";
import type {
  DetailModel,
  DewsAreaBand,
  DockNode,
  LighthouseNode,
  PharosVilleFreshness,
  PharosVilleWorld,
  ShipChainPresence,
  ShipDockVisit,
  ShipNode,
  ShipRiskPlacement,
  ShipWaterZone,
} from "./world-types";

const SHIP_SCATTER_RADIUS: Record<ShipRiskPlacement, { x: number; y: number }> = {
  "safe-harbor": { x: 5, y: 4 },
  "breakwater-edge": { x: 4, y: 3 },
  "harbor-mouth-watch": { x: 4, y: 3 },
  "outer-rough-water": { x: 5, y: 5 },
  "storm-shelf": { x: 5, y: 5 },
  "data-fog": { x: 5, y: 4 },
  "ledger-mooring": { x: 4, y: 3 },
};

const SHIP_WATER_ANCHORS: Record<ShipRiskPlacement, readonly { x: number; y: number }[]> = {
  "safe-harbor": [
    { x: 16, y: 27 },
    { x: 22, y: 20 },
    { x: 31, y: 19 },
    { x: 43, y: 21 },
    { x: 49, y: 31 },
    { x: 47, y: 36 },
    { x: 40, y: 45 },
    { x: 31, y: 45 },
    { x: 20, y: 45 },
    { x: 18, y: 36 },
  ],
  "breakwater-edge": [
    { x: 21, y: 22 },
    { x: 27, y: 20 },
    { x: 39, y: 19 },
    { x: 46, y: 24 },
    { x: 49, y: 38 },
    { x: 40, y: 45 },
    { x: 26, y: 45 },
  ],
  "harbor-mouth-watch": [
    { x: 39, y: 42 },
    { x: 40, y: 43 },
    { x: 41, y: 43 },
    { x: 39, y: 44 },
    { x: 40, y: 45 },
    { x: 42, y: 46 },
    { x: 38, y: 46 },
    { x: 37, y: 47 },
  ],
  "outer-rough-water": [
    { x: 45, y: 44 },
    { x: 46, y: 45 },
    { x: 47, y: 43 },
    { x: 49, y: 46 },
    { x: 50, y: 48 },
    { x: 48, y: 49 },
    { x: 54, y: 44 },
    { x: 55, y: 46 },
  ],
  "storm-shelf": [
    { x: 54, y: 52 },
    { x: 55, y: 53 },
    { x: 56, y: 53 },
    { x: 57, y: 49 },
    { x: 51, y: 55 },
    { x: 58, y: 55 },
  ],
  "data-fog": [
    { x: 10, y: 16 },
    { x: 8, y: 24 },
    { x: 14, y: 20 },
    { x: 7, y: 12 },
    { x: 18, y: 18 },
  ],
  "ledger-mooring": [
    { x: 36, y: 43 },
    { x: 32, y: 46 },
    { x: 40, y: 45 },
    { x: 29, y: 46 },
  ],
};

const DEWS_AREA_PLACEMENTS: Record<DewsAreaBand, ShipRiskPlacement> = {
  DANGER: "storm-shelf",
  WARNING: "outer-rough-water",
  ALERT: "harbor-mouth-watch",
  WATCH: "breakwater-edge",
  CALM: "safe-harbor",
};

const DEWS_AREA_LABELS: Record<DewsAreaBand, string> = {
  DANGER: "Danger Strait",
  WARNING: "Warning Shoals",
  ALERT: "Alert Channel",
  WATCH: "Watch Breakwater",
  CALM: "Calm Anchorage",
};

const AREA_SIGN_TILES: Record<DewsAreaBand, { x: number; y: number }> = {
  DANGER: { x: 55, y: 53 },
  WARNING: { x: 49, y: 46 },
  ALERT: { x: 40, y: 45 },
  WATCH: { x: 27, y: 46 },
  CALM: { x: 23, y: 39 },
};

export interface PharosVilleInputs {
  stablecoins: StablecoinListResponse | null | undefined;
  chains: ChainsResponse | null | undefined;
  stability: StabilityIndexResponse | null | undefined;
  pegSummary: PegSummaryResponse | null | undefined;
  stress: StressSignalsAllResponse | null | undefined;
  reportCards: ReportCardsResponse | null | undefined;
  mintBurnFlows?: MintBurnFlowsResponse | null | undefined;
  blacklistSummary?: BlacklistSummaryResponse | null | undefined;
  dexLiquidity?: DexLiquidityMap | null | undefined;
  redemptionBackstops?: RedemptionBackstopsResponse | null | undefined;
  yieldRankings?: YieldRankingsResponse | null | undefined;
  cemeteryEntries?: readonly CemeteryEntry[];
  freshness: PharosVilleFreshness;
  routeMode?: PharosVilleWorld["routeMode"];
}

function isConditionBand(value: string | null | undefined): value is keyof typeof PSI_HEX_COLORS {
  return !!value && value in PSI_HEX_COLORS;
}

function buildLighthouse(stability: StabilityIndexResponse | null | undefined): LighthouseNode {
  const current = stability?.current ?? null;
  const band = current?.band ?? null;
  return {
    id: "lighthouse",
    kind: "lighthouse",
    label: "Pharos lighthouse",
    tile: { ...LIGHTHOUSE_TILE },
    psiBand: band,
    score: current?.score ?? null,
    color: isConditionBand(band) ? PSI_HEX_COLORS[band] : "#8aa0a6",
    unavailable: !current || !isConditionBand(band),
    detailId: "lighthouse",
  };
}

function activeAssets(stablecoins: StablecoinListResponse | null | undefined): StablecoinData[] {
  return (stablecoins?.peggedAssets ?? []).filter((asset) => (
    ACTIVE_IDS.has(asset.id) && ACTIVE_META_BY_ID.has(asset.id) && asset.frozen !== true
  ));
}

function buildDewsBandCounts(stress: StressSignalsAllResponse | null | undefined): Record<DewsAreaBand, number> {
  const counts: Record<DewsAreaBand, number> = {
    DANGER: 0,
    WARNING: 0,
    ALERT: 0,
    WATCH: 0,
    CALM: 0,
  };
  for (const entry of Object.values(stress?.signals ?? {})) {
    const band = entry.band.toUpperCase();
    if (band in counts) counts[band as DewsAreaBand] += 1;
  }
  return counts;
}

function buildAreas(stress: StressSignalsAllResponse | null | undefined): PharosVilleWorld["areas"] {
  const counts = buildDewsBandCounts(stress);
  return (Object.keys(DEWS_AREA_PLACEMENTS) as DewsAreaBand[]).map((band) => ({
    id: `area.dews.${band.toLowerCase()}`,
    kind: "area" as const,
    label: DEWS_AREA_LABELS[band],
    tile: AREA_SIGN_TILES[band],
    band,
    count: counts[band],
    riskPlacement: DEWS_AREA_PLACEMENTS[band],
  }));
}

export function waterZoneForPlacement(placement: ShipRiskPlacement): ShipWaterZone {
  if (placement === "safe-harbor" || placement === "breakwater-edge") return "safe";
  if (placement === "harbor-mouth-watch" || placement === "outer-rough-water") return "muddy";
  if (placement === "storm-shelf") return "storm";
  if (placement === "data-fog") return "fog";
  return "ledger";
}

function buildShipChainPresence(asset: StablecoinData, renderedDockChainIds: ReadonlySet<string>): ShipChainPresence[] {
  const entries = [...canonicalizeChainCirculating(asset.chainCirculating).entries()]
    .filter(([, point]) => point.current > 0)
    .sort((a, b) => b[1].current - a[1].current || a[0].localeCompare(b[0]));
  const totalUsd = entries.reduce((sum, [, point]) => sum + point.current, 0);
  if (totalUsd <= 0) return [];

  return entries.map(([chainId, point]) => ({
    chainId,
    currentUsd: point.current,
    share: point.current / totalUsd,
    hasRenderedDock: renderedDockChainIds.has(chainId),
  }));
}

function normalizeDockVisitWeights(visits: ShipDockVisit[]): ShipDockVisit[] {
  const totalWeight = visits.reduce((sum, visit) => sum + visit.weight, 0);
  if (totalWeight <= 0) return visits;
  return visits.map((visit) => ({
    ...visit,
    weight: visit.weight / totalWeight,
  }));
}

function shipPlacementAnchor(asset: StablecoinData, placement: ShipNode["riskPlacement"]): { x: number; y: number } {
  const anchors = SHIP_WATER_ANCHORS[placement];
  return anchors[stableHash(`${asset.id}.${placement}.anchor`) % anchors.length] ?? REGION_TILES[placement];
}

function shipTile(asset: StablecoinData, placement: ShipNode["riskPlacement"]): { x: number; y: number } {
  const base = shipPlacementAnchor(asset, placement);
  const radius = SHIP_SCATTER_RADIUS[placement];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angle = stableUnit(`${asset.id}.${placement}.angle.${attempt}`) * Math.PI * 2;
    const distance = 0.25 + Math.sqrt(stableUnit(`${asset.id}.${placement}.distance.${attempt}`)) * 0.75;
    const tile = {
      x: Math.round(clamp(base.x + Math.cos(angle) * radius.x * distance + stableOffset(`${asset.id}.risk.x.${attempt}`, 1) * 0.3, 0, 63)),
      y: Math.round(clamp(base.y + Math.sin(angle) * radius.y * distance + stableOffset(`${asset.id}.risk.y.${attempt}`, 1) * 0.3, 0, 63)),
    };
    if (isPlacementWaterTile(tile, placement)) return tile;
  }
  return nearestPlacementWaterTile(base, placement, 18) ?? nearestWaterTile(base, 18);
}

function buildShips(inputs: PharosVilleInputs, docks: readonly DockNode[]): ShipNode[] {
  const pegById = buildPegSummaryCoinMap(inputs.pegSummary?.coins);
  const reportCardById = buildReportCardMap(inputs.reportCards?.cards) ?? {};
  const stressById = inputs.stress?.signals ?? {};
  const renderedDockChainIds = new Set(docks.map((dock) => dock.chainId));

  const ships = activeAssets(inputs.stablecoins).map((asset) => {
    const meta = ACTIVE_META_BY_ID.get(asset.id);
    if (!meta) throw new Error(`Active asset ${asset.id} is missing metadata`);
    const reportCard = reportCardById[asset.id] ?? null;
    const risk = resolveShipRiskPlacement({
      asset,
      meta,
      pegCoin: pegById.get(asset.id),
      stress: stressById[asset.id],
      freshness: inputs.freshness,
    });
    const chainPresence = buildShipChainPresence(asset, renderedDockChainIds);
    const dominantChainId = chainPresence[0]?.chainId ?? null;
    const homeDockChainId = chainPresence.find((presence) => presence.hasRenderedDock)?.chainId ?? null;
    const recent = getRecentChange(asset);
    const riskTile = shipTile(asset, risk.placement);
    return {
      id: asset.id,
      kind: "ship" as const,
      label: asset.name,
      symbol: asset.symbol,
      asset,
      meta,
      reportCard,
      logoSrc: logosById[asset.id] ?? null,
      tile: riskTile,
      riskTile,
      chainPresence,
      dockVisits: [],
      dominantChainId,
      homeDockChainId,
      dockChainId: homeDockChainId,
      marketCapUsd: getCirculatingRaw(asset),
      riskPlacement: risk.placement,
      riskZone: waterZoneForPlacement(risk.placement),
      placementEvidence: risk.evidence,
      visual: resolveShipVisual(asset, meta, reportCard),
      change24hUsd: recent.change24hUsd,
      change24hPct: recent.change24hPct,
      detailId: `ship.${asset.id}`,
    };
  });
  return spreadShipRiskAnchorsAcrossWater(ships);
}

function dockMooringTile(dock: DockNode, index: number, occupied: ReadonlySet<string>): { x: number; y: number } {
  const outward = dockOutwardVector(dock);
  const fan = { x: -outward.y, y: outward.x };
  const depth = 2 + Math.floor(index / 7);
  const lane = (index % 7) - 3;

  return nearestAvailableWaterTile({
    x: Math.max(0, Math.min(63, dock.tile.x + outward.x * depth + fan.x * lane)),
    y: Math.max(0, Math.min(63, dock.tile.y + outward.y * depth + fan.y * lane)),
  }, occupied);
}

function dockOutwardVector(dock: DockNode): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const dx = dock.tile.x - 31.5;
  const dy = dock.tile.y - 31.5;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx < 0 ? -1 : 1, y: 0 };
  return { x: 0, y: dy < 0 ? -1 : 1 };
}

function assignDockVisits(ships: readonly ShipNode[], docks: readonly DockNode[]): ShipNode[] {
  const dockByChainId = new Map(docks.map((dock) => [dock.chainId, dock]));
  const occupied = new Set<string>();
  const dockedIndex = new Map<string, number>();

  return ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd || a.id.localeCompare(b.id))
    .map((ship) => {
      const visits = ship.chainPresence
        .filter((presence) => presence.hasRenderedDock)
        .flatMap((presence) => {
          const dock = dockByChainId.get(presence.chainId);
          if (!dock) return [];

          const index = dockedIndex.get(dock.chainId) ?? 0;
          dockedIndex.set(dock.chainId, index + 1);
          const mooringTile = dockMooringTile(dock, index, occupied);
          occupied.add(`${mooringTile.x}.${mooringTile.y}`);
          return [{
            chainId: presence.chainId,
            dockId: dock.id,
            weight: Math.max(0.08, presence.share),
            mooringTile,
          }];
        });

      const normalizedVisits = normalizeDockVisitWeights(visits);
      const representativeTile = normalizedVisits.find((visit) => visit.chainId === ship.homeDockChainId)?.mooringTile
        ?? normalizedVisits[0]?.mooringTile
        ?? ship.tile;

      return {
        ...ship,
        dockChainId: ship.homeDockChainId ?? null,
        dockVisits: normalizedVisits,
        tile: representativeTile,
      };
    });
}

function spreadShipRiskAnchorsAcrossWater(ships: ShipNode[]): ShipNode[] {
  const occupied = new Set<string>();
  return ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd || a.id.localeCompare(b.id))
    .map((ship) => {
      const riskTile = nearestAvailablePlacementWaterTile(ship.riskTile, ship.riskPlacement, occupied, 18)
        ?? nearestAvailableWaterTile(ship.riskTile, occupied);
      occupied.add(`${riskTile.x}.${riskTile.y}`);
      return { ...ship, tile: riskTile, riskTile };
    });
}

function isPlacementWaterTile(tile: { x: number; y: number }, placement: ShipNode["riskPlacement"]): boolean {
  const terrain = terrainKindAt(tile.x, tile.y);
  if (placement === "harbor-mouth-watch") return terrain === "alert-water";
  if (placement === "outer-rough-water") return terrain === "warning-water";
  if (placement === "storm-shelf") return terrain === "storm-water";
  if (placement === "data-fog") return terrain === "fog-water";
  return isWaterTileKind(tileKindAt(tile.x, tile.y));
}

function nearestPlacementWaterTile(
  tile: { x: number; y: number },
  placement: ShipNode["riskPlacement"],
  maxRadius = 12,
): { x: number; y: number } | null {
  if (isPlacementWaterTile(tile, placement)) return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = {
          x: Math.max(0, Math.min(63, tile.x + dx)),
          y: Math.max(0, Math.min(63, tile.y + dy)),
        };
        if (!isPlacementWaterTile(candidate, placement)) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = candidate;
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return null;
}

function nearestAvailablePlacementWaterTile(
  tile: { x: number; y: number },
  placement: ShipNode["riskPlacement"],
  occupied: ReadonlySet<string>,
  maxRadius = 12,
): { x: number; y: number } | null {
  const initialKey = `${tile.x}.${tile.y}`;
  if (isPlacementWaterTile(tile, placement) && !occupied.has(initialKey)) return tile;

  let bestTile: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidate = {
          x: Math.max(0, Math.min(63, tile.x + dx)),
          y: Math.max(0, Math.min(63, tile.y + dy)),
        };
        if (occupied.has(`${candidate.x}.${candidate.y}`)) continue;
        if (!isPlacementWaterTile(candidate, placement)) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance) {
          bestTile = candidate;
          bestDistance = distance;
        }
      }
    }
    if (bestTile) return bestTile;
  }

  return null;
}

function buildDetailIndex(world: Omit<PharosVilleWorld, "detailIndex" | "visualCues">): Record<string, DetailModel> {
  const details = [
    detailForLighthouse(world.lighthouse),
    ...world.docks.map(detailForDock),
    ...world.ships.map(detailForShip),
    ...world.shipClusters.map(detailForCluster),
    ...world.graves.map(detailForGrave),
    ...world.buildings.map(detailForBuilding),
  ];
  return Object.fromEntries(details.map((detail) => [detail.id, detail]));
}

function stableUnit(id: string) {
  return stableHash(id) / 0xffffffff;
}

function stableHash(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return hash;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function buildPharosVilleWorld(inputs: PharosVilleInputs): PharosVilleWorld {
  const map = buildPharosVilleMap();
  const lighthouse = buildLighthouse(inputs.stability);
  const docks = buildChainDocks(inputs.chains);
  const areas = buildAreas(inputs.stress);
  const allShips = buildShips(inputs, docks);
  const dockedShips = assignDockVisits(allShips, docks);
  const { visibleShips, clusters } = clusterLongTailShips(dockedShips);
  const graves = graveNodesFromEntries(inputs.cemeteryEntries ?? CEMETERY_ENTRIES);
  const buildings = buildDataBuildings({
    blacklistSummary: inputs.blacklistSummary,
    dexLiquidity: inputs.dexLiquidity,
    freshness: inputs.freshness,
    mintBurnFlows: inputs.mintBurnFlows,
    redemptionBackstops: inputs.redemptionBackstops,
    reportCards: inputs.reportCards,
    yieldRankings: inputs.yieldRankings,
  });
  const baseWorld = {
    generatedAt: Date.now(),
    routeMode: inputs.routeMode ?? "world",
    freshness: inputs.freshness,
    map,
    lighthouse,
    docks,
    areas,
    ships: visibleShips,
    shipClusters: clusters,
    graves,
    buildings,
    effects: [],
    legends: [
      { id: "legend.psi", label: "Lighthouse", description: "PSI composite status" },
      { id: "legend.docks", label: "Docks", description: "Top chain harbors by stablecoin supply" },
      { id: "legend.ships", label: "Ships", description: "Active stablecoins" },
      { id: "legend.buildings", label: "Data landmarks", description: "Thematic landmarks for Pharos data products" },
      { id: "legend.cemetery", label: "Cemetery", description: "Dead and frozen assets" },
    ],
  };
  return {
    ...baseWorld,
    detailIndex: buildDetailIndex(baseWorld),
    visualCues: buildVisualCueRegistry(),
  };
}
