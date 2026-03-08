import type { ReactNode } from "react";

const BG = "#0a0f1e";
const TEXT_PRIMARY = "#e8e8e8";
const TEXT_SECONDARY = "#8b8fa3";
const FROST_BLUE = "#5ba3d9";
const BORDER = "#1e293b";

export interface CardFrameProps {
  title: string;
  subtitle?: string;
  borderTopColor?: string;
  badge?: { text: string; color: string };
  children: ReactNode;
}

export function CardFrame({
  title,
  subtitle,
  borderTopColor,
  badge,
  children,
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
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: FROST_BLUE,
              letterSpacing: "0.08em",
            }}
          >
            PHAROS
          </span>
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
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-evenly" }}>
        {children}
      </div>
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

export { BG, TEXT_PRIMARY, TEXT_SECONDARY, FROST_BLUE, BORDER };
