import { CardFrame, Sparkline, TEXT_SECONDARY, FROST_BLUE } from "./shared";
import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { PSI_HEX_COLORS } from "@shared/lib/psi-colors";
import { formatCurrency } from "@shared/lib/format";

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
  vol24h: number | null;
  flow7d: number;
  sparklineData: number[];
  hasActiveDepeg: boolean;
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
  const gradeColor = GRADE_RADAR_COLORS[gradeRange(data.grade as Parameters<typeof gradeRange>[0])] ?? TEXT_SECONDARY;
  const dewsColor = THREAT_BAND_HEX[data.dewsBand as keyof typeof THREAT_BAND_HEX] ?? TEXT_SECONDARY;
  const psiColor = PSI_HEX_COLORS[data.psiBand as keyof typeof PSI_HEX_COLORS] ?? TEXT_SECONDARY;
  const sign = data.flow7d >= 0 ? "+" : "";
  const secondaryMetrics = [
    { label: "MARKET CAP", value: formatCurrency(data.mcap, 1) },
    ...(data.vol24h != null
      ? [{ label: "24H VOLUME", value: formatCurrency(data.vol24h, 1) }]
      : []),
    {
      label: "7D FLOW",
      value: `${sign}${formatCurrency(data.flow7d, 1)}`,
      color: data.flow7d >= 0 ? "#22c55e" : "#ef4444",
    },
  ];

  return (
    <CardFrame
      title={`${data.name} (${data.symbol})`}
      subtitle="Stablecoin Intelligence"
      borderTopColor={treatment.borderTopColor}
      badge={treatment.badge}
    >
      {/* Top section: metrics */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Primary metrics row */}
        <div
          style={{
            display: "flex",
            gap: 56,
            marginBottom: 28,
            fontFamily: "Geist Mono",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                color: TEXT_SECONDARY,
                letterSpacing: "0.06em",
              }}
            >
              GRADE
            </span>
            <span style={{ fontSize: 44, fontWeight: 700, color: gradeColor }}>
              {data.grade}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                color: TEXT_SECONDARY,
                letterSpacing: "0.06em",
              }}
            >
              PEG
            </span>
            <span style={{ fontSize: 36, fontWeight: 700 }}>
              ${data.pegPrice.toFixed(4)}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                color: TEXT_SECONDARY,
                letterSpacing: "0.06em",
              }}
            >
              DEWS
            </span>
            <span style={{ fontSize: 36, fontWeight: 700, color: dewsColor }}>
              {data.dewsBand}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                color: TEXT_SECONDARY,
                letterSpacing: "0.06em",
              }}
            >
              LIQUIDITY
            </span>
            <span style={{ fontSize: 36, fontWeight: 700 }}>
              {data.liquidityScore.toFixed(0)}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                color: TEXT_SECONDARY,
                letterSpacing: "0.06em",
              }}
            >
              PSI
            </span>
            <span style={{ fontSize: 36, fontWeight: 700, color: psiColor }}>
              {data.psiScore.toFixed(1)}
            </span>
          </div>
        </div>

        {/* Secondary metrics row */}
        <div
          style={{
            display: "flex",
            gap: 56,
            fontFamily: "Geist Mono",
          }}
        >
          {secondaryMetrics.map((metric) => (
            <div
              key={metric.label}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <span
                style={{
                  fontSize: 14,
                  color: TEXT_SECONDARY,
                  letterSpacing: "0.06em",
                }}
              >
                {metric.label}
              </span>
              <span
                style={{
                  fontSize: 24,
                  ...(metric.color ? { color: metric.color } : {}),
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
