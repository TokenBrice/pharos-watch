"use client";

import { useCallback, useMemo, type CSSProperties } from "react";
import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PegCluster, PlacedCoin } from "@/lib/alt-peg-hero";

type HitTargetStyle = CSSProperties & { "--hit-z": number };

function hitTargetSizePx(coin: PlacedCoin): number {
  return Math.max(20, Math.min(32, Math.round(coin.sizePx * 0.55)));
}

function CoinHitTarget({ coin }: { coin: PlacedCoin }) {
  const { setHoveredCoin } = useHoverState();
  const target = useMemo(() => ({ id: coin.id, pegCurrency: coin.pegCurrency }), [coin.id, coin.pegCurrency]);
  const onEnter = useCallback(() => setHoveredCoin(target), [setHoveredCoin, target]);
  const onLeave = useCallback(() => setHoveredCoin(null), [setHoveredCoin]);
  const sizePx = hitTargetSizePx(coin);
  const style: HitTargetStyle = {
    left: `${coin.x}%`,
    top: `${coin.y}%`,
    width: `${sizePx}px`,
    height: `${sizePx}px`,
    "--hit-z": Math.max(40, 70 - Math.round(coin.sizePx / 2)),
  };

  return (
    <a
      href={coin.href}
      aria-hidden="true"
      tabIndex={-1}
      className="coin-emblem-hit-target"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-hit-coin-id={coin.id}
    />
  );
}

export function FiatEmblems({ clusters }: { clusters: readonly PegCluster[] }) {
  const allCoins = clusters.flatMap((c) => [...c.coins]);
  return (
    <div className="fiat-emblems">
      <CohortThreads coins={allCoins} colorHex="#60a5fa" />
      {clusters.map((cluster) => {
        const cohortMarketCap = cluster.coins.reduce((sum, coin) => sum + coin.marketCap, 0);
        const rankedCoins = [...cluster.coins].sort((left, right) => right.marketCap - left.marketCap);
        const leaderId = rankedCoins[0]?.id;
        const cohortSymbolPreview = rankedCoins
          .slice(0, 3)
          .map((coin) => coin.symbol)
          .join(" · ");
        return cluster.coins.map((coin, idx) => (
          <CoinEmblem
            key={coin.id}
            coin={coin}
            variant="fiat"
            loading={idx === 0 ? "eager" : "lazy"}
            cohortCoinCount={cluster.coins.length}
            cohortMarketCap={cohortMarketCap}
            cohortSymbolPreview={cohortSymbolPreview}
            cohortRank={cluster.rank}
            showTickerLabel={coin.id === leaderId || (cluster.coins.length === 1 && coin.sizePx >= 44)}
          />
        ));
      })}
      <div className="coin-emblem-hit-layer" aria-hidden="true">
        {[...allCoins]
          .sort((left, right) => right.sizePx - left.sizePx)
          .map((coin) => (
            <CoinHitTarget key={coin.id} coin={coin} />
          ))}
      </div>
    </div>
  );
}
