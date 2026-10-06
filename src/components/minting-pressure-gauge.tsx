"use client";

import { clamp } from "@shared/lib/math";
import { getNetPrefix } from "@shared/lib/format";
import { getLiteralMintingPressureScore } from "@shared/lib/mint-burn-signals";
import { getMintPressureBand, MINT_PRESSURE_LABELS } from "@shared/lib/classification";
import { MINT_PRESSURE_STYLES } from "@/lib/severity-colors";
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
  if (pos < 45) return "text-red-600 dark:text-red-400";
  if (pos < 65) return "text-foreground";
  return "text-emerald-700 dark:text-emerald-400";
}

export function MintingPressureArcGauge({
  mintVolume24hUsd,
  burnVolume24hUsd,
  className,
}: MintingPressureGaugeProps) {
  const score = getLiteralMintingPressureScore({ mintVolume24hUsd, burnVolume24hUsd });
  const pos = score == null ? null : clamp((score + 100) / 2, 0, 100);
  const display = pos == null ? null : Math.round(pos);
  const notch = pos == null ? null : arcPoint(pos);

  return (
    <div className={cn("relative flex w-full max-w-[300px] flex-col items-center", className)}>
      <svg
        viewBox="0 0 160 84"
        className="w-full"
        role="img"
        aria-label={
          display == null
            ? "Minting pressure gauge: no 24h activity"
            : `Minting pressure gauge at ${display} of 100 (0 all burns, 100 all mints)`
        }
      >
        <path
          d={arcPath(0, 100)}
          fill="none"
          stroke={TRACK_HEX}
          strokeOpacity={0.25}
          strokeWidth={ARC_STROKE_WIDTH}
          strokeLinecap="round"
        />
        {pos != null && pos !== CENTER ? (
          <path
            d={arcPath(Math.min(pos, CENTER), Math.max(pos, CENTER))}
            fill="none"
            stroke={fillHex(pos)}
            strokeWidth={ARC_STROKE_WIDTH}
            strokeLinecap="butt"
          />
        ) : null}
        {notch ? (
          <line
            x1={ARC_CX + (ARC_R - 9) * Math.cos(Math.PI * (1 - pos! / 100))}
            y1={ARC_CY - (ARC_R - 9) * Math.sin(Math.PI * (1 - pos! / 100))}
            x2={ARC_CX + (ARC_R + 9) * Math.cos(Math.PI * (1 - pos! / 100))}
            y2={ARC_CY - (ARC_R + 9) * Math.sin(Math.PI * (1 - pos! / 100))}
            stroke="#ffffff"
            strokeOpacity={0.95}
            strokeWidth={4}
            strokeLinecap="round"
          />
        ) : null}
      </svg>
      {/* Value sits inside the arc mouth (Figma coin template). */}
      <p className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-baseline gap-1.5 pb-0.5">
        <span className={cn("pharos-numeric text-2xl font-extrabold", display == null ? "text-muted-foreground" : arcZoneValueClass(pos!))}>
          {display == null ? "NR" : display}
        </span>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="pharos-numeric text-2xl font-extrabold text-foreground">100</span>
      </p>
    </div>
  );
}

interface MintingPressureGaugeProps {
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  /** Lower-bound caveat when either volume is a known-valuation subtotal. */
  volumeNote?: string | null;
  className?: string;
}


export function MintingPressureGauge({
  mintVolume24hUsd,
  burnVolume24hUsd,
  volumeNote,
  className,
}: MintingPressureGaugeProps) {
  const score = getLiteralMintingPressureScore({
    mintVolume24hUsd,
    burnVolume24hUsd,
  });
  const pressureBand = getMintPressureBand(score);
  const ui = {
    label: MINT_PRESSURE_LABELS[pressureBand],
    ...MINT_PRESSURE_STYLES[pressureBand],
  };
  const display = score == null ? null : Math.round(score);
  const knobPct = score == null
    ? null
    : clamp((score + 100) / 2, 0, 100);

  return (
    <div className={cn("space-y-2 rounded-xl border p-3", ui.panelClass, className)}>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Minting Pressure (24h)</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              ui.badgeClass,
            )}
          >
            {ui.label}
          </span>
          <span className={cn("pharos-numeric", ui.valueClass)}>
            {display == null ? "NR" : `${getNetPrefix(display)}${display} / 100`}
          </span>
        </div>
      </div>
      <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
        <div
          className="h-full rounded-full"
          style={{
            background:
              "linear-gradient(90deg, var(--severity-severe-hex) 0%, var(--severity-mild-hex) 35%, var(--muted-foreground) 50%, var(--severity-healthy-hex) 100%)",
          }}
        />
        {knobPct !== null && (
          <div
            className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground ring-2 ring-foreground/30 transition-all"
            style={{ left: `calc(${knobPct}% - 10px)` }}
            role="img"
            aria-label={`Minting pressure at ${Math.round(knobPct)}%`}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        This gauge uses only raw 24h mint and burn volume balance. It does not use the 30-day baseline.
      </p>
      {volumeNote ? <p className="text-xs text-muted-foreground">{volumeNote}</p> : null}
    </div>
  );
}
