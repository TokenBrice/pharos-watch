"use client";

import { cn } from "@/lib/utils";
import { formatSignedCurrency, getNetPrefix } from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildFlowSummaryNarrative, getFlowDirectionUi, getFlowPressureUi } from "@/lib/flow-signal-ui";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";
import type { MintBurnSignedNetView } from "@/lib/mint-burn-valuation-display";
import { FlowSignedNetValue } from "@/components/flow-valuation-value";

const PRESSURE_BAR_COLOR: Record<PressureShiftState, string> = {
  improving: "bg-[var(--severity-healthy)]",
  stable: "bg-border",
  worsening: "bg-[var(--severity-severe)]",
  nr: "bg-muted",
};

export interface CoinFlowCardProps {
  symbol: string;
  color: string;
  netFlow24h: MintBurnSignedNetView;
  pressureShiftScore: number | null;
  /** Set when partial valuation withholds the pressure shift. */
  pressureUnavailableNote: string | null;
  /** `null` when missing valuation leaves the 24h direction unproven. */
  netFlowDirection24h: NetFlowDirection24h | null;
  pressureShiftState: PressureShiftState;
}

export function CoinFlowCard({
  symbol,
  color,
  netFlow24h,
  pressureShiftScore,
  pressureUnavailableNote,
  netFlowDirection24h,
  pressureShiftState,
}: CoinFlowCardProps) {
  const directionUi = getFlowDirectionUi(netFlowDirection24h, "summary");
  const pressureUi = getFlowPressureUi(pressureShiftState, "summary");
  const pressureDisplay = pressureShiftScore != null
    ? getPressureShiftDisplay(pressureShiftScore)
    : null;

  const barFillPct = pressureShiftScore != null
    ? Math.round(((Math.min(100, Math.max(-100, pressureShiftScore)) + 100) / 200) * 100)
    : 0;

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
        {netFlowDirection24h === "inactive" ? (
          <span className={cn("pharos-numeric text-xs font-semibold", directionUi.valueClass)}>—</span>
        ) : (
          <FlowSignedNetValue
            net={netFlow24h}
            format={formatSignedCurrency}
            className={cn("pharos-numeric text-xs font-semibold", directionUi.valueClass)}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">vs 30D</span>
        <span
          className={cn(
            "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            pressureUi.badgeClass,
          )}
          title={pressureUnavailableNote ?? undefined}
        >
          {pressureDisplay != null
            ? `${pressureUi.label} ${getNetPrefix(pressureDisplay)}${pressureDisplay}`
            : "NR"}
          {pressureUnavailableNote ? <span className="sr-only"> ({pressureUnavailableNote})</span> : null}
        </span>
      </div>

      <div
        className="pressure-track h-1 w-full rounded-full bg-border/40"
        role="meter"
        aria-label="Pressure shift vs 30-day baseline"
        aria-valuenow={pressureShiftScore ?? undefined}
        aria-valuemin={-100}
        aria-valuemax={100}
      >
        <div
          className={cn("h-1 rounded-full transition-[width]", PRESSURE_BAR_COLOR[pressureShiftState])}
          style={{ width: `${barFillPct}%` }}
        />
      </div>

      {/* Pressure description */}
      {pressureDisplay != null && (
        <p className="text-[10px] text-muted-foreground truncate">
          {buildFlowSummaryNarrative(netFlowDirection24h, pressureShiftState)}
        </p>
      )}
    </div>
  );
}
