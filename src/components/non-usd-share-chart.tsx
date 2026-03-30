"use client";

import { useCallback, useMemo, useState } from "react";
import { AreaChart, Area } from "recharts";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency, formatChartDate, formatPercent } from "@shared/lib/format";
import { useNonUsdShare } from "@/hooks/api-hooks";
import { CHART_GREEN, CHART_AMBER, CHART_HEIGHT } from "@/lib/chart-colors";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { computeChartYDomain } from "@/lib/chart-utils";

const COMMODITY_COLOR = CHART_AMBER;
const FIAT_COLOR = CHART_GREEN;

interface SharePoint {
  ts: number;
  commodityShare: number;
  fiatNonUsdShare: number;
  commodity: number;
  fiatNonUsd: number;
  total: number;
}

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
      <TooltipRow color={FIAT_COLOR} label="Fiat non-USD" value={`${formatPercent(point.fiatNonUsdShare)} · ${formatCurrency(point.fiatNonUsd, 1)}`} />
      <div className="border-t border-border/50 mt-1.5 pt-1.5">
        <TooltipRow label="Total non-USD" value={`${formatPercent(totalShare)} · ${formatCurrency(totalNonUsd, 1)}`} bold />
      </div>
    </PharosChartTooltip>
  );
}

export function NonUsdShareChart() {
  const { data, isLoading } = useNonUsdShare();
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const { chartData, latestShare, latestNonUsd, latestTotal } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0)
      return { chartData: [] as SharePoint[], latestShare: 0, latestNonUsd: 0, latestTotal: 0 };

    const points: SharePoint[] = data.map((point) => ({
      ts: point.date * 1000,
      commodityShare: point.commodityShare,
      fiatNonUsdShare: point.fiatNonUsdShare,
      commodity: point.commodity,
      fiatNonUsd: point.fiatNonUsd,
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

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo(
    () => computeChartYDomain(
      filteredData.map((d) => d.commodityShare + d.fiatNonUsdShare),
      range === "all",
    ),
    [range, filteredData],
  );

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Non-USD Market Share</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle as="h2">Non-USD Market Share</CardTitle>
          {latestTotal > 0 && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatPercent(latestShare)} &middot; {formatCurrency(latestNonUsd, 1)} of{" "}
              {formatCurrency(latestTotal, 1)} total
            </p>
          )}
        </div>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <>
            <div
              ref={chartContainerRef}
              className={CHART_HEIGHT}
              role="figure"
              aria-label={`Non-USD market share stacked area chart showing ${formatPercent(latestShare)} share`}
            >
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={filteredData}
                  margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                >
                  <defs>
                    <linearGradient id="commodityShareGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COMMODITY_COLOR} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COMMODITY_COLOR} stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="fiatNonUsdShareGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={FIAT_COLOR} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={FIAT_COLOR} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <TimeGrid />
                  <TimeXAxis dataKey="ts" minTickGap={72} />
                  <MonoYAxis
                    tickFormatter={(val: number) => formatPercent(val, 1)}
                    domain={yDomain}
                  />
                  <DateTooltip content={<ShareTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="commodityShare"
                    stackId="1"
                    stroke={COMMODITY_COLOR}
                    fill="url(#commodityShareGrad)"
                    strokeWidth={1.5}
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="fiatNonUsdShare"
                    stackId="1"
                    stroke={FIAT_COLOR}
                    fill="url(#fiatNonUsdShareGrad)"
                    strokeWidth={1.5}
                    {...animProps}
                  />
                </AreaChart>
              ) : (
                <Skeleton className="h-full w-full" />
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: COMMODITY_COLOR }} />
                Commodities (gold, silver)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: FIAT_COLOR }} />
                Fiat non-USD
              </span>
            </div>
          </>
        ) : (
          <div className={`flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}>
            No market share data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
