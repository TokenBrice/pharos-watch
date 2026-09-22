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

interface ChartRow extends Record<string, number> {
  ts: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: number;
  pegKeys: string[];
}

function CohortTooltip({ active, payload, label, pegKeys }: ChartTooltipProps) {
  if (!active || !payload?.length || !label) return null;

  const rows = [...pegKeys]
    .reverse()
    .map((key) => {
      const item = payload.find((entry) => entry.dataKey === key);
      if (!item || !item.value) return null;
      return { key, value: item.value, color: pegKeyToHex(key) };
    })
    .filter(Boolean) as Array<{ key: string; value: number; color: string }>;

  const total = rows.reduce((sum, row) => sum + row.value, 0);

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
          <span className="pharos-numeric text-foreground">{formatCurrency(row.value)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/50 pt-1.5 text-xs">
        <span className="text-muted-foreground">Total</span>
        <span className="pharos-numeric font-semibold text-foreground">{formatCurrency(total)}</span>
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
  const { data, isLoading } = useStablecoinCharts();

  const { chartData, pegKeys, totalNonUsd, pegCount, otherLabels } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return {
        chartData: [] as ChartRow[],
        pegKeys: [] as string[],
        totalNonUsd: 0,
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
    const sorted = [...keySet].sort((left, right) => (latest[right] ?? 0) - (latest[left] ?? 0));
    const majorKeys: string[] = [];
    const minorKeys: string[] = [];

    for (const key of sorted) {
      if ((latest[key] ?? 0) >= OTHER_THRESHOLD) {
        majorKeys.push(key);
      } else {
        minorKeys.push(key);
      }
    }

    const hasOther = minorKeys.length > 0;
    const displayKeys = hasOther ? [...majorKeys, OTHER_KEY] : majorKeys;

    const points = data.map((point) => {
      const row: ChartRow = { ts: point.date * 1000 };
      for (const key of majorKeys) {
        row[key] = point.totalCirculatingUSD[key] ?? 0;
      }
      if (hasOther) {
        row[OTHER_KEY] = minorKeys.reduce(
          (sum, key) => sum + (point.totalCirculatingUSD[key] ?? 0),
          0,
        );
      }
      return row;
    });

    const total = sorted.reduce((sum, key) => sum + (latest[key] ?? 0), 0);

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
  const legendKeys = latestPoint ? pegKeys.filter((key) => (latestPoint[key] ?? 0) > 0) : pegKeys;
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
        format: (row: ChartRow) => formatCurrency(row[key] ?? 0),
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
    <FocusedStackedAreaCard
      data={chartData}
      tsKey="ts"
      isLoading={isLoading}
      title="Alt-Peg Market Cap By Cohort"
      loadingTitle="Alt-Peg Cohort Growth"
      titleClassName="pharos-section-title"
      subtitle={
        <p className="pharos-meta">
          {legendKeys.length} currently visible cohorts in this feed &middot; current alt-peg market cap:{" "}
          {formatCurrency(totalNonUsd, 1)}.
        </p>
      }
      coverageNote={
        coverageStartLabel ? (
          <p className="text-xs text-muted-foreground">
            Coverage starts {coverageStartLabel}. This uses the legacy provider-wide stablecoin-charts cohort feed;
            its live core-universe tail is withheld during the aggregate-policy transition to avoid a false drop.
            Cohorts below the current ${OTHER_THRESHOLD.toLocaleString("en-US")} latest-point threshold roll into
            Other.
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
      tooltip={<CohortTooltip pegKeys={pegKeys} />}
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
  );
}
