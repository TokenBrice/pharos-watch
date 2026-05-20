import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V1: readonly MethodologyChangelogEntry[] = [
    {
      version: "1.0",
      title: "Initial 2-source price cross-validation",
      date: "2026-02-01",
      effectiveAt: 1769904000,
      summary:
        "Launched baseline pricing with CoinGecko as primary and DefiLlama as cross-validation source. Simple comparison logic with single enrichment pass.",
      impact: [
        "CoinGecko primary prices with DefiLlama cross-validation",
        "Basic price reasonableness checks against peg references",
        "DexScreener enrichment for assets missing from aggregators",
      ],
      commits: [],
      reconstructed: true,
    },
];
