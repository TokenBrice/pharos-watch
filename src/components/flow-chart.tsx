"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { TimeXAxis, MonoYAxis, TimeGrid, ChartLegendChip } from "@/components/chart-primitives/axes";
import { ChartFigure } from "@/components/chart-primitives/figure";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { CHART_GREEN, CHART_RED, CHART_BLUE, CHART_SLATE, CHART_HEIGHT } from "@/lib/chart-colors";
import type { MintBurnHourlyBucket } from "@shared/types";
import { DAY_HOURS, HOUR_SECONDS } from "@/lib/constants";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

interface FlowChartProps {
  hourly: MintBurnHourlyBucket[];
  isLoading: boolean;
}

interface ChartDatum {
  ts: number;
  /** Positive when net flow is positive (mint dominated bucket), else 0. */
  positiveDelta: number;
  /** Negative when net flow is negative (burn dominated bucket), else 0. */
  negativeDelta: number;
  /** Raw mint and burn volumes for the tooltip. */
  mint: number;
  burn: number;
  /** Net flow for this bucket. */
  net: number;
  /** Running cumulative of net flow across the visible series. */
  cumulative: number;
  /** 7-period trailing mean of net flow. Drives the reference band. */
  rollingNet: number;
  isInterpolated: boolean;
}

const FLOW_TABLE_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const FLOW_TABLE_COLUMNS: ChartDataTableColumn<ChartDatum>[] = [
  { id: "time", label: "Time (UTC)", format: (row) => FLOW_TABLE_DATE_FMT.format(new Date(row.ts)) },
  { id: "mint", label: "Minted (USD)", format: (row) => formatCurrency(row.mint, 0) },
  { id: "burn", label: "Burned (USD)", format: (row) => formatCurrency(row.burn, 0) },
  { id: "net", label: "Net flow (USD)", format: (row) => formatCurrency(row.net, 0) },
  { id: "cumulative", label: "Cumulative (USD)", format: (row) => formatCurrency(row.cumulative, 0) },
];

const DAY_SECONDS = DAY_HOURS * 60 * 60;
const WATERFALL_BUCKET_THRESHOLD_HOURS = 7 * DAY_HOURS;
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

function aggregateBuckets(
  sorted: MintBurnHourlyBucket[],
  bucketSeconds: number,
): Array<{
  ts: number;
  mint: number;
  burn: number;
  net: number;
  isInterpolated: boolean;
}> {
  if (sorted.length === 0) return [];
  const byBucket = new Map<number, { mint: number; burn: number; net: number; hadData: boolean }>();
  for (const b of sorted) {
    const bucketTs = Math.floor(b.hourTs / bucketSeconds) * bucketSeconds;
    const entry = byBucket.get(bucketTs) ?? { mint: 0, burn: 0, net: 0, hadData: false };
    entry.mint += b.mintVolumeUsd;
    entry.burn += b.burnVolumeUsd;
    entry.net += b.netFlowUsd;
    entry.hadData = true;
    byBucket.set(bucketTs, entry);
  }

  const startBucket = Math.floor(sorted[0].hourTs / bucketSeconds) * bucketSeconds;
  const endBucket = Math.floor(sorted[sorted.length - 1].hourTs / bucketSeconds) * bucketSeconds;
  const result: Array<{ ts: number; mint: number; burn: number; net: number; isInterpolated: boolean }> = [];
  for (let bucketTs = startBucket; bucketTs <= endBucket; bucketTs += bucketSeconds) {
    const entry = byBucket.get(bucketTs);
    result.push({
      ts: bucketTs * 1000,
      mint: entry?.mint ?? 0,
      burn: entry?.burn ?? 0,
      net: entry?.net ?? 0,
      isInterpolated: !entry?.hadData,
    });
  }
  return result;
}

export function FlowChart({ hourly, isLoading }: FlowChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const prefersReducedMotion = usePrefersReducedMotion();
  const entranceMs = useMotionDurationMs();

  /**
   * Range probe: needs a separate pass on raw hourly so the threshold check is
   * cheap and predictable. Used to pick the aggregation cadence (hourly vs
   * daily) before we shape the chart data, and as the X-axis tick range.
   */
  const rangeHours = useMemo(() => {
    if (hourly.length < 2) return 0;
    let min = hourly[0].hourTs;
    let max = hourly[0].hourTs;
    for (const b of hourly) {
      if (b.hourTs < min) min = b.hourTs;
      if (b.hourTs > max) max = b.hourTs;
    }
    return (max - min) / 3600;
  }, [hourly]);

  const useDailyBuckets = rangeHours > WATERFALL_BUCKET_THRESHOLD_HOURS;
  const bucketSeconds = useDailyBuckets ? DAY_SECONDS : HOUR_SECONDS;

  const chartData = useMemo<ChartDatum[]>(() => {
    if (hourly.length === 0) return [];
    const sorted = [...hourly].sort((a, b) => a.hourTs - b.hourTs);
    const buckets = aggregateBuckets(sorted, bucketSeconds);

    // 7-bucket trailing window for rolling-net band. Window scales with cadence
    // so the daily view shows a 7-day band; hourly view shows a 7-hour band.
    const window = 7;
    let cumulative = 0;
    const result: ChartDatum[] = [];
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      cumulative += b.net;
      const start = Math.max(0, i - (window - 1));
      let rolling = 0;
      for (let j = start; j <= i; j += 1) rolling += buckets[j].net;
      const rollingMean = rolling / (i - start + 1);
      result.push({
        ts: b.ts,
        positiveDelta: b.net > 0 ? b.net : 0,
        negativeDelta: b.net < 0 ? b.net : 0,
        mint: b.mint,
        burn: b.burn,
        net: b.net,
        cumulative,
        rollingNet: rollingMean,
        isInterpolated: b.isInterpolated,
      });
    }
    return result;
  }, [hourly, bucketSeconds]);

  const hasInterpolated = useMemo(() => chartData.some((d) => d.isInterpolated), [chartData]);

  const { bandX1, bandX2, bandY1, bandY2 } = useMemo(() => {
    // Reference area uses the min/max of the rolling-net series so the band
    // hugs the visible range; if the rolling values straddle zero we draw a
    // calm equilibrium ribbon.
    if (chartData.length === 0) return { bandX1: 0, bandX2: 0, bandY1: 0, bandY2: 0 };
    let rMin = Infinity;
    let rMax = -Infinity;
    for (const d of chartData) {
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

  const formatXAxisTick = useCallback(
    (ts: number) => {
      if (rangeHours <= 48) {
        return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
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

  const animationActive = !prefersReducedMotion;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_GREEN }}>
          Net Mint
        </ChartLegendChip>
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_RED }}>
          Net Burn
        </ChartLegendChip>
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_BLUE }}>
          Cumulative
        </ChartLegendChip>
        <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_SLATE, opacity: 0.35 }}>
          7{useDailyBuckets ? "d" : "h"} rolling-net band
        </ChartLegendChip>
        <span className="ml-auto text-[11px] text-muted-foreground/70 uppercase tracking-wide">
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
            <TimeXAxis dataKey="ts" minTickGap={72} tickFormatter={formatXAxisTick} />
            <MonoYAxis tickFormatter={(val: number) => formatCurrency(val, 0)} />
            <Tooltip content={<FlowTooltip useDailyBuckets={useDailyBuckets} />} cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }} />
            {bandX2 > bandX1 && bandY2 > bandY1 && (
              <ReferenceArea
                x1={bandX1}
                x2={bandX2}
                y1={bandY1}
                y2={bandY2}
                fill={CHART_SLATE}
                fillOpacity={0.08}
                stroke={CHART_SLATE}
                strokeOpacity={0.18}
                strokeDasharray="3 4"
                ifOverflow="extendDomain"
              />
            )}
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
            />
          </ComposedChart>
        )}
      />
      {hasInterpolated && (
        <p className="mt-1 text-xs text-muted-foreground">Gaps in {useDailyBuckets ? "daily" : "hourly"} data are filled with zero values.</p>
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
  payload?: Array<{ dataKey: string; value: number; color: string; name: string; payload?: ChartDatum }>;
  label?: number;
  useDailyBuckets: boolean;
}) {
  if (!active || !payload || !label) return null;

  const datum = payload[0]?.payload;
  const time = new Date(label).toLocaleString(
    "en-US",
    useDailyBuckets
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true },
  );

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{time}</TooltipLabel>
      {datum ? (
        <>
          <TooltipRow color={CHART_GREEN} label="Mint" value={formatCurrency(datum.mint)} />
          <TooltipRow color={CHART_RED} label="Burn" value={formatCurrency(datum.burn)} />
          <TooltipRow
            color={datum.net >= 0 ? CHART_GREEN : CHART_RED}
            label="Net"
            value={`${datum.net >= 0 ? "+" : "-"}${formatCurrency(Math.abs(datum.net))}`}
          />
          <TooltipRow
            color={CHART_BLUE}
            label="Cumulative"
            value={`${datum.cumulative >= 0 ? "+" : "-"}${formatCurrency(Math.abs(datum.cumulative))}`}
          />
        </>
      ) : null}
    </PharosChartTooltip>
  );
}
