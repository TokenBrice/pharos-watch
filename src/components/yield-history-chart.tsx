"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useYieldHistory } from "@/hooks/api-hooks";
import { CHART_AMBER, CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { DAY_MS } from "@/lib/constants";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { cn } from "@/lib/utils";
import type { YieldHistoryPoint } from "@shared/types";

const BRAND_ACCENT = "oklch(0.72 0.14 248)";
const DEFAULT_DAYS = 90;
const PRESET_DAYS = [7, 30, 90, 365] as const;

interface YieldHistoryChartProps {
  stablecoinId: string;
  benchmarkRate: number;
  benchmarkLabel?: string;
  benchmarkIsFallback?: boolean;
  medianApy: number;
  defaultDays?: number;
  compact?: boolean;
  availableSources?: Array<{
    sourceKey: string;
    yieldSource: string;
  }>;
}

interface YieldHistoryChartPoint {
  date: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourceTvlUsd: number | null;
  warningSignals: string[];
  sourceKey: string | null;
  yieldSource: string | null;
  dataSource: string | null;
  isBest: boolean;
  sourceSwitch: boolean;
}

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

function normalizeDefaultDays(value?: number) {
  return PRESET_DAYS.includes(value as (typeof PRESET_DAYS)[number]) ? value! : DEFAULT_DAYS;
}

function toTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

const DATE_FMT_MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });
const DATE_FMT_MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_FMT_TOOLTIP = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function formatAxisDate(timestamp: number, days: number) {
  return (days === 365 ? DATE_FMT_MONTH_YEAR : DATE_FMT_MONTH_DAY).format(timestamp);
}

function formatTooltipDate(timestamp: number) {
  return DATE_FMT_TOOLTIP.format(timestamp);
}

/** Format a number for chart display (no % suffix — callers append it). */
function formatChartNumber(value: number, minimumFractionDigits = 2, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

function formatTickPercent(value: number) {
  return `${formatChartNumber(value, 0, Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function buildTicks(points: YieldHistoryChartPoint[], days: number) {
  if (points.length === 0) return [];

  const first = points[0].date;
  const last = points[points.length - 1].date;
  const ticks = new Set<number>([first, last]);

  if (days === 365) {
    const cursor = new Date(first);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);

    if (cursor.getTime() < first) {
      cursor.setMonth(cursor.getMonth() + 1);
    }

    while (cursor.getTime() < last) {
      ticks.add(cursor.getTime());
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const stepMs = days === 7 ? DAY_MS : 7 * DAY_MS;
    const cursor = new Date(first);
    cursor.setHours(0, 0, 0, 0);

    if (cursor.getTime() < first) {
      cursor.setTime(cursor.getTime() + stepMs);
    }

    while (cursor.getTime() < last) {
      ticks.add(cursor.getTime());
      cursor.setTime(cursor.getTime() + stepMs);
    }
  }

  return Array.from(ticks).sort((a, b) => a - b);
}

function AxisTick({ x = 0, y = 0, payload, value, compact = false }: AxisTickProps & { value: string; compact?: boolean }) {
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

function YAxisTick({ x = 0, y = 0, payload, compact = false }: AxisTickProps & { compact?: boolean }) {
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

function WarningDot({ cx, cy, payload, active = false }: WarningDotProps) {
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

function SourceSwitchDot({ cx, cy, payload, active = false }: WarningDotProps) {
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

function YieldHistoryTooltip({
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
        "min-w-[180px] rounded-xl border border-border/70 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-sm",
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

export function YieldHistoryChart({
  stablecoinId,
  benchmarkRate,
  benchmarkLabel,
  benchmarkIsFallback = false,
  medianApy,
  defaultDays = DEFAULT_DAYS,
  compact = false,
  availableSources = [],
}: YieldHistoryChartProps) {
  const [days, setDays] = useState(() => normalizeDefaultDays(defaultDays));
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>("best");
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const effectiveSelectedSourceKey =
    selectedSourceKey === "best" || availableSources.some((source) => source.sourceKey === selectedSourceKey)
      ? selectedSourceKey
      : "best";

  const historyQuery = useYieldHistory(stablecoinId, {
    days,
    mode: effectiveSelectedSourceKey === "best" ? "best" : "source",
    sourceKey: effectiveSelectedSourceKey === "best" ? null : effectiveSelectedSourceKey,
  });

  const chartData = useMemo<YieldHistoryChartPoint[]>(() => {
    return (historyQuery.data?.history ?? [])
      .map((point: YieldHistoryPoint) => {
        const date = toTimestampMs(point.date as unknown);
        return {
          date,
          apy: point.apy,
          apyBase: point.apyBase,
          apyReward: point.apyReward,
          sourceTvlUsd: point.sourceTvlUsd,
          warningSignals: point.warningSignals,
          sourceKey: point.sourceKey ?? null,
          yieldSource: point.yieldSource ?? null,
          dataSource: point.dataSource ?? null,
          isBest: point.isBest ?? false,
          sourceSwitch: point.sourceSwitch ?? false,
        };
      })
      .filter((point) => Number.isFinite(point.date))
      .sort((a, b) => a.date - b.date);
  }, [historyQuery.data]);

  const hasBreakdown = useMemo(
    () => chartData.some((point) => point.apyBase !== null),
    [chartData],
  );
  const effectiveShowBreakdown = hasBreakdown && showBreakdown;

  const tickValues = useMemo(() => buildTicks(chartData, days), [chartData, days]);

  const yDomain = useMemo(() => {
    if (chartData.length === 0) {
      const minRef = Math.min(0, benchmarkRate, medianApy > 0 ? medianApy : 0);
      const maxRef = Math.max(benchmarkRate, medianApy, 1);
      return [minRef - 1, maxRef + 1] as const;
    }

    const values = [
      ...chartData.map((point) => point.apy),
      benchmarkRate,
    ];

    if (medianApy > 0) {
      values.push(medianApy);
    }

    if (effectiveShowBreakdown) {
      for (const point of chartData) {
        if (point.apyBase !== null) values.push(point.apyBase);
        if (point.apyReward !== null) values.push(point.apyReward);
      }
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    const padding = Math.max(span * 0.08, 0.5);

    return [min - padding, max + padding] as const;
  }, [benchmarkRate, chartData, effectiveShowBreakdown, medianApy]);

  const chartHeightClass = compact ? "h-[200px]" : "h-[300px]";
  const referenceLabelStyle = compact
    ? undefined
    : { fill: "var(--color-muted-foreground)", fontSize: 10, position: "right" as const };
  const resolvedBenchmarkLabel = getYieldBenchmarkDisplayLabel({
    benchmarkLabel,
    benchmarkIsFallback,
  });

  if (historyQuery.isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex h-8 items-center rounded-md border border-border/60 bg-muted/30 px-2 text-xs text-muted-foreground">
            Loading history
          </div>
        </div>
        <div className={cn("overflow-hidden rounded-2xl border border-border/60 bg-background/40", compact ? "p-2.5" : "p-3.5")}>
          <ChartSkeleton className={cn("w-full rounded-xl", chartHeightClass)} />
        </div>
      </div>
    );
  }

  if (historyQuery.error) {
    return (
      <div className="space-y-3">
        <ChartShell compact={compact}>
          <div className={cn("flex items-center justify-center text-center", chartHeightClass)}>
            <p className="max-w-xs text-sm text-muted-foreground">Unable to load yield history right now.</p>
          </div>
        </ChartShell>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="space-y-3">
      <Controls
        compact={compact}
        days={days}
        onDaysChange={setDays}
        hasBreakdown={false}
        showBreakdown={effectiveShowBreakdown}
        onShowBreakdownChange={setShowBreakdown}
        availableSources={availableSources}
        selectedSourceKey={effectiveSelectedSourceKey}
        onSourceChange={setSelectedSourceKey}
      />
        <ChartShell compact={compact}>
          <div className={cn("flex items-center justify-center text-center", chartHeightClass)}>
            <p className="text-sm text-muted-foreground">No yield history available</p>
          </div>
        </ChartShell>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {historyQuery.meta?.warning ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {historyQuery.meta.warning}
        </div>
      ) : null}
      <Controls
        compact={compact}
        days={days}
        onDaysChange={setDays}
        hasBreakdown={hasBreakdown}
        showBreakdown={effectiveShowBreakdown}
        onShowBreakdownChange={setShowBreakdown}
        availableSources={availableSources}
        selectedSourceKey={effectiveSelectedSourceKey}
        onSourceChange={setSelectedSourceKey}
      />
      <ChartShell compact={compact}>
        <div
          ref={chartContainerRef}
          className={cn("min-w-0 w-full", chartHeightClass)}
          role="figure"
          aria-label={`Yield history chart showing ${chartData.length} APY data points`}
        >
          {isChartReady ? (
            <ComposedChart
              width={width}
              height={height}
              data={chartData}
              margin={compact ? { top: 8, right: 8, bottom: 8, left: 0 } : { top: 12, right: 18, bottom: 12, left: 0 }}
            >
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" strokeOpacity={0.35} />
              <XAxis
                dataKey="date"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                ticks={tickValues}
                tickLine={false}
                axisLine={false}
                height={compact ? 26 : 30}
                tick={(props) => (
                  <AxisTick
                    {...props}
                    compact={compact}
                    value={formatAxisDate(props.payload?.value ?? 0, days)}
                  />
                )}
              />
              <YAxis
                domain={yDomain}
                tickLine={false}
                axisLine={false}
                width={compact ? 48 : 58}
                tick={(props) => <YAxisTick {...props} compact={compact} />}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border)", strokeWidth: 1, strokeDasharray: "3 3" }}
                content={<YieldHistoryTooltip showBreakdown={effectiveShowBreakdown} compact={compact} />}
              />
              <ReferenceLine
                y={benchmarkRate}
                stroke={CHART_SLATE}
                strokeOpacity={0.8}
                strokeDasharray="6 4"
                label={
                  referenceLabelStyle
                    ? { ...referenceLabelStyle, value: resolvedBenchmarkLabel }
                    : undefined
                }
              />
              {medianApy > 0 ? (
                <ReferenceLine
                  y={medianApy}
                  stroke={CHART_BLUE}
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                  label={
                    referenceLabelStyle
                      ? { ...referenceLabelStyle, value: "Peer Median" }
                      : undefined
                  }
                />
              ) : null}
              <Line
                type="monotone"
                dataKey="apy"
                stroke={BRAND_ACCENT}
                strokeWidth={2}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
              {effectiveShowBreakdown ? (
                <Line
                  type="monotone"
                  dataKey="apyBase"
                  stroke="var(--color-muted-foreground)"
                  strokeOpacity={0.75}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              {effectiveShowBreakdown ? (
                <Line
                  type="monotone"
                  dataKey="apyReward"
                  stroke="var(--color-muted-foreground)"
                  strokeOpacity={0.5}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey="apy"
                stroke="transparent"
                strokeWidth={0}
                dot={<WarningDot />}
                activeDot={<WarningDot active />}
                legendType="none"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="apy"
                stroke="transparent"
                strokeWidth={0}
                dot={<SourceSwitchDot />}
                activeDot={<SourceSwitchDot active />}
                legendType="none"
                isAnimationActive={false}
              />
            </ComposedChart>
          ) : (
            <ChartSkeleton className={cn("w-full rounded-xl", chartHeightClass)} />
          )}
        </div>
      </ChartShell>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
          <span className="font-mono tabular-nums">{formatChartNumber(benchmarkRate)}%</span>
          {resolvedBenchmarkLabel} reference
        </span>
        {medianApy > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
            <span className="font-mono tabular-nums">{formatChartNumber(medianApy)}%</span>
            Peer median
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_AMBER }} />
          Warning markers
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
          <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: CHART_BLUE }} />
          Source switches
        </span>
      </div>
    </div>
  );
}

function Controls({
  compact,
  days,
  onDaysChange,
  hasBreakdown,
  showBreakdown,
  onShowBreakdownChange,
  availableSources,
  selectedSourceKey,
  onSourceChange,
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

        {availableSources.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="uppercase tracking-[0.12em]">History</span>
            <select
              aria-label="Select yield history source"
              className="appearance-none bg-transparent font-medium text-foreground outline-none cursor-pointer"
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
            <span aria-hidden="true" className="text-[10px] leading-none text-muted-foreground">&#9662;</span>
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

function ChartShell({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border/60 bg-background/40", compact ? "p-2.5" : "p-3.5")}>
      {children}
    </div>
  );
}
