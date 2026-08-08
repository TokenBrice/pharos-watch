import { formatCurrency } from "@shared/lib/format";
import type { LiquidityCoverageClass, LiquiditySourceMix } from "@shared/types";

const COVERAGE_BADGES: Record<LiquidityCoverageClass, { label: string; className: string }> = {
  primary: {
    label: "Primary",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  mixed: {
    label: "Mixed",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  fallback: {
    label: "Fallback",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  legacy: {
    label: "Legacy",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
  unobserved: {
    label: "NR",
    className: "border-border/70 bg-muted text-muted-foreground",
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

export function getLiquidityCoverageBadge(coverageClass: LiquidityCoverageClass) {
  return COVERAGE_BADGES[coverageClass];
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
