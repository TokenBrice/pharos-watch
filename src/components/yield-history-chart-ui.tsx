"use client";

import type { ReactNode } from "react";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CHART_AMBER, CHART_BLUE } from "@/lib/chart-colors";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { cn } from "@/lib/utils";
import {
  PRESET_DAYS,
  formatAxisDate,
  formatChartNumber,
  formatTickPercent,
  formatTooltipDate,
  toTimestampMs,
  type YieldHistoryChartPoint,
} from "./yield-history-chart-model";

interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  payload?: {
    value: number | string;
  };
}

interface WarningDotProps {
  cx?: number;
  cy?: number;
  payload?: YieldHistoryChartPoint;
  active?: boolean;
}

export function AxisTick({
  x = 0,
  y = 0,
  payload,
  value,
  compact = false,
}: AxisTickProps & { value: string; compact?: boolean }) {
  if (!payload) return null;

  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dy={12}
      textAnchor="middle"
      className="font-mono"
      fontSize={compact ? 10 : 11}
      fill="var(--color-muted-foreground)"
    >
      {value}
    </text>
  );
}

export function YAxisTick({
  x = 0,
  y = 0,
  payload,
  compact = false,
}: AxisTickProps & { compact?: boolean }) {
  if (!payload) return null;

  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dx={-6}
      dy={4}
      textAnchor="end"
      className="font-mono"
      fontSize={compact ? 10 : 11}
      fill="var(--color-muted-foreground)"
    >
      {formatTickPercent(Number(payload.value))}
    </text>
  );
}

export function WarningDot({ cx, cy, payload, active = false }: WarningDotProps) {
  if (typeof cx !== "number" || typeof cy !== "number" || !payload || payload.warningSignals.length === 0) {
    return null;
  }

  return (
    <circle
      cx={cx}
      cy={cy}
      r={active ? 5 : 4}
      fill={CHART_AMBER}
      stroke="var(--color-background)"
      strokeWidth={active ? 2 : 1.5}
    />
  );
}

export function SourceSwitchDot({ cx, cy, payload, active = false }: WarningDotProps) {
  if (typeof cx !== "number" || typeof cy !== "number" || !payload?.sourceSwitch) {
    return null;
  }

  return (
    <rect
      x={cx - (active ? 4 : 3)}
      y={cy - (active ? 4 : 3)}
      width={active ? 8 : 6}
      height={active ? 8 : 6}
      rx={1.5}
      fill={CHART_BLUE}
      stroke="var(--color-background)"
      strokeWidth={active ? 2 : 1.5}
    />
  );
}

export function YieldHistoryTooltip({
  active,
  payload,
  label,
  showBreakdown,
  compact,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; payload: YieldHistoryChartPoint }>;
  label?: number | string;
  showBreakdown: boolean;
  compact: boolean;
}) {
  const labelTimestamp = toTimestampMs(label);
  if (!active || !payload || payload.length === 0 || !Number.isFinite(labelTimestamp)) {
    return null;
  }

  const point = payload.find((entry) => entry.dataKey === "apy")?.payload ?? payload[0]?.payload;
  if (!point) return null;

  return (
    <div
      className={cn(
        "min-w-[180px] rounded-xl border border-border/70 bg-card px-3 py-2.5 shadow-lg",
        compact ? "text-[11px]" : "text-xs",
      )}
    >
      <p className="font-medium text-foreground">{formatTooltipDate(labelTimestamp)}</p>
      <div className="mt-2 space-y-1.5 text-muted-foreground">
        {point.yieldSource ? (
          <div className="flex items-center justify-between gap-4">
            <span>Source</span>
            <span className="max-w-[160px] truncate text-right text-foreground">{point.yieldSource}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <span>APY</span>
          <span className="font-mono tabular-nums text-foreground">{formatChartNumber(point.apy)}%</span>
        </div>
        {showBreakdown ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span>Base</span>
              <span className="font-mono tabular-nums">
                {point.apyBase !== null ? `${formatChartNumber(point.apyBase)}%` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span>Reward</span>
              <span className="font-mono tabular-nums">
                {point.apyReward !== null ? `${formatChartNumber(point.apyReward)}%` : "—"}
              </span>
            </div>
          </>
        ) : null}
      </div>
      {point.sourceSwitch ? (
        <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-[10px] uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
          Source switch
        </div>
      ) : null}
      {point.warningSignals.length > 0 ? (
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-amber-700 dark:text-amber-400">
            Warning signals
          </p>
          <div className="mt-1 space-y-1">
            {point.warningSignals.map((signal) => (
              <div key={signal} className="text-muted-foreground">
                {formatYieldWarningSignal(signal)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Controls({
  compact,
  days,
  onDaysChange,
  hasBreakdown,
  showBreakdown,
  onShowBreakdownChange,
  availableSources,
  selectedSourceKey,
  onSourceChange,
  hideSourceSelector = false,
}: {
  compact: boolean;
  days: number;
  onDaysChange: (days: number) => void;
  hasBreakdown: boolean;
  showBreakdown: boolean;
  onShowBreakdownChange: (pressed: boolean) => void;
  availableSources: Array<{ sourceKey: string; yieldSource: string }>;
  selectedSourceKey: string;
  onSourceChange: (sourceKey: string) => void;
  hideSourceSelector?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={String(days)}
          onValueChange={(value) => {
            if (!value) return;
            onDaysChange(Number(value));
          }}
          variant="outline"
          size={compact ? "sm" : "default"}
          className="rounded-full border border-border/60 bg-background/60 p-1"
          aria-label="Select yield history time range"
        >
          {PRESET_DAYS.map((preset) => (
            <ToggleGroupItem
              key={preset}
              value={String(preset)}
              className={cn(
                "rounded-full border-0 font-mono text-xs text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
                compact ? "h-7 px-2.5" : "h-8 px-3",
              )}
            >
              {preset === 365 ? "1y" : `${preset}d`}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {availableSources.length > 0 && !hideSourceSelector ? (
          <label className="flex cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="uppercase tracking-[0.12em]">History</span>
            <select
              aria-label="Select yield history source"
              className="cursor-pointer appearance-none bg-transparent font-medium text-foreground outline-none"
              value={selectedSourceKey}
              onChange={(event) => onSourceChange(event.target.value)}
            >
              <option value="best">Best source</option>
              {availableSources.map((source) => (
                <option key={source.sourceKey} value={source.sourceKey}>
                  {source.yieldSource}
                </option>
              ))}
            </select>
            <span aria-hidden="true" className="text-[10px] leading-none text-muted-foreground">
              &#9662;
            </span>
          </label>
        ) : null}
      </div>

      {hasBreakdown ? (
        <Toggle
          pressed={showBreakdown}
          onPressedChange={onShowBreakdownChange}
          variant="outline"
          size="sm"
          aria-label="Show base and reward APY breakdown"
          className={cn(
            "rounded-full border-border/60 bg-background/60 text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
            compact ? "px-2.5 text-[11px]" : "px-3 text-xs",
          )}
        >
          {compact ? "Split" : "Show breakdown"}
        </Toggle>
      ) : null}
    </div>
  );
}

export function ChartShell({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border/60 bg-background/40", compact ? "p-2.5" : "p-3.5")}>
      {children}
    </div>
  );
}

export function renderAxisTick(value: number | string | undefined, days: number) {
  return formatAxisDate(Number(value ?? 0), days);
}
