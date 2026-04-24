"use client";

import type { LiquidityCoverageClass } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  COVERAGE_WATER_HEX,
  clarityOpacity,
  depthFillPct,
  rippleIntensityBand,
} from "@/lib/liquidity-ui";
import "./depth-gauges.css";

export interface DepthGaugeProps {
  score: number | null;
  coverageClass: LiquidityCoverageClass | null;
  volume24hUsd: number;
  organicFraction: number | null;
  logoUrl?: string;
  symbol: string;
  size?: "sm" | "lg";
  patternId: string;
}

export function DepthGauge({
  score,
  coverageClass,
  volume24hUsd,
  organicFraction,
  logoUrl,
  symbol,
  size = "sm",
  patternId,
}: DepthGaugeProps) {
  const dry = score == null || coverageClass === "unobserved" || coverageClass == null;
  const W = size === "lg" ? 180 : 80;
  const H = size === "lg" ? 320 : 220;
  const CYL_X = size === "lg" ? 40 : 18;
  const CYL_Y = size === "lg" ? 30 : 20;
  const CYL_W = W - CYL_X * 2;
  const CYL_H = H - CYL_Y * 2;
  const fillPct = depthFillPct(score);
  const fillPx = (fillPct / 100) * CYL_H;
  const waterY = CYL_Y + CYL_H - fillPx;
  const cls: LiquidityCoverageClass = coverageClass ?? "unobserved";
  const waterHex = COVERAGE_WATER_HEX[cls];
  const murk = clarityOpacity(organicFraction);
  const ripple = rippleIntensityBand(volume24hUsd);
  const rippleClass =
    ripple === "choppy" ? "dg-ripple-choppy"
    : ripple === "gentle" ? "dg-ripple-gentle"
    : "dg-ripple-still";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={
        dry
          ? `${symbol} — unrated depth gauge`
          : `${symbol} — depth ${fillPct.toFixed(0)} of 100, ${cls} coverage`
      }
      className={cn("block", size === "lg" ? "h-80 w-auto" : "h-56 w-full max-w-[80px]")}
    >
      <defs>
        <pattern id={`${patternId}-murk`} width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.6" />
          <circle cx="4" cy="4" r="1" fill="currentColor" opacity="0.6" />
        </pattern>
        <pattern id={`${patternId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        </pattern>
      </defs>

      <rect
        x={CYL_X}
        y={CYL_Y}
        width={CYL_W}
        height={CYL_H}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={dry ? "4 3" : undefined}
        opacity={dry ? 0.4 : 0.7}
        rx={4}
      />
      {[0.25, 0.5, 0.75].map((t) => {
        const y = CYL_Y + CYL_H - t * CYL_H;
        return (
          <line
            key={t}
            x1={CYL_X - 4}
            y1={y}
            x2={CYL_X}
            y2={y}
            stroke="currentColor"
            strokeWidth={0.8}
            opacity={0.5}
          />
        );
      })}

      {!dry && (
        <>
          {cls === "unobserved" ? (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={`url(#${patternId}-hatch)`}
              color="currentColor"
            />
          ) : (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={waterHex}
              opacity={0.85}
            />
          )}
          {murk > 0 && (
            <rect
              x={CYL_X + 1}
              y={waterY}
              width={CYL_W - 2}
              height={fillPx}
              fill={`url(#${patternId}-murk)`}
              opacity={murk}
              color="#1e293b"
            />
          )}
          <path
            className={rippleClass}
            d={`M ${CYL_X + 1} ${waterY} q ${CYL_W / 4} -3 ${CYL_W / 2} 0 t ${CYL_W / 2} 0`}
            fill="none"
            stroke={waterHex}
            strokeWidth={1.5}
            opacity={0.9}
          />
          {logoUrl && (
            <g className="dg-buoy" transform={`translate(${W / 2}, ${waterY})`}>
              <circle r={size === "lg" ? 18 : 12} fill="#fff" opacity={0.9} />
              <image
                href={logoUrl}
                x={size === "lg" ? -16 : -10}
                y={size === "lg" ? -16 : -10}
                width={size === "lg" ? 32 : 20}
                height={size === "lg" ? 32 : 20}
              />
            </g>
          )}
        </>
      )}
    </svg>
  );
}
