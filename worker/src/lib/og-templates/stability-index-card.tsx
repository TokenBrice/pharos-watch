import * as React from "react";
import { CardFrame, Sparkline, TEXT_SECONDARY, SEMANTIC_COLORS } from "./shared";
import { PSI_HEX_COLORS } from "@shared/lib/psi-colors";

export interface StabilityIndexCardData {
  psiScore: number;
  psiBand: string;
  delta24h: number;
  sparklineData: number[];
  bands: Array<{ name: string; active: boolean }>;
  // New fields
  avg7d: number;
  allTimeHigh: number;
  allTimeLow: number;
  flightToQuality: boolean;
  flightIntensity: number | null;
  lastUpdated?: string;
}

function getBandColor(band: string): string {
  return PSI_HEX_COLORS[band as keyof typeof PSI_HEX_COLORS] ?? "#8b8fa3";
}

/** Get position percentage for thermometer (0 = BEDROCK/healthy, 100 = MELTDOWN/crisis) */
function getThermometerPosition(score: number): number {
  // PSI ranges from 0 (worst) to 100 (best)
  // Thermometer runs left (healthy) -> right (stress), so invert the score.
  return Math.min(100, Math.max(0, 100 - score));
}

export function StabilityIndexCard({
  data,
}: {
  data: StabilityIndexCardData;
}) {
  const bandColor = getBandColor(data.psiBand);
  const deltaColor =
    data.delta24h > 0 ? "#22c55e" : data.delta24h < 0 ? "#ef4444" : "#8b8fa3";
  // Higher PSI = healthier conditions, so positive delta = green (improving), negative = red (worsening)
  const deltaSign = data.delta24h > 0 ? "+" : "";
  
  // Calculate position for thermometer
  const thermoPosition = getThermometerPosition(data.psiScore);

  return (
    <CardFrame
      title="Pharos Stability Index"
      subtitle="Market-wide Peg Health"
      borderTopColor={bandColor}
      lastUpdated={data.lastUpdated}
    >
      {/* Top section: score + context */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Score + band row */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 24,
            marginBottom: 8,
            fontFamily: "Geist Mono",
          }}
        >
          <span style={{ fontSize: 80, fontWeight: 700 }}>
            {data.psiScore.toFixed(1)}
          </span>
          <span style={{ fontSize: 32, fontWeight: 600, color: bandColor }}>
            {data.psiBand}
          </span>
        </div>

        {/* 24h delta */}
        <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
          <span style={{ fontSize: 20, color: deltaColor, fontFamily: "Geist Mono" }}>
            {deltaSign}{data.delta24h.toFixed(2)} 24h
          </span>
          <span style={{ fontSize: 20, color: TEXT_SECONDARY, fontFamily: "Geist Mono" }}>
            7D AVG: {data.avg7d.toFixed(1)}
          </span>
        </div>

        {/* Larger Sparkline */}
        <Sparkline data={data.sparklineData} color={bandColor} />
      </div>

      {/* Context row: ATH/ATL + Flight to Quality */}
      <div
        style={{
          display: "flex",
          gap: 40,
          fontFamily: "Geist Mono",
          fontSize: 14,
        }}
      >
        <div style={{ display: "flex", gap: 16 }}>
          <span style={{ color: TEXT_SECONDARY }}>
            ATH: <span style={{ color: SEMANTIC_COLORS.positive, fontWeight: 600 }}>{data.allTimeHigh.toFixed(1)}</span>
          </span>
          <span style={{ color: TEXT_SECONDARY }}>
            ATL: <span style={{ color: SEMANTIC_COLORS.negative, fontWeight: 600 }}>{data.allTimeLow.toFixed(1)}</span>
          </span>
        </div>
        {data.flightToQuality && (
          <span style={{ color: SEMANTIC_COLORS.warning, fontWeight: 600 }}>
            ⚠ FLIGHT TO QUALITY {data.flightIntensity ? `(${(data.flightIntensity * 100).toFixed(0)}%)` : ""}
          </span>
        )}
      </div>

      {/* Thermometer-style band visualization */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span
          style={{
            fontSize: 12,
            color: TEXT_SECONDARY,
            letterSpacing: "0.06em",
            fontFamily: "Geist Sans",
          }}
        >
          MARKET CONDITION
        </span>
        
        {/* Thermometer bar */}
        <div style={{ display: "flex", position: "relative", height: 32, width: "100%" }}>
          {/* Gradient background bar */}
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 0,
              right: 0,
              height: 8,
              borderRadius: 4,
              background: `linear-gradient(to right, ${PSI_HEX_COLORS.BEDROCK} 0%, ${PSI_HEX_COLORS.STEADY} 20%, ${PSI_HEX_COLORS.TREMOR} 40%, ${PSI_HEX_COLORS.FRACTURE} 60%, ${PSI_HEX_COLORS.CRISIS} 80%, ${PSI_HEX_COLORS.MELTDOWN} 100%)`,
            }}
          />
          
          {/* Position indicator */}
          <div
            style={{
              position: "absolute",
              top: 4,
              left: `${thermoPosition}%`,
              transform: "translateX(-50%)",
              width: 0,
              height: 0,
              borderLeft: "10px solid transparent",
              borderRight: "10px solid transparent",
              borderTop: `12px solid ${bandColor}`,
            }}
          />
          
          {/* Value label at position */}
          <div
            style={{
              position: "absolute",
              top: 18,
              left: `${thermoPosition}%`,
              transform: "translateX(-50%)",
              fontSize: 12,
              fontWeight: 700,
              color: bandColor,
              fontFamily: "Geist Mono",
            }}
          >
            {data.psiScore.toFixed(1)}
          </div>
        </div>

        {/* Band labels */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "Geist Mono",
            fontSize: 11,
            color: TEXT_SECONDARY,
          }}
        >
          {data.bands.map((band) => (
            <span
              key={band.name}
              style={{
                fontWeight: band.active ? 700 : 400,
                color: band.active ? getBandColor(band.name) : TEXT_SECONDARY,
              }}
            >
              {band.name}
            </span>
          ))}
        </div>
      </div>
    </CardFrame>
  );
}
