import { CardFrame, TEXT_SECONDARY } from "./shared";
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
}

const DANGER_HEX = THREAT_BAND_HEX.DANGER;
const ALERT_HEX = THREAT_BAND_HEX.ALERT;
const WARNING_HEX = THREAT_BAND_HEX.WARNING;
const NORMAL_HEX = THREAT_BAND_HEX.CALM;

export function DepegCard({ data }: { data: DepegCardData }) {
  const depegColor = data.activeDepegCount === 0 ? NORMAL_HEX : DANGER_HEX;

  return (
    <CardFrame
      title="Depeg Monitor"
      subtitle="Real-time Peg Tracking"
      borderTopColor={depegColor}
    >
      {/* Top row: active depegs + PSI score */}
      <div
        style={{
          display: "flex",
          gap: 80,
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
          <span style={{ fontSize: 72, fontWeight: 700, color: depegColor }}>
            {data.activeDepegCount}
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
            PSI SCORE
          </span>
          <span style={{ fontSize: 72, fontWeight: 700 }}>
            {data.psiScore.toFixed(1)}
          </span>
          <span style={{ fontSize: 18, color: TEXT_SECONDARY }}>
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
          <span style={{ fontSize: 72, fontWeight: 700 }}>
            {data.coinsAtPeg}
            <span style={{ fontSize: 28, color: TEXT_SECONDARY }}>
              /{data.totalCoins}
            </span>
          </span>
        </div>
      </div>

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
            gap: 40,
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
              <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
                {band.label}
              </span>
              <span style={{ fontSize: 28, fontWeight: 700 }}>
                {band.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </CardFrame>
  );
}
