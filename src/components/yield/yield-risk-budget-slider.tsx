"use client";

import { YIELD_RISK_BUDGET_CLASSES } from "@shared/lib/classification";
import { cn } from "@/lib/utils";
import type { YieldRiskBudgetKey, YieldRiskBudgetStop } from "@/lib/yield-view-model";

const RISK_BUDGET_STYLES = YIELD_RISK_BUDGET_CLASSES satisfies Record<YieldRiskBudgetKey, unknown>;

interface YieldRiskBudgetSliderProps {
  stops: readonly YieldRiskBudgetStop[];
  onSelect: (key: YieldRiskBudgetKey) => void;
  className?: string;
}

function formatStopThreshold(stop: YieldRiskBudgetStop): string | null {
  const minSafety = stop.overrides.minSafety;
  if (typeof minSafety !== "number") return null;
  return `≥${minSafety}`;
}

export function YieldRiskBudgetSlider({ stops, onSelect, className }: YieldRiskBudgetSliderProps) {
  const activeStop = stops.find((stop) => stop.active) ?? null;
  const activeStyle = activeStop ? RISK_BUDGET_STYLES[activeStop.key] : null;
  const zeroStopIndex = stops.findIndex((stop) => stop.count === 0);
  const zeroStop = zeroStopIndex >= 0 ? stops[zeroStopIndex] : null;
  const nearestBroaderStop = zeroStop ? (stops.slice(zeroStopIndex + 1).find((stop) => stop.count > 0) ?? null) : null;

  return (
    <div
      role="group"
      aria-label="Risk tolerance"
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/60 bg-card/40 px-3.5 py-2.5 sm:px-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="pharos-label shrink-0">Risk tolerance</span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          {activeStop && activeStyle ? (
            <span className={cn("truncate text-xs font-semibold tracking-tight", activeStyle.text)}>
              {activeStop.label}
            </span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">Custom</span>
          )}
        </div>

        <div
          role="group"
          aria-label="Risk tolerance bands"
          className="pharos-segmented flex-wrap"
        >
          {stops.map((stop) => {
            const style = RISK_BUDGET_STYLES[stop.key];
            const isActive = stop.active;
            const threshold = formatStopThreshold(stop);
            return (
              <button
                key={stop.key}
                type="button"
                aria-pressed={isActive}
                data-active={String(isActive)}
                title={stop.description}
                onClick={() => {
                  if (!isActive) onSelect(stop.key);
                }}
                className="pharos-segmented-item pharos-focus-ring min-h-11 gap-1.5 px-2.5 sm:min-h-8 sm:px-3"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    isActive ? style.dot : "bg-muted-foreground/40",
                  )}
                />
                <span className={cn("tracking-tight", isActive && "font-semibold")}>{stop.label}</span>
                {threshold ? (
                  <span className="font-mono text-2xs tabular-nums text-muted-foreground">{threshold}</span>
                ) : null}
                <span
                  className={cn(
                    "font-mono text-2xs tabular-nums",
                    isActive ? "font-semibold text-foreground" : "text-muted-foreground/75",
                  )}
                >
                  ({stop.count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {zeroStop ? (
        <p className="text-xs text-muted-foreground" role="status">
          <span className="font-medium text-foreground">{zeroStop.label} has no current matches.</span>{" "}
          {zeroStop.description}.
          {nearestBroaderStop ? (
            <>
              {" "}
              Nearest broader band: {nearestBroaderStop.label} ({nearestBroaderStop.count}).
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
