"use client";

import { getNetPrefix } from "@shared/lib/format";
import { getLiteralMintingPressureScore } from "@shared/lib/mint-burn-signals";
import { cn } from "@/lib/utils";

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
          <span className={cn("font-mono", ui.valueClass)}>
            {display == null ? "NR" : `${getNetPrefix(display)}${display} / 100`}
          </span>
        </div>
      </div>
      <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
        <div
          className="h-full rounded-full"
          style={{
            background:
              "linear-gradient(90deg, #ef4444 0%, #f59e0b 35%, #6b7280 50%, #84cc16 65%, #10b981 100%)",
          }}
        />
        {knobPct !== null && (
          <div
            className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
            style={{ left: `calc(${knobPct}% - 10px)` }}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        This gauge uses only raw 24h mint and burn volume balance. It does not use the 30-day baseline.
      </p>
    </div>
  );
}
