"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CHART_AMBER, CHART_BLUE } from "@/lib/chart-colors";
import { toTimestampMs } from "@/lib/time";
import { formatYieldWarningSignal, formatYieldWarningSignalDescription } from "@/lib/yield-constants";
import { cn } from "@/lib/utils";
import {
  PRESET_DAYS,
  formatAxisDate,
  formatChartNumber,
  formatTickPercent,
  formatTooltipDate,
  getYieldHistorySourceDisplayLabel,
  type YieldHistorySourceOption,
  type YieldHistoryChartPoint,
  type YieldSourceSegment,
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

export interface SpikeTooltipInfo {
  trailingAvg: number;
  ratio: number;
}

export function YieldHistoryTooltip({
  active,
  payload,
  label,
  showBreakdown,
  compact,
  spikesByDate,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; payload: YieldHistoryChartPoint }>;
  label?: number | string;
  showBreakdown: boolean;
  compact: boolean;
  spikesByDate?: Map<number, SpikeTooltipInfo>;
}) {
  const labelTimestamp = toTimestampMs(label);
  if (!active || !payload || payload.length === 0 || !Number.isFinite(labelTimestamp)) {
    return null;
  }

  const point = payload.find((entry) => entry.dataKey === "apy")?.payload ?? payload[0]?.payload;
  if (!point) return null;

  const spikeInfo = spikesByDate?.get(point.date) ?? null;

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
        <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-[10px] text-sky-700 dark:text-sky-300">
          <span className="block font-medium uppercase tracking-[0.14em]">Source changed</span>
          <span className="mt-1 block normal-case tracking-normal">
            The selected source changed versus the prior published snapshot. This explains provenance churn, not stablecoin safety.
          </span>
        </div>
      ) : null}
      {spikeInfo ? (
        <div className="mt-2 rounded-md border border-orange-500/25 bg-orange-500/10 px-2.5 py-2 text-[10px] text-orange-700 dark:text-orange-300">
          <span className="block font-medium uppercase tracking-[0.14em]">Yield spike</span>
          <span className="mt-1 block normal-case tracking-normal">
            {`Current ${formatChartNumber(point.apy)}% is ${formatChartNumber(spikeInfo.ratio, 1, 1)}× the trailing 30d average of ${formatChartNumber(spikeInfo.trailingAvg)}%.`}
          </span>
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
                <span className="font-medium text-foreground">{formatYieldWarningSignal(signal)}</span>
                <span className="block">{formatYieldWarningSignalDescription(signal)}</span>
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
  availableSources: YieldHistorySourceOption[];
  selectedSourceKey: string;
  onSourceChange?: (sourceKey: string) => void;
  hideSourceSelector?: boolean;
}) {
  const selectedSourceLabel = selectedSourceKey === "best"
    ? "Best yield (highest APY)"
    : getYieldHistorySourceDisplayLabel(
        availableSources.find((source) => source.sourceKey === selectedSourceKey) ?? {
          sourceKey: selectedSourceKey,
          yieldSource: selectedSourceKey,
        },
        availableSources,
      );

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

        {availableSources.length > 0 && !hideSourceSelector && onSourceChange ? (
          <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="uppercase tracking-[0.12em]">History</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Select yield history source"
                className="pharos-focus-ring inline-flex max-w-[18rem] items-center gap-1.5 rounded-md px-1 py-0.5 font-medium text-foreground outline-none transition-colors hover:text-foreground"
              >
                <span className="truncate">{selectedSourceLabel}</span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 w-[min(22rem,calc(100vw-2rem))]">
                <DropdownMenuRadioGroup value={selectedSourceKey} onValueChange={onSourceChange}>
                  <DropdownMenuRadioItem value="best" className="text-xs">
                    Best yield (highest APY)
                  </DropdownMenuRadioItem>
                  {availableSources.map((source) => (
                    <DropdownMenuRadioItem key={source.sourceKey} value={source.sourceKey} className="text-xs">
                      <span className="truncate">
                        {getYieldHistorySourceDisplayLabel(source, availableSources)}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>

      {hasBreakdown ? (
        <Toggle
          pressed={showBreakdown}
          onPressedChange={onShowBreakdownChange}
          variant="outline"
          size="sm"
          aria-label="Show APY and PYS breakdown detail"
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
    <div className={cn("overflow-hidden rounded-xl border border-border/60 bg-background/40", compact ? "p-2.5" : "p-3.5")}>
      {children}
    </div>
  );
}

export function renderAxisTick(value: number | string | undefined, days: number) {
  return formatAxisDate(Number(value ?? 0), days);
}

function formatSourceStripDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SourceStrip({
  segments,
  timeStart,
  timeEnd,
}: {
  segments: ReadonlyArray<YieldSourceSegment>;
  timeStart: number;
  timeEnd: number;
}) {
  if (segments.length === 0) return null;
  const span = timeEnd - timeStart;
  if (!Number.isFinite(span) || span <= 0) return null;

  /* Build legend entries deduped by sourceKey while preserving first-appearance
     order. "other" — if present — counts how many original sources collapsed. */
  const legendOrder: string[] = [];
  const legendByKey = new Map<string, { label: string; color: string; isOther: boolean; count: number }>();
  for (const segment of segments) {
    const existing = legendByKey.get(segment.sourceKey);
    if (existing) {
      if (segment.isOther) existing.count += 1;
      continue;
    }
    legendByKey.set(segment.sourceKey, {
      label: segment.sourceLabel,
      color: segment.color,
      isOther: segment.isOther,
      count: 1,
    });
    legendOrder.push(segment.sourceKey);
  }
  /* For "other", count distinct original-source contributions to display "other (N)". */

  const ariaSummary = segments
    .map((segment) => `${segment.sourceLabel} from ${formatSourceStripDate(segment.startTs)} to ${formatSourceStripDate(segment.endTs)}`)
    .join(", ");

  return (
    <div className="space-y-1.5">
      <div
        role="img"
        aria-label={`Source timeline: ${ariaSummary}`}
        className="flex h-2.5 w-full overflow-hidden rounded-full border border-border/60 bg-background/40"
      >
        {segments.map((segment, index) => {
          const widthPct = Math.max(((segment.endTs - segment.startTs) / span) * 100, 0);
          if (widthPct <= 0) return null;
          return (
            <div
              key={`${segment.sourceKey}-${segment.startTs}-${index}`}
              className={cn(
                segment.color,
                index > 0 ? "border-l border-background/80" : null,
              )}
              style={{ width: `${widthPct}%` }}
              title={`${segment.sourceLabel} — ${formatSourceStripDate(segment.startTs)} to ${formatSourceStripDate(segment.endTs)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {legendOrder.map((key) => {
          const entry = legendByKey.get(key);
          if (!entry) return null;
          const label = entry.isOther ? `other (${entry.count})` : entry.label;
          return (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-sm", entry.color)} />
              <span className="truncate">{label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
