"use client";

import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@shared/lib/classification";
import type { ThreatBand } from "@shared/lib/classification";

interface DEWSBadgeProps {
  score: number;
  band: ThreatBand;
  prevScore?: number;
  compact?: boolean;
  signals?: Record<string, { value: number; available: boolean }>;
}

export function DEWSBadge({ score, band, prevScore, compact, signals }: DEWSBadgeProps) {
  // Suppress CALM badges to reduce noise
  if (band === "CALM") return null;

  const arrow = prevScore !== undefined && score > prevScore ? " \u25B2" : "";
  const colorClasses = THREAT_BAND_COLORS[band] ?? "";

  // Find the top contributing signal for tooltip
  let tooltip = `DEWS: ${score}/100`;
  if (signals) {
    const sorted = Object.entries(signals)
      .filter(([, s]) => s.available)
      .sort(([, a], [, b]) => b.value - a.value);
    if (sorted.length > 0) {
      tooltip += ` | Top: ${sorted[0][0]} (${sorted[0][1].value}/100)`;
    }
  }

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center rounded-sm border px-1 py-0.5 text-[10px] font-semibold leading-none ${colorClasses}`}
    >
      {compact ? band.slice(0, 1) : THREAT_BAND_LABELS[band]}
      {arrow}
    </span>
  );
}
