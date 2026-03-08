"use client";

import { useMemo, useRef, useCallback, useEffect } from "react";
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
import { useStablecoinCharts } from "@/hooks/use-stablecoin-charts";
import { useSupplyHistory } from "@/hooks/use-stablecoins";

/* Brand colors */
const USDT_GREEN = "#26a17b";
const USDC_BLUE = "#2775ca";
const SKY_YELLOW = "#f5a623";
const OTHERS_SLATE = "#94a3b8";

export function TotalMcapChart() {
  const chartRef = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);
  const animProps = hasAnimated.current ? { isAnimationActive: false } : CHART_DRAW_IN;
  useEffect(() => { hasAnimated.current = true; }, []);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-total-mcap");
  }, []);
  const { data, isLoading } = useStablecoinCharts();
  const { data: usdtHistory } = useSupplyHistory("usdt-tether");
  const { data: usdcHistory } = useSupplyHistory("usdc-circle");
  const { data: usdsHistory } = useSupplyHistory("usds-sky");
  const { data: daiHistory } = useSupplyHistory("dai-makerdao");
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    // Build lookup maps keyed by date (unix seconds)
    const usdtByDate = new Map<number, number>();
    for (const p of usdtHistory) usdtByDate.set(p.date, p.circulatingUsd);
    const usdcByDate = new Map<number, number>();
    for (const p of usdcHistory) usdcByDate.set(p.date, p.circulatingUsd);
    const usdsByDate = new Map<number, number>();
    for (const p of usdsHistory) usdsByDate.set(p.date, p.circulatingUsd);
    const daiByDate = new Map<number, number>();
    for (const p of daiHistory) daiByDate.set(p.date, p.circulatingUsd);

    return data.map((point) => {
      const total = Object.values(point.totalCirculatingUSD).reduce((sum, v) => sum + (v ?? 0), 0);
      // Coerce date to number — stablecoin-charts API returns string dates
      // while detail API returns numeric dates, causing Map lookup mismatch
      const ts = Number(point.date);
      const usdt = usdtByDate.get(ts) ?? 0;
      const usdc = usdcByDate.get(ts) ?? 0;
      const sky = (usdsByDate.get(ts) ?? 0) + (daiByDate.get(ts) ?? 0);
      const others = Math.max(0, total - usdt - usdc - sky);
      return { ts: ts * 1000, usdt, usdc, sky, others, total };
    });
  }, [data, usdtHistory, usdcHistory, usdsHistory, daiHistory]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const values = filteredData.map((d) => d.total).filter((v): v is number => v != null);
    const min = values.reduce((m, v) => Math.min(m, v), Infinity);
    const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Stablecoin Total Marketcap</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle as="h2" className="min-w-0">
          Stablecoin Total Marketcap
        </CardTitle>
        <CardAction className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
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
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: USDT_GREEN }} />
                USDT
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: USDC_BLUE }} />
                USDC
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_YELLOW }} />
                USDS + DAI
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: OTHERS_SLATE }} />
                Others
              </div>
            </div>
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
                  margin={{ top: 5, right: 20, bottom: 20, left: 5 }}
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
                      <stop offset="5%" stopColor={OTHERS_SLATE} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={OTHERS_SLATE} stopOpacity={0.05} />
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
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="others"
                    stackId="mcap"
                    stroke={OTHERS_SLATE}
                    fill="url(#othersGrad)"
                    strokeWidth={1.5}
                    name="Others"
                    {...animProps}
                  />
                </AreaChart>
              ) : (
                <ChartSkeleton className="h-full w-full" />
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No market cap data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
