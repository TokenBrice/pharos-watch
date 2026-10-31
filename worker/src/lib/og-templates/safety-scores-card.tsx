import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, FROST_BLUE, GRADE_COLORS, SEMANTIC_COLORS } from "./shared";

export interface SafetyScoresCardData {
  gradeDistribution: Record<string, number>;
  pulseScore: number | null;
  coverageRatio: number | null; // 0-1; null when the safety source is unavailable
  totalCoins: number;
  // New fields
  topPerformers: Array<{ symbol: string; grade: string; score: number }>;
  bottomPerformers: Array<{ symbol: string; grade: string; score: number }>;
  safetyModel?: "v8" | "v9" | null;
  lastUpdated?: string;
}

/**
 * A nonzero coverage shortfall never prints as a complete 100%, and a measured
 * sliver never prints as the observed zero (ADR-34).
 */
function formatCoverageRatio(ratio: number | null): string {
  if (ratio == null) return "—";
  if (ratio === 0) return "0%";
  if (ratio === 1) return "100%";
  if (ratio < 0.001) return "<0.1%";
  const rounded = (ratio * 100).toFixed(1);
  return ratio < 1 && Number(rounded) >= 100 ? "<100%" : `${rounded}%`;
}

function PerformerList({
  title,
  accentColor,
  coins,
}: {
  title: string;
  accentColor: string;
  coins: SafetyScoresCardData["topPerformers"];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span
        style={{
          fontSize: 13,
          color: accentColor,
          letterSpacing: "0",
          fontWeight: 600,
        }}
      >
        {title}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {coins.map((coin) => (
          <div
            key={coin.symbol}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontFamily: "Geist Mono",
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, minWidth: 60 }}>
              {coin.symbol}
            </span>
            <span
              style={{
                fontSize: 14,
                color: GRADE_COLORS[coin.grade] || TEXT_SECONDARY,
                fontWeight: 700,
                minWidth: 30,
              }}
            >
              {coin.grade}
            </span>
            <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>
              {coin.score.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SafetyScoresCard({ data }: { data: SafetyScoresCardData }) {
  // Filter out zero counts for cleaner display; every nonzero grade must stay
  // visible (ADR-34: the block is the published distribution, not a top-N slice).
  const filteredDistribution = Object.entries(data.gradeDistribution)
    .filter(([, count]) => count > 0);

  return (
    <CardFrame 
      title="Safety Scores" 
      subtitle={data.safetyModel ? `${data.safetyModel.toUpperCase()} Report Card Overview` : "Report Card Overview"}
      lastUpdated={data.lastUpdated}
    >
      {/* Grade distribution - horizontal layout */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <MetricLabel>
          {data.safetyModel ? `${data.safetyModel.toUpperCase()} GRADE DISTRIBUTION` : "GRADE DISTRIBUTION"}
        </MetricLabel>
        <div
          style={{
            display: "flex",
            gap: 20,
            fontFamily: "Geist Mono",
          }}
        >
          {filteredDistribution.map(([grade, count]) => (
            <div
              key={grade}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                minWidth: 50,
              }}
            >
              <span 
                style={{ 
                  fontSize: 14, 
                  color: GRADE_COLORS[grade] || TEXT_SECONDARY,
                  fontWeight: 600,
                }}
              >
                {grade}
              </span>
              <span style={{ fontSize: 28, fontWeight: 700 }}>{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Middle section: Average score + Coverage */}
      <div style={{ display: "flex", gap: 60, fontFamily: "Geist Mono" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <MetricLabel>AVERAGE SCORE</MetricLabel>
          <span style={{ fontSize: 56, fontWeight: 700, color: FROST_BLUE }}>
            {data.pulseScore !== null ? data.pulseScore.toFixed(1) : "NR"}
          </span>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.pulseScore !== null ? "/ 100 · no aggregate grade" : "Safety score unavailable"}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <MetricLabel>COVERAGE</MetricLabel>
          <span style={{ fontSize: 56, fontWeight: 700 }}>
            {formatCoverageRatio(data.coverageRatio)}
          </span>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.totalCoins} active coins
          </span>
        </div>
      </div>

      {/* Bottom section: Top and Bottom performers */}
      <div style={{ display: "flex", gap: 80 }}>
        <PerformerList
          title="TOP 3 SAFEST"
          accentColor={SEMANTIC_COLORS.positive}
          coins={data.topPerformers}
        />
        <PerformerList
          title="BOTTOM 3 RISKIEST"
          accentColor={SEMANTIC_COLORS.negative}
          coins={data.bottomPerformers}
        />
      </div>
    </CardFrame>
  );
}
