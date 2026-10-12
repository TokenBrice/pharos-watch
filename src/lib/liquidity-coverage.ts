import { LIQUIDITY_COVERAGE_BADGE_CLASSES } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import type { DexLiquidityData, LiquidityCoverageClass, LiquiditySourceMix } from "@shared/types";

const COVERAGE_BADGES: Record<LiquidityCoverageClass, { label: string; className: string }> = {
  primary: {
    label: "Primary",
    className: LIQUIDITY_COVERAGE_BADGE_CLASSES.primary,
  },
  mixed: {
    label: "Mixed",
    className: LIQUIDITY_COVERAGE_BADGE_CLASSES.mixed,
  },
  fallback: {
    label: "Fallback",
    className: LIQUIDITY_COVERAGE_BADGE_CLASSES.fallback,
  },
  legacy: {
    label: "Legacy",
    className: LIQUIDITY_COVERAGE_BADGE_CLASSES.legacy,
  },
  unobserved: {
    label: "NR",
    className: LIQUIDITY_COVERAGE_BADGE_CLASSES.unobserved,
  },
};

const SOURCE_LABELS: Record<string, string> = {
  dl: "DeFiLlama",
  direct_api: "Direct API",
  cg_onchain: "CG Onchain",
  gecko_terminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  cg_tickers: "CG Tickers",
  horizon: "Stellar Horizon",
};

export function getLiquidityCoverageBadge(
  coverageClass: LiquidityCoverageClass | null | undefined,
  unavailableReason?: DexLiquidityData["unavailableReason"],
) {
  if (unavailableReason) {
    return { label: "Unavailable", className: COVERAGE_BADGES.unobserved.className };
  }
  return COVERAGE_BADGES[coverageClass ?? "unobserved"];
}

export function formatLiquiditySourceMix(sourceMix: LiquiditySourceMix): string {
  const entries = Object.entries(sourceMix)
    .sort((a, b) => b[1].tvlUsd - a[1].tvlUsd);
  if (entries.length === 0) return "No observed liquidity sources.";

  return entries
    .map(([source, entry]) =>
      `${SOURCE_LABELS[source] ?? source}: ${formatCurrency(entry.tvlUsd)} across ${entry.poolCount} ${entry.poolCount === 1 ? "pool" : "pools"}`
    )
    .join(" · ");
}
