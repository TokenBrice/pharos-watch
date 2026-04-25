import {
  formatCompactUsd,
  formatPercent,
  formatPercentFromRatio,
  formatScore,
  formatSignedPercent,
} from "@shared/lib/format";
import type { ChainSummary, HealthBand } from "@shared/types/chains";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { buildChainHarborEntries } from "../chains/harbor-map";
import {
  aggregateSkyBand,
  cargoCapacityForHull,
  depthLayers,
  hullWidth,
  wakeLength,
} from "../chains/nautical-scene-math";

const MAX_VISIBLE_SHIPS = 6;
const SCENE_WIDTH = 1360;
const SHIP_START_X = 144;
const SHIP_END_X = 1000;
const WATERLINE_Y = 382;
const LIGHTHOUSE_X = 1184;
const LIGHTHOUSE_Y = 170;

export interface LighthouseShipRow {
  id: string;
  name: string;
  logoPath: string;
  totalUsd: number;
  sharePct: number;
  change7dPct: number;
  healthScore: number | null;
  healthBand: HealthBand | null;
  dominantSymbol: string;
  dominantSharePct: number;
  dominantCargoUsd: number;
  stablecoinCount: number;
  cargoCount: number;
  pennantWidth: number;
  draftLayers: 1 | 2 | 3;
  hullWidth: number;
  hullHeight: number;
  mastHeight: number;
  wakeDirection: -1 | 0 | 1;
  wakeLength: number;
  centerX: number;
  deckY: number;
  isSelected: boolean;
}

export interface LighthouseTailFleet {
  remainingCount: number;
  remainingUsd: number;
  remainingSharePct: number;
  label: string;
}

export interface LighthouseSceneModel {
  totalUsd: number;
  chainCount: number;
  visibleShipCount: number;
  ships: LighthouseShipRow[];
  tailFleet: LighthouseTailFleet | null;
  selectedId: string | null;
  selectedShip: LighthouseShipRow | null;
  fleetBand: "sun" | "fog";
  watchScore: number | null;
  watchBand: string | null;
  watchLabel: string;
  sceneSummary: string;
  sceneSubtitle: string;
  largestHarbor: string | null;
  lighthouseX: number;
  lighthouseY: number;
  waterlineY: number;
}

export function buildLighthouseSceneModel({
  chains,
  totalUsd,
  stabilityIndex,
  selectedId,
}: {
  chains: readonly ChainSummary[];
  totalUsd: number;
  stabilityIndex: StabilityIndexCurrent | null | undefined;
  selectedId: string | null;
}): LighthouseSceneModel {
  const harborEntries = buildChainHarborEntries([...chains], totalUsd);
  const visibleEntries = harborEntries.slice(0, MAX_VISIBLE_SHIPS);
  const maxUsd = visibleEntries[0]?.totalUsd ?? 0;
  const visibleSpan = Math.max(1, visibleEntries.length - 1);
  const positionStep = visibleEntries.length > 1 ? (SHIP_END_X - SHIP_START_X) / visibleSpan : 0;

  const ships = visibleEntries.map((entry, index) => {
    const hullW = hullWidth(entry.totalUsd, maxUsd, 180);
    const cargoCount = Math.max(1, Math.min(5, cargoCapacityForHull(hullW)));
    const pennantWidth = Math.max(20, Math.min(74, 20 + (entry.dominantSharePct / 100) * 54));
    const draftLayers = depthLayers(entry.dominantSharePct / 100);
    const wake = wakeLength(entry.change7dPct);
    const hullH = 24 + Math.round(hullW * 0.18) + (cargoCount - 1) * 2;
    const mastH = 92 + Math.round(hullW * 0.26) + draftLayers * 4;

    return {
      id: entry.id,
      name: entry.name,
      logoPath: entry.logoPath,
      totalUsd: entry.totalUsd,
      sharePct: entry.sharePct,
      change7dPct: entry.change7dPct,
      healthScore: entry.healthScore,
      healthBand: entry.healthBand,
      dominantSymbol: entry.dominantSymbol,
      dominantSharePct: entry.dominantSharePct,
      dominantCargoUsd: entry.dominantCargoUsd,
      stablecoinCount: entry.stablecoinCount,
      cargoCount,
      pennantWidth,
      draftLayers,
      hullWidth: hullW,
      hullHeight: hullH,
      mastHeight: mastH,
      wakeDirection: (wake > 0 ? 1 : wake < 0 ? -1 : 0) as -1 | 0 | 1,
      wakeLength: wake,
      centerX: Math.round(SHIP_START_X + index * positionStep),
      deckY: WATERLINE_Y - 6 + (index % 2 === 0 ? 0 : 10),
      isSelected: false,
    };
  });

  const selectedIdResolved = ships.some((ship) => ship.id === selectedId) ? selectedId : (ships[0]?.id ?? null);
  const selectedShip = selectedIdResolved ? (ships.find((ship) => ship.id === selectedIdResolved) ?? null) : null;
  const selectedShips = ships.map((ship) => ({ ...ship, isSelected: ship.id === selectedIdResolved }));
  const tailEntries = harborEntries.slice(MAX_VISIBLE_SHIPS);
  const tailUsd = tailEntries.reduce((sum, entry) => sum + entry.totalUsd, 0);
  const fleetBand = aggregateSkyBand(harborEntries);
  const watchScore = stabilityIndex?.score ?? null;
  const watchBand = stabilityIndex?.band ?? null;
  const watchLabel = watchScore != null && watchBand ? `${watchBand} ${formatScore(watchScore)}` : "watch unavailable";
  const sceneSubtitle = watchBand
    ? `PSI ${watchBand} ${formatScore(watchScore)} · ${fleetBand === "fog" ? "fog over the harbor" : "clear watch"}`
    : `${fleetBand === "fog" ? "fog over the harbor" : "clear watch"} · chain data only`;

  return {
    totalUsd,
    chainCount: harborEntries.length,
    visibleShipCount: selectedShips.length,
    ships: selectedShips,
    tailFleet:
      tailEntries.length > 0
        ? {
            remainingCount: tailEntries.length,
            remainingUsd: tailUsd,
            remainingSharePct: totalUsd > 0 ? tailUsd / totalUsd : 0,
            label: `+${tailEntries.length} more harbors`,
          }
        : null,
    selectedId: selectedIdResolved,
    selectedShip,
    fleetBand,
    watchScore,
    watchBand,
    watchLabel,
    sceneSummary: `Pharos Lighthouse watching ${harborEntries.length} chain harbors, largest ${harborEntries[0]?.name ?? "none"}, ${sceneSubtitle}.`,
    sceneSubtitle,
    largestHarbor: harborEntries[0]?.name ?? null,
    lighthouseX: LIGHTHOUSE_X,
    lighthouseY: LIGHTHOUSE_Y,
    waterlineY: WATERLINE_Y,
  };
}

export function formatLighthouseShipSummary(ship: LighthouseShipRow): string {
  return `${ship.name} · ${formatCompactUsd(ship.totalUsd)} · ${formatPercent(ship.sharePct, 1)} of supply · ${ship.healthBand ?? "unrated"} · ${formatSignedPercent(ship.change7dPct * 100, 1)} 7d`;
}

export function formatTailFleetSummary(tailFleet: LighthouseTailFleet | null): string {
  if (!tailFleet) return "No trailing fleet";
  return `${tailFleet.label} · ${formatCompactUsd(tailFleet.remainingUsd)} · ${formatPercentFromRatio(tailFleet.remainingSharePct, 1)} of supply`;
}

export const LIGHTHOUSE_SCENE_LIMIT = MAX_VISIBLE_SHIPS;
export const LIGHTHOUSE_SCENE_WIDTH = SCENE_WIDTH;
