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
import { buildChainDocks } from "./chain-docks";
import { clusterLongTailShips } from "./clustering";
import {
  detailForCluster,
  detailForDock,
  detailForGrave,
  detailForLighthouse,
  detailForShip,
} from "./detail-model";
import { buildPharosVilleMap, graveNodesFromEntries, nearestAvailableWaterTile, nearestWaterTile, REGION_TILES, stableOffset } from "./world-layout";
import { getRecentChange } from "./recent-change";
import { resolveShipRiskPlacement } from "./risk-placement";
import { resolveShipVisual } from "./ship-visuals";
import { buildVisualCueRegistry } from "./visual-cue-registry";
import type {
  DetailModel,
  LighthouseNode,
  PharosVilleFreshness,
  PharosVilleWorld,
  ShipNode,
} from "./world-types";

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
    tile: { x: 32, y: 31 },
    psiBand: band,
    score: current?.score ?? null,
    color: isConditionBand(band) ? PSI_HEX_COLORS[band] : "#8aa0a6",
    unavailable: !current || !isConditionBand(band),
    detailId: "lighthouse",
  };
}

function dominantChain(asset: StablecoinData): string | null {
  const entries = [...canonicalizeChainCirculating(asset.chainCirculating).entries()];
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1].current - a[1].current);
  return entries[0]?.[0] ?? null;
}

function activeAssets(stablecoins: StablecoinListResponse | null | undefined): StablecoinData[] {
  return (stablecoins?.peggedAssets ?? []).filter((asset) => (
    ACTIVE_IDS.has(asset.id) && ACTIVE_META_BY_ID.has(asset.id) && asset.frozen !== true
  ));
}

function shipTile(asset: StablecoinData, placement: ShipNode["riskPlacement"]): { x: number; y: number } {
  const base = REGION_TILES[placement];
  return nearestWaterTile({
    x: Math.max(0, Math.min(63, base.x + stableOffset(asset.id, 4))),
    y: Math.max(0, Math.min(63, base.y + stableOffset(`${asset.id}.y`, 4))),
  });
}

function buildShips(inputs: PharosVilleInputs): ShipNode[] {
  const pegById = buildPegSummaryCoinMap(inputs.pegSummary?.coins);
  const reportCardById = buildReportCardMap(inputs.reportCards?.cards) ?? {};
  const stressById = inputs.stress?.signals ?? {};

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
    const recent = getRecentChange(asset);
    return {
      id: asset.id,
      kind: "ship" as const,
      label: asset.name,
      symbol: asset.symbol,
      asset,
      meta,
      reportCard,
      tile: shipTile(asset, risk.placement),
      dockChainId: dominantChain(asset),
      marketCapUsd: getCirculatingRaw(asset),
      riskPlacement: risk.placement,
      placementEvidence: risk.evidence,
      visual: resolveShipVisual(asset, meta, reportCard),
      change24hUsd: recent.change24hUsd,
      change24hPct: recent.change24hPct,
      detailId: `ship.${asset.id}`,
    };
  });
  return spreadShipsAcrossWater(ships);
}

function spreadShipsAcrossWater(ships: ShipNode[]): ShipNode[] {
  const occupied = new Set<string>();
  return ships
    .toSorted((a, b) => b.marketCapUsd - a.marketCapUsd || a.id.localeCompare(b.id))
    .map((ship) => {
      const tile = nearestAvailableWaterTile(ship.tile, occupied);
      occupied.add(`${tile.x}.${tile.y}`);
      return { ...ship, tile };
    });
}

function buildDetailIndex(world: Omit<PharosVilleWorld, "detailIndex" | "visualCues">): Record<string, DetailModel> {
  const details = [
    detailForLighthouse(world.lighthouse),
    ...world.docks.map(detailForDock),
    ...world.ships.map(detailForShip),
    ...world.shipClusters.map(detailForCluster),
    ...world.graves.map(detailForGrave),
  ];
  return Object.fromEntries(details.map((detail) => [detail.id, detail]));
}

export function buildPharosVilleWorld(inputs: PharosVilleInputs): PharosVilleWorld {
  const map = buildPharosVilleMap();
  const lighthouse = buildLighthouse(inputs.stability);
  const docks = buildChainDocks(inputs.chains);
  const allShips = buildShips(inputs);
  const renderedDockIds = new Set(docks.map((dock) => dock.chainId));
  const dockedShips = allShips.map((ship) => ({
    ...ship,
    dockChainId: ship.dockChainId && renderedDockIds.has(ship.dockChainId) ? ship.dockChainId : null,
  }));
  const { visibleShips, clusters } = clusterLongTailShips(dockedShips);
  const graves = graveNodesFromEntries(inputs.cemeteryEntries ?? CEMETERY_ENTRIES);
  const baseWorld = {
    generatedAt: Date.now(),
    routeMode: inputs.routeMode ?? "world",
    freshness: inputs.freshness,
    map,
    lighthouse,
    docks,
    ships: visibleShips,
    shipClusters: clusters,
    graves,
    effects: [],
    legends: [
      { id: "legend.psi", label: "Lighthouse", description: "PSI composite status" },
      { id: "legend.docks", label: "Docks", description: "Chain stablecoin supply" },
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
