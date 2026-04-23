"use client";

import Image from "next/image";
import { useCallback, useMemo, type CSSProperties } from "react";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { formatCompactUsd, formatPercentFromRatio } from "@shared/lib/format";
import type { PlacedCoin } from "@/lib/alt-peg-hero";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

export type EmblemVariant = "fiat" | "sun-core" | "sun-planet" | "moon" | "star";
type HoverCardYPlacement = "auto" | "above" | "below";

export function CoinEmblem({
  coin,
  variant,
  loading = "lazy",
  cohortCoinCount = 1,
  cohortMarketCap,
  cohortSymbolPreview,
  hoverCardYPlacement = "auto",
  showTickerLabel = false,
}: {
  coin: PlacedCoin;
  variant: EmblemVariant;
  loading?: "eager" | "lazy";
  cohortCoinCount?: number;
  cohortMarketCap?: number;
  cohortSymbolPreview?: string;
  hoverCardYPlacement?: HoverCardYPlacement;
  showTickerLabel?: boolean;
}) {
  const { setHoveredCoin, isHovered, isSibling, isDimmed } = useHoverState();
  const target = useMemo(() => ({ id: coin.id, pegCurrency: coin.pegCurrency }), [coin.id, coin.pegCurrency]);
  const hovered = isHovered(coin.id);
  const sibling = isSibling(target);
  const dimmed = isDimmed(target);

  const onEnter = useCallback(() => setHoveredCoin(target), [setHoveredCoin, target]);
  const onLeave = useCallback(() => setHoveredCoin(null), [setHoveredCoin]);

  const mcap = coin.marketCap > 0 ? formatCompactUsd(coin.marketCap) : null;
  const cohortCap = cohortMarketCap !== undefined && cohortMarketCap > 0 ? formatCompactUsd(cohortMarketCap) : null;
  const cohortShare =
    cohortMarketCap !== undefined && cohortMarketCap > 0 && coin.marketCap > 0
      ? formatPercentFromRatio(coin.marketCap / cohortMarketCap, 1)
      : null;
  const pegLabel = PEG_LABELS_SHORT[coin.pegCurrency] ?? coin.pegCurrency;
  const cohortLabel = `${pegLabel} cohort`;
  const coinCountLabel = `${cohortCoinCount} ${cohortCoinCount === 1 ? "coin" : "coins"}`;
  const showCoinName = coin.name.trim().toLowerCase() !== coin.symbol.trim().toLowerCase();
  const shouldShowTickerLabel = showTickerLabel && coin.sizePx >= 44;
  const cardX = coin.x < 24 ? "left" : coin.x > 76 ? "right" : "center";
  const cardY = hoverCardYPlacement === "auto" ? (coin.y < 24 ? "below" : "above") : hoverCardYPlacement;
  const tooltipId = `coin-emblem-card-${coin.id}`;

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

  const ariaLabel = [
    coin.symbol,
    coin.name,
    mcap ? `${mcap} market cap` : null,
    cohortLabel,
    cohortShare ? `${cohortShare} of cohort market cap` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <a
      href={coin.href}
      className={cls}
      style={style}
      aria-label={ariaLabel}
      aria-describedby={hovered ? tooltipId : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      data-coin-id={coin.id}
      data-peg={coin.pegCurrency}
      data-card-x={cardX}
      data-card-y={cardY}
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
        <span id={tooltipId} role="tooltip" className="coin-emblem__hover-card">
          <span className="coin-emblem__hover-card-head">
            <span className="coin-emblem__hover-card-symbol">{coin.symbol}</span>
            <span className="coin-emblem__hover-card-peg">{cohortLabel}</span>
          </span>
          {showCoinName ? <span className="coin-emblem__hover-card-name">{coin.name}</span> : null}
          <span className="coin-emblem__hover-card-grid">
            <span>
              <span className="coin-emblem__hover-card-label">Market cap</span>
              <span className="coin-emblem__hover-card-value">{mcap ?? "n/a"}</span>
            </span>
            <span>
              <span className="coin-emblem__hover-card-label">Cohort share</span>
              <span className="coin-emblem__hover-card-value">{cohortShare ?? "n/a"}</span>
            </span>
            <span>
              <span className="coin-emblem__hover-card-label">Cohort cap</span>
              <span className="coin-emblem__hover-card-value">{cohortCap ?? "n/a"}</span>
            </span>
            <span>
              <span className="coin-emblem__hover-card-label">Cohort size</span>
              <span className="coin-emblem__hover-card-value">{coinCountLabel}</span>
            </span>
          </span>
          {cohortSymbolPreview ? (
            <span className="coin-emblem__hover-card-peers">
              <span className="coin-emblem__hover-card-label">Top peers</span>
              <span className="coin-emblem__hover-card-value">{cohortSymbolPreview}</span>
            </span>
          ) : null}
          <span className="coin-emblem__hover-card-action">Click emblem to open {coin.symbol}</span>
        </span>
      ) : null}
      {shouldShowTickerLabel ? <span className="coin-emblem__mini-label">{coin.symbol}</span> : null}
    </a>
  );
}
