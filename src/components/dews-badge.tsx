"use client";

import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@shared/lib/classification";
import type { ThreatBand } from "@shared/lib/classification";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import { getTopDewsContributors } from "@/lib/dews-signal-utils";
import type { MethodologyContextKey } from "@/lib/methodology-context";

interface DEWSBadgeProps {
  score: number;
  band: ThreatBand;
  prevScore?: number;
  compact?: boolean;
  signals?: Record<string, { value: number; available: boolean }>;
  /**
   * When set, wraps the badge in `<ScoreBadgeWrapper>` so it carries the
   * methodology-aware tooltip and (per `versionVariant`) the inline `vX.Y`
   * version suffix. Per W3-B Stage 5: compact tape-context badges should
   * not append the suffix; pass `versionVariant="tooltip-only"`.
   */
  versionTopic?: MethodologyContextKey;
  versionVariant?: ScoreBadgeWrapperVariant;
}

export function DEWSBadge({ score, band, prevScore, compact, signals, versionTopic, versionVariant }: DEWSBadgeProps) {
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

  const badge = (
    <span
      title={tooltip}
      className={`inline-flex items-center rounded-sm border px-1 py-0.5 text-[10px] font-semibold leading-none ${colorClasses}`}
    >
      {compact ? band.slice(0, 1) : THREAT_BAND_LABELS[band]}
      {arrow}
    </span>
  );

  if (versionTopic) {
    // Per Stage 5 rule #4: compact 1-char DEWS badges in tape contexts
    // never get the suffix; force tooltip-only mode if compact is true and
    // no explicit variant was passed.
    const resolvedVariant: ScoreBadgeWrapperVariant = versionVariant ?? (compact ? "tooltip-only" : "suffix");
    return (
      <ScoreBadgeWrapper topic={versionTopic} variant={resolvedVariant}>
        {badge}
      </ScoreBadgeWrapper>
    );
  }
  return badge;
}
