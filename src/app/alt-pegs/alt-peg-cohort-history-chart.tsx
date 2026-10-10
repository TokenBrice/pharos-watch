"use client";

import { Fragment, useCallback, useMemo } from "react";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { type TimeRangeOption } from "@/hooks/use-time-range-filter";
import {
  FocusedStackedAreaCard,
  type StackedAreaSeries,
} from "@/components/chart-primitives/focused-stacked-area-card";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { computeChartYDomain } from "@/lib/chart-utils";
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { PharosChartTooltip, TooltipLabel } from "@/components/pharos-chart-tooltip";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { admitSupplyBuckets } from "@shared/lib/supply";

const OTHER_KEY = "peggedOther";
const OTHER_THRESHOLD = 5_000_000;
const OTHER_COLOR = PEG_CHART_COLORS.OTHER.hex;
const RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];
const DEFAULT_RANGE: TimeRangeOption = "1y";
const FOCUSED_CHART_HEIGHT = "h-[24rem] sm:h-[30rem]";

function pegKeyToCode(key: string): string {
  return key.replace(/^pegged/, "");
}

function pegKeyToHex(key: string): string {
  if (key === OTHER_KEY) return OTHER_COLOR;
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.hex ?? OTHER_COLOR;
}

function pegKeyToLabel(key: string): string {
  if (key === OTHER_KEY) return "Other";
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.label ?? pegKeyToCode(key);
}

interface ChartRow extends Record<string, number | null> {
  ts: number;
}

function sumCohorts(buckets: Record<string, number | null>, keys: readonly string[]): number | null {
  const admitted = admitSupplyBuckets(Object.fromEntries(keys.map((key) => [key, buckets[key] ?? null])));
  return admitted.status === "observed" ? admitted.total : null;
}

function formatObservation(value: number | null | undefined, decimals = 2): string {
  return value == null ? "Unavailable" : formatCurrency(value, decimals);
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; color: string }>;
  label?: number;
  pegKeys: string[];
  data: ChartRow[];
}

function CohortTooltip({ active, label, pegKeys, data }: ChartTooltipProps) {
  if (!active || !label) return null;
  const point = data.find((row) => row.ts === label);
  if (!point) return null;
  const rows = [...pegKeys].reverse().map((key) => ({
    key, value: point[key], color: pegKeyToHex(key),
  }));

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{formatChartDate(label, "long")}</TooltipLabel>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            {pegKeyToLabel(row.key)}
          </span>
          <span className="pharos-numeric text-foreground">{formatObservation(row.value)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/50 pt-1.5 text-xs">
        <span className="text-muted-foreground">Total</span>
        <span className="pharos-numeric font-semibold text-foreground">{formatObservation(point.total)}</span>
      </div>
    </PharosChartTooltip>
  );
}

interface AltPegCohortHistoryChartProps {
  initialRange?: TimeRangeOption;
  isFocused?: boolean;
  onOpenFocus?: (range: TimeRangeOption) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (range: TimeRangeOption) => void;
}

export function AltPegCohortHistoryChart({
  initialRange = DEFAULT_RANGE,
  isFocused = false,
  onOpenFocus,
  onCloseFocus,
  onRangeChange,
}: AltPegCohortHistoryChartProps = {}) {
  const query = useStablecoinCharts();
  const { data, isLoading } = query;

  const { chartData, pegKeys, totalNonUsd, pegCount, otherLabels } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return {
        chartData: [] as ChartRow[],
        pegKeys: [] as string[],
        totalNonUsd: null,
        pegCount: 0,
        otherLabels: [] as string[],
      };
    }

    const keySet = new Set<string>();
    for (const point of data) {
      for (const key of Object.keys(point.totalCirculatingUSD)) {
        if (key !== "peggedUSD") keySet.add(key);
      }
    }

    const latest = data[data.length - 1]?.totalCirculatingUSD ?? {};
    // Missing latest observations do not reclassify a previously major cohort as a collapse.
    const latestObserved = new Map<string, number>();
    for (const point of data) {
      for (const key of keySet) {
        const value = point.totalCirculatingUSD[key];
        if (value != null) latestObserved.set(key, value);
      }
    }
    const sorted = [...keySet].sort((left, right) =>
      (latestObserved.get(right) ?? -1) - (latestObserved.get(left) ?? -1));
    const majorKeys: string[] = [];
    const minorKeys: string[] = [];

    for (const key of sorted) {
      if ((latestObserved.get(key) ?? -1) >= OTHER_THRESHOLD) {
        majorKeys.push(key);
      } else {
        minorKeys.push(key);
      }
    }

    const hasOther = minorKeys.length > 0;
    const displayKeys = hasOther ? [...majorKeys, OTHER_KEY] : majorKeys;

    const points = data.map((point) => {
      const row: ChartRow = { ts: point.date * 1000, total: sumCohorts(point.totalCirculatingUSD, sorted) };
      for (const key of majorKeys) {
        row[key] = point.totalCirculatingUSD[key] ?? null;
      }
      if (hasOther) {
        row[OTHER_KEY] = sumCohorts(point.totalCirculatingUSD, minorKeys);
      }
      return row;
    });

    const total = sumCohorts(latest, sorted);

    return {
      chartData: points,
      pegKeys: displayKeys,
      totalNonUsd: total,
      pegCount: sorted.length,
      otherLabels: minorKeys.map((key) => pegKeyToLabel(key)),
    };
  }, [data]);

  const coverageStartLabel = chartData[0] ? formatChartDate(chartData[0].ts, "long") : null;
  const latestPoint = chartData[chartData.length - 1];
  const latestSampleLabel = latestPoint ? formatChartDate(latestPoint.ts, "long") : null;
  const legendKeys = pegKeys;
  const series = useMemo<StackedAreaSeries[]>(
    () =>
      pegKeys.map((key) => ({
        dataKey: key,
        color: pegKeyToHex(key),
        gradientId: `altPegGrad-${pegKeyToCode(key)}`,
        stackId: "alt-pegs",
        handleAnimationEnd: true,
        legend: legendKeys.includes(key) ? (
          <Fragment>
            {pegKeyToLabel(key)}
            {key === OTHER_KEY && otherLabels.length > 0 ? (
              <span className="text-muted-foreground/70">({otherLabels.join(", ")})</span>
            ) : null}
          </Fragment>
        ) : undefined,
      })),
    [legendKeys, otherLabels, pegKeys],
  );
  const tableColumns = useMemo<ChartDataTableColumn<ChartRow>[]>(
    () => [
      { id: "date", label: "Date", format: (row) => formatChartDate(row.ts, "short-year") },
      ...pegKeys.map((key) => ({
        id: key,
        label: pegKeyToLabel(key),
        format: (row: ChartRow) => formatObservation(row[key]),
      })),
    ],
    [pegKeys],
  );
  const getYDomain = useCallback(
    (filteredData: ChartRow[], range: TimeRangeOption) =>
      computeChartYDomain(
        filteredData.map((row) => pegKeys.reduce((sum, key) => sum + (row[key] ?? 0), 0)),
        range === "all",
      ),
    [pegKeys],
  );

  return (
    <>
    <StaleDataBanner queries={[{
      label: "Alt-Peg Cohort History",
      dataUpdatedAt: query.dataUpdatedAt,
      staleTime: API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts * 1000,
      error: query.error,
      hasData: !!data?.length,
      meta: query.meta,
    }]} />
    {query.error ? (
      <QueryErrorNotice error={query.error} hasData={!!data?.length} onRetry={() => void query.refetch()} />
    ) : null}
    <FocusedStackedAreaCard
      data={chartData}
      tsKey="ts"
      isLoading={isLoading}
      title="Alt-Peg Market Cap By Cohort"
      loadingTitle="Alt-Peg Cohort Growth"
      titleClassName="pharos-section-title"
      subtitle={
        <p className="pharos-meta">
          {legendKeys.length} cohorts in this feed &middot; latest provider-wide sample
          {latestSampleLabel ? ` (${latestSampleLabel})` : ""}: {formatObservation(totalNonUsd, 1)}.
        </p>
      }
      coverageNote={
        coverageStartLabel ? (
          <p className="text-xs text-muted-foreground">
            Coverage starts {coverageStartLabel}. This historical provider-wide cohort feed includes selected
            structural history overlays. No current core-universe point is appended because the populations differ.
            Cohorts below ${OTHER_THRESHOLD.toLocaleString("en-US")} at their latest observed sample roll into
            Other. Missing or invalid buckets remain gaps; incomplete totals are unavailable.
          </p>
        ) : null
      }
      focusedNote={
        <p className="text-xs text-muted-foreground">
          Focused view &middot; shareable URL &middot; this chart measures cohort dollar market cap, not share of
          the total stablecoin market.
        </p>
      }
      initialRange={initialRange}
      rangeOptions={RANGE_OPTIONS}
      isFocused={isFocused}
      onOpenFocus={onOpenFocus}
      onCloseFocus={onCloseFocus}
      onRangeChange={onRangeChange}
      openFocusLabel="Open large cohort chart"
      closeFocusLabel="Return cohort chart to overview"
      focusedHeightClassName={FOCUSED_CHART_HEIGHT}
      ariaLabel={`Alt-peg market-cap-by-cohort chart covering ${pegCount} peg currencies`}
      emptyMessage="No cohort-growth data available"
      series={series}
      tooltip={<CohortTooltip pegKeys={pegKeys} data={chartData} />}
      yDomain={getYDomain}
      yTickFormatter={(value) => formatCurrency(value, 0)}
      tableColumns={tableColumns}
      tableCaption={(_rows, truncated, total) =>
        `Alt-peg market cap by cohort over ${total} points${truncated ? "; showing the latest 90" : ""}.`
      }
      cardClassName="pharos-card-shell animate-in fade-in duration-200 motion-reduce:animate-none"
      contentClassName="space-y-4"
      legendClassName="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
    />
    </>
  );
}
