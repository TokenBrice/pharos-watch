"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function MoonCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  const cohortMarketCap = cohort.coins.reduce((sum, coin) => sum + coin.marketCap, 0);
  const cohortSymbolPreview = cohort.coins
    .slice(0, 3)
    .map((coin) => coin.symbol)
    .join(" · ");
  return (
    <div className="moon-cohort" aria-label="Silver stablecoins">
      <div className="moon-cohort__halo" style={{ left: "50%", top: "42%" }} />
      <CohortThreads coins={cohort.coins} colorHex="#cbd5e1" />
      <span className="sky-region-tag" style={{ left: "50%", top: "9%" }}>
        Silver · Moon · {cohort.coins.length} {cohort.coins.length === 1 ? "coin" : "coins"}
      </span>
      {cohort.coins.map((c) => (
        <CoinEmblem
          key={c.id}
          coin={c}
          variant="moon"
          loading="eager"
          cohortCoinCount={cohort.coins.length}
          cohortMarketCap={cohortMarketCap}
          cohortSymbolPreview={cohortSymbolPreview}
          cohortRank={cohort.rank}
          hoverCardYPlacement="below"
          showTickerLabel={c.id === cohort.coins[0]?.id}
        />
      ))}
    </div>
  );
}
