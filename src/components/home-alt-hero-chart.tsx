"use client";

import { useEffect, useMemo, useState } from "react";
import { useChartShell } from "@/hooks/use-chart-shell";
import { CHART_SLATE, SKY_YELLOW, USDC_BLUE, USDT_GREEN } from "@/lib/chart-colors";
import { computeChartYDomain } from "@/lib/chart-utils";
import type { TotalMcapChartRow } from "@/lib/total-mcap-chart";
import { formatCurrency } from "@shared/lib/format";

const HOME_ALT_CHART_MARGIN = { top: 12, right: 16, bottom: 12, left: 0 } as const;
const HOME_ALT_Y_AXIS_WIDTH = 68;
const HOME_ALT_X_AXIS_HEIGHT = 30;
const HOME_ALT_TICK_FONT_SIZE = 12;
const HOME_ALT_PLACEHOLDER_END = Date.UTC(2026, 0, 1);
const HOME_ALT_PLACEHOLDER_START = HOME_ALT_PLACEHOLDER_END - 90 * 24 * 60 * 60 * 1000;

const HOME_ALT_DATE_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});

type HomeAltHeroChartModules = {
  recharts: typeof import("recharts");
  axes: typeof import("@/components/chart-primitives/axes");
};

interface HomeAltHeroChartProps {
  rows: TotalMcapChartRow[];
}

function buildEvenTicks(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

function HomeAltInlineChartSkeleton() {
  return (
    <div className="pharos-chart-stage skeleton-shimmer relative h-full w-full overflow-hidden" aria-hidden="true">
      <div className="absolute bottom-8 left-3 top-3 flex w-8 flex-col justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-2.5 w-full rounded bg-muted/50" />
        ))}
      </div>
      <div className="absolute bottom-2 left-12 right-3 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-2 w-8 rounded bg-muted/50" />
        ))}
      </div>
      <svg
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        viewBox="0 0 400 100"
      >
        <path
          d="M 40 80 C 80 75, 120 60, 160 65 C 200 70, 240 40, 280 45 C 320 50, 360 30, 400 35 L 400 100 L 40 100 Z"
          fill="currentColor"
          className="text-muted/20"
        />
      </svg>
    </div>
  );
}

function HomeAltChartFrame({
  width,
  height,
  rows,
  yDomain,
}: {
  width: number;
  height: number;
  rows: TotalMcapChartRow[];
  yDomain: ReturnType<typeof computeChartYDomain>;
}) {
  if (width <= 0 || height <= 0) return null;

  const x0 = HOME_ALT_CHART_MARGIN.left + HOME_ALT_Y_AXIS_WIDTH;
  const x1 = Math.max(x0, width - HOME_ALT_CHART_MARGIN.right);
  const y0 = HOME_ALT_CHART_MARGIN.top;
  const y1 = Math.max(y0, height - HOME_ALT_CHART_MARGIN.bottom - HOME_ALT_X_AXIS_HEIGHT);
  const start = rows.length > 0 ? rows[0].ts : HOME_ALT_PLACEHOLDER_START;
  const end = rows.length > 0 ? rows[rows.length - 1].ts : HOME_ALT_PLACEHOLDER_END;
  const maxFromRows = rows.reduce((max, row) => Math.max(max, row.total), 0);
  const resolvedYDomain: [number, number] = [
    yDomain[0],
    typeof yDomain[1] === "number" ? yDomain[1] : maxFromRows,
  ];

  return (
    <svg
      className="pharos-chart-shell-skeleton"
      width={width}
      height={height}
      role="img"
      aria-label="Stablecoin market cap chart loading"
    >
      <g aria-hidden="true">
        {buildEvenTicks(5).map((tick, i) => {
          const y = y0 + tick * (y1 - y0);
          const value = resolvedYDomain[1] - tick * (resolvedYDomain[1] - resolvedYDomain[0]);
          return (
            <g key={i}>
              <line
                x1={x0}
                x2={x1}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeDasharray="2 6"
                strokeWidth={1}
                style={{ opacity: 0.6 }}
              />
              <text
                x={x0 - 8}
                y={y + HOME_ALT_TICK_FONT_SIZE / 2 - 2}
                fill="var(--color-muted-foreground)"
                fontFamily="var(--font-mono, monospace)"
                fontSize={HOME_ALT_TICK_FONT_SIZE}
                textAnchor="end"
                style={{ opacity: 0.75 }}
              >
                {formatCurrency(value, 0)}
              </text>
            </g>
          );
        })}
        {buildEvenTicks(6).map((tick, i) => {
          const x = x0 + tick * (x1 - x0);
          const ts = start + tick * (end - start);
          return (
            <text
              key={i}
              x={x}
              y={y1 + 10 + HOME_ALT_TICK_FONT_SIZE}
              fill="var(--color-muted-foreground)"
              fontFamily="var(--font-mono, monospace)"
              fontSize={HOME_ALT_TICK_FONT_SIZE}
              textAnchor="middle"
              style={{ opacity: 0.75 }}
            >
              {HOME_ALT_DATE_TICK_FORMATTER.format(new Date(ts))}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

export function HomeAltHeroChart({ rows }: HomeAltHeroChartProps) {
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } =
    useChartShell<HTMLDivElement>();
  const [chartModules, setChartModules] = useState<HomeAltHeroChartModules | null>(null);

  useEffect(() => {
    let active = true;

    void Promise.all([
      import("recharts"),
      import("@/components/chart-primitives/axes"),
    ]).then(([recharts, axes]) => {
      if (active) {
        setChartModules({ recharts, axes });
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const yDomain = useMemo(
    () =>
      computeChartYDomain(
        rows.map((d) => d.total).filter((v): v is number => v != null),
        true,
      ),
    [rows],
  );
  const chartReady = isChartReady && chartModules !== null && rows.length > 0;

  if (chartReady) {
    const { Area, AreaChart } = chartModules.recharts;
    const { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } = chartModules.axes;

    return (
      <div
        ref={chartContainerRef}
        className="h-[260px] w-full sm:h-[320px] lg:h-auto lg:min-h-[360px]"
        role="figure"
        aria-label="Stablecoin market cap history by major cohort"
      >
        <div className="animate-fade-in">
          <AreaChart
            width={width}
            height={height}
            data={rows}
            margin={HOME_ALT_CHART_MARGIN}
          >
            <defs>
              <linearGradient id="homeAltUsdtGrad" x1={0} y1={0} x2={0} y2={1}>
                <stop offset="5%" stopColor={USDT_GREEN} stopOpacity={0.78} />
                <stop offset="95%" stopColor={USDT_GREEN} stopOpacity={0.18} />
              </linearGradient>
              <linearGradient id="homeAltUsdcGrad" x1={0} y1={0} x2={0} y2={1}>
                <stop offset="5%" stopColor={USDC_BLUE} stopOpacity={0.72} />
                <stop offset="95%" stopColor={USDC_BLUE} stopOpacity={0.16} />
              </linearGradient>
              <linearGradient id="homeAltSkyGrad" x1={0} y1={0} x2={0} y2={1}>
                <stop offset="5%" stopColor={SKY_YELLOW} stopOpacity={0.7} />
                <stop offset="95%" stopColor={SKY_YELLOW} stopOpacity={0.16} />
              </linearGradient>
              <linearGradient id="homeAltOthersGrad" x1={0} y1={0} x2={0} y2={1}>
                <stop offset="5%" stopColor={CHART_SLATE} stopOpacity={0.55} />
                <stop offset="95%" stopColor={CHART_SLATE} stopOpacity={0.12} />
              </linearGradient>
            </defs>
            <TimeGrid />
            <TimeXAxis dataKey="ts" minTickGap={72} />
            <MonoYAxis
              tickFormatter={(value: number) => formatCurrency(value, 0)}
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
              fill="url(#homeAltUsdtGrad)"
              strokeWidth={1.75}
              name="USDT"
              onAnimationEnd={handleAnimationEnd}
              {...animProps}
            />
            <Area
              type="monotone"
              dataKey="usdc"
              stackId="mcap"
              stroke={USDC_BLUE}
              fill="url(#homeAltUsdcGrad)"
              strokeWidth={1.75}
              name="USDC"
              onAnimationEnd={handleAnimationEnd}
              {...animProps}
            />
            <Area
              type="monotone"
              dataKey="sky"
              stackId="mcap"
              stroke={SKY_YELLOW}
              fill="url(#homeAltSkyGrad)"
              strokeWidth={1.75}
              name="USDS + DAI"
              onAnimationEnd={handleAnimationEnd}
              {...animProps}
            />
            <Area
              type="monotone"
              dataKey="others"
              stackId="mcap"
              stroke={CHART_SLATE}
              fill="url(#homeAltOthersGrad)"
              strokeWidth={1.75}
              name="Others"
              onAnimationEnd={handleAnimationEnd}
              {...animProps}
            />
          </AreaChart>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={chartContainerRef}
      className="h-[260px] w-full sm:h-[320px] lg:h-auto lg:min-h-[360px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      {isChartReady ? (
        <HomeAltChartFrame
          width={width}
          height={height}
          rows={rows}
          yDomain={yDomain}
        />
      ) : (
        <div className="h-full p-5">
          <HomeAltInlineChartSkeleton />
        </div>
      )}
    </div>
  );
}
