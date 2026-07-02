import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityMap, PegCurrency } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types/market";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import type { LiquidityRow } from "@/components/liquidity-table";

export const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

export interface LiquidityViewModel {
  rows: LiquidityRow[];
  scoredRows: LiquidityRow[];
  unratedRows: LiquidityRow[];
  summaryStats: LiquidityStatsData | null;
}

export function normalizePegFilter(value: string): PegCurrency | "all" {
  return value === "all" || value in PEG_LABELS_SHORT ? (value as PegCurrency | "all") : "all";
}

export function formatLiquidityWarningMessage(warning: string): string {
  try {
    return warning
      .split(/,\s*(?=\d{3}\s+-)/)
      .map((entry) => entry.match(/"(.+)"/)?.[1] ?? entry.trim())
      .join(" ");
  } catch {
    return warning;
  }
}

function computeLiquidityStats(
  liquidityMap: DexLiquidityMap,
  allRows: LiquidityRow[],
): LiquidityStatsData {
  const globalData = liquidityMap[DEX_GLOBAL_KEY];
  const totalTvl = globalData?.totalTvlUsd ?? 0;
  const totalVol = globalData?.totalVolume24hUsd ?? 0;
  let scoreSum = 0;
  let scoreCount = 0;
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
    if (liq.liquidityScore != null) {
      scoreSum += liq.liquidityScore;
      scoreCount++;
      withLiquidity++;
      if (liq.coverageClass === "primary" || liq.coverageClass === "mixed") highConfidenceCoverage++;
      if (liq.coverageClass === "fallback") fallbackCoverage++;
    }
    if (liq.tvlChange7d != null && liq.totalTvlUsd > 0) {
      const prevTvl = liq.totalTvlUsd / (1 + liq.tvlChange7d / 100);
      tvlForChange += liq.totalTvlUsd;
      totalPrevTvl += prevTvl;
    }
    if (liq.weightedBalanceRatio != null) {
      const measuredTvl = liq.balanceMeasuredTvlUsd;
      totalBalance += liq.weightedBalanceRatio * measuredTvl;
      balanceWeight += measuredTvl;
    }
    if (liq.organicFraction != null) {
      const measuredTvl = liq.organicMeasuredTvlUsd;
      totalOrganic += liq.organicFraction * measuredTvl;
      organicWeight += measuredTvl;
    }
  }

  const agg7dChange = totalPrevTvl > 0 ? ((tvlForChange - totalPrevTvl) / totalPrevTvl) * 100 : null;

  return {
    totalTvl,
    totalVol,
    avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
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
    return { rows: [], scoredRows: [], unratedRows: [], summaryStats: null };
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
    scoredRows: rows.filter((row) => row.liq.liquidityScore != null),
    unratedRows: rows.filter((row) => row.liq.liquidityScore == null),
    summaryStats: computeLiquidityStats(liquidityMap, allRows),
  };
}
