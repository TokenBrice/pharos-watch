"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import type { YieldRiskBudgetKey, YieldRiskBudgetStop } from "@/lib/yield-view-model";

const RISK_BUDGET_STYLES: Record<
  YieldRiskBudgetKey,
  { dot: string; dotBorder: string; ring: string; trackFill: string; text: string; activeCount: string }
> = {
  conservative: {
    dot: "bg-emerald-500",
    dotBorder: "border-emerald-500",
    ring: "ring-emerald-500/25",
    trackFill: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
    activeCount: "text-emerald-700 dark:text-emerald-200",
  },
  balanced: {
    dot: "bg-green-500",
    dotBorder: "border-green-500",
    ring: "ring-green-500/25",
    trackFill: "bg-green-500",
    text: "text-green-700 dark:text-green-300",
    activeCount: "text-green-700 dark:text-green-200",
  },
  opportunistic: {
    dot: "bg-amber-500",
    dotBorder: "border-amber-500",
    ring: "ring-amber-500/25",
    trackFill: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    activeCount: "text-amber-700 dark:text-amber-200",
  },
  all: {
    dot: "bg-orange-500",
    dotBorder: "border-orange-500",
    ring: "ring-orange-500/30",
    trackFill: "bg-orange-500",
    text: "text-orange-700 dark:text-orange-300",
    activeCount: "text-orange-700 dark:text-orange-200",
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
  const matchedIndex = stops.findIndex((stop) => stop.active);
  const hasMatch = matchedIndex >= 0;
  // WHY: when no stop matches (custom filters), park the thumb at "All" so
  // ArrowLeft steps toward stricter bands. Visual layer stays unlit because
  // we drive that off `hasMatch`, not `activeIndex`.
  const activeIndex = hasMatch ? matchedIndex : Math.max(0, stopCount - 1);
  const activeStop = hasMatch ? (stops[activeIndex] ?? null) : null;
  const activeStyle = activeStop ? RISK_BUDGET_STYLES[activeStop.key] : null;
  const fillPercentage = stopCount <= 1 ? 0 : (activeIndex / (stopCount - 1)) * 100;
  const valueText = activeStop
    ? `${activeStop.label} — ${activeStop.count} rows`
    : "No band selected — custom filters active";
  const zeroStopIndex = stops.findIndex((stop) => stop.count === 0);
  const zeroStop = zeroStopIndex >= 0 ? stops[zeroStopIndex] : null;
  const nearestBroaderStop = zeroStop ? (stops.slice(zeroStopIndex + 1).find((stop) => stop.count > 0) ?? null) : null;

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
      aria-label="Risk tolerance"
      className={cn("flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 px-4 py-3.5", className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <label
            htmlFor={inputId}
            className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
          >
            Risk tolerance
          </label>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          {activeStop && activeStyle ? (
            <span className={cn("text-xs font-semibold tracking-tight", activeStyle.text)}>{activeStop.label}</span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">Custom</span>
          )}
        </div>
        <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">Matching rows</p>
      </div>
      <div className="relative px-2.5 pt-3 pb-1">
        {/* Background track — runs through the center of the dot row */}
        <div
          aria-hidden="true"
          className="absolute left-[1.125rem] right-[1.125rem] top-[1.5rem] h-1 -translate-y-1/2 rounded-full bg-border/55"
        />
        {/* Colored fill from the first dot up to the active dot — dimmed so the active dot, not the rail, is the focal point */}
        {activeStyle ? (
          <div
            aria-hidden="true"
            className={cn(
              "absolute left-[1.125rem] top-[1.5rem] h-1 -translate-y-1/2 rounded-full opacity-50 transition-[width] duration-300",
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
          aria-label="Risk tolerance"
          aria-valuetext={valueText}
          // WHY: h-11 (44px) meets WCAG 2.5.5 advisory target size while
          // -translate-y-1/2 keeps the hit corridor centered on the dot row;
          // the visual layer renders beneath with pointer-events disabled.
          className="pharos-focus-ring absolute inset-x-2.5 top-[1.5rem] z-20 h-11 w-[calc(100%-1.25rem)] -translate-y-1/2 cursor-pointer appearance-none bg-transparent opacity-0"
        />
        {/* Visual stops + labels — non-interactive; the input above owns events */}
        <div className="pointer-events-none relative flex justify-between">
          {stops.map((stop, idx) => {
            const style = RISK_BUDGET_STYLES[stop.key];
            const isActive = stop.active;
            const isPassed = activeStyle !== null && idx < activeIndex;
            return (
              <div
                key={stop.key}
                data-active={stop.active}
                className={cn(
                  "inline-flex flex-col items-center gap-1.5 px-1 transition-colors",
                  isActive ? style.text : "text-muted-foreground",
                )}
              >
                <span aria-hidden="true" className="relative inline-flex h-6 w-6 items-center justify-center">
                  {isActive ? (
                    <span
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background ring-[3px] transition-all duration-200",
                        style.dotBorder,
                        style.ring,
                      )}
                    >
                      <span className={cn("h-2 w-2 rounded-full", style.dot)} />
                    </span>
                  ) : isPassed && activeStyle ? (
                    <span className={cn("h-2.5 w-2.5 rounded-full opacity-70", activeStyle.dot)} />
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-border/60 bg-background" />
                  )}
                </span>
                <span className={cn("text-[12px] tracking-tight", isActive ? "font-semibold" : "font-medium")}>
                  {stop.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-[12px] tabular-nums",
                    isActive ? cn("font-semibold", style.activeCount) : "font-normal text-muted-foreground/70",
                  )}
                >
                  {stop.count}
                </span>
              </div>
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
