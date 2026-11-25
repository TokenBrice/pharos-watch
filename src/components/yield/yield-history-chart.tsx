"use client";

import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import { RefreshCw } from "lucide-react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { PysHistorySparkline, type PysHistorySparklinePoint } from "@/components/yield/pys-history-sparkline";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DataHealthBanner } from "@/components/data-health-banner";
import { CHART_AMBER, CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { CHART_GRID_DASH, CHART_GRID_STROKE } from "@/lib/chart-theme";
import { toTimestampMs } from "@/lib/time";
import { cn } from "@/lib/utils";
import { isClientTokenizedFundId } from "@shared/lib/stablecoins/aggregate-client-registry";
import { isPublicWarning } from "@/lib/data-health";
import {
  BRAND_ACCENT,
  DEFAULT_DAYS,
  formatChartNumber,
  resolveReferenceLineLabels,
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
  YAxisTick,
  YieldHistoryTooltip,
} from "./yield-history-chart-ui";

const SPIKE_COLOR = "oklch(0.72 0.18 35)";
/** A label within this many px of the plot top sits under its line instead of over it. */
const REFERENCE_LABEL_HEIGHT_PX = 14;

/**
 * Reference-line label set beside its line, never on it (a dashed line through
 * the text read as struck through), haloed in the chart background so a series
 * passing behind it cannot cross the glyphs.
 */
function ReferenceLabel({
  viewBox,
  text,
  below,
}: {
  viewBox?: { x?: number; y?: number; width?: number };
  text: string;
  below: boolean;
}) {
  return (
    <text
      x={(viewBox?.x ?? 0) + (viewBox?.width ?? 0) - 4}
      y={(viewBox?.y ?? 0) + (below ? 12 : -5)}
      textAnchor="end"
      fill="var(--color-muted-foreground)"
      fontSize={10}
      stroke="var(--color-background)"
      strokeWidth={3}
      strokeLinejoin="round"
      paintOrder="stroke"
    >
      {text}
    </text>
  );
}

type NullableBenchmarkYieldHistoryChartProps = YieldHistoryChartProps;

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
}: NullableBenchmarkYieldHistoryChartProps) {
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
  const sourceNotices = model.sourceQueries.map((source) => {
    // Retained data with a failed refresh, an advisory or a degraded clock is operator signal (ADR-42).
    const showsHealth = source.hasData && isPublicWarning(source.health);
    return (
      <div key={source.sourceKey} className="space-y-2" aria-label={`${source.label} history status`}>
        {source.isLoading || (source.error && !source.hasData) || showsHealth ? (
          <p className="text-xs font-medium text-muted-foreground">{source.label}</p>
        ) : null}
        {source.isLoading ? <p className="text-xs text-muted-foreground">Loading history</p> : null}
        <QueryErrorNotice error={source.error} hasData={source.hasData} onRetry={source.onRetry} />
        {showsHealth ? <DataHealthBanner entries={[source.health]} /> : null}
      </div>
    );
  });

  const spikeAnnotations = model.spikeAnnotations;
  const domainMax = model.yDomain[1];
  const domainMin = model.yDomain[0];
  const spikesByDate = new Map(
    spikeAnnotations.map((s) => [
      s.date,
      { trailingAvg: s.trailingAvg, ratio: s.ratio, windowDays: s.windowDays },
    ]),
  );
  const chartMargin = compact ? { top: 8, right: 8, bottom: 8, left: 0 } : { top: 12, right: 18, bottom: 12, left: 0 };
  const xAxisHeight = compact ? 26 : 30;
  const plotHeight = Math.max(1, height - chartMargin.top - chartMargin.bottom - xAxisHeight);
  // Off-scale references say so (E25); near-coincident ones share one label.
  const referenceLabels = resolveReferenceLineLabels({
    benchmark: benchmarkRate == null ? null : { rate: benchmarkRate, label: benchmarkLabel ?? "Benchmark" },
    median: medianApy == null ? null : { rate: medianApy, label: "Median" },
    domain: model.yDomain,
    plotHeight,
  });
  // Compact charts carry no inline labels; the legend chips name both lines.
  const referenceLabel = (text: string | null, rate: number) => {
    if (compact || !text) return undefined;
    const fromTop = domainMax > domainMin ? ((domainMax - Math.min(Math.max(rate, domainMin), domainMax)) / (domainMax - domainMin)) * plotHeight : 0;
    return <ReferenceLabel text={text} below={fromTop < REFERENCE_LABEL_HEIGHT_PX} />;
  };
  // A warning run is a band; a one-observation run still gets a visible sliver.
  const firstTs = model.mergedChartData[0]?.date ?? 0;
  const lastTs = model.mergedChartData[model.mergedChartData.length - 1]?.date ?? 0;
  const minRunMs = (lastTs - firstTs) * 0.004;
  const warningBands = model.warningRuns.map((run) => {
    const end = Math.min(Math.max(run.end, run.start + minRunMs), lastTs);
    return { ...run, start: Math.max(firstTs, Math.min(run.start, end - minRunMs)), end };
  });
  const hasSourceSwitch = model.chartData.some((point) => point.sourceSwitch);
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
  if (model.mergedChartData.length === 0 && model.sourceQueries.every((source) => source.isLoading)) {
    // The loading frame is the final layout (controls, then chart), not a placeholder pill.
    return (
      <div className="space-y-3" aria-busy="true">
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
          <p role="status" className="sr-only">Loading history</p>
          <ChartSkeleton className={cn("w-full rounded-xl", chartHeightClass)} />
        </ChartShell>
      </div>
    );
  }

  if (model.mergedChartData.length === 0) {
    // Every requested source failed with nothing retained: one compact state
    // with its retry, not a red alert stacked over an empty chart frame.
    const allFailed = model.sourceQueries.length > 0 && model.sourceQueries.every((source) => source.error && !source.hasData);
    if (allFailed) {
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
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground"
          >
            <span>Yield history could not be loaded right now.</span>
            <button
              type="button"
              onClick={() => model.sourceQueries.forEach((source) => source.onRetry?.())}
              className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border/70 bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {sourceNotices}
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
              <p className="text-sm text-muted-foreground">
                {model.sourceQueries.some((source) => source.error) ? "Unable to load requested yield history" : "No yield history available"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">Select a different yield source or check back later.</p>
            </div>
          </div>
        </ChartShell>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sourceNotices}
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
      {model.primarySourceKey === "best" ? (
        <p className="text-xs text-muted-foreground">
          Selected source over time. The headline 30d APY uses the current source&apos;s series only.
        </p>
      ) : null}
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
          aria-label={`Yield history chart showing ${model.mergedChartData.length} observation timestamps`}
        >
          {isChartReady ? (
            <ComposedChart
              width={width}
              height={height}
              data={model.mergedChartData}
              margin={chartMargin}
            >
              <CartesianGrid stroke={CHART_GRID_STROKE} strokeDasharray={CHART_GRID_DASH} vertical={false} />
              {warningBands.map((run) => (
                <ReferenceArea
                  key={`${run.kind}-${run.start}`}
                  x1={run.start}
                  x2={run.end}
                  fill={run.kind === "warning" ? CHART_AMBER : "var(--color-muted-foreground)"}
                  fillOpacity={run.kind === "warning" ? 0.1 : 0.08}
                  strokeOpacity={0}
                  ifOverflow="hidden"
                />
              ))}
              <XAxis
                dataKey="date"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                ticks={model.tickValues}
                tickLine={false}
                axisLine={false}
                height={xAxisHeight}
                tick={(props) => (
                  <AxisTick
                    {...props}
                    value={renderAxisTick(props.payload?.value, model.days)}
                  />
                )}
              />
              <YAxis
                domain={model.yDomain}
                ticks={model.yTicks}
                interval={0}
                allowDataOverflow
                tickLine={false}
                axisLine={false}
                width={compact ? 48 : 58}
                tick={(props) => <YAxisTick {...props} />}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-border)", strokeWidth: 1, strokeDasharray: "3 3" }}
                content={<YieldHistoryTooltip showBreakdown={model.effectiveShowBreakdown} compact={compact} spikesByDate={spikesByDate} primarySource={model.primarySourceLabel} overlaySources={model.overlayLabels} tokenizedFund={isClientTokenizedFundId(stablecoinId)} />}
              />
              {benchmarkRate != null ? (
                <ReferenceLine
                  y={Math.min(Math.max(benchmarkRate, domainMin), domainMax)}
                  stroke={CHART_SLATE}
                  strokeOpacity={0.8}
                  strokeDasharray="6 4"
                  label={referenceLabel(referenceLabels.benchmark, benchmarkRate)}
                />
              ) : null}
              {medianApy != null ? (
                <ReferenceLine
                  y={Math.min(Math.max(medianApy, domainMin), domainMax)}
                  stroke={CHART_BLUE}
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                  label={referenceLabel(referenceLabels.median, medianApy)}
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
                  isAnimationActive={false}
                />
              ) : null}
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
              {model.overlayLabels.map(({ dataKey, color }) => (
                <Line
                  key={dataKey}
                  type="monotone"
                  dataKey={dataKey}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  dot={{ r: 2, strokeWidth: 0 }}
                  activeDot={false}
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-2xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BRAND_ACCENT }} />
            {model.primarySourceLabel.label}
          </span>
          {benchmarkRate != null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              <span className="font-mono tabular-nums">{formatChartNumber(benchmarkRate)}%</span>
              Benchmark: {benchmarkLabel ?? "Rate"}
              {benchmarkIsFallback ? (
                <span className="rounded-sm bg-state-warn-solid/15 px-1 py-px text-3xs font-medium uppercase text-state-warn">
                  fallback
                </span>
              ) : null}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              No benchmark
            </span>
          )}
          {medianApy != null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              <span className="font-mono tabular-nums">{formatChartNumber(medianApy)}%</span>
              Median of tracked yields (TVL-weighted)
            </span>
          ) : null}
          {model.overlayLabels.map((source) => (
            <span key={source.sourceKey} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: source.color }} />
              {source.label}
            </span>
          ))}
          {model.omittedOverlayKeys.length > 0 ? (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-background/55 px-2.5 py-1">
              +{model.omittedOverlayKeys.length} more not plotted
            </span>
          ) : null}
        </div>
        {/* The key lists only markers this window actually draws. */}
        {warningBands.length > 0 || hasSourceSwitch || spikeAnnotations.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground/80">
            <span className="pharos-label">Markers</span>
            {warningBands.some((run) => run.kind === "warning") ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-3 rounded-xs opacity-40" style={{ backgroundColor: CHART_AMBER }} />
                warning
              </span>
            ) : null}
            {warningBands.some((run) => run.kind === "unreadable") ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-3 rounded-xs bg-muted-foreground/25" />
                warnings unreadable
              </span>
            ) : null}
            {hasSourceSwitch ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-xs" style={{ backgroundColor: CHART_BLUE }} />
                source change
              </span>
            ) : null}
            {spikeAnnotations.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SPIKE_COLOR }} />
                spike
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
