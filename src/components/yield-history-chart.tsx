"use client";

import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { PysHistorySparkline, type PysHistorySparklinePoint } from "@/components/pys-history-sparkline";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { CHART_AMBER, CHART_BLUE, CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import { toTimestampMs } from "@/lib/time";
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
  SourceStrip,
  SourceSwitchDot,
  WarningDot,
  YAxisTick,
  YieldHistoryTooltip,
} from "./yield-history-chart-ui";

/** Distinct overlay colors (skip CHART_PALETTE[0] = blue, used by the primary series) */
const SPIKE_COLOR = "oklch(0.72 0.18 35)";
const OVERLAY_COLORS = [CHART_PALETTE[3], CHART_PALETTE[4], CHART_PALETTE[5]];

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
  const historyWarning = model.bodyWarning ?? model.historyQuery.meta?.warning ?? null;

  const spikeAnnotations = model.spikeAnnotations;
  const spikesByDate = new Map(
    spikeAnnotations.map((s) => [s.date, { trailingAvg: s.trailingAvg, ratio: s.ratio }]),
  );
  const domainMax = model.yDomain[1];
  /* Render markers only for the most extreme spikes so the plot doesn't fill
     with overlapping labels when a series has a sustained high-volatility period. */
  const MAX_SPIKE_MARKERS = 3;
  const visibleSpikes = [...spikeAnnotations]
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, MAX_SPIKE_MARKERS);
  const chartHeightClass = compact ? "h-[200px]" : "h-[220px] sm:h-[260px]";
  /* Map raw history points to the sparkline shape. We read directly from the
     query payload (not model.chartData) because the model's mapper omits the
     optional pysAtPublish field. */
  const pysSparklinePoints: PysHistorySparklinePoint[] = (model.historyQuery.data?.history ?? [])
    .map((point) => ({
      ts: toTimestampMs(point.date),
      pysAtPublish: point.pysAtPublish ?? null,
    }))
    .filter((point) => Number.isFinite(point.ts));
  const sourceSegments = model.sourceSegments;
  const distinctSourceCount = new Set(sourceSegments.map((segment) => segment.sourceKey)).size;
  const showSourceStrip = distinctSourceCount > 1 && sourceSegments.length > 0;
  const sourceStripStart = sourceSegments[0]?.startTs ?? 0;
  const sourceStripEnd = sourceSegments[sourceSegments.length - 1]?.endTs ?? 0;
  /* insideRight keeps the inline benchmark/peer-median labels within the plot
     bounds — position "right" rendered them into the margin, truncating them
     at the chart edge. */
  const referenceLabelStyle = compact
    ? undefined
    : { fill: "var(--color-muted-foreground)", fontSize: 10, position: "insideRight" as const };

  if (model.historyQuery.isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex h-8 items-center rounded-md border border-border/60 bg-muted/30 px-2 text-xs text-muted-foreground">
            Loading history
          </div>
        </div>
        <div className={cn("overflow-hidden rounded-xl border border-border/60 bg-background/40", compact ? "p-2.5" : "p-3.5")}>
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
        {historyWarning ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {historyWarning}
          </div>
        ) : null}
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
      {historyWarning ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {historyWarning}
        </div>
      ) : null}
      <Controls
        compact={compact}
        days={model.days}
        onDaysChange={model.setDays}
        hasBreakdown={model.hasBreakdown || pysSparklinePoints.some((point) => point.pysAtPublish !== null)}
        showBreakdown={model.effectiveShowBreakdown}
        onShowBreakdownChange={model.setShowBreakdown}
        availableSources={availableSources}
        selectedSourceKey={model.selectedSourceKey}
        onSourceChange={model.onSourceChange}
        hideSourceSelector={hideSourceSelector}
      />
      <ChartShell compact={compact}>
        {showSourceStrip ? (
          <div className="mb-3">
            <SourceStrip
              segments={sourceSegments}
              timeStart={sourceStripStart}
              timeEnd={sourceStripEnd}
            />
          </div>
        ) : null}
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
                allowDataOverflow
                tickLine={false}
                axisLine={false}
                width={compact ? 48 : 58}
                tick={(props) => <YAxisTick {...props} compact={compact} />}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border)", strokeWidth: 1, strokeDasharray: "3 3" }}
                content={<YieldHistoryTooltip showBreakdown={model.effectiveShowBreakdown} compact={compact} spikesByDate={spikesByDate} />}
              />
              <ReferenceLine
                y={Math.min(Math.max(benchmarkRate, model.yDomain[0]), domainMax)}
                stroke={CHART_SLATE}
                strokeOpacity={0.8}
                strokeDasharray="6 4"
                label={
                  referenceLabelStyle
                    ? { ...referenceLabelStyle, value: benchmarkLabel ?? "Benchmark" }
                    : undefined
                }
              />
              {medianApy > 0 ? (
                <ReferenceLine
                  y={Math.min(Math.max(medianApy, model.yDomain[0]), domainMax)}
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
              {/* Spike annotations — clamped to the visible y-domain so an outlier
                  doesn't sit off-canvas after the domain excludes it. */}
              {visibleSpikes.map((spike) => {
                const clampedY = Math.min(spike.apy, domainMax);
                const isClamped = spike.apy > domainMax;
                return (
                  <ReferenceDot
                    key={spike.date}
                    x={spike.date}
                    y={clampedY}
                    r={4}
                    fill={SPIKE_COLOR}
                    stroke="var(--color-background)"
                    strokeWidth={1.5}
                    label={{
                      value: `${isClamped ? "↑↑" : "↑"} ${formatChartNumber(spike.apy, 1, 1)}%`,
                      fill: SPIKE_COLOR,
                      fontSize: 10,
                      position: "top",
                    }}
                  />
                );
              })}
              {/* Overlay lines for multi-source comparison */}
              {model.overlaySeriesKeys.map((dataKey, i) => (
                <Line
                  key={dataKey}
                  type="monotone"
                  dataKey={dataKey}
                  stroke={OVERLAY_COLORS[i]}
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
        {model.showBreakdown && pysSparklinePoints.some((point) => point.pysAtPublish !== null) ? (
          <div className="mt-2 border-t border-border/40 pt-2">
            <PysHistorySparkline history={pysSparklinePoints} />
          </div>
        ) : null}
      </ChartShell>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BRAND_ACCENT }} />
            {model.primarySourceLabel.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
            <span className="font-mono tabular-nums">{formatChartNumber(benchmarkRate)}%</span>
            Benchmark: {benchmarkLabel ?? "Rate"}
            {benchmarkIsFallback ? (
              <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-[0.1em] text-amber-700 dark:text-amber-400">
                fallback
              </span>
            ) : null}
          </span>
          {medianApy > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              <span className="font-mono tabular-nums">{formatChartNumber(medianApy)}%</span>
              Peer median
            </span>
          ) : null}
          {model.overlayLabels.map((source, i) => (
            <span key={source.sourceKey} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: OVERLAY_COLORS[i] }} />
              {source.label}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/80">
          <span className="uppercase tracking-[0.12em] text-muted-foreground/70">Markers</span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CHART_AMBER }} />
            warning
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-[2px]" style={{ backgroundColor: CHART_BLUE }} />
            source change
          </span>
          {spikeAnnotations.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SPIKE_COLOR }} />
              spike
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
