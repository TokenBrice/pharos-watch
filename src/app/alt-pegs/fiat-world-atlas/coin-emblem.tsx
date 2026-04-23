"use client";

import Image from "next/image";
import { useCallback, useMemo, type CSSProperties } from "react";
import { formatCompactUsd } from "@shared/lib/format";
import type { PlacedCoin } from "@/lib/alt-peg-hero";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

export type EmblemVariant = "fiat" | "sun-core" | "sun-planet" | "moon" | "star";

export function CoinEmblem({
  coin,
  variant,
  loading = "lazy",
}: {
  coin: PlacedCoin;
  variant: EmblemVariant;
  loading?: "eager" | "lazy";
}) {
  const { setHoveredCoin, isHovered, isSibling, isDimmed } = useHoverState();
  const target = useMemo(
    () => ({ id: coin.id, pegCurrency: coin.pegCurrency }),
    [coin.id, coin.pegCurrency],
  );
  const hovered = isHovered(coin.id);
  const sibling = isSibling(target);
  const dimmed = isDimmed(target);

  const onEnter = useCallback(() => setHoveredCoin(target), [setHoveredCoin, target]);
  const onLeave = useCallback(() => setHoveredCoin(null), [setHoveredCoin]);

  const mcap = coin.marketCap > 0 ? formatCompactUsd(coin.marketCap) : null;

  const style: CSSProperties = {
    left: `${coin.x}%`,
    top: `${coin.y}%`,
    width: `${coin.sizePx}px`,
    height: `${coin.sizePx}px`,
  };

  const cls = [
    "coin-emblem",
    `coin-emblem--${variant}`,
    hovered && "is-hovered",
    sibling && "is-sibling",
    dimmed && "is-dimmed",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = mcap
    ? `${coin.symbol} · ${coin.name} · ${mcap} market cap · ${coin.pegCurrency} peg`
    : `${coin.symbol} · ${coin.name} · ${coin.pegCurrency} peg`;

  return (
    <a
      href={coin.href}
      className={cls}
      style={style}
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      data-coin-id={coin.id}
      data-peg={coin.pegCurrency}
    >
      <Image
        src={coin.logoSrc}
        alt=""
        width={coin.sizePx}
        height={coin.sizePx}
        unoptimized
        loading={loading}
        className="coin-emblem__img"
      />
      {hovered ? (
        <span role="tooltip" className="coin-emblem__tooltip">
          <span className="coin-emblem__tooltip-symbol">{coin.symbol}</span>
          {mcap ? <span className="coin-emblem__tooltip-mcap">{mcap}</span> : null}
          <span className="coin-emblem__tooltip-peg">{coin.pegCurrency}</span>
        </span>
      ) : null}
    </a>
  );
}
