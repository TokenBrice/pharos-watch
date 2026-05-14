"use client";

import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@shared/lib/classification";
import type { ThreatBand } from "@shared/lib/classification";
import { getTopDewsContributors } from "@/lib/dews-signal-utils";

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

  let tooltip = `DEWS: ${score}/100`;
  if (signals) {
    const top = getTopDewsContributors(signals, 2);
    if (top.length > 0) {
      tooltip += ` | Top: ${top.map((item) => `${item.label} (${Math.round(item.value)}/100)`).join(", ")}`;
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
