import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS, TRACK_BG } from "./shared";
import { formatCurrency } from "@shared/lib/format";
import { CHAIN_HEALTH_HEX, CHAIN_HEALTH_UNRATED_HEX } from "@shared/lib/classification";

export interface ChainCardTopStablecoin {
  symbol: string;
  share: number;
  supplyUsd: number;
}

export interface ChainCardData {
  name: string;
  totalUsd: number;
  /** 0-100 percentage, already converted from the 0-1 ratio the chain aggregate carries. */
  change7dPercent: number | null;
  stablecoinCount: number;
  dominanceShare: number;
  healthScore: number | null;
  healthBand: string | null;
  topStablecoins: ChainCardTopStablecoin[];
  safetyModel?: "v8" | "v9" | null;
  lastUpdated?: string;
}

function healthBandColor(band: string | null): string {
  return band != null && band in CHAIN_HEALTH_HEX ? CHAIN_HEALTH_HEX[band as keyof typeof CHAIN_HEALTH_HEX] : CHAIN_HEALTH_UNRATED_HEX;
}

export function ChainCard({ data }: { data: ChainCardData }) {
  const bandColor = healthBandColor(data.healthBand);
  const changeColor =
    (data.change7dPercent ?? 0) > 0 ? SEMANTIC_COLORS.positive : (data.change7dPercent ?? 0) < 0 ? SEMANTIC_COLORS.negative : SEMANTIC_COLORS.neutral;
  const changeSign = (data.change7dPercent ?? 0) > 0 ? "+" : "";
  const maxShare = Math.max(...data.topStablecoins.map((coin) => coin.share), 0.01);

  return (
    <CardFrame
      title={`${data.name} Stablecoins`}
      subtitle="Chain supply & health"
      borderTopColor={bandColor}
      lastUpdated={data.lastUpdated}
    >
      {/* Headline: total supply + 7d trend */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <MetricLabel fontSize={14}>STABLECOIN SUPPLY</MetricLabel>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 24,
            fontFamily: "Geist Mono",
          }}
        >
          <span style={{ fontSize: 72, fontWeight: 700 }}>{formatCurrency(data.totalUsd, 1)}</span>
          <span style={{ fontSize: 28, fontWeight: 600, color: changeColor }}>
            {changeSign}
            {data.change7dPercent == null ? "—" : `${data.change7dPercent.toFixed(1)}%`} 7d
          </span>
        </div>
      </div>

      {/* Secondary metrics */}
      <div style={{ display: "flex", gap: 48, fontFamily: "Geist Mono" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <MetricLabel fontSize={13}>STABLECOINS</MetricLabel>
          <span style={{ fontSize: 30, fontWeight: 700 }}>{data.stablecoinCount}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <MetricLabel fontSize={13}>SHARE OF GLOBAL</MetricLabel>
          <span style={{ fontSize: 30, fontWeight: 700, color: FROST_BLUE }}>
            {(data.dominanceShare * 100).toFixed(1)}%
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <MetricLabel fontSize={13}>
            {data.safetyModel ? `CHAIN HEALTH · ${data.safetyModel.toUpperCase()} INPUT` : "CHAIN HEALTH"}
          </MetricLabel>
          <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 30, fontWeight: 700, color: bandColor }}>
              {data.healthScore != null ? data.healthScore.toFixed(0) : "NR"}
            </span>
            {data.healthBand && (
              <span style={{ fontSize: 18, fontWeight: 600, color: bandColor, textTransform: "uppercase" }}>
                {data.healthBand}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Top stablecoins with share bars */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <MetricLabel fontSize={13}>TOP STABLECOINS ON CHAIN</MetricLabel>
        {data.topStablecoins.length === 0 && (
          <span style={{ fontFamily: "Geist Mono", fontSize: 18, color: TEXT_SECONDARY }}>
            No tracked stablecoin supply
          </span>
        )}
        {data.topStablecoins.map((coin) => (
          <div
            key={coin.symbol}
            style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "Geist Mono", fontSize: 18 }}
          >
            <span style={{ width: 110, fontWeight: 700 }}>{coin.symbol}</span>
            <div style={{ display: "flex", width: 520, height: 12, borderRadius: 6, backgroundColor: TRACK_BG }}>
              <div
                style={{
                  display: "flex",
                  width: `${Math.max(2, (coin.share / maxShare) * 100)}%`,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: FROST_BLUE,
                }}
              />
            </div>
            <span style={{ width: 90, color: TEXT_SECONDARY }}>{(coin.share * 100).toFixed(1)}%</span>
            <span style={{ color: TEXT_SECONDARY }}>{formatCurrency(coin.supplyUsd, 1)}</span>
          </div>
        ))}
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
      subtitle="Chain supply & health"
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
