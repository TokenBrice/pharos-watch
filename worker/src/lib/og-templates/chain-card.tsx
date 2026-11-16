import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS, TRACK_BG } from "./shared";
import { formatCurrency } from "@shared/lib/format";
import { formatChainShare } from "@shared/lib/chain-share-format";

export interface ChainCardTopStablecoin {
  symbol: string;
  share: number;
}

export interface ChainCardData {
  name: string;
  totalUsd: number;
  /** 0-100 percentage, already converted from the 0-1 ratio the chain aggregate carries. */
  change7dPercent: number | null;
  stablecoinCount: number;
  dominanceShare: number | null;
  unavailableSupplyObservationCount: number;
  aggregateUnavailableAssetCount: number;
  topStablecoins: ChainCardTopStablecoin[];
  lastUpdated?: string;
}


export function ChainCard({ data }: { data: ChainCardData }) {
  const changeColor =
    (data.change7dPercent ?? 0) > 0 ? SEMANTIC_COLORS.positive : (data.change7dPercent ?? 0) < 0 ? SEMANTIC_COLORS.negative : SEMANTIC_COLORS.neutral;
  const changeSign = (data.change7dPercent ?? 0) > 0 ? "+" : "";
  const maxShare = Math.max(...data.topStablecoins.map((coin) => coin.share), 0.01);

  return (
    <CardFrame
      title={`${data.name} Stablecoins`}
      subtitle="Dated chain briefing"
      lastUpdated={data.lastUpdated}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 450, flexShrink: 0, gap: 14 }}>
          <MetricLabel>{data.unavailableSupplyObservationCount > 0 ? "OBSERVED SUPPLY SUBTOTAL" : "STABLECOIN SUPPLY"}</MetricLabel>
          <span style={{ fontSize: 88, fontWeight: 700, fontFamily: "Geist Mono", lineHeight: 1.1 }}>{formatCurrency(data.totalUsd, 1)}</span>
          {data.unavailableSupplyObservationCount > 0 && (
            <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>{data.unavailableSupplyObservationCount} chain observations unavailable</span>
          )}
          <span style={{ fontSize: 28, fontWeight: 600, color: changeColor }}>
            {changeSign}{data.change7dPercent == null ? "\u2014" : `${data.change7dPercent.toFixed(1)}%`} 7d
          </span>
          <MetricLabel>{data.aggregateUnavailableAssetCount > 0 || data.unavailableSupplyObservationCount > 0 ? "SHARE OF GLOBAL UNAVAILABLE" : "SHARE OF GLOBAL"}</MetricLabel>
          <span style={{ fontSize: 32, fontFamily: "Geist Mono" }}>
            {formatChainShare(data.aggregateUnavailableAssetCount > 0 || data.unavailableSupplyObservationCount > 0 ? null : data.dominanceShare)}
          </span>
          {data.aggregateUnavailableAssetCount > 0 && (
            <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>{data.aggregateUnavailableAssetCount} global supply observations unavailable</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }}>
          <MetricLabel>TOP {Math.min(data.topStablecoins.length, 3)} OF {data.stablecoinCount} STABLECOINS</MetricLabel>
          {data.unavailableSupplyObservationCount > 0 && <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>Shares of observed chain subtotal</span>}
          {data.topStablecoins.length === 0 && <span style={{ fontSize: 24, color: TEXT_SECONDARY }}>No tracked stablecoin supply</span>}
          {data.topStablecoins.slice(0, 3).map((coin) => (
            <div key={coin.symbol} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Geist Mono", fontSize: 26 }}>
                <span style={{ fontWeight: 700 }}>{coin.symbol}</span>
                <span style={{ color: TEXT_SECONDARY }}>{formatChainShare(coin.share)}</span>
              </div>
              <div style={{ display: "flex", width: 540, height: 14, backgroundColor: TRACK_BG }}>
                <div style={{ display: "flex", width: `${(coin.share / maxShare) * 100}%`, height: 14, backgroundColor: FROST_BLUE }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </CardFrame>
  );
}

/**
 * A chain absent from the current aggregate has no supply observation this
 * generation. Absence is not an observed zero, so the card carries no figure.
 */
export function ChainUnavailableCard({ name, lastUpdated }: { name: string; lastUpdated?: string }) {
  return (
    <CardFrame
      title={`${name} Stablecoins`}
      subtitle="Dated chain briefing"
      borderTopColor={SEMANTIC_COLORS.neutral}
      lastUpdated={lastUpdated}
    >
      <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "center", gap: 12 }}>
        <span style={{ fontSize: 36, fontWeight: 700 }}>No current supply observation</span>
        <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>
          This chain is not in the current stablecoin aggregate.
        </span>
      </div>
    </CardFrame>
  );
}
