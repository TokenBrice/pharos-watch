import * as React from "react";
import { CardFrame, MetricLabel, Sparkline, TEXT_SECONDARY, FROST_BLUE, SEMANTIC_COLORS, GRADE_COLORS } from "./shared";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";

export interface StablecoinCardData {
  name: string;
  symbol: string;
  grade: string;
  pegPrice: number | null;
  /** `pegPrice` is a nominal par reference (pricing v6.38), not an observed market price. */
  pegPriceIsNominal?: boolean;
  dewsBand: string | null;
  /** Signed net, except `mint-burn-partial-gross`, where it is a known gross lower bound. */
  flow7d: number | null;
  flow7dSource: "mint-burn" | "mint-burn-coverage-unknown" | "mint-burn-partial-gross" | "supply-delta" | null;
  sparklineData: number[] | null;
  hasActiveDepeg: boolean;
  variantLabel?: string | null;
  variantParentSymbol?: string | null;
  isFrozen?: boolean;
  safetyMethodologyVersion?: string | null;
  lastUpdated?: string;
}

function getAdaptiveTreatment(data: StablecoinCardData): {
  borderTopColor?: string;
  badge?: { text: string; color: string };
} {
  if (data.hasActiveDepeg) {
    return { borderTopColor: SEMANTIC_COLORS.negative, badge: { text: "OPEN DEPEG", color: SEMANTIC_COLORS.negative } };
  }
  const bandColor = data.dewsBand == null ? undefined : THREAT_BAND_HEX[data.dewsBand as keyof typeof THREAT_BAND_HEX];
  if (data.dewsBand === "DANGER" || data.dewsBand === "ALERT" || data.dewsBand === "WARNING") {
    return { borderTopColor: bandColor, badge: { text: data.dewsBand, color: bandColor ?? SEMANTIC_COLORS.warning } };
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
          <MetricLabel fontSize={22}>{metric.label}</MetricLabel>
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
  const supports: Metric[] = [
    {
      label: data.pegPriceIsNominal ? "NOMINAL PAR" : "PRICE",
      value: data.pegPrice != null ? `$${data.pegPrice.toFixed(4)}` : "\u2014",
    },
    flowMetric(data),
  ];
  return (
    <CardFrame
      title={`${data.name} (${data.symbol})`}
      subtitle="Dated dossier"
      borderTopColor={treatment.borderTopColor}
      badge={treatment.badge}
      lastUpdated={data.lastUpdated}
    >
      <div style={{ display: "flex", gap: 48, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 400, flexShrink: 0 }}>
          <MetricLabel>PUBLISHED SAFETY GRADE</MetricLabel>
          <span style={{ fontFamily: "Geist Mono", fontSize: data.grade.length > 3 ? 46 : 120, fontWeight: 700, lineHeight: 1.1, color: gradeColor }}>
            {data.grade}
          </span>
          <span style={{ fontSize: 22, color: TEXT_SECONDARY }}>
            {data.safetyMethodologyVersion ? `Methodology v${data.safetyMethodologyVersion}` : "Publication unavailable"}
          </span>
          {data.isFrozen && <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>Frozen archive</span>}
          {data.variantLabel && data.variantParentSymbol && (
            <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>{data.variantLabel} of {data.variantParentSymbol}</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 24 }}>
          <MetricRow metrics={supports} valueFontSize={34} />
          {data.sparklineData != null ? (
            <Sparkline data={data.sparklineData} color={FROST_BLUE} width={580} />
          ) : (
            <span style={{ color: TEXT_SECONDARY, fontSize: 22 }}>Price history unavailable</span>
          )}
        </div>
      </div>
    </CardFrame>
  );
}
