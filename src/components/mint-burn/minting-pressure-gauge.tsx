"use client";

import { clamp } from "@shared/lib/math";
import { MINT_GAUGE_ZONE_TEXT_CLASSES } from "@shared/lib/classification";
import { cn } from "@/lib/utils";

/* Figma coin-template semicircular gauge (Mint & Burn Flows card).
 * Position scale 0..100: 0 = all burn, 50 = balanced, 100 = all mint.
 * The track is one neutral arc. Only the filled span between the centre mark
 * and the current position carries colour, and only one colour at a time:
 * green for net minting, grey for balanced, red solely for burn-dominated
 * flow. A routine minting reading therefore never draws red, which belongs to
 * an active alarm state. A white notch marks the current position. Hex
 * literals: CSS vars are unreliable in SVG stroke/fill. */
const BALANCED_FROM = 45;
const BALANCED_TO = 65;
const CENTER = 50;
const TRACK_HEX = "#6b7280";
const BURN_HEX = "#ef4444";
const BALANCED_HEX = "#6b7280";
const MINT_HEX = "#22c55e";

function fillHex(pos: number): string {
  if (pos < BALANCED_FROM) return BURN_HEX;
  if (pos < BALANCED_TO) return BALANCED_HEX;
  return MINT_HEX;
}
const ARC_CX = 80;
const ARC_CY = 78;
const ARC_R = 60;
const ARC_STROKE_WIDTH = 13;

function arcPoint(pos: number): { x: number; y: number } {
  if (pos === 0) return { x: ARC_CX - ARC_R, y: ARC_CY };
  if (pos === 100) return { x: ARC_CX + ARC_R, y: ARC_CY };
  const theta = Math.PI * (1 - pos / 100); // 0 -> 180deg (left), 100 -> 0deg (right)
  return { x: ARC_CX + ARC_R * Math.cos(theta), y: ARC_CY - ARC_R * Math.sin(theta) };
}

function arcPath(from: number, to: number): string {
  const start = arcPoint(from);
  const end = arcPoint(to);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${ARC_R} ${ARC_R} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function arcZoneValueClass(pos: number): string {
  if (pos < 45) return MINT_GAUGE_ZONE_TEXT_CLASSES.burn;
  if (pos < 65) return "text-foreground";
  return MINT_GAUGE_ZONE_TEXT_CLASSES.mint;
}

/**
 * Draws a published literal minting-pressure score. The caller gates it with
 * `getLiteralMintingPressureReading()` and renders NR with the reason when the
 * reading is withheld, so this dial never draws a lower-bound balance.
 */
export function MintingPressureArcGauge({
  score,
  className,
}: {
  /** Literal 24h mint-vs-burn balance, -100..+100, from a fully valued window. */
  score: number;
  className?: string;
}) {
  const pos = clamp((score + 100) / 2, 0, 100);
  const display = Math.round(pos);
  const notchAngle = Math.PI * (1 - pos / 100);

  return (
    <div className={cn("relative flex w-full max-w-[300px] flex-col items-center", className)}>
      <svg
        viewBox="0 0 160 84"
        className="w-full"
        role="img"
        aria-label={`Minting pressure gauge at ${display} of 100 (0 all burns, 100 all mints)`}
      >
        <path
          d={arcPath(0, 100)}
          fill="none"
          stroke={TRACK_HEX}
          strokeOpacity={0.25}
          strokeWidth={ARC_STROKE_WIDTH}
          strokeLinecap="round"
        />
        {pos !== CENTER ? (
          <path
            d={arcPath(Math.min(pos, CENTER), Math.max(pos, CENTER))}
            fill="none"
            stroke={fillHex(pos)}
            strokeWidth={ARC_STROKE_WIDTH}
            strokeLinecap="butt"
          />
        ) : null}
        <line
          x1={ARC_CX + (ARC_R - 9) * Math.cos(notchAngle)}
          y1={ARC_CY - (ARC_R - 9) * Math.sin(notchAngle)}
          x2={ARC_CX + (ARC_R + 9) * Math.cos(notchAngle)}
          y2={ARC_CY - (ARC_R + 9) * Math.sin(notchAngle)}
          stroke="#ffffff"
          strokeOpacity={0.95}
          strokeWidth={4}
          strokeLinecap="round"
        />
      </svg>
      {/* Value sits inside the arc mouth (Figma coin template). */}
      <p className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-baseline gap-1.5 pb-0.5">
        <span className={cn("pharos-numeric text-2xl font-extrabold", arcZoneValueClass(pos))}>{display}</span>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="pharos-numeric text-2xl font-extrabold text-foreground">100</span>
      </p>
    </div>
  );
}
