import { THREAT_BAND_HEX, THREAT_BAND_ORDER, isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { formatCompactUsd, formatPercent, formatScore } from "@shared/lib/format";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import type { ChainSummary, HealthBand, StablecoinData, StressSignalsAllResponse } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { HEALTH_HEX_FILL } from "@/lib/chain-ui";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { buildChainHarborEntries } from "../chains/harbor-map";

export type Lighthouse2ModuleId = "chains" | "psi" | "dews" | "alt-pegs";

export const LIGHTHOUSE_2_VIEWBOX = { width: 1600, height: 900 } as const;
export const LIGHTHOUSE_2_VISIBLE_CHAINS = 9;
export const LIGHTHOUSE_2_VISIBLE_DEWS = 8;
export const LIGHTHOUSE_2_VISIBLE_ALT_PEGS = 8;

const NEUTRAL_HEX = "#64748b";
const BRASS_HEX = "#d6a64b";
const CHAIN_ROUTE_POINTS = [
  { x: 232, y: 612 },
  { x: 372, y: 546 },
  { x: 514, y: 646 },
  { x: 660, y: 570 },
  { x: 820, y: 668 },
  { x: 980, y: 592 },
  { x: 1126, y: 690 },
  { x: 1268, y: 608 },
  { x: 1390, y: 718 },
] as const;

const DEWS_POINTS = [
  { x: 1088, y: 236 },
  { x: 1196, y: 188 },
  { x: 1310, y: 244 },
  { x: 1390, y: 342 },
  { x: 1300, y: 430 },
  { x: 1162, y: 402 },
  { x: 1048, y: 332 },
  { x: 1238, y: 304 },
] as const;

const MODULE_LAYOUT: Record<Lighthouse2ModuleId, {
  x: number;
  y: number;
  rx: number;
  ry: number;
  target: { x: number; y: number };
}> = {
  chains: { x: 514, y: 642, rx: 405, ry: 158, target: { x: 514, y: 610 } },
  psi: { x: 788, y: 312, rx: 190, ry: 118, target: { x: 790, y: 292 } },
  dews: { x: 1238, y: 306, rx: 260, ry: 176, target: { x: 1238, y: 282 } },
  "alt-pegs": { x: 1194, y: 654, rx: 294, ry: 146, target: { x: 1194, y: 624 } },
};

const MODULE_LABELS: Record<Lighthouse2ModuleId, string> = {
  chains: "Chain harbors",
  psi: "PSI lighthouse",
  dews: "DEWS storm compass",
  "alt-pegs": "Alt-peg archipelago",
};

export interface Lighthouse2Point {
  x: number;
  y: number;
}

export interface Lighthouse2Module {
  id: Lighthouse2ModuleId;
  x: number;
  y: number;
  rx: number;
  ry: number;
  target: Lighthouse2Point;
  colorHex: string;
  isActive: boolean;
  ariaLabel: string;
}

export interface Lighthouse2ChainVessel {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  colorHex: string;
  totalUsd: number;
  sharePct: number;
  stablecoinCount: number;
  healthBand: HealthBand | null;
  dominantSymbol: string;
  isSelected: boolean;
  ariaLabel: string;
}

export interface Lighthouse2DewsBuoy {
  id: string;
  symbol: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  score: number;
  band: Exclude<ThreatBand, "CALM">;
  colorHex: string;
  isSelected: boolean;
  ariaLabel: string;
}

export interface Lighthouse2AltPegIsland {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  colorHex: string;
  marketCap: number;
  coinCount: number;
  isSelected: boolean;
  ariaLabel: string;
}

export interface Lighthouse2LedgerRow {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface Lighthouse2Model {
  stage: {
    viewBox: typeof LIGHTHOUSE_2_VIEWBOX;
    sceneLabel: string;
    activeModuleId: Lighthouse2ModuleId;
    activeTarget: Lighthouse2Point;
    lighthouse: Lighthouse2Point;
    hasCompleteData: boolean;
    activeColorHex: string;
    modules: Record<Lighthouse2ModuleId, Lighthouse2Module>;
  };
  chains: {
    vessels: Lighthouse2ChainVessel[];
    remainingCount: number;
    remainingUsd: number;
    totalUsd: number;
  };
  psi: {
    score: number | null;
    band: string | null;
    colorHex: string;
    needleAngleDeg: number;
    componentMarks: { id: string; value: number; angleDeg: number; radius: number; ariaLabel: string }[];
  };
  dews: {
    highestBand: ThreatBand;
    highestColorHex: string;
    elevatedCount: number;
    bandCounts: Record<ThreatBand, number>;
    buoys: Lighthouse2DewsBuoy[];
  };
  altPegs: {
    islands: Lighthouse2AltPegIsland[];
    visibleCoinCount: number;
    cohortCount: number;
  };
  ledgerRows: Lighthouse2LedgerRow[];
}

export interface BuildLighthouse2ModelInput {
  chains: readonly ChainSummary[];
  totalUsd: number;
  stabilityIndex: StabilityIndexCurrent | null | undefined;
  stressSignals: StressSignalsAllResponse | null | undefined;
  stablecoins: readonly StablecoinData[] | undefined;
  activeModuleId?: Lighthouse2ModuleId;
  selectedMarkId?: string | null;
}

function finiteNumber(value: number | null | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, min)));
}

function isConditionBand(value: string | null | undefined): value is ConditionBand {
  return typeof value === "string" && value in PSI_HEX_COLORS;
}

function chainColorHex(band: HealthBand | null): string {
  return band ? (HEALTH_HEX_FILL[band] ?? NEUTRAL_HEX) : NEUTRAL_HEX;
}

function buildChainVessels(
  chains: readonly ChainSummary[],
  totalUsd: number,
  selectedMarkId: string | null | undefined,
): Lighthouse2Model["chains"] {
  const entries = buildChainHarborEntries([...chains], Math.max(0, finiteNumber(totalUsd)));
  const visibleEntries = entries.slice(0, LIGHTHOUSE_2_VISIBLE_CHAINS);
  const maxUsd = visibleEntries.reduce((max, entry) => Math.max(max, finiteNumber(entry.totalUsd)), 0);
  const visibleUsd = visibleEntries.reduce((sum, entry) => sum + Math.max(0, finiteNumber(entry.totalUsd)), 0);

  const vessels = visibleEntries.map((entry, index) => {
    const point = CHAIN_ROUTE_POINTS[index] ?? CHAIN_ROUTE_POINTS[CHAIN_ROUTE_POINTS.length - 1];
    const scale = maxUsd > 0 ? Math.sqrt(clamp(entry.totalUsd / maxUsd, 0.08, 1)) : 0.4;
    const width = Math.round(58 + scale * 78);
    const height = Math.round(22 + scale * 24);
    const sharePct = clamp(entry.sharePct, 0, 100);
    const id = `chain:${entry.id}`;

    return {
      id,
      name: entry.name,
      x: point.x,
      y: point.y,
      width,
      height,
      colorHex: chainColorHex(entry.healthBand),
      totalUsd: Math.max(0, finiteNumber(entry.totalUsd)),
      sharePct,
      stablecoinCount: Math.max(0, Math.round(finiteNumber(entry.stablecoinCount))),
      healthBand: entry.healthBand,
      dominantSymbol: entry.dominantSymbol,
      isSelected: selectedMarkId === id,
      ariaLabel: `${entry.name}: ${formatCompactUsd(entry.totalUsd)} on chain, ${formatPercent(sharePct, 1)} of tracked supply, ${entry.stablecoinCount} tracked stablecoins, dominant asset ${entry.dominantSymbol}.`,
    } satisfies Lighthouse2ChainVessel;
  });

  return {
    vessels,
    remainingCount: Math.max(0, entries.length - visibleEntries.length),
    remainingUsd: Math.max(0, finiteNumber(totalUsd) - visibleUsd),
    totalUsd: Math.max(0, finiteNumber(totalUsd)),
  };
}

function buildPsi(stabilityIndex: StabilityIndexCurrent | null | undefined): Lighthouse2Model["psi"] {
  const score = stabilityIndex ? clamp(stabilityIndex.score, 0, 100) : null;
  const band = stabilityIndex?.band ?? null;
  const colorHex = isConditionBand(band) ? PSI_HEX_COLORS[band] : BRASS_HEX;
  const components = stabilityIndex?.components ?? null;
  const componentInput = [
    { id: "severity", value: components?.severity ?? 0, angleDeg: -78 },
    { id: "breadth", value: components?.breadth ?? 0, angleDeg: -24 },
    { id: "stressBreadth", value: components?.stressBreadth ?? 0, angleDeg: 34 },
    { id: "trend", value: components?.trend ?? 0, angleDeg: 88 },
  ];

  return {
    score,
    band,
    colorHex,
    needleAngleDeg: score == null ? -36 : -58 + clamp(score, 0, 100) * 1.16,
    componentMarks: componentInput.map((component) => {
      const magnitude = Math.min(100, Math.abs(finiteNumber(component.value)));
      return {
        id: component.id,
        value: finiteNumber(component.value),
        angleDeg: component.angleDeg,
        radius: 48 + magnitude * 0.56,
        ariaLabel: `PSI ${component.id} component ${formatScore(component.value)}.`,
      };
    }),
  };
}

function initializeBandCounts(): Record<ThreatBand, number> {
  return { CALM: 0, WATCH: 0, ALERT: 0, WARNING: 0, DANGER: 0 };
}

function buildDews(
  stressSignals: StressSignalsAllResponse | null | undefined,
  selectedMarkId: string | null | undefined,
): Lighthouse2Model["dews"] {
  const bandCounts = initializeBandCounts();
  const entries = Object.entries(stressSignals?.signals ?? {})
    .map(([id, signal]) => {
      const band = isThreatBand(signal.band) ? signal.band : null;
      if (!band) return null;
      bandCounts[band] += 1;
      return {
        id,
        symbol: id.split("-")[0]?.toUpperCase() ?? id.toUpperCase(),
        score: finiteNumber(signal.score),
        band,
      };
    })
    .filter((entry): entry is { id: string; symbol: string; score: number; band: ThreatBand } => entry !== null);

  const elevated = entries
    .filter((entry): entry is { id: string; symbol: string; score: number; band: Exclude<ThreatBand, "CALM"> } => (
      entry.band !== "CALM" && Number.isFinite(entry.score)
    ))
    .sort((a, b) => (THREAT_BAND_ORDER[b.band] - THREAT_BAND_ORDER[a.band]) || b.score - a.score)
    .slice(0, LIGHTHOUSE_2_VISIBLE_DEWS);

  let highestBand: ThreatBand = "CALM";
  for (const entry of entries) {
    if (THREAT_BAND_ORDER[entry.band] > THREAT_BAND_ORDER[highestBand]) highestBand = entry.band;
  }

  return {
    highestBand,
    highestColorHex: THREAT_BAND_HEX[highestBand],
    elevatedCount: entries.filter((entry) => entry.band !== "CALM").length,
    bandCounts,
    buoys: elevated.map((entry, index) => {
      const point = DEWS_POINTS[index] ?? DEWS_POINTS[DEWS_POINTS.length - 1];
      const radius = 17 + clamp(entry.score, 0, 100) * 0.16;
      const id = `dews:${entry.id}`;
      return {
        id,
        symbol: entry.symbol,
        name: entry.id,
        x: point.x,
        y: point.y,
        radius,
        score: entry.score,
        band: entry.band,
        colorHex: THREAT_BAND_HEX[entry.band],
        isSelected: selectedMarkId === id,
        ariaLabel: `${entry.id}: DEWS ${formatScore(entry.score)}, ${entry.band.toLowerCase()} band.`,
      };
    }),
  };
}

function buildAltPegIslands(
  stablecoins: readonly StablecoinData[] | undefined,
  selectedMarkId: string | null | undefined,
): Lighthouse2Model["altPegs"] {
  const diversity = buildPegDiversityHero(stablecoins);
  const fiatClusters = diversity.pegClusters.map((cluster) => {
    const marketCap = cluster.coins.reduce((sum, coin) => sum + finiteNumber(coin.marketCap), 0);
    return {
      id: `alt:${cluster.peg}`,
      label: cluster.peg,
      anchor: cluster.anchor,
      colorHex: cluster.colorHex,
      marketCap,
      coinCount: cluster.coins.length,
    };
  });
  const skyClusters = diversity.skyCohorts
    .filter((cohort) => cohort.coins.length > 0)
    .map((cohort, index) => ({
      id: `alt:${cohort.kind}`,
      label: cohort.label,
      anchor: { x: 22 + index * 24, y: 78 - index * 5 },
      colorHex: cohort.kind === "sun" ? "#eab308" : cohort.kind === "moon" ? "#94a3b8" : "#a78bfa",
      marketCap: cohort.coins.reduce((sum, coin) => sum + finiteNumber(coin.marketCap), 0),
      coinCount: cohort.coins.length,
    }));

  const clusters = [...fiatClusters, ...skyClusters]
    .filter((cluster) => cluster.coinCount > 0)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, LIGHTHOUSE_2_VISIBLE_ALT_PEGS);
  const maxMcap = clusters.reduce((max, cluster) => Math.max(max, cluster.marketCap), 0);

  return {
    visibleCoinCount: clusters.reduce((sum, cluster) => sum + cluster.coinCount, 0),
    cohortCount: clusters.length,
    islands: clusters.map((cluster, index) => {
      const route = index % 2 === 0 ? 1 : -1;
      const x = 1026 + (cluster.anchor.x - 50) * 4.25 + route * (index % 3) * 9;
      const y = 610 + (cluster.anchor.y - 42) * 2.3 + (index % 4) * 8;
      const radius = 21 + Math.sqrt(maxMcap > 0 ? cluster.marketCap / maxMcap : 0.2) * 38;
      return {
        id: cluster.id,
        label: cluster.label,
        x: Math.round(clamp(x, 940, 1460)),
        y: Math.round(clamp(y, 522, 778)),
        radius: Math.round(clamp(radius, 22, 60)),
        colorHex: cluster.colorHex,
        marketCap: cluster.marketCap,
        coinCount: cluster.coinCount,
        isSelected: selectedMarkId === cluster.id,
        ariaLabel: `${cluster.label} alt-peg cohort: ${cluster.coinCount} coins, ${formatCompactUsd(cluster.marketCap)} tracked market cap.`,
      } satisfies Lighthouse2AltPegIsland;
    }),
  };
}

function buildModules(
  activeModuleId: Lighthouse2ModuleId,
  psiColorHex: string,
  dewsColorHex: string,
): Record<Lighthouse2ModuleId, Lighthouse2Module> {
  const moduleColors: Record<Lighthouse2ModuleId, string> = {
    chains: "#38bdf8",
    psi: psiColorHex,
    dews: dewsColorHex,
    "alt-pegs": "#2dd4bf",
  };
  const labels: Record<Lighthouse2ModuleId, string> = {
    chains: "Chain harbors module. Shows the largest chain supply lanes as ships on the sea chart.",
    psi: "PSI compass module. Shows the Pharos Stability Index as a brass navigation instrument.",
    dews: "DEWS buoy field module. Shows elevated early warning stress as clockwork buoys.",
    "alt-pegs": "Alt-peg archipelago module. Shows non-USD peg cohorts as fantasy chart islands.",
  };

  return Object.fromEntries(
    (Object.keys(MODULE_LAYOUT) as Lighthouse2ModuleId[]).map((id) => {
      const layout = MODULE_LAYOUT[id];
      return [
        id,
        {
          id,
          ...layout,
          colorHex: moduleColors[id],
          isActive: id === activeModuleId,
          ariaLabel: labels[id],
        },
      ];
    }),
  ) as Record<Lighthouse2ModuleId, Lighthouse2Module>;
}

function selectedTarget({
  selectedMarkId,
  chains,
  dews,
  altPegs,
}: {
  selectedMarkId: string | null | undefined;
  chains: Lighthouse2Model["chains"];
  dews: Lighthouse2Model["dews"];
  altPegs: Lighthouse2Model["altPegs"];
}): Lighthouse2Point | null {
  if (!selectedMarkId) return null;
  const vessel = chains.vessels.find((item) => item.id === selectedMarkId);
  if (vessel) return { x: vessel.x, y: vessel.y - vessel.height * 0.85 };
  const buoy = dews.buoys.find((item) => item.id === selectedMarkId);
  if (buoy) return { x: buoy.x, y: buoy.y };
  const island = altPegs.islands.find((item) => item.id === selectedMarkId);
  if (island) return { x: island.x, y: island.y - island.radius * 0.5 };
  return null;
}

export function buildLighthouse2Model({
  chains,
  totalUsd,
  stabilityIndex,
  stressSignals,
  stablecoins,
  activeModuleId = "chains",
  selectedMarkId = null,
}: BuildLighthouse2ModelInput): Lighthouse2Model {
  const normalizedActiveModule = activeModuleId in MODULE_LAYOUT ? activeModuleId : "chains";
  const chainModel = buildChainVessels(chains, totalUsd, selectedMarkId);
  const psi = buildPsi(stabilityIndex);
  const dews = buildDews(stressSignals, selectedMarkId);
  const altPegs = buildAltPegIslands(stablecoins, selectedMarkId);
  const modules = buildModules(normalizedActiveModule, psi.colorHex, dews.highestColorHex);
  const activeModule = modules[normalizedActiveModule];
  const activeTarget = selectedTarget({ selectedMarkId, chains: chainModel, dews, altPegs }) ?? activeModule.target;

  const ledgerRows: Lighthouse2LedgerRow[] = [
    {
      id: "chains",
      label: "Chain lanes",
      value: formatCompactUsd(chainModel.totalUsd),
      detail: `${chainModel.vessels.length} largest chain harbors shown, ${chainModel.remainingCount} smaller harbors held off chart.`,
    },
    {
      id: "psi",
      label: "PSI",
      value: psi.score == null ? "Unavailable" : `${formatScore(psi.score)} ${psi.band ?? ""}`.trim(),
      detail: "The compass needle uses the current Pharos Stability Index score and band.",
    },
    {
      id: "dews",
      label: "DEWS",
      value: `${dews.elevatedCount} elevated`,
      detail: `Highest current stress band is ${dews.highestBand.toLowerCase()}.`,
    },
    {
      id: "alt-pegs",
      label: "Alt-pegs",
      value: `${altPegs.visibleCoinCount} coins`,
      detail: `${altPegs.cohortCount} non-USD peg cohorts are plotted as islands.`,
    },
  ];

  return {
    stage: {
      viewBox: LIGHTHOUSE_2_VIEWBOX,
      sceneLabel: `Pharos Lighthouse 2 sea chart with ${chainModel.vessels.length} chain lanes, PSI ${psi.score == null ? "unavailable" : formatScore(psi.score)}, ${dews.elevatedCount} elevated DEWS signals, and ${altPegs.visibleCoinCount} alt-peg coins.`,
      activeModuleId: normalizedActiveModule,
      activeTarget,
      lighthouse: { x: 790, y: 430 },
      hasCompleteData: chains.length > 0 && !!stabilityIndex && !!stressSignals && !!stablecoins,
      activeColorHex: activeModule.colorHex,
      modules,
    },
    chains: chainModel,
    psi,
    dews,
    altPegs,
    ledgerRows,
  };
}

export function lighthouse2ModuleLabel(id: Lighthouse2ModuleId): string {
  return MODULE_LABELS[id];
}
