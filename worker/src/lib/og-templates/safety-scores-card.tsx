import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, FROST_BLUE, GRADE_COLORS, SEMANTIC_COLORS } from "./shared";

export interface SafetyScoresCardData {
  gradeDistribution: Record<string, number>;
  pulseGrade: string;
  pulseScore: number;
  coverageRatio: number; // 0-1
  totalCoins: number;
  // New fields
  topPerformers: Array<{ symbol: string; grade: string; score: number }>;
  bottomPerformers: Array<{ symbol: string; grade: string; score: number }>;
  trend: number | null; // week-over-week change
  lastUpdated?: string;
}

/** Get trend arrow and color */
function getTrendIndicator(trend: number | null): { arrow: string; color: string } {
  if (trend === null) return { arrow: "—", color: TEXT_SECONDARY };
  if (trend > 0) return { arrow: "↑", color: SEMANTIC_COLORS.positive };
  if (trend < 0) return { arrow: "↓", color: SEMANTIC_COLORS.negative };
  return { arrow: "→", color: TEXT_SECONDARY };
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
  const trend = getTrendIndicator(data.trend);
  
  // Filter out zero counts for cleaner display
  const filteredDistribution = Object.entries(data.gradeDistribution)
    .filter(([, count]) => count > 0)
    .slice(0, 8); // Show max 8 grades

  return (
    <CardFrame 
      title="Safety Scores" 
      subtitle="Report Card Overview"
      lastUpdated={data.lastUpdated}
    >
      {/* Grade distribution - horizontal layout */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <MetricLabel>GRADE DISTRIBUTION</MetricLabel>
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

      {/* Middle section: Pulse + Coverage + Trend */}
      <div style={{ display: "flex", gap: 60, fontFamily: "Geist Mono" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <MetricLabel>MARKET PULSE</MetricLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 56, fontWeight: 700, color: FROST_BLUE }}>
              {data.pulseGrade}
            </span>
            <span 
              style={{ 
                fontSize: 24, 
                color: trend.color,
                fontWeight: 700,
              }}
            >
              {trend.arrow}
            </span>
          </div>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.pulseScore.toFixed(1)} / 100
          </span>
          {data.trend !== null && (
            <span style={{ fontSize: 14, color: trend.color }}>
              {data.trend >= 0 ? "+" : ""}{data.trend.toFixed(1)}% vs last week
            </span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <MetricLabel>COVERAGE</MetricLabel>
          <span style={{ fontSize: 56, fontWeight: 700 }}>
            {(data.coverageRatio * 100).toFixed(0)}%
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
