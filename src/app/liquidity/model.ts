import { CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityData, DexLiquidityMap } from "@shared/types/dex-liquidity";
import type { PegCurrency } from "@shared/types/core";
import { DEX_GLOBAL_KEY } from "@shared/types/dex-liquidity";
import type { LiquidityStatsData } from "@/components/liquidity/liquidity-stats-types";
import type { LiquidityRow } from "@/components/liquidity/liquidity-table";
import { computeDepthToMcapRatio } from "@/components/liquidity/liquidity-table-logic";
import { parseDataHealthWarnings } from "@/lib/data-health";

export const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

export type LiquidityTriageFilter = "all" | "deep" | "thin" | "nr";

export const LIQUIDITY_TRIAGE_FILTERS: readonly { value: LiquidityTriageFilter; label: string }[] = [
  { value: "all", label: "All depth" },
  { value: "deep", label: "Deep liquidity" },
  { value: "thin", label: "Thin exit" },
  { value: "nr", label: "Unrated" },
];

export interface LiquidityRouteFilter {
  kind: "protocol" | "chain";
  key: string;
  label: string;
}

export interface LiquidityViewModelOptions {
  mcapById?: ReadonlyMap<string, number | null>;
  triageFilter?: LiquidityTriageFilter;
  routeFilter?: LiquidityRouteFilter | null;
  /** Top named protocol/chain keys shown on the Exit Route Map, used to match `_other-routes`. */
  routeNamedTopKeys?: ReadonlySet<string>;
}

function matchesLiquidityTriage(liq: DexLiquidityData, triage: LiquidityTriageFilter): boolean {
  if (triage === "all") return true;
  if (triage === "deep") return liq.liquidityScore != null && liq.liquidityScore >= 70;
  if (triage === "thin") return liq.liquidityScore != null && liq.liquidityScore < 40;
  return liq.liquidityScore == null;
}

function matchesExitRouteFilter(
  liq: DexLiquidityData,
  filter: LiquidityRouteFilter,
  namedTopKeys?: ReadonlySet<string>,
): boolean {
  if (filter.kind === "protocol") {
    const entries = Object.entries(liq.protocolTvl ?? {});
    if (filter.key === "_other-routes") {
      return entries.some(([key, value]) => value > 0 && !(namedTopKeys?.has(key) ?? false));
    }
    return (liq.protocolTvl?.[filter.key] ?? 0) > 0;
  }
  const entries = Object.entries(liq.chainTvl ?? {});
  const target = filter.key.toLowerCase();
  if (filter.key === "_other-routes") {
    return entries.some(([key, value]) => value > 0 && !(namedTopKeys?.has(key.toLowerCase()) ?? false));
  }
  return entries.some(([key, value]) => key.toLowerCase() === target && value > 0);
}

function computeRawMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Number.isFinite(raw) ? raw : null;
}

function computeMedian(values: readonly number[]): number | null {
  const raw = computeRawMedian(values);
  return raw != null ? Math.round(raw * 10) / 10 : null;
}

export interface LiquidityViewModel {
  rows: LiquidityRow[];
  /** Rated rows plus observed NR rows; the table sorts the NR rows last. */
  leaderboardRows: LiquidityRow[];
  /** Admitted tracked coins with no observed DEX market (the compact fold). */
  unobservedRows: LiquidityRow[];
  /** Quarantined or unclassified evidence; raw depth is not admitted liquidity. */
  unavailableRows: LiquidityRow[];
  summaryStats: LiquidityStatsData | null;
}

function isUnavailableDexEvidence(liq: DexLiquidityData): boolean {
  return liq.unavailableReason != null ||
    liq.liquidityScoreUnavailableReason === "invalid-coverage-evidence" ||
    liq.coverageClass == null || liq.liquidityEvidenceClass == null;
}

/**
 * A retained DEX market with classified evidence. Rated or NR, it counts as
 * observed: an NR score is a missing activity reading, not a missing market.
 */
function isObservedOnDex(liq: DexLiquidityData): boolean {
  return !isUnavailableDexEvidence(liq) && liq.poolCount > 0 && liq.totalTvlUsd > 0 &&
    liq.coverageClass != null && liq.coverageClass !== "unobserved" &&
    liq.liquidityEvidenceClass != null && liq.liquidityEvidenceClass !== "unobserved";
}

const WARNING_DETAIL_SUFFIX = /\s*\([^()]*\)\s*$/;
const DRIFT_WARNING_PATTERN = /^Latest sync-dex-liquidity run shows (?:medium|high) quality drift$/;

export function formatLiquidityWarningMessage(warning: string): string {
  return parseDataHealthWarnings(warning)
    .map(({ message }) => {
      // Keep liquidity's existing concise copy; transport and reason details
      // remain in metadata rather than leaking HTTP punctuation into the chip.
      const summary = message.replace(WARNING_DETAIL_SUFFIX, "").trim();
      return DRIFT_WARNING_PATTERN.test(summary) ? "Some liquidity data is being re-verified" : summary;
    })
    .join(" ");
}

function computeLiquidityStats(
  liquidityMap: DexLiquidityMap,
  allRows: LiquidityRow[],
): LiquidityStatsData {
  const globalData = liquidityMap[DEX_GLOBAL_KEY];
  // A quarantined global row publishes no depth; its reason travels with the null.
  const totalTvlUnavailableReason = globalData == null ? "global-row-missing" : globalData.unavailableReason ?? null;
  const totalTvl = totalTvlUnavailableReason == null ? globalData.totalTvlUsd : null;
  // Unavailable global volume stays null; it is never rendered as zero activity.
  // A quarantined global row withholds its volume together with its depth.
  const totalVol = totalTvlUnavailableReason == null ? globalData.totalVolume24hUsd : null;
  let ratedCount = 0;
  let nrObservedCount = 0;
  let withLiquidity = 0;
  let highConfidenceCoverage = 0;
  let fallbackCoverage = 0;
  let tvlForChange = 0;
  let totalPrevTvl = 0;
  let hasNonInvertibleBaseline = false;
  let totalBalance = 0;
  let balanceWeight = 0;
  let totalOrganic = 0;
  let organicWeight = 0;
  const change7dValues: number[] = [];
  let depthRatioMcapSum = 0;
  let aggDepthToMcapObservedCount = 0;
  const depthToMcapValues: number[] = [];

  for (const { liq, mcapUsd } of allRows) {
    if (isUnavailableDexEvidence(liq)) continue;
    if (liq.liquidityScore != null) ratedCount++;
    // Retained markets remain covered when required activity makes the score NR.
    if (isObservedOnDex(liq)) {
      withLiquidity++;
      if (liq.liquidityScore == null) nrObservedCount++;
      if (liq.coverageClass === "primary" || liq.coverageClass === "mixed") highConfidenceCoverage++;
      if (liq.coverageClass === "fallback") fallbackCoverage++;
      const coinDepthRatio = computeDepthToMcapRatio(liq.totalTvlUsd, mcapUsd);
      if (coinDepthRatio != null && mcapUsd != null) {
        depthRatioMcapSum += mcapUsd;
        aggDepthToMcapObservedCount++;
        depthToMcapValues.push(coinDepthRatio);
      }
    }
    if (liq.tvlChange7d != null && Number.isFinite(liq.tvlChange7d) && liq.totalTvlUsd > 0) {
      change7dValues.push(liq.tvlChange7d);
      // A published -100.00% (any >99.996% collapse) has no invertible prior
      // value; adding Infinity would turn the whole aggregate into NaN.
      const denominator = 1 + liq.tvlChange7d / 100;
      const prevTvl = denominator > 0 ? liq.totalTvlUsd / denominator : null;
      if (prevTvl != null && Number.isFinite(prevTvl)) {
        tvlForChange += liq.totalTvlUsd;
        totalPrevTvl += prevTvl;
      } else {
        // Publishing the aggregate over the surviving members would claim a
        // market move the observed collapse contradicts.
        hasNonInvertibleBaseline = true;
      }
    }
    if (liq.weightedBalanceRatio != null && liq.balanceMeasuredTvlUsd != null) {
      const measuredTvl = liq.balanceMeasuredTvlUsd;
      totalBalance += liq.weightedBalanceRatio * measuredTvl;
      balanceWeight += measuredTvl;
    }
    if (liq.organicFraction != null && liq.organicMeasuredTvlUsd != null) {
      const measuredTvl = liq.organicMeasuredTvlUsd;
      totalOrganic += liq.organicFraction * measuredTvl;
      organicWeight += measuredTvl;
    }
  }

  const publishedGlobal7d =
    totalTvlUnavailableReason == null && globalData.tvlChange7d != null && Number.isFinite(globalData.tvlChange7d)
      ? globalData.tvlChange7d
      : null;
  const weighted7d =
    !hasNonInvertibleBaseline && totalPrevTvl > 0
      ? ((tvlForChange - totalPrevTvl) / totalPrevTvl) * 100
      : null;
  const rawAgg7dChange = publishedGlobal7d ?? weighted7d;
  const agg7dChangeBasis =
    publishedGlobal7d != null ? "global" as const : weighted7d != null ? "weighted" as const : null;
  const median7dChange = computeMedian(change7dValues);
  // Per-coin totalTvlUsd is gross (multi-stablecoin pools count full pool TVL in every
  // constituent coin), while globalData.totalTvlUsd is cross-coin deduped. Publish the
  // aggregate ratio only from deduped global TVL when every observed DEX coin has positive
  // supply so numerator and denominator share the exact same cohort (R7). Otherwise fall
  // back to the per-coin median, which never double-counts shared pools across coins.
  const aggDepthToMcapRatio =
    totalTvl != null &&
    withLiquidity > 0 &&
    aggDepthToMcapObservedCount === withLiquidity &&
    depthRatioMcapSum > 0 &&
    Number.isFinite(totalTvl / depthRatioMcapSum)
      ? totalTvl / depthRatioMcapSum
      : null;
  const medianDepthToMcapRatio = computeRawMedian(depthToMcapValues);

  return {
    totalTvl,
    totalVol,
    ...(totalTvlUnavailableReason == null && globalData.volume24hAvailability
      ? { totalVolAvailability: globalData.volume24hAvailability }
      : {}),
    totalTvlUnavailableReason,
    ratedCount,
    nrObservedCount,
    withLiquidity,
    highConfidenceCoverage,
    fallbackCoverage,
    totalTracked: ACTIVE_STABLECOINS.length,
    agg7dChange: rawAgg7dChange != null && Number.isFinite(rawAgg7dChange) ? Math.round(rawAgg7dChange * 10) / 10 : null,
    agg7dChangeBasis,
    median7dChange,
    change7dCoinCount: change7dValues.length,
    aggDepthToMcapRatio,
    medianDepthToMcapRatio,
    aggDepthToMcapObservedCount,
    avgBalance: balanceWeight > 0 ? Math.round((totalBalance / balanceWeight) * 100) : null,
    avgOrganic: organicWeight > 0 ? Math.round((totalOrganic / organicWeight) * 100) : null,
  };
}

export function buildLiquidityViewModel(
  liquidityMap: DexLiquidityMap | undefined,
  pegFilter: PegCurrency | "all",
  searchQuery: string,
  options?: LiquidityViewModelOptions,
): LiquidityViewModel {
  if (!liquidityMap) {
    return { rows: [], leaderboardRows: [], unobservedRows: [], unavailableRows: [], summaryStats: null };
  }
  const mcapById = options?.mcapById;
  const triageFilter = options?.triageFilter ?? "all";
  const routeFilter = options?.routeFilter ?? null;
  const routeNamedTopKeys = options?.routeNamedTopKeys;
  // Single pass: build all rows, then filter for display.
  const q = searchQuery.toLowerCase().trim();
  const allRows: LiquidityRow[] = ACTIVE_STABLECOINS
    .flatMap((meta) => {
      const liq = liquidityMap[meta.id];
      if (liq == null) return [];
      return [{ meta, liq, mcapUsd: mcapById?.get(meta.id) ?? null }];
    });
  const rows = allRows.filter(({ meta }) => {
    if (pegFilter !== "all" && meta.flags.pegCurrency !== pegFilter) return false;
    return !q || meta.name.toLowerCase().includes(q) || meta.symbol.toLowerCase().includes(q);
  });
  const leaderboardRows = rows.filter(({ liq }) => {
    if (isUnavailableDexEvidence(liq) || (liq.liquidityScore == null && !isObservedOnDex(liq))) return false;
    if (!matchesLiquidityTriage(liq, triageFilter)) return false;
    if (routeFilter && !matchesExitRouteFilter(liq, routeFilter, routeNamedTopKeys)) return false;
    return true;
  });
  return {
    rows,
    leaderboardRows,
    unobservedRows: rows.filter(({ liq }) => !isUnavailableDexEvidence(liq) && liq.liquidityScore == null && !isObservedOnDex(liq)),
    unavailableRows: rows.filter(({ liq }) => isUnavailableDexEvidence(liq)),
    summaryStats: computeLiquidityStats(liquidityMap, allRows),
  };
}
