import * as React from "react";
import { CardFrame, Sparkline, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS } from "./shared";
import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";

export interface StablecoinCardData {
  name: string;
  symbol: string;
  grade: string;
  pegPrice: number;
  dewsBand: string;
  liquidityScore: number;
  mcap: number;
  vol24h: number | null;
  flow7d: number;
  sparklineData: number[];
  hasActiveDepeg: boolean;
  // Fields
  pegScore: number | null;
  backing: string;
  governance: string;
  redemptionScore: number | null;
  change24h: number | null;
  lastUpdated?: string;
}

function getAdaptiveTreatment(data: StablecoinCardData): {
  borderTopColor?: string;
  badge?: { text: string; color: string };
} {
  if (data.hasActiveDepeg) {
    return {
      borderTopColor: "#ef4444",
      badge: { text: "DEPEGGED", color: "#ef4444" },
    };
  }
  if (data.dewsBand === "DANGER") {
    return {
      borderTopColor: "#ef4444",
      badge: { text: "DANGER", color: "#ef4444" },
    };
  }
  if (data.dewsBand === "ALERT" || data.dewsBand === "WARNING") {
    return {
      borderTopColor: "#f59e0b",
      badge: { text: "ELEVATED STRESS", color: "#f59e0b" },
    };
  }
  return {};
}

/** Format backing type to short label */
function formatBacking(backing: string): string {
  const map: Record<string, string> = {
    fiat: "Fiat",
    "fiat-backed": "Fiat",
    crypto: "Crypto",
    "crypto-backed": "Crypto",
    rwa: "RWA",
    "rwa-backed": "RWA",
    algorithmic: "Algo",
  };
  return map[backing] || backing;
}

/** Format governance type to short label */
function formatGovernance(gov: string): string {
  const map: Record<string, string> = {
    centralized: "CeFi",
    "centralized-dependent": "CeFi-Dep",
    decentralized: "DeFi",
  };
  return map[gov] || gov;
}

/** Get color for 24h change */
function getChangeColor(value: number | null): string {
  if (value === null) return TEXT_SECONDARY;
  if (value > 0) return SEMANTIC_COLORS.positive;
  if (value < 0) return SEMANTIC_COLORS.negative;
  return TEXT_SECONDARY;
}

export function StablecoinCard({ data }: { data: StablecoinCardData }) {
  const treatment = getAdaptiveTreatment(data);
  const gradeColor = GRADE_RADAR_COLORS[gradeRange(data.grade as Parameters<typeof gradeRange>[0])] ?? TEXT_SECONDARY;
  const dewsColor = THREAT_BAND_HEX[data.dewsBand as keyof typeof THREAT_BAND_HEX] ?? TEXT_SECONDARY;
  
  // Build primary metrics row (5 items - PSI removed as it's market-wide)
  const primaryMetrics = [
    { label: "GRADE", value: data.grade, color: gradeColor, size: "large" as const },
    { label: "PEG", value: `$${data.pegPrice.toFixed(4)}`, color: TEXT_SECONDARY },
    { label: "PEG SCORE", value: data.pegScore != null ? data.pegScore.toFixed(1) : "—", color: TEXT_SECONDARY },
    { label: "DEWS", value: data.dewsBand, color: dewsColor },
    { label: "LIQUIDITY", value: data.liquidityScore.toFixed(0), color: TEXT_SECONDARY },
  ];

  // Build secondary metrics row (6 items)
  const secondaryMetrics = [
    { 
      label: "MARKET CAP", 
      value: formatCurrency(data.mcap, 1),
    },
    { 
      label: "24H CHANGE", 
      value: data.change24h != null ? `${data.change24h >= 0 ? "+" : ""}${data.change24h.toFixed(2)}%` : "—",
      color: getChangeColor(data.change24h),
    },
    { 
      label: "7D FLOW", 
      value: `${data.flow7d >= 0 ? "+" : ""}${formatCurrency(data.flow7d, 1)}`,
      color: data.flow7d >= 0 ? SEMANTIC_COLORS.positive : SEMANTIC_COLORS.negative,
    },
    { 
      label: "BACKING", 
      value: formatBacking(data.backing),
    },
    { 
      label: "TYPE", 
      value: formatGovernance(data.governance),
    },
    { 
      label: "REDEMPTION", 
      value: data.redemptionScore != null ? data.redemptionScore.toFixed(0) : "—",
    },
  ];

  return (
    <CardFrame
      title={`${data.name} (${data.symbol})`}
      subtitle="Stablecoin Intelligence"
      borderTopColor={treatment.borderTopColor}
      badge={treatment.badge}
      lastUpdated={data.lastUpdated}
    >
      {/* Top section: metrics */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Primary metrics row - 6 items */}
        <div
          style={{
            display: "flex",
            gap: 40,
            marginBottom: 32,
            fontFamily: "Geist Mono",
          }}
        >
          {primaryMetrics.map((metric) => (
            <div
              key={metric.label}
              style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 80 }}
            >
              <span
                style={{
                  fontSize: 13,
                  color: TEXT_SECONDARY,
                  letterSpacing: "0.06em",
                }}
              >
                {metric.label}
              </span>
              <span
                style={{
                  fontSize: metric.size === "large" ? 44 : 32,
                  fontWeight: 700,
                  color: metric.color || TEXT_SECONDARY,
                }}
              >
                {metric.value}
              </span>
            </div>
          ))}
        </div>

        {/* Secondary metrics row - 6 items */}
        <div
          style={{
            display: "flex",
            gap: 40,
            fontFamily: "Geist Mono",
          }}
        >
          {secondaryMetrics.map((metric) => (
            <div
              key={metric.label}
              style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 80 }}
            >
              <span
                style={{
                  fontSize: 13,
                  color: TEXT_SECONDARY,
                  letterSpacing: "0.06em",
                }}
              >
                {metric.label}
              </span>
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: metric.color || TEXT_SECONDARY,
                }}
              >
                {metric.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Sparkline — pushed to bottom by space-between */}
      <Sparkline data={data.sparklineData} color={FROST_BLUE} />
    </CardFrame>
  );
}
