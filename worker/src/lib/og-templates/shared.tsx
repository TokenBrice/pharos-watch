import type { ReactNode } from "react";

// Base colors
const BG = "#0a0f1e";
const TEXT_PRIMARY = "#e8e8e8";
const TEXT_SECONDARY = "#8b8fa3";
const FROST_BLUE = "#5ba3d9";
const BORDER = "#1e293b";

// Semantic colors for data visualization
export const SEMANTIC_COLORS = {
  positive: "#22c55e",   // Green for good/up
  negative: "#ef4444",   // Red for bad/down
  warning: "#f59e0b",    // Orange for caution
  neutral: "#94a3b8",    // Gray for neutral
  highlight: "#5ba3d9",  // Frost blue for highlights
};

// Grade colors (consistent with report cards)
export const GRADE_COLORS: Record<string, string> = {
  "A+": "#22c55e", "A": "#22c55e", "A-": "#4ade80",
  "B+": "#5ba3d9", "B": "#5ba3d9", "B-": "#7dd3fc",
  "C+": "#f59e0b", "C": "#f59e0b", "C-": "#fbbf24",
  "D": "#f97316", "F": "#ef4444", "NR": "#94a3b8",
};

// Typography constants for consistency
export const TYPOGRAPHY = {
  header: { fontSize: 32, fontWeight: 700, fontFamily: "Geist Sans" },
  label: { fontSize: 14, fontWeight: 400, fontFamily: "Geist Sans", letterSpacing: "0.06em" },
  value: { fontSize: 36, fontWeight: 700, fontFamily: "Geist Mono" },
  grade: { fontSize: 44, fontWeight: 700, fontFamily: "Geist Mono" },
  secondary: { fontSize: 16, fontWeight: 400, fontFamily: "Geist Sans" },
  caption: { fontSize: 12, fontWeight: 400, fontFamily: "Geist Sans" },
};

export interface CardFrameProps {
  title: string;
  subtitle?: string;
  borderTopColor?: string;
  badge?: { text: string; color: string };
  children: ReactNode;
  lastUpdated?: string;
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
        padding: "48px 56px",
        borderTop: borderTopColor ? `4px solid ${borderTopColor}` : "none",
        position: "relative",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 32,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Pharos Logo - SVG lighthouse icon */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* SVG Logo - 40px height, maintaining aspect ratio */}
            <svg width="40" height="40" viewBox="0 0 88 88" fill="none">
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
              <line x1="42" y1="22" x2="42" y2="29" stroke="#0a1628" strokeWidth="0.8" opacity="0.3"/>
              <line x1="46" y1="22" x2="46" y2="29" stroke="#0a1628" strokeWidth="0.8" opacity="0.3"/>
              {/* Gallery */}
              <rect x="34" y="29" width="20" height="4" rx="1.5" fill="#E8DCC4" opacity="0.85"/>
              {/* Tower shaft */}
              <path d="M37,33 L51,33 L54,66 L34,66 Z" fill="url(#tBody)" opacity="0.8"/>
              {/* Bands */}
              <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="#0d1f3c" strokeWidth="2" opacity="0.35"/>
              <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="#0d1f3c" strokeWidth="2" opacity="0.35"/>
              {/* Base */}
              <rect x="30" y="66" width="28" height="5" rx="2.5" fill="#E8DCC4" opacity="0.7"/>
              <rect x="26" y="71" width="36" height="5" rx="2.5" fill="#E8DCC4" opacity="0.45"/>
            </svg>
            <span
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: FROST_BLUE,
                letterSpacing: "0.08em",
              }}
            >
              PHAROS
            </span>
          </div>
          {subtitle && (
            <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>
              {subtitle}
            </span>
          )}
        </div>
        <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>
          pharos.watch
        </span>
      </div>

      {/* Badge */}
      {badge && (
        <div
          style={{
            position: "absolute",
            top: 48,
            right: 56,
            padding: "4px 12px",
            borderRadius: 4,
            backgroundColor: badge.color,
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          {badge.text}
        </div>
      )}

      {/* Title */}
      <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>
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
            position: "absolute",
            bottom: 16,
            right: 56,
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

/** Helper to format numbers with sign */
export function formatChange(value: number, suffix = "%"): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

/** Get color for a numeric change value */
export function getChangeColor(value: number): string {
  if (value > 0) return SEMANTIC_COLORS.positive;
  if (value < 0) return SEMANTIC_COLORS.negative;
  return TEXT_SECONDARY;
}

export { BG, TEXT_PRIMARY, TEXT_SECONDARY, FROST_BLUE, BORDER };
