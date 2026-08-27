"use client";

import { clamp } from "@shared/lib/math";
import { getNetPrefix } from "@shared/lib/format";
import { getLiteralMintingPressureScore } from "@shared/lib/mint-burn-signals";
import { cn } from "@/lib/utils";

/* Figma coin-template semicircular gauge (Mint & Burn Flows card).
 * Position scale 0..100: 0 = all burn, 50 = balanced, 100 = all mint.
 * Zones: burn (red) 0-45, balanced (gray) 45-65, mint (green) 65-100.
 * The traversed portion renders at full saturation, the rest dimmed, with a
 * white notch at the current position. Hex literals: CSS vars are unreliable
 * in SVG stroke/fill. */
const ARC_ZONES = [
  { from: 0, to: 45, hex: "#ef4444", dimOpacity: 0.28 },
  { from: 45, to: 65, hex: "#6b7280", dimOpacity: 0.4 },
  { from: 65, to: 100, hex: "#22c55e", dimOpacity: 0.45 },
] as const;
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
        {ARC_ZONES.map((zone) => {
          const capPosition = zone.from === 0 ? 0 : zone.to === 100 ? 100 : null;
          const cap = capPosition == null ? null : arcPoint(capPosition);
          return (
            <g key={`dim-${zone.from}`} opacity={zone.dimOpacity}>
              <path
                d={arcPath(zone.from, zone.to)}
                fill="none"
                stroke={zone.hex}
                strokeWidth={ARC_STROKE_WIDTH}
                strokeLinecap="butt"
              />
              {/* Keep only the gauge's outer ends rounded; internal zone joins stay flush. */}
              {cap ? (
                <circle
                  cx={cap.x}
                  cy={cap.y}
                  r={ARC_STROKE_WIDTH / 2}
                  fill={zone.hex}
                />
              ) : null}
            </g>
          );
        })}
        {pos != null
          ? ARC_ZONES.filter((zone) => zone.from < pos).map((zone) => {
              const to = Math.min(pos, zone.to);
              return (
                <path
                  key={`lit-${zone.from}`}
                  d={arcPath(zone.from, to)}
                  fill="none"
                  stroke={zone.hex}
                  strokeWidth={ARC_STROKE_WIDTH}
                  strokeLinecap="butt"
                />
              );
            })
          : null}
        {pos != null && pos > 0 ? (
          <circle
            cx={arcPoint(0).x}
            cy={arcPoint(0).y}
            r={ARC_STROKE_WIDTH / 2}
            fill={ARC_ZONES[0].hex}
          />
        ) : null}
        {pos === 100 ? (
          <circle
            cx={arcPoint(100).x}
            cy={arcPoint(100).y}
            r={ARC_STROKE_WIDTH / 2}
            fill={ARC_ZONES[ARC_ZONES.length - 1].hex}
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
  className?: string;
}

interface MintingPressureUi {
  label: string;
  badgeClass: string;
  valueClass: string;
  panelClass: string;
}

function getLiteralMintingPressureUi(score: number | null): MintingPressureUi {
  if (score === null) {
    return {
      label: "No activity",
      badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
      valueClass: "text-muted-foreground",
      panelClass: "border-border/60 bg-background/35",
    };
  }
  if (score >= 35) {
    return {
      label: "Mint dominated",
      badgeClass:
        "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
      valueClass: "text-emerald-700 dark:text-emerald-400",
      panelClass:
        "border-emerald-600/30 bg-emerald-500/10 dark:border-emerald-500/35 dark:bg-emerald-500/10",
    };
  }
  if (score >= 10) {
    return {
      label: "Mint tilt",
      badgeClass:
        "border-lime-600/30 bg-lime-500/10 text-lime-700 dark:border-lime-500/40 dark:bg-lime-500/15 dark:text-lime-300",
      valueClass: "text-lime-700 dark:text-lime-400",
      panelClass:
        "border-lime-600/30 bg-lime-500/10 dark:border-lime-500/35 dark:bg-lime-500/10",
    };
  }
  if (score > -10) {
    return {
      label: "Balanced",
      badgeClass: "border-border/70 bg-muted/40 text-foreground",
      valueClass: "text-foreground",
      panelClass: "border-border/60 bg-background/40",
    };
  }
  if (score > -35) {
    return {
      label: "Burn tilt",
      badgeClass:
        "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
      valueClass: "text-amber-700 dark:text-amber-400",
      panelClass:
        "border-amber-600/30 bg-amber-500/10 dark:border-amber-500/35 dark:bg-amber-500/10",
    };
  }
  return {
    label: "Burn dominated",
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: "text-red-700 dark:text-red-400",
    panelClass:
      "border-red-600/30 bg-red-500/10 dark:border-red-500/35 dark:bg-red-500/10",
  };
}

export function MintingPressureGauge({
  mintVolume24hUsd,
  burnVolume24hUsd,
  className,
}: MintingPressureGaugeProps) {
  const score = getLiteralMintingPressureScore({
    mintVolume24hUsd,
    burnVolume24hUsd,
  });
  const ui = getLiteralMintingPressureUi(score);
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
    </div>
  );
}
