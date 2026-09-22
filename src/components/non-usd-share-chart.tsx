"use client";

import { useCallback, useMemo } from "react";
import { type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { formatCurrency, formatChartDate, formatPercent } from "@shared/lib/format";
import { useNonUsdShare } from "@/hooks/api-hooks";
import { CHART_GREEN, CHART_AMBER } from "@/lib/chart-colors";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import {
  FocusedStackedAreaCard,
  type StackedAreaSeries,
} from "@/components/chart-primitives/focused-stacked-area-card";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { computeChartYDomain } from "@/lib/chart-utils";

const COMMODITY_COLOR = CHART_AMBER;
const FIAT_COLOR = CHART_GREEN;
const RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];
const DEFAULT_RANGE: TimeRangeOption = "1y";
const FOCUSED_CHART_HEIGHT = "h-[24rem] sm:h-[30rem]";

interface SharePoint {
  ts: number;
  commodityShare: number;
  fiatNonUsdShare: number;
  commodity: number;
  fiatNonUsd: number;
  total: number;
}

const SHARE_SERIES: StackedAreaSeries[] = [
  {
    dataKey: "commodityShare",
    color: COMMODITY_COLOR,
    gradientId: "commodityShareGrad",
    stackId: "1",
    legend: "Commodities (gold, silver)",
    legendMarkerClassName: "inline-block h-2.5 w-2.5 rounded-full shrink-0",
    handleAnimationEnd: true,
  },
  {
    dataKey: "fiatNonUsdShare",
    color: FIAT_COLOR,
    gradientId: "fiatNonUsdShareGrad",
    stackId: "1",
    legend: "Non-commodity non-USD",
    legendMarkerClassName: "inline-block h-2.5 w-2.5 rounded-full shrink-0",
  },
];

const SHARE_TABLE_COLUMNS: ChartDataTableColumn<SharePoint>[] = [
  { id: "date", label: "Date", format: (row) => formatChartDate(row.ts, "short-year") },
  { id: "commodities", label: "Commodities", format: (row) => formatPercent(row.commodityShare) },
  {
    id: "nonCommodity",
    label: "Non-commodity non-USD",
    format: (row) => formatPercent(row.fiatNonUsdShare),
  },
];

interface ShareTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: SharePoint }>;
  label?: number;
}

function ShareTooltip({ active, payload, label }: ShareTooltipProps) {
  if (!payload?.length || !label) return null;
  const point = payload[0]!.payload;
  const totalShare = point.commodityShare + point.fiatNonUsdShare;
  const totalNonUsd = point.commodity + point.fiatNonUsd;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{formatChartDate(label, "long")}</TooltipLabel>
      <TooltipRow color={COMMODITY_COLOR} label="Commodities" value={`${formatPercent(point.commodityShare)} · ${formatCurrency(point.commodity, 1)}`} />
      <TooltipRow color={FIAT_COLOR} label="Non-commodity non-USD" value={`${formatPercent(point.fiatNonUsdShare)} · ${formatCurrency(point.fiatNonUsd, 1)}`} />
      <div className="border-t border-border/50 mt-1.5 pt-1.5">
        <TooltipRow label="Total non-USD" value={`${formatPercent(totalShare)} · ${formatCurrency(totalNonUsd, 1)}`} bold />
      </div>
    </PharosChartTooltip>
  );
}

interface NonUsdShareChartProps {
  initialRange?: TimeRangeOption;
  isFocused?: boolean;
  onOpenFocus?: (range: TimeRangeOption) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (range: TimeRangeOption) => void;
}

export function NonUsdShareChart({
  initialRange = DEFAULT_RANGE,
  isFocused = false,
  onOpenFocus,
  onCloseFocus,
  onRangeChange,
}: NonUsdShareChartProps = {}) {
  const { data, isLoading } = useNonUsdShare();

  const { chartData, latestShare, latestNonUsd, latestTotal } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0)
      return { chartData: [] as SharePoint[], latestShare: 0, latestNonUsd: 0, latestTotal: 0 };

    const points: SharePoint[] = data.map((point) => ({
      ts: point.date * 1000,
      commodityShare: point.commodityShare ?? 0,
      fiatNonUsdShare: point.fiatNonUsdShare ?? 0,
      commodity: point.commodity ?? 0,
      fiatNonUsd: point.fiatNonUsd ?? 0,
      total: point.total,
    }));

    const last = points[points.length - 1]!;
    return {
      chartData: points,
      latestShare: last.commodityShare + last.fiatNonUsdShare,
      latestNonUsd: last.commodity + last.fiatNonUsd,
      latestTotal: last.total,
    };
  }, [data]);

  const coverageStartLabel = chartData[0] ? formatChartDate(chartData[0].ts, "long") : null;
  const getYDomain = useCallback(
    (filteredData: SharePoint[], range: TimeRangeOption) =>
      computeChartYDomain(
        filteredData.map((point) => point.commodityShare + point.fiatNonUsdShare),
        range === "all",
      ),
    [],
  );

  return (
    <FocusedStackedAreaCard
      data={chartData}
      tsKey="ts"
      isLoading={isLoading}
      title="Share Of Total Stablecoin Market Outside USD"
      loadingTitle="Non-USD Market Share"
      subtitle={
        latestTotal > 0 ? (
          <p className="text-sm text-muted-foreground">
            Current share: {formatPercent(latestShare)} of total stablecoin market &middot; current outside-USD
            segment size: {formatCurrency(latestNonUsd, 1)}
          </p>
        ) : null
      }
      coverageNote={
        coverageStartLabel ? (
          <p className="text-xs text-muted-foreground">
            Coverage starts {coverageStartLabel}. Built from supply-history snapshots: daily over the last 90d, then
            weekly to 2y, then monthly across the loaded history window. The non-commodity bucket includes
            currency-linked plus other non-commodity pegs.
          </p>
        ) : null
      }
      focusedNote={
        <p className="text-xs text-muted-foreground">
          Focused view &middot; shareable URL &middot; this chart measures share, not cohort dollar market cap.
        </p>
      }
      initialRange={initialRange}
      rangeOptions={RANGE_OPTIONS}
      isFocused={isFocused}
      onOpenFocus={onOpenFocus}
      onCloseFocus={onCloseFocus}
      onRangeChange={onRangeChange}
      openFocusLabel="Open large share chart"
      closeFocusLabel="Return share chart to overview"
      focusedHeightClassName={FOCUSED_CHART_HEIGHT}
      ariaLabel={`Share of total stablecoin market outside USD chart showing ${formatPercent(latestShare)} current share`}
      emptyMessage="No market share data available"
      series={SHARE_SERIES}
      tooltip={<ShareTooltip />}
      yDomain={getYDomain}
      yTickFormatter={(value) => formatPercent(value, 1)}
      tableColumns={SHARE_TABLE_COLUMNS}
      tableCaption={(_rows, truncated, total) =>
        `Share of total stablecoin market outside USD over ${total} points${truncated ? "; showing the latest 90" : ""}.`
      }
      cardClassName="pharos-card-shell animate-in fade-in duration-300"
      legendClassName="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground"
    />
  );
}
