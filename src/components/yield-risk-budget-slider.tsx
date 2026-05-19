"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import type { YieldRiskBudgetKey, YieldRiskBudgetStop } from "@/lib/yield-view-model";

const RISK_BUDGET_STYLES: Record<
  YieldRiskBudgetKey,
  { dot: string; dotBorder: string; trackFill: string; text: string; activeCount: string }
> = {
  conservative: {
    dot: "bg-emerald-500",
    dotBorder: "border-emerald-500",
    trackFill: "bg-emerald-500/70",
    text: "text-emerald-700 dark:text-emerald-300",
    activeCount: "text-emerald-700/80 dark:text-emerald-300/80",
  },
  balanced: {
    dot: "bg-sky-500",
    dotBorder: "border-sky-500",
    trackFill: "bg-sky-500/70",
    text: "text-sky-700 dark:text-sky-300",
    activeCount: "text-sky-700/80 dark:text-sky-300/80",
  },
  opportunistic: {
    dot: "bg-amber-500",
    dotBorder: "border-amber-500",
    trackFill: "bg-amber-500/70",
    text: "text-amber-700 dark:text-amber-300",
    activeCount: "text-amber-700/80 dark:text-amber-300/80",
  },
  aggressive: {
    dot: "bg-orange-600",
    dotBorder: "border-orange-600",
    trackFill: "bg-orange-600/70",
    text: "text-orange-700 dark:text-orange-300",
    activeCount: "text-orange-700/80 dark:text-orange-300/80",
  },
};

interface YieldRiskBudgetSliderProps {
  stops: readonly YieldRiskBudgetStop[];
  onSelect: (key: YieldRiskBudgetKey) => void;
  className?: string;
}

export function YieldRiskBudgetSlider({ stops, onSelect, className }: YieldRiskBudgetSliderProps) {
  const inputId = useId();
  const stopCount = stops.length;
  const activeIndex = Math.max(0, stops.findIndex((stop) => stop.active));
  const activeStop = activeIndex >= 0 ? stops[activeIndex] ?? null : null;
  const activeStyle = activeStop ? RISK_BUDGET_STYLES[activeStop.key] : null;
  const fillPercentage = stopCount <= 1 ? 0 : (activeIndex / (stopCount - 1)) * 100;
  const valueText = activeStop ? `${activeStop.label} — ${activeStop.count} rows` : "Aggressive";

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(event.target.value);
    if (!Number.isFinite(next) || next < 0 || next >= stopCount) return;
    const target = stops[next];
    if (!target || target.active) return;
    onSelect(target.key);
  }

  return (
    <div
      role="group"
      aria-label="Risk budget"
      className={cn("flex flex-col gap-2 rounded-xl border border-border/70 bg-background/40 px-3 py-3", className)}
    >
      <div className="flex items-baseline justify-between">
        <label
          htmlFor={inputId}
          className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          Risk budget
        </label>
        <p className="text-[10px] text-muted-foreground">Conservative → Aggressive · drag to adjust</p>
      </div>
      <div className="relative px-2.5 pt-3 pb-1">
        {/* Background track — runs through the center of the dot row */}
        <div
          aria-hidden="true"
          className="absolute left-[1.125rem] right-[1.125rem] top-[1.375rem] h-1 -translate-y-1/2 rounded-full bg-border/60"
        />
        {/* Colored fill from the first dot up to the active dot */}
        {activeStyle ? (
          <div
            aria-hidden="true"
            className={cn(
              "absolute left-[1.125rem] top-[1.375rem] h-1 -translate-y-1/2 rounded-full transition-all",
              activeStyle.trackFill,
            )}
            style={{ width: `calc((100% - 2.25rem) * ${fillPercentage / 100})` }}
          />
        ) : null}
        {/* Invisible drag surface — native range input covers the whole stop row */}
        <input
          id={inputId}
          type="range"
          min={0}
          max={stopCount - 1}
          step={1}
          value={activeIndex}
          onChange={handleChange}
          aria-label="Risk budget"
          aria-valuetext={valueText}
          // WHY: covers the dot row so drag and click anywhere snaps to the nearest stop;
          // visual layer is rendered beneath with pointer-events disabled.
          className="pharos-focus-ring absolute inset-x-2.5 top-[1.375rem] z-20 h-5 w-[calc(100%-1.25rem)] -translate-y-1/2 cursor-pointer appearance-none bg-transparent opacity-0"
        />
        {/* Visual stops + labels — non-interactive; the input above owns events */}
        <div className="pointer-events-none relative flex justify-between">
          {stops.map((stop) => {
            const style = RISK_BUDGET_STYLES[stop.key];
            return (
              <div
                key={stop.key}
                data-active={stop.active}
                className={cn(
                  "inline-flex flex-col items-center gap-1 px-1 transition-colors",
                  stop.active ? style.text : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background transition-all",
                    stop.active ? style.dotBorder : "border-border/70",
                  )}
                >
                  <span className={cn("h-2.5 w-2.5 rounded-full", stop.active ? style.dot : "bg-transparent")} />
                </span>
                <span className={cn("text-[11px]", stop.active ? "font-semibold" : "font-medium")}>{stop.label}</span>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    stop.active ? style.activeCount : "text-muted-foreground/80",
                  )}
                >
                  {stop.count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
