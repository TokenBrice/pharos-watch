"use client";

import { useMemo, useRef, useCallback } from "react";
import { AreaChart, Area } from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { ChartShellSkeleton, ChartSkeleton } from "@/components/chart-skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { usePreference } from "@/hooks/use-preferences";
import { formatCurrency } from "@shared/lib/format";
import { ChartLegendChip, ChartScaleToggle, DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { computeChartYDomain } from "@/lib/chart-utils";
import { buildTotalMcapChartRows, TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS } from "@/lib/total-mcap-chart";
import { CHART_SLATE, USDT_GREEN, USDC_BLUE, SKY_YELLOW } from "@/lib/chart-colors";

const TOTAL_MCAP_CHART_MARGIN = { top: 8, right: 16, bottom: 16, left: 0 } as const;

export function TotalMcapChart() {
  const chartRef = useRef<HTMLDivElement>(null);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-total-mcap");
  }, []);
  // Log toggle persisted but disabled on stacked area (mathematically misleading).
  // See ChartScaleToggle below: rendered greyed-out with explanatory title.
  const [logScale, setLogScale] = usePreference<boolean>("pharos-chart-log-scale", false);
  const { data, isLoading } = useStablecoinCharts();
  const { data: usdtHistory } = useSupplyHistory("usdt-tether", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdcHistory } = useSupplyHistory("usdc-circle", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: usdsHistory } = useSupplyHistory("usds-sky", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { data: daiHistory } = useSupplyHistory("dai-makerdao", TOTAL_MCAP_MAJOR_COHORT_HISTORY_DAYS);
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } = useChartShell<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return buildTotalMcapChartRows(data, {
      usdtHistory,
      usdcHistory,
      usdsHistory,
      daiHistory,
    });
  }, [data, daiHistory, usdcHistory, usdsHistory, usdtHistory]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  // Get latest values for title and legend
  const latest = useMemo(() => {
    if (filteredData.length === 0) return null;
    return filteredData[filteredData.length - 1];
  }, [filteredData]);

  const yDomain = useMemo(
    () => computeChartYDomain(
      filteredData.map((d) => d.total).filter((v): v is number => v != null),
      range === "all",
    ),
    [range, filteredData],
  );

  if (isLoading) {
    return (
      <Card className="pharos-card-shell">
        <CardHeader>
          <div className="space-y-1.5">
            <p className="pharos-kicker">Market Structure</p>
            <CardTitle as="h2" className="pharos-section-title">Stablecoin Total Marketcap</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="pharos-card-shell animate-in fade-in duration-300">
      <CardHeader>
        <div className="space-y-1.5">
          <p className="pharos-kicker">Market Structure</p>
          <CardTitle as="h2" className="pharos-section-title min-w-0">
            Stablecoin Total Marketcap{latest ? `: ${formatCurrency(latest.total, 1)}` : ""}
          </CardTitle>
          <p className="pharos-meta">
            Stacked cohort framing keeps concentration visible instead of flattening the market into a single
            aggregate line.
          </p>
        </div>
        <CardAction className="col-start-1 row-start-2 mt-2 flex w-full min-w-0 items-center gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:w-auto sm:justify-self-end">
          <ChartScaleToggle
            value={logScale ? "log" : "lin"}
            onChange={(v) => setLogScale(v === "log")}
            disabled
            disabledTitle="Log scale is disabled on stacked area — magnitudes don't sum on a log axis."
          />
          <TimeRangeButtons options={options} value={range} onChange={setRange} />
          <Button
            variant="ghost"
            size="icon-sm"
            className="hidden shrink-0 sm:inline-flex"
            onClick={handlePngExport}
            title="Save chart as PNG"
          >
            <Camera className="h-4 w-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div ref={chartRef}>
            <div className="mb-4 flex flex-wrap gap-2">
              <ChartLegendChip markerStyle={{ backgroundColor: USDT_GREEN }}>
                USDT{latest ? `: ${formatCurrency(latest.usdt, 1)}` : ""}
              </ChartLegendChip>
              <ChartLegendChip markerStyle={{ backgroundColor: USDC_BLUE }}>
                USDC{latest ? `: ${formatCurrency(latest.usdc, 1)}` : ""}
              </ChartLegendChip>
              <ChartLegendChip markerStyle={{ backgroundColor: SKY_YELLOW }}>
                USDS + DAI{latest ? `: ${formatCurrency(latest.sky, 1)}` : ""}
              </ChartLegendChip>
              <ChartLegendChip markerStyle={{ backgroundColor: CHART_SLATE }}>
                Others{latest ? `: ${formatCurrency(latest.others, 1)}` : ""}
              </ChartLegendChip>
            </div>
            <div className="pharos-chart-stage">
              <div
                ref={chartContainerRef}
                className="h-[250px] sm:h-[350px]"
                role="figure"
                aria-label={`Total stablecoin market cap chart showing ${filteredData.length} data points`}
              >
                {isChartReady ? (
                  <div className="animate-fade-in">
                  <AreaChart
                    width={width}
                    height={height}
                    data={filteredData}
                    margin={TOTAL_MCAP_CHART_MARGIN}
                  >
                  <defs>
                    <linearGradient id="usdtGrad" x1={0} y1={0} x2={0} y2={1}>
                      <stop offset="5%" stopColor={USDT_GREEN} stopOpacity={0.5} />
                      <stop offset="95%" stopColor={USDT_GREEN} stopOpacity={0.1} />
                    </linearGradient>
                    <linearGradient id="usdcGrad" x1={0} y1={0} x2={0} y2={1}>
                      <stop offset="5%" stopColor={USDC_BLUE} stopOpacity={0.5} />
                      <stop offset="95%" stopColor={USDC_BLUE} stopOpacity={0.1} />
                    </linearGradient>
                    <linearGradient id="skyGrad" x1={0} y1={0} x2={0} y2={1}>
                      <stop offset="5%" stopColor={SKY_YELLOW} stopOpacity={0.5} />
                      <stop offset="95%" stopColor={SKY_YELLOW} stopOpacity={0.1} />
                    </linearGradient>
                    <linearGradient id="othersGrad" x1={0} y1={0} x2={0} y2={1}>
                      <stop offset="5%" stopColor={CHART_SLATE} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={CHART_SLATE} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    minTickGap={72}
                  />
                  <MonoYAxis
                    tickFormatter={(val: number) => formatCurrency(val, 0)}
                    domain={yDomain}
                  />
                  <DateTooltip
                    formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
                  />
                  <Area
                    type="monotone"
                    dataKey="usdt"
                    stackId="mcap"
                    stroke={USDT_GREEN}
                    fill="url(#usdtGrad)"
                    strokeWidth={1.5}
                    name="USDT"
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="usdc"
                    stackId="mcap"
                    stroke={USDC_BLUE}
                    fill="url(#usdcGrad)"
                    strokeWidth={1.5}
                    name="USDC"
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="sky"
                    stackId="mcap"
                    stroke={SKY_YELLOW}
                    fill="url(#skyGrad)"
                    strokeWidth={1.5}
                    name="USDS + DAI"
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="others"
                    stackId="mcap"
                    stroke={CHART_SLATE}
                    fill="url(#othersGrad)"
                    strokeWidth={1.5}
                    name="Others"
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  </AreaChart>
                  </div>
                ) : width > 0 && height > 0 ? (
                  <ChartShellSkeleton
                    width={width}
                    height={height}
                    margin={TOTAL_MCAP_CHART_MARGIN}
                    yTickFormatter={(value) => formatCurrency(value, 0)}
                    ariaLabel="Total stablecoin market cap chart loading"
                  />
                ) : (
                  <ChartSkeleton className="h-full w-full" />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="pharos-empty-note flex h-[250px] sm:h-[350px] items-center justify-center text-center">
            No market-cap history for this window.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
