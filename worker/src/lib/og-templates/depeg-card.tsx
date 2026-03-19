import { CardFrame, TEXT_SECONDARY, SEMANTIC_COLORS } from "./shared";
import { THREAT_BAND_HEX } from "@shared/lib/classification";

export interface DepegCardData {
  activeDepegCount: number;
  psiScore: number;
  psiBand: string;
  coinsAtPeg: number;
  totalCoins: number;
  dewsDistribution: {
    danger: number;
    alert: number;
    warning: number;
    normal: number;
  };
  // New fields
  activeDepegs: Array<{
    symbol: string;
    name: string;
    deviationBps: number;
  }>;
  recoveredToday: number;
  newToday: number;
  lastUpdated?: string;
}

const DANGER_HEX = THREAT_BAND_HEX.DANGER;
const ALERT_HEX = THREAT_BAND_HEX.ALERT;
const WARNING_HEX = THREAT_BAND_HEX.WARNING;
const NORMAL_HEX = THREAT_BAND_HEX.CALM;

/** Get color based on deviation severity */
function getDeviationColor(bps: number): string {
  const absBps = Math.abs(bps);
  if (absBps > 200) return SEMANTIC_COLORS.negative; // Severe
  if (absBps > 100) return SEMANTIC_COLORS.warning;  // Moderate
  return "#fbbf24"; // Mild
}

export function DepegCard({ data }: { data: DepegCardData }) {
  const depegColor = data.activeDepegCount === 0 ? NORMAL_HEX : DANGER_HEX;

  return (
    <CardFrame
      title="Depeg Monitor"
      subtitle="Real-time Peg Tracking"
      borderTopColor={depegColor}
      lastUpdated={data.lastUpdated}
    >
      {/* Top row: active depegs + PSI score + At Peg */}
      <div
        style={{
          display: "flex",
          gap: 60,
          fontFamily: "Geist Mono",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            ACTIVE DEPEGS
          </span>
          <span style={{ fontSize: 64, fontWeight: 700, color: depegColor }}>
            {data.activeDepegCount}
          </span>
          {/* Recovery stats */}
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <span style={{ color: SEMANTIC_COLORS.positive }}>
              ↑ {data.recoveredToday} recovered
            </span>
            <span style={{ color: SEMANTIC_COLORS.negative }}>
              ↓ {data.newToday} new
            </span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            PSI SCORE
          </span>
          <span style={{ fontSize: 64, fontWeight: 700 }}>
            {data.psiScore.toFixed(1)}
          </span>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.psiBand}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            AT PEG
          </span>
          <span style={{ fontSize: 64, fontWeight: 700 }}>
            {data.coinsAtPeg}
            <span style={{ fontSize: 24, color: TEXT_SECONDARY }}>
              /{data.totalCoins}
            </span>
          </span>
        </div>
      </div>

      {/* Active depegs list - show top 5 */}
      {data.activeDepegs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span
            style={{
              fontSize: 14,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            CURRENTLY DEPEGGED (TOP {Math.min(data.activeDepegs.length, 5)})
          </span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "12px 32px",
              fontFamily: "Geist Mono",
            }}
          >
            {data.activeDepegs.slice(0, 5).map((depeg) => (
              <div
                key={depeg.symbol}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 180,
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 600 }}>
                  {depeg.symbol}
                </span>
                <span
                  style={{
                    fontSize: 14,
                    color: getDeviationColor(depeg.deviationBps),
                    fontWeight: 700,
                  }}
                >
                  {depeg.deviationBps > 0 ? "+" : ""}
                  {depeg.deviationBps} bps
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* DEWS distribution */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span
          style={{
            fontSize: 14,
            color: TEXT_SECONDARY,
            letterSpacing: "0.06em",
          }}
        >
          DEWS DISTRIBUTION
        </span>
        <div
          style={{
            display: "flex",
            gap: 32,
            fontFamily: "Geist Mono",
          }}
        >
          {(
            [
              { label: "DANGER", count: data.dewsDistribution.danger, color: DANGER_HEX },
              { label: "ALERT", count: data.dewsDistribution.alert, color: ALERT_HEX },
              { label: "WARNING", count: data.dewsDistribution.warning, color: WARNING_HEX },
              { label: "NORMAL", count: data.dewsDistribution.normal, color: NORMAL_HEX },
            ] as const
          ).map((band) => (
            <div
              key={band.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  backgroundColor: band.color,
                }}
              />
              <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>
                {band.label}
              </span>
              <span style={{ fontSize: 24, fontWeight: 700 }}>
                {band.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </CardFrame>
  );
}
