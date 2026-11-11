"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ReferenceDot,
  DefaultZIndexes,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { TimeXAxis, MonoYAxis, TimeGrid, useNiceValueAxis } from "@/components/chart-primitives/axes";
import { ChartLegendChip } from "@/components/chart-primitives/legend";
import { ChartFigure } from "@/components/chart-primitives/figure";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { formatCurrencyTick } from "@/lib/chart-ticks";
import { CHART_GREEN, CHART_RED, CHART_BLUE, CHART_SLATE, CHART_HEIGHT } from "@/lib/chart-colors";
import type { MintBurnClassification, MintBurnHourlyBucket, MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import { buildFlowChartModel, type ChartDatum } from "./flow-chart-model";
import { formatMintBurnVolume, MINT_BURN_COVERAGE_UNKNOWN_NOTE } from "@shared/lib/mint-burn-valuation-display";
import { DAY_HOURS } from "@/lib/constants";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

interface FlowChartProps {
  hourly: MintBurnHourlyBucket[];
  isLoading: boolean;
  /** Published closed-hour window; absent on pre-cutover payloads. */
  publishedWindow?: { start: number; end: number };
}

const PARTIAL_BUCKET_NOTE = "Partial valuation: net unavailable";

function formatBucketVolume(value: number | null, valuation: MintBurnValuationCompleteness | null, decimals: number, scanComplete: boolean, classification?: MintBurnClassification["completeness"]): string {
  if (value == null) return "—";
  return formatMintBurnVolume(value, valuation, (v) => formatCurrency(v, decimals), scanComplete, classification);
}

/** A gross volume is complete only when the wire scan is complete and the bucket covers its full period. */
function isVolumeComplete(datum: Pick<ChartDatum, "scanComplete" | "periodPartial">): boolean {
  return datum.scanComplete && !datum.periodPartial;
}

function describeBucketValuation(valuation: MintBurnValuationCompleteness | null): string {
  if (valuation === "partial") return PARTIAL_BUCKET_NOTE;
  if (valuation === "unknown") return MINT_BURN_COVERAGE_UNKNOWN_NOTE;
  return valuation === "complete" ? "Complete" : "—";
}

const FLOW_TABLE_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

const FLOW_TABLE_COLUMNS: ChartDataTableColumn<ChartDatum>[] = [
  { id: "time", label: "Time (UTC)", format: (row) => FLOW_TABLE_DATE_FMT.format(new Date(row.ts)) },
  { id: "mint", label: "Minted (USD)", format: (row) => formatBucketVolume(row.mint, row.valuation, 0, isVolumeComplete(row), row.mintClassification) },
  { id: "burn", label: "Burned (USD)", format: (row) => formatBucketVolume(row.burn, row.valuation, 0, isVolumeComplete(row), row.burnClassification) },
  { id: "net", label: "Net flow (USD)", format: (row) => row.net == null ? "—" : formatCurrency(row.net, 0) },
  { id: "cumulative", label: "Cumulative (USD)", format: (row) => row.cumulative == null ? "—" : formatCurrency(row.cumulative, 0) },
  { id: "valuation", label: "Completeness", format: (row) => row.isInterpolated ? "—"
    : row.mintClassification !== "complete" || row.burnClassification !== "complete"
      ? "Classification incomplete: signed net unavailable" : describeBucketValuation(row.valuation) },
  { id: "scan", label: "Gross totals", format: (row) => row.isInterpolated || isVolumeComplete(row) ? "—" : "Observed subtotals" },
];

const ENTRANCE_DURATION_FALLBACK_MS = 400;

/**
 * Resolve the entrance duration from the `--motion-duration-entrance` token at
 * mount time. Falls back to 400ms (token default) if the var isn't readable —
 * the value is stable for the chart's lifetime, so a lazy initializer avoids
 * the React effect-setState anti-pattern.
 */
function useMotionDurationMs(token = "--motion-duration-entrance"): number {
  const [ms] = useState<number>(() => {
    if (typeof window === "undefined") return ENTRANCE_DURATION_FALLBACK_MS;
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (!raw) return ENTRANCE_DURATION_FALLBACK_MS;
    if (raw.endsWith("ms")) return Number.parseFloat(raw);
    if (raw.endsWith("s")) return Number.parseFloat(raw) * 1000;
    return ENTRANCE_DURATION_FALLBACK_MS;
  });
  return ms;
}

export function FlowChart({ hourly, isLoading, publishedWindow }: FlowChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const prefersReducedMotion = usePrefersReducedMotion();
  const entranceMs = useMotionDurationMs();
  // Bars animate once, on entrance. A later re-render (polling refetch, range
  // switch, layout shift from a fold) draws them at rest: a restarted
  // animation was seen to leave the plot without bars (review round 2).
  const [hasEntered, setHasEntered] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setHasEntered(true), entranceMs + 100);
    return () => window.clearTimeout(timer);
  }, [entranceMs]);

  const { rangeHours, useDailyBuckets, bucketSeconds, chartData, hasInterpolated, partialBuckets, partialBucketCount, cumulativeStop } = useMemo(
    () => buildFlowChartModel(hourly, publishedWindow),
    [hourly, publishedWindow],
  );
  const hatchId = `flow-chart-hatch-${useId().replace(/:/g, "")}`;

  const { bandX1, bandX2, bandY1, bandY2 } = useMemo(() => {
    // Reference area uses the min/max of the rolling-net series so the band
    // hugs the visible range; if the rolling values straddle zero we draw a
    // calm equilibrium ribbon.
    if (chartData.length === 0) return { bandX1: 0, bandX2: 0, bandY1: 0, bandY2: 0 };
    let rMin = Infinity;
    let rMax = -Infinity;
    for (const d of chartData) {
      if (d.rollingNet == null) continue;
      if (d.rollingNet < rMin) rMin = d.rollingNet;
      if (d.rollingNet > rMax) rMax = d.rollingNet;
    }
    if (rMin === Infinity || rMax === -Infinity) return { bandX1: 0, bandX2: 0, bandY1: 0, bandY2: 0 };
    if (rMin === rMax) {
      const pad = Math.max(Math.abs(rMax) * 0.05, 1);
      rMin -= pad;
      rMax += pad;
    }
    return {
      bandX1: chartData[0].ts,
      bandX2: chartData[chartData.length - 1].ts,
      bandY1: rMin,
      bandY2: rMax,
    };
  }, [chartData]);
  const axisValues = useMemo(
    () => [...chartData.flatMap((d) => [d.positiveDelta, d.negativeDelta, d.cumulative]), bandY1, bandY2],
    [bandY1, bandY2, chartData],
  );
  const valueAxis = useNiceValueAxis(axisValues, { kind: "currency" });
  // Bars are centred on their bucket timestamp: pad the time domain by half a
  // bucket so the first and last bars are drawn whole instead of half-cut.
  const xDomain = useMemo<[number, number] | ["dataMin", "dataMax"]>(() => {
    if (chartData.length === 0) return ["dataMin", "dataMax"];
    const halfBucketMs = (bucketSeconds * 1000) / 2;
    return [chartData[0].ts - halfBucketMs, chartData[chartData.length - 1].ts + halfBucketMs];
  }, [bucketSeconds, chartData]);

  const formatXAxisTick = useCallback(
    (ts: number) => {
      if (rangeHours <= 48) {
        return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
      }
      if (rangeHours <= 8 * DAY_HOURS) {
        return formatChartDate(ts, "with-time");
      }
      return formatChartDate(ts, "short");
    },
    [rangeHours],
  );

  if (isLoading) {
    return <Skeleton className={`${CHART_HEIGHT} w-full rounded-xl`} />;
  }

  const animationActive = !prefersReducedMotion && !hasEntered;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_GREEN }}>
          Net mint
        </ChartLegendChip>
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_RED }}>
          Net burn
        </ChartLegendChip>
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_BLUE }}>
          Cumulative
        </ChartLegendChip>
        {partialBucketCount > 0 ? (
          <ChartLegendChip
            markerClassName="inline-block h-2.5 w-2.5 rounded-sm border"
            markerStyle={{
              borderColor: CHART_SLATE,
              backgroundImage: `repeating-linear-gradient(135deg, ${CHART_SLATE} 0 1px, transparent 1px 4px)`,
            }}
          >
            Net withheld
          </ChartLegendChip>
        ) : null}
        <span className="ml-auto text-2xs text-muted-foreground/70">
          {useDailyBuckets ? "Daily" : "Hourly"}
        </span>
      </div>
      <ChartFigure
        data={chartData}
        columns={FLOW_TABLE_COLUMNS}
        caption={(rows, truncated, total) => {
          const bucketLabel = useDailyBuckets ? "daily" : "hourly";
          return truncated
            ? `Mint and burn flow — most recent ${rows.length} of ${total} ${bucketLabel} buckets`
            : `Mint and burn flow — ${total} ${bucketLabel} buckets`;
        }}
        ariaLabel={`Mint and burn waterfall chart showing ${chartData.length} ${useDailyBuckets ? "daily" : "hourly"} data points`}
        emptyMessage="No flow data available for this period."
        heightClassName={CHART_HEIGHT}
        containerRef={chartContainerRef}
        isReady={isChartReady}
        renderChart={() => (
          <ComposedChart
            width={width}
            height={height}
            data={chartData}
            margin={{ top: 5, right: 20, bottom: 20, left: 5 }}
          >
            <TimeGrid />
            <TimeXAxis dataKey="ts" domain={xDomain} minTickGap={72} tickFormatter={formatXAxisTick} />
            <MonoYAxis tickFormatter={formatCurrencyTick} {...valueAxis} />
            <Tooltip content={<FlowTooltip useDailyBuckets={useDailyBuckets} />} cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }} />
            <defs>
              <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_SLATE} strokeWidth="1.5" strokeOpacity="0.45" />
              </pattern>
            </defs>
            {bandX2 > bandX1 && bandY2 > bandY1 && (
              <ReferenceArea
                x1={bandX1}
                x2={bandX2}
                y1={bandY1}
                y2={bandY2}
                fill={CHART_SLATE}
                fillOpacity={0.04}
                stroke={CHART_SLATE}
                strokeOpacity={0.45}
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            )}
            {/* A partial bucket's net is withheld, not zero: a hatched column marks the hole. */}
            {partialBuckets.map((bucket) => (
              <ReferenceArea
                key={bucket.ts}
                x1={bucket.ts - (bucketSeconds * 1000) / 2}
                x2={bucket.ts + (bucketSeconds * 1000) / 2}
                fill={`url(#${hatchId})`}
                fillOpacity={1}
                strokeOpacity={0}
                ifOverflow="hidden"
              />
            ))}
            <ReferenceLine y={0} stroke="var(--color-border)" strokeWidth={1} />
            <Bar
              dataKey="positiveDelta"
              name="Net Mint"
              fill={CHART_GREEN}
              isAnimationActive={animationActive}
              animationDuration={entranceMs}
              animationEasing="ease-out"
              stackId="delta"
            />
            <Bar
              dataKey="negativeDelta"
              name="Net Burn"
              fill={CHART_RED}
              isAnimationActive={animationActive}
              animationDuration={entranceMs}
              animationEasing="ease-out"
              stackId="delta"
            />

            <Line
              type="stepAfter"
              dataKey="cumulative"
              stroke={CHART_BLUE}
              strokeWidth={1.5}
              strokeOpacity={0.85}
              dot={false}
              name="Cumulative"
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* The band's direct label in its own layer above the bars (a ReferenceArea label otherwise sits under them). */}
            {bandX2 > bandX1 && bandY2 > bandY1 && (
              <ReferenceArea
                x1={bandX1}
                x2={bandX2}
                y1={bandY1}
                y2={bandY2}
                fillOpacity={0}
                strokeOpacity={0}
                ifOverflow="extendDomain"
                zIndex={DefaultZIndexes.label}
                label={(props: { viewBox?: { x?: number; y?: number } }) => (
                  // Direct label just above the band's top edge, haloed so bars never erase it.
                  <text
                    x={(props.viewBox?.x ?? 0) + 6}
                    y={(props.viewBox?.y ?? 0) - 5}
                    fill={CHART_SLATE}
                    fontSize={10}
                    stroke="var(--background)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {`7${useDailyBuckets ? "d" : "h"} rolling net range`}
                  </text>
                )}
              />
            )}
            {cumulativeStop ? (
              <ReferenceDot
                x={cumulativeStop.ts}
                y={cumulativeStop.value}
                r={3}
                fill={CHART_BLUE}
                stroke="none"
                ifOverflow="extendDomain"
                label={(props: { viewBox?: { x?: number; y?: number } }) => (
                  <text
                    x={(props.viewBox?.x ?? 0) + 8}
                    y={(props.viewBox?.y ?? 0) - 8}
                    fill={CHART_BLUE}
                    fontSize={10}
                    stroke="var(--background)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    Cumulative stops: withheld net
                  </text>
                )}
              />
            ) : null}
          </ComposedChart>
        )}
      />
      {hasInterpolated && (
        <p className="mt-1 text-xs text-muted-foreground">
          Gaps in {useDailyBuckets ? "daily" : "hourly"} data stop cumulative net and withhold rolling averages until the window is complete.
        </p>
      )}
      {partialBucketCount > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Incomplete flow evidence: {partialBucketCount} {useDailyBuckets ? "daily" : "hourly"}{" "}
          {partialBucketCount === 1 ? "bucket has" : "buckets have"} a withheld net. Hatched columns mark the
          withheld nets, and the cumulative line stops before the first one. Mint and burn volumes there are lower bounds.
        </p>
      )}
    </div>
  );
}

function FlowTooltip({
  active,
  payload,
  label,
  useDailyBuckets,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; color: string; name: string; payload?: ChartDatum }>;
  label?: number;
  useDailyBuckets: boolean;
}) {
  if (!active || !payload || !label) return null;

  const datum = payload[0]?.payload;
  // Buckets are closed UTC hours; the viewer's timezone must not move the date.
  const time = formatChartDate(label, useDailyBuckets ? "short-year" : "full");

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{time}</TooltipLabel>
      {datum ? (
        <>
          <TooltipRow color={CHART_GREEN} label="Mint" value={formatBucketVolume(datum.mint, datum.valuation, 2, isVolumeComplete(datum), datum.mintClassification)} />
          <TooltipRow color={CHART_RED} label="Burn" value={formatBucketVolume(datum.burn, datum.valuation, 2, isVolumeComplete(datum), datum.burnClassification)} />
          {datum.mintClassification !== "complete" || datum.burnClassification !== "complete" ? (
            <TooltipRow label="Classification" value="Incomplete: signed net unavailable" />
          ) : null}
          {!datum.scanComplete && !datum.isInterpolated ? (
            <TooltipRow label="Scan coverage" value="Incomplete: observed subtotals" />
          ) : null}
          <TooltipRow
            color={datum.net == null || datum.net >= 0 ? CHART_GREEN : CHART_RED}
            label="Net"
            value={datum.net == null ? "—" : `${datum.net >= 0 ? "+" : "-"}${formatCurrency(Math.abs(datum.net))}`}
          />
          <TooltipRow
            color={CHART_BLUE}
            label="Cumulative"
            value={datum.cumulative == null
              ? "—"
              : `${datum.cumulative >= 0 ? "+" : "-"}${formatCurrency(Math.abs(datum.cumulative))}`}
          />
          {datum.valuation === "partial" || datum.valuation === "unknown" ? (
            <TooltipRow
              label="Valuation"
              value={datum.valuation === "partial" ? PARTIAL_BUCKET_NOTE : "Coverage unknown"}
            />
          ) : null}
        </>
      ) : null}
    </PharosChartTooltip>
  );
}
