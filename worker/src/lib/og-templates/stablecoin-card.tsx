import * as React from "react";
import { CardFrame, MetricLabel, Sparkline, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS, GRADE_COLORS } from "./shared";
import { getBackingLabelShort, getGovernanceLabelShort, THREAT_BAND_HEX } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";

export interface StablecoinCardData {
  name: string;
  symbol: string;
  grade: string;
  pegPrice: number | null;
  dewsBand: string | null;
  liquidityScore: number | null;
  mcap: number | null;
  /** Signed net, except `mint-burn-partial-gross`, where it is a known gross lower bound. */
  flow7d: number | null;
  flow7dSource: "mint-burn" | "mint-burn-coverage-unknown" | "mint-burn-partial-gross" | "supply-delta" | null;
  sparklineData: number[] | null;
  hasActiveDepeg: boolean;
  // Fields
  pegScore: number | null;
  backing: string | null;
  governance: string | null;
  redemptionScore: number | null;
  change24h: number | null;
  variantLabel?: string | null;
  variantParentSymbol?: string | null;
  isFrozen?: boolean;
  safetyModel?: "v8" | "v9" | null;
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
  return data.dewsBand == null ? { borderTopColor: TEXT_SECONDARY } : {};
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

const FLOW_LABEL_BY_SOURCE: Record<NonNullable<StablecoinCardData["flow7dSource"]>, string> = {
  "mint-burn": "7D NET MINT/BURN",
  "mint-burn-coverage-unknown": "7D NET (UNVERIFIED)",
  "mint-burn-partial-gross": "7D GROSS (MIN)",
  "supply-delta": "7D SUPPLY DELTA",
};

/**
 * Seven-day flow cell. A partial mint/burn window never shows a signed net: its
 * known gross subtotal renders as a lower bound (`$X+`) without direction color.
 * Legacy buckets aggregated before valuation completeness keep their net with an
 * unverified label and neutral color.
 */
function flowMetric(data: StablecoinCardData): Metric {
  const label = FLOW_LABEL_BY_SOURCE[data.flow7dSource ?? "mint-burn"];
  if (data.flow7d == null) return { label, value: "—" };
  if (data.flow7dSource === "mint-burn-partial-gross") {
    return { label, value: `${formatCurrency(data.flow7d, 1)}+`, color: TEXT_SECONDARY };
  }
  return {
    label,
    value: `${data.flow7d > 0 ? "+" : ""}${formatCurrency(data.flow7d, 1)}`,
    color: data.flow7dSource === "mint-burn-coverage-unknown" ? TEXT_SECONDARY : getChangeColor(data.flow7d),
  };
}

export function StablecoinCard({ data }: { data: StablecoinCardData }) {
  const treatment = getAdaptiveTreatment(data);
  const gradeColor = GRADE_COLORS[data.grade] ?? TEXT_SECONDARY;
  const dewsColor = THREAT_BAND_HEX[data.dewsBand as keyof typeof THREAT_BAND_HEX] ?? TEXT_SECONDARY;
  
  // Build primary metrics row (5 items - PSI removed as it's market-wide)
  const primaryMetrics: Metric[] = [
    {
      label: data.safetyModel ? `${data.safetyModel.toUpperCase()} GRADE` : "GRADE",
      value: data.grade,
      color: gradeColor,
      size: "large" as const,
    },
    { label: "PRICE", value: data.pegPrice != null ? `$${data.pegPrice.toFixed(4)}` : "—", color: TEXT_SECONDARY },
    { label: "PEG SCORE", value: data.pegScore != null ? data.pegScore.toFixed(1) : "—", color: TEXT_SECONDARY },
    { label: "DEWS", value: data.dewsBand ?? "—", color: dewsColor },
    { label: "LIQUIDITY", value: data.liquidityScore != null ? data.liquidityScore.toFixed(0) : "—", color: TEXT_SECONDARY },
  ];

  // Build secondary metrics row (6 items)
  const secondaryMetrics: Metric[] = [
    { 
      label: "MARKET CAP", 
      value: data.mcap != null ? formatCurrency(data.mcap, 1) : "—",
    },
    { 
      label: "24H CHANGE", 
      value: data.change24h != null ? `${data.change24h >= 0 ? "+" : ""}${data.change24h.toFixed(2)}%` : "—",
      color: getChangeColor(data.change24h),
    },
    flowMetric(data),
    { 
      label: "BACKING", 
      value: data.backing != null ? getBackingLabelShort(data.backing) : "—",
    },
    { 
      label: "TYPE", 
      value: data.governance != null ? getGovernanceLabelShort(data.governance) : "—",
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
      {data.sparklineData != null ? (
        <Sparkline data={data.sparklineData} color={FROST_BLUE} />
      ) : (
        <div style={{ display: "flex", color: TEXT_SECONDARY, fontFamily: "Geist Mono", fontSize: 18 }}>
          Price history unavailable
        </div>
      )}
    </CardFrame>
  );
}
