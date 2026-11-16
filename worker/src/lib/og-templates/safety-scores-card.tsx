import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, GRADE_COLORS, TRACK_BG } from "./shared";

export interface SafetyScoresCardData {
  gradeDistribution: Record<string, number>;
  pulseScore: number | null;
  coverageRatio: number | null; // 0-1; null when the safety source is unavailable
  totalCoins: number;
  unavailableCount: number | null;
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


export function SafetyScoresCard({ data }: { data: SafetyScoresCardData }) {
  // Retain every published bucket in an exact letter-family total.
  const distribution = Object.entries(data.gradeDistribution);
  const families = ["A", "B", "C", "D", "F", "NR"].map((family) => ({
    grade: family,
    count: distribution.reduce(
      (sum, [grade, count]) => sum + (grade === family || grade === `${family}+` || grade === `${family}-` ? count : 0),
      0,
    ),
  }));
  const maxCount = Math.max(1, ...families.map(({ count }) => count));
  return (
    <CardFrame title="Safety Scores" subtitle="Dated market briefing" lastUpdated={data.lastUpdated}>
      <div style={{ display: "flex", alignItems: "center", gap: 56 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 410, gap: 10 }}>
          <MetricLabel>AVERAGE SCORE</MetricLabel>
          <span style={{ fontSize: data.pulseScore == null ? 44 : 96, fontWeight: 700, fontFamily: "Geist Mono", lineHeight: 1.1 }}>
            {data.pulseScore !== null ? data.pulseScore.toFixed(1) : "Unavailable"}
          </span>
          <span style={{ fontSize: 22, color: TEXT_SECONDARY }}>
            {data.pulseScore !== null ? "/ 100 \u00b7 no aggregate grade" : "Safety score unavailable"}
          </span>
          <span style={{ fontSize: 26, fontFamily: "Geist Mono" }}>
            {formatCoverageRatio(data.coverageRatio)} rated coverage
          </span>
          <span style={{ fontSize: 22, color: TEXT_SECONDARY }}>{data.totalCoins} active coins</span>
          <span style={{ fontSize: 22, color: TEXT_SECONDARY }}>
            {data.unavailableCount == null ? "Unavailable membership unknown" : `${data.gradeDistribution.NR ?? 0} not rated \u00b7 ${data.unavailableCount} unavailable (pipeline gap)`}
          </span>
        </div>
        <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 16 }}>
          <MetricLabel>GRADE DISTRIBUTION</MetricLabel>
          <span style={{ fontSize: 20, color: TEXT_SECONDARY }}>Letter families include + / - grades</span>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 18, height: 180 }}>
            {families.map(({ grade, count }) => (
              <div key={grade} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", flex: 1, gap: 8 }}>
                <span style={{ fontSize: 26, fontWeight: 700 }}>{data.coverageRatio == null ? "\u2014" : count}</span>
                <div style={{ display: "flex", height: 110 * count / maxCount + 2, width: 52, backgroundColor: data.coverageRatio == null ? TRACK_BG : GRADE_COLORS[grade] }} />
                <span style={{ fontSize: 24, fontWeight: 700 }}>{grade}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </CardFrame>
  );
}
