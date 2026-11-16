import * as React from "react";
import { CardFrame, Sparkline, TEXT_SECONDARY } from "./shared";
import { PSI_HEX_COLORS } from "@shared/lib/classification";

export interface StabilityIndexCardData {
  psiScore: number;
  psiBand: string;
  delta24h: number | null;
  sparklineData: number[] | null;
  bands: Array<{ name: string; active: boolean }>;
  avg7d: number | null;
  retainedSampleHigh: number | null;
  retainedSampleLow: number | null;
  lastUpdated?: string;
}

function getBandColor(band: string): string {
  return PSI_HEX_COLORS[band as keyof typeof PSI_HEX_COLORS] ?? "#8b8fa3";
}

export function StabilityIndexCard({
  data,
}: {
  data: StabilityIndexCardData;
}) {
  const bandColor = getBandColor(data.psiBand);
  const deltaColor =
    data.delta24h != null && data.delta24h > 0 ? "#22c55e" : data.delta24h != null && data.delta24h < 0 ? "#ef4444" : "#8b8fa3";
  // Higher PSI = healthier conditions, so positive delta = green (improving), negative = red (worsening)
  const deltaSign = data.delta24h != null && data.delta24h > 0 ? "+" : "";
  return (
    <CardFrame
      title="Pharos Stability Index"
      subtitle="Market-wide Peg Health"
      borderTopColor={bandColor}
      lastUpdated={data.lastUpdated}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 24,
            marginBottom: 8,
            fontFamily: "Geist Mono",
          }}
        >
          <span style={{ fontSize: 120, fontWeight: 700 }}>
            {data.psiScore.toFixed(1)}
          </span>
          <span style={{ fontSize: 32, fontWeight: 600, color: bandColor }}>
            {data.psiBand}
          </span>
        </div>

        {/* 24h delta */}
        <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
          <span style={{ fontSize: 26, color: deltaColor, fontFamily: "Geist Mono" }}>
            {data.delta24h == null ? "24h change unavailable" : `${deltaSign}${data.delta24h.toFixed(2)} 24h`}
          </span>
          <span style={{ fontSize: 26, color: TEXT_SECONDARY, fontFamily: "Geist Mono" }}>
            7D AVG: {data.avg7d == null ? "—" : data.avg7d.toFixed(1)}
          </span>
        </div>

        {data.sparklineData ? <Sparkline data={data.sparklineData} color={bandColor} /> : (
          <span style={{ fontSize: 22, color: TEXT_SECONDARY }}>{"History unavailable \u00b7 fewer than two observations"}</span>
        )}
      </div>

    </CardFrame>
  );
}
