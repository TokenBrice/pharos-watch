import * as React from "react";
import { CardFrame, MetricLabel, TEXT_SECONDARY, SEMANTIC_COLORS } from "./shared";
import { THREAT_BAND_HEX } from "@shared/lib/classification";

export interface DepegCardData {
  activeDepegCount: number;
  activeDepegs: Array<{
    symbol: string;
    deviationBps: number | null;
    /** The deviation exists but its FX or metal reference market is closed. */
    deviationHeld?: boolean;
    peakBps?: number;
  }>;
  recoveredToday: number;
  newToday: number | null;
  lastUpdated?: string;
}

const DANGER_HEX = THREAT_BAND_HEX.DANGER;
const NORMAL_HEX = THREAT_BAND_HEX.CALM;

function getDeviationColor(bps: number): string {
  const absBps = Math.abs(bps);
  if (absBps > 200) return SEMANTIC_COLORS.negative; // Severe
  if (absBps > 100) return SEMANTIC_COLORS.warning;  // Moderate
  return "#fbbf24"; // Mild
}

export function DepegCard({ data }: { data: DepegCardData }) {
  const depegColor = data.activeDepegCount === 0 ? NORMAL_HEX : DANGER_HEX;
  return (
    <CardFrame title="Depeg Monitor" subtitle="Dated incident briefing" borderTopColor={depegColor} lastUpdated={data.lastUpdated}>
      <div style={{ display: "flex", gap: 56, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 410, gap: 10 }}>
          <MetricLabel>OPEN DEPEG EVENTS</MetricLabel>
          <span style={{ fontSize: 120, fontFamily: "Geist Mono", fontWeight: 700, lineHeight: 1.1, color: depegColor }}>
            {data.activeDepegCount}
          </span>
          <span style={{ fontSize: 26 }}>{data.recoveredToday} recovered today</span>
          <span style={{ fontSize: 26 }}>{data.newToday ?? "\u2014"} new today</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 18 }}>
          <MetricLabel>TOP {Math.min(data.activeDepegs.length, 3)} OF {data.activeDepegCount} OPEN INCIDENTS</MetricLabel>
          {data.activeDepegs.slice(0, 3).map((depeg) => (
            <div key={depeg.symbol} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 700 }}>{depeg.symbol}</span>
              <span style={{ fontSize: 22, color: depeg.deviationBps == null ? TEXT_SECONDARY : getDeviationColor(depeg.deviationBps) }}>
                {depeg.deviationBps == null
                  ? `${depeg.deviationHeld ? "Reference market closed" : "Current unavailable"}; peak ${depeg.peakBps ?? "N/A"} bps`
                  : `${depeg.deviationBps > 0 ? "+" : ""}${depeg.deviationBps} bps${depeg.peakBps != null ? ` (peak ${depeg.peakBps})` : ""}`}
              </span>
            </div>
          ))}
          {data.activeDepegs.length === 0 && <span style={{ fontSize: 26, color: TEXT_SECONDARY }}>No open incidents in this reading</span>}
        </div>
      </div>
    </CardFrame>
  );
}
