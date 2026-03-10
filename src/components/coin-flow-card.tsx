"use client";

import { cn } from "@/lib/utils";
import { formatCurrency, getNetPrefix } from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";

const PRESSURE_BAR_COLOR: Record<PressureShiftState, string> = {
  improving: "bg-emerald-500",
  stable: "bg-border",
  worsening: "bg-red-500",
  nr: "bg-muted",
};

export interface CoinFlowCardProps {
  symbol: string;
  color: string;
  netFlow24hUsd: number;
  pressureShiftScore: number | null;
  netFlowDirection24h: NetFlowDirection24h;
  pressureShiftState: PressureShiftState;
}

export function CoinFlowCard({
  symbol,
  color,
  netFlow24hUsd,
  pressureShiftScore,
  netFlowDirection24h,
  pressureShiftState,
}: CoinFlowCardProps) {
  const directionUi = getFlowDirectionUi(netFlowDirection24h, "summary");
  const pressureUi = getFlowPressureUi(pressureShiftState, "summary");
  const pressureDisplay = pressureShiftScore != null
    ? getPressureShiftDisplay(pressureShiftScore)
    : null;

  const barFillPct = pressureShiftScore != null
    ? Math.round(((pressureShiftScore + 100) / 200) * 100)
    : 50;

  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="text-sm font-semibold">{symbol}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Net 24h</span>
        <span className={cn("text-xs font-mono tabular-nums font-semibold", directionUi.valueClass)}>
          {netFlowDirection24h === "inactive"
            ? "—"
            : `${getNetPrefix(netFlow24hUsd)}${formatCurrency(netFlow24hUsd)}`}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">vs 30D</span>
        <span className={cn(
          "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
          pressureUi.badgeClass,
        )}>
          {pressureDisplay != null
            ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
            : "NR"}
        </span>
      </div>

      <div className="pressure-track h-1 w-full rounded-full bg-border/40">
        <div
          className={cn("h-1 rounded-full transition-all", PRESSURE_BAR_COLOR[pressureShiftState])}
          style={{ width: `${barFillPct}%` }}
        />
      </div>
    </div>
  );
}
