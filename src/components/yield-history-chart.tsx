"use client";

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
import { CHART_AMBER, CHART_BLUE, CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import {
  BRAND_ACCENT,
  DEFAULT_DAYS,
  formatChartNumber,
  type YieldHistoryChartProps,
  useYieldHistoryChartModel,
} from "./yield-history-chart-model";
import {
  AxisTick,
  ChartShell,
  Controls,
  renderAxisTick,
  SourceSwitchDot,
  WarningDot,
  YAxisTick,
  YieldHistoryTooltip,
} from "./yield-history-chart-ui";

/** Distinct colors for overlay lines (skip index 0 = blue, use contrasting hues) */
const OVERLAY_COLORS = [CHART_PALETTE[1], CHART_PALETTE[3], CHART_PALETTE[4], CHART_PALETTE[5]];

export function YieldHistoryChart({
  stablecoinId,
  benchmarkRate,
  benchmarkLabel,
  benchmarkIsFallback = false,
  medianApy,
  defaultDays = DEFAULT_DAYS,
  compact = false,
  availableSources = [],
  hideSourceSelector = false,
  externalSourceKey,
  externalSourceKeys,
}: YieldHistoryChartProps) {
  const model = useYieldHistoryChartModel({
    stablecoinId,
    benchmarkRate,
    benchmarkLabel,
    benchmarkIsFallback,
    medianApy,
    defaultDays,
    availableSources,
    externalSourceKey,
    externalSourceKeys,
  });
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartHeightClass = compact ? "h-[200px]" : "h-[300px]";
  const referenceLabelStyle = compact
    ? undefined
    : { fill: "var(--color-muted-foreground)", fontSize: 10, position: "right" as const };

  if (model.historyQuery.isLoading) {
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

  if (model.historyQuery.error) {
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

  if (model.chartData.length === 0) {
    return (
      <div className="space-y-3">
        <Controls
          compact={compact}
          days={model.days}
          onDaysChange={model.setDays}
          hasBreakdown={false}
          showBreakdown={model.effectiveShowBreakdown}
          onShowBreakdownChange={model.setShowBreakdown}
          availableSources={availableSources}
          selectedSourceKey={model.selectedSourceKey}
          onSourceChange={model.onSourceChange}
          hideSourceSelector={hideSourceSelector}
        />
        <ChartShell compact={compact}>
          <div className={cn("flex items-center justify-center text-center", chartHeightClass)}>
            <div>
              <p className="text-sm text-muted-foreground">No yield history available</p>
              <p className="mt-1 text-xs text-muted-foreground/70">Select a different yield source or check back later.</p>
            </div>
          </div>
        </ChartShell>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {model.historyQuery.meta?.warning ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {model.historyQuery.meta.warning}
        </div>
      ) : null}
      <Controls
        compact={compact}
        days={model.days}
        onDaysChange={model.setDays}
        hasBreakdown={model.hasBreakdown}
        showBreakdown={model.effectiveShowBreakdown}
        onShowBreakdownChange={model.setShowBreakdown}
        availableSources={availableSources}
        selectedSourceKey={model.selectedSourceKey}
        onSourceChange={model.onSourceChange}
        hideSourceSelector={hideSourceSelector}
      />
      <ChartShell compact={compact}>
        <div
          ref={chartContainerRef}
          className={cn("min-w-0 w-full", chartHeightClass)}
          role="figure"
          aria-label={`Yield history chart showing ${model.chartData.length} APY data points`}
        >
          {isChartReady ? (
            <ComposedChart
              width={width}
              height={height}
              data={model.mergedChartData}
              margin={compact ? { top: 8, right: 8, bottom: 8, left: 0 } : { top: 12, right: 18, bottom: 12, left: 0 }}
            >
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" strokeOpacity={0.35} />
              <XAxis
                dataKey="date"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                ticks={model.tickValues}
                tickLine={false}
                axisLine={false}
                height={compact ? 26 : 30}
                tick={(props) => (
                  <AxisTick
                    {...props}
                    compact={compact}
                    value={renderAxisTick(props.payload?.value, model.days)}
                  />
                )}
              />
              <YAxis
                domain={model.yDomain}
                tickLine={false}
                axisLine={false}
                width={compact ? 48 : 58}
                tick={(props) => <YAxisTick {...props} compact={compact} />}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border)", strokeWidth: 1, strokeDasharray: "3 3" }}
                content={<YieldHistoryTooltip showBreakdown={model.effectiveShowBreakdown} compact={compact} />}
              />
              <ReferenceLine
                y={benchmarkRate}
                stroke={CHART_SLATE}
                strokeOpacity={0.8}
                strokeDasharray="6 4"
                label={
                  referenceLabelStyle
                    ? { ...referenceLabelStyle, value: model.resolvedBenchmarkLabel }
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
              {model.effectiveShowBreakdown ? (
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
              {model.effectiveShowBreakdown ? (
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
              {/* Overlay lines for multi-source comparison */}
              {model.overlaySeriesKeys.map((dataKey, i) => (
                <Line
                  key={dataKey}
                  type="monotone"
                  dataKey={dataKey}
                  stroke={OVERLAY_COLORS[i + 1] ?? OVERLAY_COLORS[0]}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          ) : (
            <ChartSkeleton className={cn("w-full rounded-xl", chartHeightClass)} />
          )}
        </div>
      </ChartShell>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
          <span className="font-mono tabular-nums">{formatChartNumber(benchmarkRate)}%</span>
          {model.resolvedBenchmarkLabel} reference
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
        {model.overlayLabels.map((label, i) => (
          <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: OVERLAY_COLORS[i + 1] ?? OVERLAY_COLORS[0] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
