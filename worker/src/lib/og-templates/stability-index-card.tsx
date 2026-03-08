import { CardFrame, Sparkline, TEXT_SECONDARY } from "./shared";

export interface StabilityIndexCardData {
  psiScore: number;
  psiBand: string;
  delta24h: number;
  sparklineData: number[];
  bands: Array<{ name: string; active: boolean }>;
}

// Hardcoded hex colors matching PSI_HEX_COLORS from shared/lib/psi-colors.ts
// (Satori cannot use CSS variables or runtime imports)
const BAND_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

function getBandColor(band: string): string {
  return BAND_COLORS[band] ?? "#8b8fa3";
}

export function StabilityIndexCard({
  data,
}: {
  data: StabilityIndexCardData;
}) {
  const bandColor = getBandColor(data.psiBand);
  const deltaColor =
    data.delta24h > 0 ? "#ef4444" : data.delta24h < 0 ? "#22c55e" : "#8b8fa3";
  // Higher PSI = worse stability, so positive delta = red (worsening), negative = green (improving)
  const deltaSign = data.delta24h > 0 ? "+" : "";

  return (
    <CardFrame
      title="Pharos Stability Index"
      subtitle="Market-wide Peg Health"
      borderTopColor={bandColor}
    >
      {/* Top section: score + sparkline */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Score + delta row */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 24,
            marginBottom: 16,
            fontFamily: "Geist Mono",
          }}
        >
          <span style={{ fontSize: 88, fontWeight: 700 }}>
            {data.psiScore.toFixed(1)}
          </span>
          <span style={{ fontSize: 32, fontWeight: 600, color: bandColor }}>
            {data.psiBand}
          </span>
          <span style={{ fontSize: 24, color: deltaColor }}>
            {deltaSign}
            {data.delta24h.toFixed(2)} 24h
          </span>
        </div>

        {/* Sparkline */}
        <Sparkline data={data.sparklineData} color={bandColor} />
      </div>

      {/* Band labels */}
      <div
        style={{
          display: "flex",
          gap: 16,
          fontFamily: "Geist Mono",
        }}
      >
        {data.bands.map((band) => (
          <div
            key={band.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 4,
              backgroundColor: band.active
                ? getBandColor(band.name) + "26" // ~15% opacity
                : "transparent",
              border: band.active
                ? `1px solid ${getBandColor(band.name)}`
                : "1px solid #1e293b",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: getBandColor(band.name),
                opacity: band.active ? 1 : 0.4,
              }}
            />
            <span
              style={{
                fontSize: 12,
                color: band.active ? getBandColor(band.name) : TEXT_SECONDARY,
                fontWeight: band.active ? 700 : 400,
                letterSpacing: "0.04em",
              }}
            >
              {band.name}
            </span>
          </div>
        ))}
      </div>
    </CardFrame>
  );
}
