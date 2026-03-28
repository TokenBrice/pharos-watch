"use client";

import { useMemo, useRef, useState, useCallback } from "react";
import { CHART_DRAW_IN } from "@/lib/chart-animation";
import { AreaChart, Area } from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency } from "@shared/lib/format";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { useStablecoinDetailHistory } from "@/hooks/use-stablecoin-detail-history";
import { computeChartYDomain } from "@/lib/chart-utils";
import { buildTotalMcapChartRows } from "@/lib/total-mcap-chart";
import { CHART_SLATE, USDT_GREEN, USDC_BLUE, SKY_YELLOW } from "@/lib/chart-colors";

/** Format a value as billions with $ prefix, e.g. "$142.5 B" */
function formatBillions(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "$0 B";
  return `$${(value / 1e9).toFixed(1)} B`;
}

export function TotalMcapChart() {
  const chartRef = useRef<HTMLDivElement>(null);
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : { isAnimationActive: false };
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-total-mcap");
  }, []);
  const { data, isLoading } = useStablecoinCharts();
  const { data: usdtHistory } = useStablecoinDetailHistory("usdt-tether");
  const { data: usdcHistory } = useStablecoinDetailHistory("usdc-circle");
  const { data: usdsHistory } = useStablecoinDetailHistory("usds-sky");
  const { data: daiHistory } = useStablecoinDetailHistory("dai-makerdao");
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return buildTotalMcapChartRows(data, {
      usdtHistory,
      usdcHistory,
      usdsHistory,
      daiHistory,
    });
  }, [data, usdtHistory, usdcHistory, usdsHistory, daiHistory]);

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
            Stablecoin Total Marketcap{latest ? `: ${formatBillions(latest.total)}` : ""}
          </CardTitle>
          <p className="pharos-meta">
            Stacked cohort framing keeps concentration visible instead of flattening the market into a single
            aggregate line.
          </p>
        </div>
        <CardAction className="flex min-w-0 items-center gap-2">
          <TimeRangeButtons options={options} value={range} onChange={setRange} />
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
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
              <div className="pharos-chart-legend-chip">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: USDT_GREEN }} />
                USDT{latest ? `: ${formatBillions(latest.usdt)}` : ""}
              </div>
              <div className="pharos-chart-legend-chip">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: USDC_BLUE }} />
                USDC{latest ? `: ${formatBillions(latest.usdc)}` : ""}
              </div>
              <div className="pharos-chart-legend-chip">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_YELLOW }} />
                USDS + DAI{latest ? `: ${formatBillions(latest.sky)}` : ""}
              </div>
              <div className="pharos-chart-legend-chip">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_SLATE }} />
                Others{latest ? `: ${formatBillions(latest.others)}` : ""}
              </div>
            </div>
            <div className="pharos-chart-stage">
              <div
                ref={chartContainerRef}
                className="h-[250px] sm:h-[350px]"
                role="figure"
                aria-label={`Total stablecoin market cap chart showing ${filteredData.length} data points`}
              >
                {isChartReady ? (
                  <AreaChart
                    width={width}
                    height={height}
                    data={filteredData}
                    margin={{ top: 8, right: 16, bottom: 16, left: 0 }}
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
                ) : (
                  <ChartSkeleton className="h-full w-full" />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="pharos-empty-note flex h-[250px] sm:h-[350px] items-center justify-center text-center">
            No market-cap history is available for the current time window.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
