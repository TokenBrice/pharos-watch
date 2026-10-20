import { CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityData, DexLiquidityMap, PegCurrency } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types/market";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import type { LiquidityRow } from "@/components/liquidity-table";
import { parseDataHealthWarnings } from "@/lib/data-health";

export const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

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
export function isObservedOnDex(liq: DexLiquidityData): boolean {
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
  let totalBalance = 0;
  let balanceWeight = 0;
  let totalOrganic = 0;
  let organicWeight = 0;

  for (const { liq } of allRows) {
    if (isUnavailableDexEvidence(liq)) continue;
    if (liq.liquidityScore != null) ratedCount++;
    // Retained markets remain covered when required activity makes the score NR.
    if (isObservedOnDex(liq)) {
      withLiquidity++;
      if (liq.liquidityScore == null) nrObservedCount++;
      if (liq.coverageClass === "primary" || liq.coverageClass === "mixed") highConfidenceCoverage++;
      if (liq.coverageClass === "fallback") fallbackCoverage++;
    }
    if (liq.tvlChange7d != null && liq.totalTvlUsd > 0) {
      const prevTvl = liq.totalTvlUsd / (1 + liq.tvlChange7d / 100);
      tvlForChange += liq.totalTvlUsd;
      totalPrevTvl += prevTvl;
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

  const agg7dChange = totalPrevTvl > 0 ? ((tvlForChange - totalPrevTvl) / totalPrevTvl) * 100 : null;

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
    agg7dChange: agg7dChange != null ? Math.round(agg7dChange * 10) / 10 : null,
    avgBalance: balanceWeight > 0 ? Math.round((totalBalance / balanceWeight) * 100) : null,
    avgOrganic: organicWeight > 0 ? Math.round((totalOrganic / organicWeight) * 100) : null,
  };
}

export function buildLiquidityViewModel(
  liquidityMap: DexLiquidityMap | undefined,
  pegFilter: PegCurrency | "all",
  searchQuery: string,
): LiquidityViewModel {
  if (!liquidityMap) {
    return { rows: [], leaderboardRows: [], unobservedRows: [], unavailableRows: [], summaryStats: null };
  }
  // Single pass: build all rows, then filter for display.
  const q = searchQuery.toLowerCase().trim();
  const allRows = ACTIVE_STABLECOINS
    .map((meta) => ({ meta, liq: liquidityMap[meta.id] }))
    .filter((row): row is LiquidityRow => row.liq != null);
  const rows = allRows.filter(({ meta }) => {
    if (pegFilter !== "all" && meta.flags.pegCurrency !== pegFilter) return false;
    return !q || meta.name.toLowerCase().includes(q) || meta.symbol.toLowerCase().includes(q);
  });
  return {
    rows,
    leaderboardRows: rows.filter(({ liq }) => !isUnavailableDexEvidence(liq) && (liq.liquidityScore != null || isObservedOnDex(liq))),
    unobservedRows: rows.filter(({ liq }) => !isUnavailableDexEvidence(liq) && liq.liquidityScore == null && !isObservedOnDex(liq)),
    unavailableRows: rows.filter(({ liq }) => isUnavailableDexEvidence(liq)),
    summaryStats: computeLiquidityStats(liquidityMap, allRows),
  };
}
