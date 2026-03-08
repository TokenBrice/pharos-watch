import { CardFrame, TEXT_SECONDARY, FROST_BLUE } from "./shared";

export interface SafetyScoresCardData {
  gradeDistribution: Record<string, number>;
  pulseGrade: string;
  pulseScore: number;
  coverageRatio: number; // 0-1
  totalCoins: number;
}

export function SafetyScoresCard({ data }: { data: SafetyScoresCardData }) {
  return (
    <CardFrame title="Safety Scores" subtitle="Report Card Overview">
      {/* Grade distribution row */}
      <div
        style={{
          display: "flex",
          gap: 28,
          fontFamily: "Geist Mono",
        }}
      >
        {Object.entries(data.gradeDistribution).map(([grade, count]) => (
          <div
            key={grade}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
              {grade}
            </span>
            <span style={{ fontSize: 32, fontWeight: 700 }}>{count}</span>
          </div>
        ))}
      </div>

      {/* Pulse + coverage */}
      <div style={{ display: "flex", gap: 80, fontFamily: "Geist Mono" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            MARKET PULSE
          </span>
          <span style={{ fontSize: 64, fontWeight: 700, color: FROST_BLUE }}>
            {data.pulseGrade}
          </span>
          <span style={{ fontSize: 18, color: TEXT_SECONDARY }}>
            {data.pulseScore.toFixed(1)} / 100
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
            COVERAGE
          </span>
          <span style={{ fontSize: 64, fontWeight: 700 }}>
            {(data.coverageRatio * 100).toFixed(0)}%
          </span>
          <span style={{ fontSize: 18, color: TEXT_SECONDARY }}>
            {data.totalCoins} coins tracked
          </span>
        </div>
      </div>
    </CardFrame>
  );
}
