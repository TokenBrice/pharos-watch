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
          {/* Pharos Logo - SVG lighthouse icon */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 40,
                height: 40,
                borderRadius: 7,
                backgroundColor: "#18191c",
              }}
            >
            <svg width="34" height="34" viewBox="0 0 88 88" fill="none">
              <defs>
                <radialGradient id="glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#E8DCC4" stopOpacity="0.45"/>
                  <stop offset="100%" stopColor="#E8DCC4" stopOpacity="0"/>
                </radialGradient>
                <linearGradient id="tBody" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#D4C8B0"/>
                  <stop offset="40%" stopColor="#E8DCC4"/>
                  <stop offset="100%" stopColor="#C8BBAA"/>
                </linearGradient>
              </defs>
              {/* Glow behind lantern */}
              <circle cx="44" cy="16" r="16" fill="url(#glow)"/>
              {/* Beams */}
              <line x1="44" y1="16" x2="44" y2="-4" stroke="#E8DCC4" strokeWidth="2.5" opacity="0.55" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="22" y2="-2" stroke="#E8DCC4" strokeWidth="2.5" opacity="0.4" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="66" y2="-2" stroke="#E8DCC4" strokeWidth="2.5" opacity="0.4" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="4" y2="4" stroke="#E8DCC4" strokeWidth="2" opacity="0.25" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="84" y2="4" stroke="#E8DCC4" strokeWidth="2" opacity="0.25" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="-4" y2="14" stroke="#E8DCC4" strokeWidth="1.5" opacity="0.15" strokeLinecap="round"/>
              <line x1="44" y1="16" x2="92" y2="14" stroke="#E8DCC4" strokeWidth="1.5" opacity="0.15" strokeLinecap="round"/>
              {/* Shield */}
              <path d="M14,8 L74,8 L74,36 Q74,74 44,84 Q14,74 14,36 Z" fill="none" stroke="#E8DCC4" strokeWidth="3" opacity="0.5" strokeLinejoin="round"/>
              {/* Lantern light */}
              <circle cx="44" cy="16" r="5" fill="white" opacity="0.85"/>
              {/* Dome */}
              <path d="M39,22 C39,14 49,14 49,22 Z" fill="#E8DCC4" opacity="0.9"/>
              {/* Lantern room */}
              <rect x="38.5" y="22" width="11" height="7" rx="1" fill="#F5F0E6" opacity="0.85"/>
              <line x1="42" y1="22" x2="42" y2="29" stroke="#18191c" strokeWidth="0.8" opacity="0.3"/>
              <line x1="46" y1="22" x2="46" y2="29" stroke="#18191c" strokeWidth="0.8" opacity="0.3"/>
              {/* Gallery */}
              <rect x="34" y="29" width="20" height="4" rx="1.5" fill="#E8DCC4" opacity="0.85"/>
              {/* Tower shaft */}
              <path d="M37,33 L51,33 L54,66 L34,66 Z" fill="url(#tBody)" opacity="0.8"/>
              {/* Bands */}
              <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="#18191c" strokeWidth="2" opacity="0.35"/>
              <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="#18191c" strokeWidth="2" opacity="0.35"/>
              {/* Base */}
              <rect x="30" y="66" width="28" height="5" rx="2.5" fill="#E8DCC4" opacity="0.7"/>
              <rect x="26" y="71" width="36" height="5" rx="2.5" fill="#E8DCC4" opacity="0.45"/>
            </svg>
            </div>
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
