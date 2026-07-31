import * as React from "react";
import type { ReactNode } from "react";

// Matches the current light product shell used by static route captures.
const BG = "#f8f8fa";
const TEXT_PRIMARY = "#171719";
const TEXT_SECONDARY = "#5f6570";
const FROST_BLUE = "#0e7490";
export const TRACK_BG = "#e4e7eb";

// Semantic colors for data visualization
export const SEMANTIC_COLORS = {
  positive: "#15803d",   // Green for good/up
  negative: "#dc2626",   // Red for bad/down
  warning: "#b45309",    // Orange for caution
  neutral: "#64748b",    // Gray for neutral
  highlight: "#0e7490",  // Frost blue for highlights
};

/**
 * Grade-to-hex mapping for OG images. Uses project branding colors
 * (e.g., frost-blue #5ba3d9 for B grades) which intentionally differ
 * from GRADE_RADAR_COLORS in shared/lib/report-cards.ts (standard palette).
 * All OG card templates (stablecoin-card, safety-scores-card) use this palette
 * so grade colors are consistent across share images.
 */
export const GRADE_COLORS: Record<string, string> = {
  "A+": "#15803d", "A": "#15803d", "A-": "#16a34a",
  "B+": "#0369a1", "B": "#0369a1", "B-": "#0284c7",
  "C+": "#a16207", "C": "#a16207", "C-": "#b45309",
  "D": "#c2410c", "F": "#dc2626", "NR": "#64748b",
};

export interface CardFrameProps {
  title: string;
  subtitle?: string;
  borderTopColor?: string;
  badge?: { text: string; color: string };
  children: ReactNode;
  lastUpdated?: string;
}

export function MetricLabel({
  children,
  fontSize = 14,
}: {
  children: ReactNode;
  fontSize?: number;
}) {
  return (
    <span
      style={{
        fontSize,
        color: TEXT_SECONDARY,
        letterSpacing: "0",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

export function CardFrame({
  title,
  subtitle,
  borderTopColor,
  badge,
  children,
  lastUpdated,
}: CardFrameProps) {
  return (
    <div
      style={{
        width: 1200,
        height: 628,
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        color: TEXT_PRIMARY,
        fontFamily: "Geist Sans",
        padding: "42px 52px",
        borderTop: `4px solid ${borderTopColor ?? "#22c55e"}`,
        position: "relative",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Pharos brand mark. Card BG is light, so this is the on-light variant (dark disc,
              light star) — the same file as public/pharos-mark-on-light.svg, inlined because
              satori cannot fetch a same-origin asset. The emblem carries its own disc, so there
              is no plate behind it. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="40" height="40" viewBox="0 0 400 400" fill="none">
              <defs>
                <clipPath id="pharos-mark-disc">
                  <rect width="400" height="400" rx="200" fill="white"/>
                </clipPath>
              </defs>
              <g clipPath="url(#pharos-mark-disc)">
                <path d="M0 199.955C0 89.4981 89.5431 -0.0449219 200 -0.0449219C310.457 -0.0449219 400 89.4981 400 199.955C400 310.412 310.457 399.955 200 399.955C89.5431 399.955 0 310.412 0 199.955Z" fill="#0A0A0A"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M280.906 400.602H122.977L201.934 225.845L280.906 400.602Z" fill="#EEEEEE"/>
                <path d="M208.675 122.569C208.836 125.476 210.853 156.915 228.73 163.317C238.333 166.747 248.509 161.533 260.496 153.873C278.58 142.348 304.57 122.866 332.349 90.4873C317.268 111.959 304.113 131.35 292.974 148.111C277.228 171.847 270.742 182.457 274.386 192.93C277.091 200.704 284.379 205.506 303.608 213.12C321.004 220.026 345.574 228.19 376.698 233.746H234.342C234.342 215.387 219.208 200.504 200.539 200.504C181.87 200.504 166.736 215.387 166.736 233.746H23.301C54.4488 228.19 78.9958 220.026 96.3918 213.12C115.621 205.506 122.932 200.704 125.637 192.93C129.258 182.457 122.795 171.847 107.027 148.111C95.9106 131.35 82.7317 111.959 67.6506 90.4873C95.429 122.866 121.42 142.348 139.503 153.873C151.49 161.533 161.667 166.747 171.27 163.317C189.146 156.915 191.164 125.476 191.324 122.569C194.235 98.7424 197.1 74.9149 200.011 51.0879C202.899 74.9149 205.787 98.7424 208.675 122.569Z" fill="#EEEEEE"/>
              </g>
            </svg>
            <span
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: TEXT_PRIMARY,
                letterSpacing: "0",
              }}
            >
              Pharos
            </span>
          </div>
          {subtitle && (
            <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
              {subtitle}
            </span>
          )}
        </div>
        {badge ? (
          <div
            style={{
              display: "flex",
              padding: "5px 12px",
              borderRadius: 4,
              backgroundColor: badge.color,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0",
            }}
          >
            {badge.text}
          </div>
        ) : (
          <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>
            pharos.watch
          </span>
        )}
      </div>

      {/* Title */}
      <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 24 }}>
        {title}
      </div>

      {/* Content — spread children to fill available space */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
        {children}
      </div>

      {/* Footer with timestamp */}
      {lastUpdated && (
        <div
          style={{
            display: "flex",
            position: "absolute",
            bottom: 16,
            right: 52,
            fontSize: 12,
            color: TEXT_SECONDARY,
            fontFamily: "Geist Mono",
          }}
        >
          Updated: {lastUpdated}
        </div>
      )}
    </div>
  );
}

/** Sparkline SVG path from price data */
export function Sparkline({
  data,
  color = FROST_BLUE,
}: {
  data: number[];
  color?: string;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 1080;
  const h = 80;
  const step = w / (data.length - 1);
  const points = data.map(
    (v, i) => `${i * step},${h - ((v - min) / range) * h}`,
  );
  const d = `M ${points.join(" L ")}`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ marginTop: 16 }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export { TEXT_SECONDARY, FROST_BLUE };
