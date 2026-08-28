"use client";

import { useCallback, useMemo, type CSSProperties } from "react";
import { CohortCoinEmblems, summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import { useHoverDispatch } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PegCluster, PlacedCoin } from "@/lib/alt-peg-hero";

type HitTargetStyle = CSSProperties & { "--hit-z": number; "--hit-size": string };

function hitTargetSizePx(coin: PlacedCoin): number {
  return Math.max(24, Math.min(32, Math.round(coin.sizePx * 0.55)));
}

function CoinHitTarget({ coin }: { coin: PlacedCoin }) {
  const setHoveredCoin = useHoverDispatch();
  const target = useMemo(() => ({ id: coin.id, pegCurrency: coin.pegCurrency }), [coin.id, coin.pegCurrency]);
  const onEnter = useCallback(() => setHoveredCoin(target), [setHoveredCoin, target]);
  const onLeave = useCallback(() => setHoveredCoin(null), [setHoveredCoin]);
  const sizePx = hitTargetSizePx(coin);
  const style: HitTargetStyle = {
    left: `${coin.x}%`,
    top: `${coin.y}%`,
    width: "calc(var(--hit-size) * var(--peg-hit-scale, 1))",
    height: "calc(var(--hit-size) * var(--peg-hit-scale, 1))",
    "--hit-size": `${sizePx}px`,
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
        const rankedCoins = [...cluster.coins].sort((left, right) => right.marketCap - left.marketCap);
        return (
          <CohortCoinEmblems
            key={cluster.peg}
            coins={cluster.coins}
            cohortRank={cluster.rank}
            summary={summarizeCohort(rankedCoins)}
            variant="fiat"
            loading={(_coin, index) => index === 0 ? "eager" : "lazy"}
          />
        );
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
