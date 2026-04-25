import { THREAT_BAND_HEX, isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { formatCompactUsd, formatPercent, formatScore, formatSignedPercent } from "@shared/lib/format";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import type { ChainSummary, HealthBand, StablecoinData, StressSignalsAllResponse } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { HEALTH_HEX_FILL } from "@/lib/chain-ui";
import { highestBand, sweepDuration } from "@/lib/dews-radar-utils";
import { buildPegDiversityHero, type PegCluster, type SkyCohort } from "@/lib/alt-peg-hero";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SKY_COHORT_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { buildChainHarborEntries } from "../chains/harbor-map";
import { aggregateSkyBand, cargoCapacityForHull, depthLayers, hullWidth, wakeLength } from "../chains/nautical-scene-math";
import { computeBandCounts, computePositions, CX as DEWS_CX, CY as DEWS_CY } from "@/components/dews-summary-model";

export type LighthouseMode = "watch" | "radar" | "atlas";

export const LIGHTHOUSE_STAGE_VIEWBOX = { width: 1440, height: 900 } as const;
export const LIGHTHOUSE_VISIBLE_HARBORS = 8;

const STAGE_CENTER_X = 720;
const STAGE_WATERLINE_Y = 635;
const HARBOR_ORBIT_CENTER_Y = 672;
const HARBOR_ORBIT_RX = 520;
const HARBOR_ORBIT_RY = 172;
const HARBOR_START_DEG = 205;
const HARBOR_END_DEG = 335;
const NEUTRAL_HEX = "#64748b";
const NEUTRAL_LENS_HEX = "#f8d77a";

export interface LighthousePoint {
  x: number;
  y: number;
}

export interface LighthouseHarborMark {
  id: string;
  name: string;
  logoPath: string;
  x: number;
  y: number;
  rank: number;
  totalUsd: number;
  sharePct: number;
  healthBand: HealthBand | null;
  healthColorHex: string;
  dominantSymbol: string;
  dominantSharePct: number;
  stablecoinCount: number;
  cargoCount: number;
  hullWidth: number;
  hullHeight: number;
  mastHeight: number;
  pennantWidth: number;
  draftLayers: 1 | 2 | 3;
  wakeDirection: -1 | 0 | 1;
  wakeLength: number;
  target: LighthousePoint;
  isSelected: boolean;
  ariaLabel: string;
}

export interface LighthouseTailMark {
  remainingCount: number;
  remainingUsd: number;
  remainingSharePct: number;
  lights: LighthousePoint[];
  ariaLabel: string;
}

export interface LighthouseDewsMark {
  id: string;
  symbol: string;
  name: string;
  score: number;
  band: Exclude<ThreatBand, "CALM">;
  colorHex: string;
  x: number;
  y: number;
  radius: number;
}

export interface LighthousePegCoinMark {
  id: string;
  symbol: string;
  name: string;
  x: number;
  y: number;
  sizePx: number;
  colorHex: string;
  href: string;
}

export interface LighthousePegCluster {
  peg: string;
  colorHex: string;
  anchor: LighthousePoint;
  coins: LighthousePegCoinMark[];
}

export interface LighthousePegCohort {
  kind: "sun" | "moon" | "constellation";
  label: string;
  href: string;
  coins: LighthousePegCoinMark[];
}

export interface LighthouseLedgerRow {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface LighthouseCinematicModel {
  stage: {
    viewBox: typeof LIGHTHOUSE_STAGE_VIEWBOX;
    sceneLabel: string;
    mode: LighthouseMode;
    selectedHarborId: string | null;
    activeTarget: LighthousePoint | null;
    hasCompleteData: boolean;
    lighthouse: LighthousePoint;
    waterlineY: number;
  };
  lens: {
    score: number | null;
    band: string | null;
    colorHex: string;
    beamReachPct: number;
    beamOpacity: number;
    sweepDurationSec: number;
  };
  harbors: {
    visible: LighthouseHarborMark[];
    tail: LighthouseTailMark | null;
    fogBand: "sun" | "fog";
    largestId: string | null;
  };
  radar: {
    highestBand: ThreatBand;
    highestColorHex: string;
    sweepDurationSec: number;
    bandCounts: Record<ThreatBand, number>;
    elevated: LighthouseDewsMark[];
    calmDensity: number;
  };
  altPeg: {
    clusters: LighthousePegCluster[];
    skyCohorts: LighthousePegCohort[];
    visibleCoinCount: number;
  };
  fallbackRows: LighthouseLedgerRow[];
}

export interface BuildLighthouseCinematicModelInput {
  chains: readonly ChainSummary[];
  totalUsd: number;
  stabilityIndex: StabilityIndexCurrent | null | undefined;
  stressSignals: StressSignalsAllResponse | null | undefined;
  stablecoins: readonly StablecoinData[] | undefined;
  selectedHarborId: string | null;
  mode?: LighthouseMode;
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

function healthColorHex(band: HealthBand | null): string {
  return band && band in HEALTH_HEX_FILL ? HEALTH_HEX_FILL[band] : NEUTRAL_HEX;
}

function sanitizeChain(chain: ChainSummary): ChainSummary {
  const dominantShare = clamp(chain.dominantStablecoin?.share ?? 0, 0, 1);
  return {
    ...chain,
    totalUsd: Math.max(0, finiteNumber(chain.totalUsd)),
    change24h: finiteNumber(chain.change24h),
    change24hPct: finiteNumber(chain.change24hPct),
    change7d: finiteNumber(chain.change7d),
    change7dPct: finiteNumber(chain.change7dPct),
    change30d: finiteNumber(chain.change30d),
    change30dPct: finiteNumber(chain.change30dPct),
    stablecoinCount: Math.max(0, Math.round(finiteNumber(chain.stablecoinCount))),
    dominantStablecoin: {
      id: chain.dominantStablecoin?.id ?? `${chain.id}-dominant`,
      symbol: chain.dominantStablecoin?.symbol ?? "UNK",
      share: dominantShare,
    },
    dominanceShare: clamp(chain.dominanceShare, 0, 1),
    topStablecoins: chain.topStablecoins?.map((coin) => ({
      ...coin,
      share: clamp(coin.share, 0, 1),
      supplyUsd: Math.max(0, finiteNumber(coin.supplyUsd)),
    })),
  };
}

function harborPoint(index: number, count: number): LighthousePoint {
  const span = Math.max(1, count - 1);
  const angleDeg = count <= 1 ? 270 : HARBOR_START_DEG + ((HARBOR_END_DEG - HARBOR_START_DEG) * index) / span;
  const angle = (angleDeg * Math.PI) / 180;
  return {
    x: Math.round(STAGE_CENTER_X + HARBOR_ORBIT_RX * Math.cos(angle)),
    y: Math.round(HARBOR_ORBIT_CENTER_Y + HARBOR_ORBIT_RY * Math.sin(angle)),
  };
}

function buildHarborMarks(
  chains: readonly ChainSummary[],
  totalUsd: number,
  selectedHarborId: string | null,
): {
  visible: LighthouseHarborMark[];
  tail: LighthouseTailMark | null;
  fogBand: "sun" | "fog";
  largestId: string | null;
  selectedId: string | null;
} {
  const sanitized = chains.map(sanitizeChain);
  const globalTotal = Math.max(0, finiteNumber(totalUsd));
  const entries = buildChainHarborEntries([...sanitized], globalTotal);
  const visibleEntries = entries.slice(0, LIGHTHOUSE_VISIBLE_HARBORS);
  const maxUsd = visibleEntries.reduce((max, entry) => Math.max(max, finiteNumber(entry.totalUsd)), 0);
  const selectedId = visibleEntries.some((entry) => entry.id === selectedHarborId)
    ? selectedHarborId
    : (visibleEntries[0]?.id ?? null);

  const visible = visibleEntries.map((entry, index) => {
    const point = harborPoint(index, visibleEntries.length);
    const hullW = hullWidth(finiteNumber(entry.totalUsd), maxUsd, 228);
    const cargoCount = Math.max(1, Math.min(5, cargoCapacityForHull(hullW)));
    const dominantSharePct = clamp(entry.dominantSharePct, 0, 100);
    const wake = wakeLength(finiteNumber(entry.change7dPct));
    const isSelected = entry.id === selectedId;
    const color = healthColorHex(entry.healthBand);
    const target = { x: point.x, y: point.y - 118 - Math.min(52, hullW * 0.12) };

    return {
      id: entry.id,
      name: entry.name,
      logoPath: entry.logoPath,
      x: point.x,
      y: point.y,
      rank: index + 1,
      totalUsd: finiteNumber(entry.totalUsd),
      sharePct: clamp(entry.sharePct, 0, 100),
      healthBand: entry.healthBand,
      healthColorHex: color,
      dominantSymbol: entry.dominantSymbol,
      dominantSharePct,
      stablecoinCount: Math.max(0, Math.round(finiteNumber(entry.stablecoinCount))),
      cargoCount,
      hullWidth: hullW,
      hullHeight: Math.round(22 + hullW * 0.15),
      mastHeight: Math.round(78 + hullW * 0.18),
      pennantWidth: Math.round(18 + (dominantSharePct / 100) * 58),
      draftLayers: depthLayers(dominantSharePct / 100),
      wakeDirection: (wake > 0 ? 1 : wake < 0 ? -1 : 0) as -1 | 0 | 1,
      wakeLength: wake,
      target,
      isSelected,
      ariaLabel: `${entry.name} harbor, ${formatCompactUsd(entry.totalUsd)} supply, ${formatPercent(entry.sharePct, 1)} tracked share, ${entry.healthBand ?? "unrated"} health, dominant cargo ${entry.dominantSymbol} ${formatPercent(dominantSharePct, 1)}, ${formatSignedPercent(entry.change7dPct * 100, 1)} seven day wake`,
    };
  });

  const tailEntries = entries.slice(LIGHTHOUSE_VISIBLE_HARBORS);
  const remainingUsd = tailEntries.reduce((sum, entry) => sum + finiteNumber(entry.totalUsd), 0);
  const tailLights = tailEntries.slice(0, 18).map((entry, index) => ({
    x: 210 + index * 58,
    y: 426 + ((entry.id.length + index) % 4) * 9,
  }));

  return {
    visible,
    tail: tailEntries.length > 0
      ? {
          remainingCount: tailEntries.length,
          remainingUsd,
          remainingSharePct: globalTotal > 0 ? remainingUsd / globalTotal : 0,
          lights: tailLights,
          ariaLabel: `${tailEntries.length} additional chain harbors, ${formatCompactUsd(remainingUsd)} supply`,
        }
      : null,
    fogBand: aggregateSkyBand(entries),
    largestId: visibleEntries[0]?.id ?? null,
    selectedId,
  };
}

function buildLens(stabilityIndex: StabilityIndexCurrent | null | undefined): LighthouseCinematicModel["lens"] {
  const score = stabilityIndex ? clamp(stabilityIndex.score, 0, 100) : null;
  const band = stabilityIndex?.band ?? null;
  const bandColor = isConditionBand(band) ? PSI_HEX_COLORS[band] : NEUTRAL_LENS_HEX;
  const scoreRatio = score == null ? 0.58 : score / 100;
  return {
    score,
    band,
    colorHex: bandColor,
    beamReachPct: 42 + scoreRatio * 52,
    beamOpacity: 0.24 + scoreRatio * 0.5,
    sweepDurationSec: 10.5,
  };
}

function sanitizeStressSignals(stressSignals: StressSignalsAllResponse | null | undefined): Record<string, { score: number; band: string }> {
  const result: Record<string, { score: number; band: string }> = {};
  for (const [id, entry] of Object.entries(stressSignals?.signals ?? {})) {
    if (!isThreatBand(entry.band)) continue;
    const score = finiteNumber(entry.score);
    result[id] = { score: clamp(score, 0, 100), band: entry.band };
  }
  return result;
}

function buildRadar(stressSignals: StressSignalsAllResponse | null | undefined): LighthouseCinematicModel["radar"] {
  const sanitized = sanitizeStressSignals(stressSignals);
  const elevated = computePositions(sanitized, undefined).map((coin) => {
    const scale = 0.72;
    return {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      score: coin.score,
      band: coin.band,
      colorHex: THREAT_BAND_HEX[coin.band],
      x: Math.round(STAGE_CENTER_X + (coin.x - DEWS_CX) * scale),
      y: Math.round(318 + (coin.y - DEWS_CY) * scale),
      radius: coin.band === "DANGER" ? 10 : coin.band === "WARNING" ? 8 : 6,
    };
  });
  const counts = computeBandCounts(sanitized);
  const highest = highestBand(elevated.map((coin) => coin.band));
  const total = Object.keys(sanitized).length;
  const calmDensity = total > 0 ? counts.CALM / total : 0;

  return {
    highestBand: highest,
    highestColorHex: THREAT_BAND_HEX[highest],
    sweepDurationSec: sweepDuration(highest),
    bandCounts: counts,
    elevated,
    calmDensity,
  };
}

function mapPegCoin(coin: PegCluster["coins"][number], colorHex: string, bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): LighthousePegCoinMark {
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    x: Math.round(bounds.x + (coin.x / 100) * bounds.width),
    y: Math.round(bounds.y + (coin.y / 100) * bounds.height),
    sizePx: coinEmblemSize(coin.marketCap, { ceil: FIAT_MAP_SIZE_CEIL }),
    colorHex,
    href: coin.href,
  };
}

function mapSkyCoin(coin: SkyCohort["coins"][number], colorHex: string, bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): LighthousePegCoinMark {
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    x: Math.round(bounds.x + (coin.x / 100) * bounds.width),
    y: Math.round(bounds.y + (coin.y / 100) * bounds.height),
    sizePx: coinEmblemSize(coin.marketCap, { ceil: SKY_COHORT_SIZE_CEIL }),
    colorHex,
    href: coin.href,
  };
}

function buildAltPeg(stablecoins: readonly StablecoinData[] | undefined): LighthouseCinematicModel["altPeg"] {
  const hero = buildPegDiversityHero(stablecoins);
  const mapBounds = { x: 180, y: 158, width: 1080, height: 242 };
  const skyBounds = { x: 218, y: 78, width: 1004, height: 176 };
  const clusters = hero.pegClusters.slice(0, 12).map((cluster) => ({
    peg: cluster.peg,
    colorHex: cluster.colorHex,
    anchor: {
      x: Math.round(mapBounds.x + (cluster.anchor.x / 100) * mapBounds.width),
      y: Math.round(mapBounds.y + (cluster.anchor.y / 100) * mapBounds.height),
    },
    coins: cluster.coins.slice(0, 4).map((coin) => mapPegCoin(coin, cluster.colorHex, mapBounds)),
  }));
  const skyCohorts = hero.skyCohorts.map((cohort) => {
    const colorHex = cohort.coins[0]?.pegCurrency === "SILVER"
      ? "#94a3b8"
      : cohort.coins[0]?.pegCurrency === "GOLD"
        ? "#f8c14a"
        : "#8b5cf6";
    return {
      kind: cohort.kind,
      label: cohort.label,
      href: cohort.href,
      coins: cohort.coins.slice(0, 5).map((coin) => mapSkyCoin(coin, colorHex, skyBounds)),
    };
  });
  const visibleCoinCount =
    clusters.reduce((sum, cluster) => sum + cluster.coins.length, 0) +
    skyCohorts.reduce((sum, cohort) => sum + cohort.coins.length, 0);

  return { clusters, skyCohorts, visibleCoinCount };
}

function buildFallbackRows({
  selected,
  lens,
  radar,
  altPeg,
}: {
  selected: LighthouseHarborMark | null;
  lens: LighthouseCinematicModel["lens"];
  radar: LighthouseCinematicModel["radar"];
  altPeg: LighthouseCinematicModel["altPeg"];
}): LighthouseLedgerRow[] {
  return [
    {
      id: "selected-harbor",
      label: "Selected Harbor",
      value: selected?.name ?? "No harbor selected",
      detail: selected
        ? `${formatCompactUsd(selected.totalUsd)} supply, ${selected.healthBand ?? "unrated"} health, ${selected.dominantSymbol} ${formatPercent(selected.dominantSharePct, 1)} dominant cargo`
        : "No chain harbor is selected.",
    },
    {
      id: "lens",
      label: "PSI Lens",
      value: lens.score == null || !lens.band ? "Unavailable" : `${lens.band} ${formatScore(lens.score)}`,
      detail: "PSI controls beam reach and lens brightness; it is not a new lighthouse score.",
    },
    {
      id: "dews",
      label: "DEWS Radar",
      value: radar.highestBand,
      detail: `${radar.bandCounts.DANGER} danger, ${radar.bandCounts.WARNING} warning, ${radar.bandCounts.ALERT} alert, ${radar.bandCounts.WATCH} watch.`,
    },
    {
      id: "alt-pegs",
      label: "Alt-Peg Projection",
      value: `${altPeg.visibleCoinCount} visible marks`,
      detail: "Non-USD peg marks use existing alt-peg market-cap sizing and peg colors.",
    },
  ];
}

export function buildLighthouseCinematicModel({
  chains,
  totalUsd,
  stabilityIndex,
  stressSignals,
  stablecoins,
  selectedHarborId,
  mode = "watch",
}: BuildLighthouseCinematicModelInput): LighthouseCinematicModel {
  const lens = buildLens(stabilityIndex);
  const harbors = buildHarborMarks(chains, totalUsd, selectedHarborId);
  const radar = buildRadar(stressSignals);
  const altPeg = buildAltPeg(stablecoins);
  const selected = harbors.visible.find((harbor) => harbor.id === harbors.selectedId) ?? null;
  const sceneLabel = [
    `Pharos Lighthouse cinematic watch`,
    `${harbors.visible.length} visible chain harbors`,
    harbors.largestId ? `largest ${harbors.visible[0]?.name ?? harbors.largestId}` : "no chain harbors",
    lens.score == null || !lens.band ? "PSI unavailable" : `PSI ${lens.band} ${formatScore(lens.score)}`,
    `DEWS highest ${radar.highestBand}`,
    `${altPeg.visibleCoinCount} alt-peg projection marks`,
  ].join(", ");

  return {
    stage: {
      viewBox: LIGHTHOUSE_STAGE_VIEWBOX,
      sceneLabel,
      mode,
      selectedHarborId: harbors.selectedId,
      activeTarget: selected?.target ?? null,
      hasCompleteData: harbors.visible.length > 0 && lens.score != null && Object.keys(radar.bandCounts).length > 0,
      lighthouse: { x: STAGE_CENTER_X, y: 585 },
      waterlineY: STAGE_WATERLINE_Y,
    },
    lens,
    harbors: {
      visible: harbors.visible,
      tail: harbors.tail,
      fogBand: harbors.fogBand,
      largestId: harbors.largestId,
    },
    radar,
    altPeg,
    fallbackRows: buildFallbackRows({ selected, lens, radar, altPeg }),
  };
}
