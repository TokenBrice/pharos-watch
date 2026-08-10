"use client";

import { THREAT_BAND_LABELS, THREAT_BAND_STYLES } from "@shared/lib/classification";
import { THREAT_BAND_HEX } from "@/lib/chart-colors";
import { clampScore } from "@shared/lib/math";
import type { ThreatBand } from "@shared/lib/classification";
import { ScoreBadgeWrapper, type ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import { getTopDewsContributors } from "@/lib/dews-signal-utils";
import type { MethodologyContextKey } from "@/lib/methodology-context";

/**
 * Four threat-band ranges drawn on the 0-100 hairline strip.
 * CALM is intentionally collapsed into WATCH on the strip \u2014 the strip exists
 * to show distance to higher bands, not to celebrate calm.
 */
const STRIP_BANDS = [
  { x1: 0, x2: 25, hex: THREAT_BAND_HEX.WATCH, label: "Watch" },
  { x1: 25, x2: 50, hex: THREAT_BAND_HEX.ALERT, label: "Alert" },
  { x1: 50, x2: 75, hex: THREAT_BAND_HEX.WARNING, label: "Warning" },
  { x1: 75, x2: 100, hex: THREAT_BAND_HEX.DANGER, label: "Danger" },
] as const;

interface DewsBandStripProps {
  score: number;
  prevScore?: number;
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Compact 60\u00D714 "score on band" strip \u2014 0..100 rail with four threat-band
 * ranges at low opacity, a notched tick for the current score, and a ghost
 * notch for the 24h-ago score. Pure inline SVG so it composes anywhere
 * (badges, card headers, table cells).
 */
function DewsBandStrip({
  score,
  prevScore,
  width = 60,
  height = 14,
  className,
  ariaLabel,
}: DewsBandStripProps) {
  const scoreX = (clampScore(score) / 100) * width;
  const prevX = prevScore !== undefined ? (clampScore(prevScore) / 100) * width : null;
  const railY1 = height * 0.22;
  const railY2 = height * 0.78;
  const computedAria =
    ariaLabel ??
    `DEWS score ${Math.round(score)} of 100${prevScore !== undefined ? `, 24h ago ${Math.round(prevScore)}` : ""}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={computedAria}
      className={className}
    >
      <title>{computedAria}</title>
      {STRIP_BANDS.map((band) => {
        const x = (band.x1 / 100) * width;
        const w = ((band.x2 - band.x1) / 100) * width;
        return (
          <rect
            key={band.label}
            x={x}
            y={railY1}
            width={w}
            height={railY2 - railY1}
            fill={band.hex}
            fillOpacity={0.18}
          />
        );
      })}
      <line
        x1={0}
        x2={width}
        y1={height / 2}
        y2={height / 2}
        stroke="var(--color-border)"
        strokeWidth={0.75}
      />
      {prevX !== null && (
        <line
          x1={prevX}
          x2={prevX}
          y1={1}
          y2={height - 1}
          stroke="var(--color-muted-foreground)"
          strokeOpacity={0.4}
          strokeWidth={1}
          strokeDasharray="2 1.5"
        />
      )}
      <line
        x1={scoreX}
        x2={scoreX}
        y1={0}
        y2={height}
        stroke="var(--color-foreground)"
        strokeWidth={1.5}
      />
      <rect
        x={Math.max(0, scoreX - 1.75)}
        y={height / 2 - 2}
        width={3.5}
        height={4}
        fill="var(--color-foreground)"
        rx={0.5}
      />
    </svg>
  );
}

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
  /**
   * Render the 60\u00D714 "score on band" strip next to the badge. Gated behind
   * `lg+` viewports so it never crowds dense table rows on mobile.
   */
  showBandStrip?: boolean;
}

export function DEWSBadge({
  score,
  band,
  prevScore,
  compact,
  signals,
  versionTopic,
  versionVariant,
  showBandStrip,
}: DEWSBadgeProps) {
  // Suppress CALM badges to reduce noise
  if (band === "CALM") return null;

  const arrow = prevScore !== undefined && score > prevScore ? " \u25B2" : "";
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
      {arrow}
    </span>
  );

  const badge = showBandStrip ? (
    <span className="inline-flex items-center gap-1.5 align-middle">
      {pill}
      <span className="hidden lg:inline-flex">
        <DewsBandStrip score={score} prevScore={prevScore} />
      </span>
    </span>
  ) : (
    pill
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
