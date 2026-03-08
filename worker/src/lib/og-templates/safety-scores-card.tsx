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
          gap: 24,
          marginBottom: 32,
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
              gap: 4,
            }}
          >
            <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>
              {grade}
            </span>
            <span style={{ fontSize: 24, fontWeight: 700 }}>{count}</span>
          </div>
        ))}
      </div>

      {/* Pulse + coverage */}
      <div style={{ display: "flex", gap: 64, fontFamily: "Geist Mono" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 12,
              color: TEXT_SECONDARY,
              letterSpacing: "0.06em",
            }}
          >
            MARKET PULSE
          </span>
          <span style={{ fontSize: 48, fontWeight: 700, color: FROST_BLUE }}>
            {data.pulseGrade}
          </span>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.pulseScore.toFixed(1)} / 100
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
            COVERAGE
          </span>
          <span style={{ fontSize: 48, fontWeight: 700 }}>
            {(data.coverageRatio * 100).toFixed(0)}%
          </span>
          <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
            {data.totalCoins} coins tracked
          </span>
        </div>
      </div>
    </CardFrame>
  );
}
