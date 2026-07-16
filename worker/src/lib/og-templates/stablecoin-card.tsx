import * as React from "react";
import { CardFrame, MetricLabel, Sparkline, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS, GRADE_COLORS } from "./shared";
import { getBackingLabelShort, getGovernanceLabelShort, THREAT_BAND_HEX } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";

export interface StablecoinCardData {
  name: string;
  symbol: string;
  grade: string;
  pegPrice: number;
  dewsBand: string;
  liquidityScore: number;
  mcap: number;
  flow7d: number;
  sparklineData: number[];
  hasActiveDepeg: boolean;
  // Fields
  pegScore: number | null;
  backing: string;
  governance: string;
  redemptionScore: number | null;
  change24h: number | null;
  variantLabel?: string | null;
  variantParentSymbol?: string | null;
  isFrozen?: boolean;
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

/** Get color for 24h change */
function getChangeColor(value: number | null): string {
  if (value === null) return TEXT_SECONDARY;
  if (value > 0) return SEMANTIC_COLORS.positive;
  if (value < 0) return SEMANTIC_COLORS.negative;
  return TEXT_SECONDARY;
}

interface Metric {
  label: string;
  value: React.ReactNode;
  color?: string;
  size?: "large";
}

function MetricRow({
  metrics,
  valueFontSize,
  // satori 0.26 throws on `undefined` style values (no skip in its expand
  // loop), so the optional prop must resolve to a concrete number.
  marginBottom = 0,
}: {
  metrics: readonly Metric[];
  valueFontSize: number;
  marginBottom?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 40,
        marginBottom,
        fontFamily: "Geist Mono",
      }}
    >
      {metrics.map((metric) => (
        <div
          key={metric.label}
          style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 80 }}
        >
          <MetricLabel fontSize={13}>{metric.label}</MetricLabel>
          <span
            style={{
              fontSize: metric.size === "large" ? 44 : valueFontSize,
              fontWeight: 700,
              color: metric.color || TEXT_SECONDARY,
            }}
          >
            {metric.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StablecoinCard({ data }: { data: StablecoinCardData }) {
  const treatment = getAdaptiveTreatment(data);
  const gradeColor = GRADE_COLORS[data.grade] ?? TEXT_SECONDARY;
  const dewsColor = THREAT_BAND_HEX[data.dewsBand as keyof typeof THREAT_BAND_HEX] ?? TEXT_SECONDARY;
  
  // Build primary metrics row (5 items - PSI removed as it's market-wide)
  const primaryMetrics: Metric[] = [
    { label: "GRADE", value: data.grade, color: gradeColor, size: "large" as const },
    { label: "PEG", value: `$${data.pegPrice.toFixed(4)}`, color: TEXT_SECONDARY },
    { label: "PEG SCORE", value: data.pegScore != null ? data.pegScore.toFixed(1) : "—", color: TEXT_SECONDARY },
    { label: "DEWS", value: data.dewsBand, color: dewsColor },
    { label: "LIQUIDITY", value: data.liquidityScore.toFixed(0), color: TEXT_SECONDARY },
  ];

  // Build secondary metrics row (6 items)
  const secondaryMetrics: Metric[] = [
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
      value: getBackingLabelShort(data.backing),
    },
    { 
      label: "TYPE", 
      value: getGovernanceLabelShort(data.governance),
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
        {data.isFrozen ? (
          <div
            style={{
              // satori rejects "inline-flex"; alignSelf already keeps the
              // badge from stretching.
              display: "flex",
              alignItems: "center",
              alignSelf: "flex-start",
              marginBottom: 18,
              borderRadius: 6,
              border: "1px solid #d4d4d8",
              padding: "4px 12px",
              fontFamily: "Geist Mono",
              fontSize: 16,
              letterSpacing: "0",
              textTransform: "uppercase",
              color: "#52525b",
            }}
          >
            Frozen archive
          </div>
        ) : null}
        {data.variantLabel && data.variantParentSymbol ? (
          <div
            style={{
              display: "flex",
              marginBottom: 18,
              fontFamily: "Geist Mono",
              fontSize: 16,
              letterSpacing: "0",
              color: TEXT_SECONDARY,
              textTransform: "uppercase",
            }}
          >
            {data.variantLabel} of {data.variantParentSymbol}
          </div>
        ) : null}
        {/* Primary metrics row - 5 items */}
        <MetricRow metrics={primaryMetrics} valueFontSize={32} marginBottom={32} />

        {/* Secondary metrics row - 6 items */}
        <MetricRow metrics={secondaryMetrics} valueFontSize={24} />
      </div>

      {/* Sparkline — pushed to bottom by space-between */}
      <Sparkline data={data.sparklineData} color={FROST_BLUE} />
    </CardFrame>
  );
}
