"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { PegCluster } from "@/lib/alt-peg-hero";

export function FiatEmblems({ clusters }: { clusters: readonly PegCluster[] }) {
  const allCoins = clusters.flatMap((c) => [...c.coins]);
  return (
    <div className="fiat-emblems">
      <CohortThreads coins={allCoins} colorHex="#60a5fa" />
      {clusters.map((cluster) => {
        const cohortMarketCap = cluster.coins.reduce((sum, coin) => sum + coin.marketCap, 0);
        return cluster.coins.map((coin, idx) => (
          <CoinEmblem
            key={coin.id}
            coin={coin}
            variant="fiat"
            loading={idx === 0 ? "eager" : "lazy"}
            cohortCoinCount={cluster.coins.length}
            cohortMarketCap={cohortMarketCap}
          />
        ));
      })}
    </div>
  );
}
