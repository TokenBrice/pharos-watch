import type {
  PegSummaryResponse,
  ReportCardsResponse,
  StablecoinData,
  StablecoinListResponse,
  StabilityIndexResponse,
  StressSignalsAllResponse,
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
  detailForDock,
  detailForGrave,
  detailForLighthouse,
  detailForArea,
  detailForShip,
} from "./detail-model";
import { buildPharosVilleMap, clampMapTile, graveNodesFromEntries, LIGHTHOUSE_TILE, MAX_TILE_X, MAX_TILE_Y, nearestAvailableWaterTile, nearestWaterTile, REGION_TILES } from "./world-layout";
import { getRecentChange } from "./recent-change";
import { resolveShipRiskPlacement } from "./risk-placement";
import { isRiskPlacementWaterTile, nearestAvailableRiskPlacementWaterTile, nearestRiskPlacementWaterTile } from "./risk-water-placement";
import {
  SHIP_SCATTER_RADIUS,
  SHIP_RISK_PLACEMENTS,
  SHIP_WATER_ANCHORS,
  riskWaterAreaForPlacement,
} from "./risk-water-areas";
import { resolveShipVisual } from "./ship-visuals";
import { stableHash, stableOffset, stableUnit } from "./stable-random";
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
} from "./world-types";

export { SHIP_WATER_ANCHORS, waterZoneForPlacement } from "./risk-water-areas";

export interface PharosVilleInputs {
  stablecoins: StablecoinListResponse | null | undefined;
  chains: ChainsResponse | null | undefined;
  stability: StabilityIndexResponse | null | undefined;
  pegSummary: PegSummaryResponse | null | undefined;
  stress: StressSignalsAllResponse | null | undefined;
  reportCards: ReportCardsResponse | null | undefined;
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

function areaIdForRiskWaterPlacement(placement: ShipNode["riskPlacement"], band: DewsAreaBand | null): string {
  return band ? `area.dews.${band.toLowerCase()}` : `area.risk-water.${placement}`;
}

function sourceFieldsForRiskWaterPlacement(placement: ShipNode["riskPlacement"], band: DewsAreaBand | null): string[] {
  if (band) return ["stress.signals[]"];
  if (placement === "ledger-mooring") return ["meta.flags.navToken", "pegSummary.coins"];
  return ["pegSummary.coins[]", "stress.signals[]"];
}

function summaryForRiskWaterPlacement(placement: ShipNode["riskPlacement"], band: DewsAreaBand | null): string {
  const area = riskWaterAreaForPlacement(placement);
  if (band) return `${area.label} uses ${area.waterStyle} for DEWS ${band} placement.`;
  if (placement === "ledger-mooring") return "Ledger Mooring uses ledger water for NAV ledger assets that do not have a standard peg-summary row.";
  return `${area.label} is a named risk-water area.`;
}

function buildAreas(stress: StressSignalsAllResponse | null | undefined): PharosVilleWorld["areas"] {
  const counts = buildDewsBandCounts(stress);
  return SHIP_RISK_PLACEMENTS.map((placement) => {
    const riskWaterArea = riskWaterAreaForPlacement(placement);
    const band = riskWaterArea.band;
    const id = areaIdForRiskWaterPlacement(placement, band);
    const sourceFields = sourceFieldsForRiskWaterPlacement(placement, band);
    return {
      id,
      kind: "area" as const,
      label: riskWaterArea.label,
      tile: riskWaterArea.labelTile,
      band: band ?? undefined,
      count: band ? counts[band] : null,
      detailId: id,
      facts: [
        { label: "Water style", value: riskWaterArea.waterStyle },
        { label: "Source", value: sourceFields.join(", ") },
      ],
      links: [{
        label: placement === "ledger-mooring" ? "Stablecoins" : "DEWS",
        href: placement === "ledger-mooring" ? "/stablecoins/" : "/depeg/",
      }],
      riskPlacement: placement,
      riskZone: riskWaterArea.motionZone,
      sourceFields,
      summary: summaryForRiskWaterPlacement(placement, band),
    };
  });
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
      ...clampMapTile({
        x: Math.round(base.x + Math.cos(angle) * radius.x * distance + stableOffset(`${asset.id}.risk.x.${attempt}`, 1) * 0.3),
        y: Math.round(base.y + Math.sin(angle) * radius.y * distance + stableOffset(`${asset.id}.risk.y.${attempt}`, 1) * 0.3),
      }),
    };
    if (isRiskPlacementWaterTile(tile, placement)) return tile;
  }
  return nearestRiskPlacementWaterTile(base, placement, 18) ?? nearestWaterTile(base, 18);
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
    const riskWaterArea = riskWaterAreaForPlacement(risk.placement);
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
      riskZone: riskWaterArea.motionZone,
      riskWaterLabel: riskWaterArea.label,
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

  return nearestAvailableWaterTile(clampMapTile({
    x: dock.tile.x + outward.x * depth + fan.x * lane,
    y: dock.tile.y + outward.y * depth + fan.y * lane,
  }), occupied);
}

function dockOutwardVector(dock: DockNode): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const dx = dock.tile.x - MAX_TILE_X / 2;
  const dy = dock.tile.y - MAX_TILE_Y / 2;
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
      return {
        ...ship,
        dockChainId: ship.homeDockChainId ?? null,
        dockVisits: normalizedVisits,
        tile: ship.riskTile,
      };
    });
}

function spreadShipRiskAnchorsAcrossWater(ships: ShipNode[]): ShipNode[] {
  const occupied = new Set<string>();
  return ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd || a.id.localeCompare(b.id))
    .map((ship) => {
      const riskTile = nearestAvailableRiskPlacementWaterTile(ship.riskTile, ship.riskPlacement, occupied, 18)
        ?? nearestAvailableWaterTile(ship.riskTile, occupied);
      occupied.add(`${riskTile.x}.${riskTile.y}`);
      return { ...ship, tile: riskTile, riskTile };
    });
}

function buildDetailIndex(world: Omit<PharosVilleWorld, "detailIndex" | "visualCues">): Record<string, DetailModel> {
  const details = [
    detailForLighthouse(world.lighthouse),
    ...world.docks.map(detailForDock),
    ...world.ships.map(detailForShip),
    ...world.shipClusters.map(detailForCluster),
    ...world.areas.map(detailForArea),
    ...world.graves.map(detailForGrave),
  ];
  return Object.fromEntries(details.map((detail) => [detail.id, detail]));
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
    effects: [],
    legends: [
      { id: "legend.psi", label: "Lighthouse", description: "PSI composite status" },
      { id: "legend.docks", label: "Docks", description: "Top chain harbors by stablecoin supply" },
      { id: "legend.ships", label: "Ships", description: "Active stablecoins" },
      { id: "legend.cemetery", label: "Cemetery", description: "Dead and frozen assets" },
    ],
  };
  return {
    ...baseWorld,
    detailIndex: buildDetailIndex(baseWorld),
    visualCues: buildVisualCueRegistry(),
  };
}
