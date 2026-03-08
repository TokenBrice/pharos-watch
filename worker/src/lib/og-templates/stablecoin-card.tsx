// worker/src/lib/og-templates/stablecoin-card.tsx
import { CardFrame, Sparkline, TEXT_SECONDARY, FROST_BLUE } from "./shared";

export interface StablecoinCardData {
  name: string;
  symbol: string;
  grade: string;
  pegPrice: number;
  dewsBand: string;
  liquidityScore: number;
  psiScore: number;
  psiBand: string;
  mcap: number;
  vol24h: number;
  flow7d: number;
  sparklineData: number[];
  hasActiveDepeg: boolean;
  deviationPct: number;
}

/**
 * Grade hex colors aligned with GRADE_RADAR_COLORS from shared/lib/report-cards.ts.
 * A-range = emerald, B-range = blue, C-range = amber, D = orange, F = red, NR = zinc.
 */
const GRADE_COLORS: Record<string, string> = {
  "A+": "#10b981",
  A: "#10b981",
  "A-": "#10b981",
  "B+": "#3b82f6",
  B: "#3b82f6",
  "B-": "#3b82f6",
  "C+": "#f59e0b",
  C: "#f59e0b",
  "C-": "#f59e0b",
  D: "#f97316",
  F: "#ef4444",
  NR: "#71717a",
};

/** DEWS band hex colors aligned with THREAT_BAND_HEX from shared/lib/classification.ts. */
const DEWS_BAND_COLORS: Record<string, string> = {
  CALM: "#22c55e",
  WATCH: "#14b8a6",
  ALERT: "#eab308",
  WARNING: "#f97316",
  DANGER: "#ef4444",
};

/** PSI band hex colors aligned with PSI_HEX_COLORS from shared/lib/psi-colors.ts. */
const PSI_BAND_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
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

export function StablecoinCard({ data }: { data: StablecoinCardData }) {
  const treatment = getAdaptiveTreatment(data);
  const gradeColor = GRADE_COLORS[data.grade] ?? TEXT_SECONDARY;
  const dewsColor = DEWS_BAND_COLORS[data.dewsBand] ?? TEXT_SECONDARY;
  const psiColor = PSI_BAND_COLORS[data.psiBand] ?? TEXT_SECONDARY;
  const sign = data.flow7d >= 0 ? "+" : "";

  return (
    <CardFrame
      title={`${data.name} (${data.symbol})`}
      subtitle="Stablecoin Intelligence"
      borderTopColor={treatment.borderTopColor}
      badge={treatment.badge}
    >
      {/* Primary metrics row */}
      <div
        style={{
          display: "flex",
          gap: 48,
          marginBottom: 24,
          fontFamily: "Geist Mono",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            GRADE
          </span>
          <span style={{ fontSize: 36, fontWeight: 700, color: gradeColor }}>
            {data.grade}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            PEG
          </span>
          <span style={{ fontSize: 28, fontWeight: 700 }}>
            ${data.pegPrice.toFixed(4)}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            DEWS
          </span>
          <span style={{ fontSize: 28, fontWeight: 700, color: dewsColor }}>
            {data.dewsBand}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            LIQUIDITY
          </span>
          <span style={{ fontSize: 28, fontWeight: 700 }}>
            {data.liquidityScore.toFixed(0)}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            PSI
          </span>
          <span style={{ fontSize: 28, fontWeight: 700, color: psiColor }}>
            {data.psiScore.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Secondary metrics row */}
      <div
        style={{
          display: "flex",
          gap: 48,
          marginBottom: 16,
          fontFamily: "Geist Mono",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            MARKET CAP
          </span>
          <span style={{ fontSize: 20 }}>{formatUsd(data.mcap)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            24H VOLUME
          </span>
          <span style={{ fontSize: 20 }}>{formatUsd(data.vol24h)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            7D FLOW
          </span>
          <span
            style={{
              fontSize: 20,
              color: data.flow7d >= 0 ? "#22c55e" : "#ef4444",
            }}
          >
            {sign}
            {formatUsd(data.flow7d)}
          </span>
        </div>
      </div>

      {/* Sparkline */}
      <Sparkline data={data.sparklineData} color={FROST_BLUE} />
    </CardFrame>
  );
}
