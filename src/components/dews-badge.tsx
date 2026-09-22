"use client";

import { THREAT_BAND_LABELS, THREAT_BAND_STYLES } from "@shared/lib/classification";
import { getTopDewsContributors } from "@/lib/dews-signal-utils";
import type { ThreatBand } from "@shared/lib/classification";

interface DEWSBadgeProps {
  score: number;
  band: ThreatBand;
  compact?: boolean;
  signals?: Record<string, { value: number; available: boolean }>;
}


export function DEWSBadge({
  score,
  band,
  compact,
  signals,
}: DEWSBadgeProps) {
  // Suppress CALM badges to reduce noise
  if (band === "CALM") return null;

  const colorClasses = THREAT_BAND_STYLES[band]?.cls ?? "";

  let tooltip = `DEWS: ${score}/100`;
  if (signals) {
    const top = getTopDewsContributors(signals, 2);
    if (top.length > 0) {
      tooltip += ` | Top: ${top.map((item) => `${item.label} (${Math.round(item.value)}/100)`).join(", ")}`;
    }
  }

  const pill = (
    <span
      title={tooltip}
      className={`inline-flex items-center rounded-sm border px-1 py-0.5 text-[10px] font-semibold leading-none ${colorClasses}`}
    >
      {compact ? band.slice(0, 1) : THREAT_BAND_LABELS[band]}
    </span>
  );

  return pill;
}
