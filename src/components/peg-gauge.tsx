"use client";

import { useId } from "react";

interface PegGaugeProps {
  /** Deviation from peg in basis points */
  deviationBps: number;
  className?: string;
}

/* SVG geometry constants */
const CX = 100;
const CY = 92;
const R = 76;
const SW = 12;
const CLAMP = 500;

/**
 * Map a bps value (-500..+500) to an angle on the semicircle (180°..0°).
 * -500 bps → 180° (left), 0 → 90° (top), +500 → 0° (right).
 */
function bpsToAngle(bps: number): number {
  const clamped = Math.max(-CLAMP, Math.min(CLAMP, bps));
  return 180 - ((clamped + CLAMP) / (2 * CLAMP)) * 180;
}

function toXY(angleDeg: number, r: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
}

export function PegGauge({ deviationBps, className }: PegGaugeProps) {
  const rawId = useId();
  const gradId = `gauge-${rawId.replace(/:/g, "")}`;

  const angleDeg = bpsToAngle(deviationBps);
  const needleR = R - SW / 2 - 3;
  const [nx, ny] = toXY(angleDeg, needleR);

  return (
    <svg
      viewBox="0 0 200 108"
      className={className}
      role="img"
      aria-label={`Peg deviation gauge: ${deviationBps >= 0 ? "+" : ""}${deviationBps} basis points`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          {/* Severity gradient: red → orange → amber → green → amber → orange → red */}
          <stop offset="0%" stopColor="#ef4444" />
          <stop offset="22%" stopColor="#f97316" />
          <stop offset="35%" stopColor="#f59e0b" />
          <stop offset="47%" stopColor="#22c55e" />
          <stop offset="53%" stopColor="#22c55e" />
          <stop offset="65%" stopColor="#f59e0b" />
          <stop offset="78%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
      </defs>

      {/* Arc track */}
      <path
        d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={SW}
        strokeLinecap="round"
        opacity={0.75}
      />

      {/* Needle */}
      <line
        x1={CX}
        y1={CY}
        x2={nx}
        y2={ny}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="transition-all duration-500 ease-out"
      />
      <circle cx={CX} cy={CY} r={4} fill="currentColor" />

      {/* Tick labels */}
      <text x={CX - R} y={CY + 16} textAnchor="middle" fill="currentColor" opacity={0.35} fontSize={8} fontFamily="var(--font-mono, monospace)">
        −500
      </text>
      <text x={CX} y={CY - R - 5} textAnchor="middle" fill="currentColor" opacity={0.35} fontSize={8} fontFamily="var(--font-mono, monospace)">
        0
      </text>
      <text x={CX + R} y={CY + 16} textAnchor="middle" fill="currentColor" opacity={0.35} fontSize={8} fontFamily="var(--font-mono, monospace)">
        +500
      </text>
    </svg>
  );
}
