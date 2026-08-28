"use client";

import { CoinEmblem, type EmblemVariant } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

export interface CohortSummary {
  coinCount: number;
  marketCap: number;
  symbolPreview: string;
}

export function summarizeCohort(coins: readonly PlacedCoin[]): CohortSummary {
  return {
    coinCount: coins.length,
    marketCap: coins.reduce((sum, coin) => sum + coin.marketCap, 0),
    symbolPreview: coins
      .slice(0, 3)
      .map((coin) => coin.symbol)
      .join(" · "),
  };
}

interface CohortCoinEmblemsProps {
  coins: readonly PlacedCoin[];
  cohortRank?: number;
  summary?: CohortSummary;
  variant: EmblemVariant | ((coin: PlacedCoin, index: number) => EmblemVariant);
  loading: "eager" | "lazy" | ((coin: PlacedCoin, index: number) => "eager" | "lazy");
  hoverCardYPlacement?: "auto" | "above" | "below";
}

export function CohortCoinEmblems({
  coins,
  cohortRank,
  summary = summarizeCohort(coins),
  variant,
  loading,
  hoverCardYPlacement,
}: CohortCoinEmblemsProps) {
  return coins.map((coin, index) => (
    <CoinEmblem
      key={coin.id}
      coin={coin}
      variant={typeof variant === "function" ? variant(coin, index) : variant}
      loading={typeof loading === "function" ? loading(coin, index) : loading}
      cohortCoinCount={summary.coinCount}
      cohortMarketCap={summary.marketCap}
      cohortSymbolPreview={summary.symbolPreview}
      cohortRank={cohortRank}
      hoverCardYPlacement={hoverCardYPlacement}
    />
  ));
}
