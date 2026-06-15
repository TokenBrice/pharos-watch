"use client";

import { useMemo } from "react";
import { HomeAltInlineChartSkeleton } from "@/components/home-alt-inline-chart-skeleton";
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

interface HomeAltHeroChartProps {
  rows: TotalMcapChartRow[];
}

interface ChartBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface CohortArea {
  key: keyof Pick<TotalMcapChartRow, "usdt" | "usdc" | "sky" | "others">;
  label: string;
  color: string;
  gradientId: string;
  topOpacity: number;
  bottomOpacity: number;
}

const COHORT_AREAS: readonly CohortArea[] = [
  {
    key: "usdt",
    label: "USDT",
    color: USDT_GREEN,
    gradientId: "homeAltUsdtGrad",
    topOpacity: 0.78,
    bottomOpacity: 0.18,
  },
  {
    key: "usdc",
    label: "USDC",
    color: USDC_BLUE,
    gradientId: "homeAltUsdcGrad",
    topOpacity: 0.72,
    bottomOpacity: 0.16,
  },
  {
    key: "sky",
    label: "USDS + DAI",
    color: SKY_YELLOW,
    gradientId: "homeAltSkyGrad",
    topOpacity: 0.7,
    bottomOpacity: 0.16,
  },
  {
    key: "others",
    label: "Others",
    color: CHART_SLATE,
    gradientId: "homeAltOthersGrad",
    topOpacity: 0.55,
    bottomOpacity: 0.12,
  },
];

function buildEvenTicks(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

function sampleRows(rows: TotalMcapChartRow[], maxPoints = 140): TotalMcapChartRow[] {
  if (rows.length <= maxPoints) return rows;
  const lastIndex = rows.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
    return rows[sourceIndex]!;
  });
}

function makeScales({
  rows,
  bounds,
  yDomain,
}: {
  rows: TotalMcapChartRow[];
  bounds: ChartBounds;
  yDomain: [number, number];
}) {
  const start = rows.length > 0 ? rows[0]!.ts : HOME_ALT_PLACEHOLDER_START;
  const end = rows.length > 0 ? rows[rows.length - 1]!.ts : HOME_ALT_PLACEHOLDER_END;
  const span = Math.max(1, end - start);
  const ySpan = Math.max(1, yDomain[1] - yDomain[0]);

  return {
    x: (ts: number) => bounds.x0 + ((ts - start) / span) * (bounds.x1 - bounds.x0),
    y: (value: number) =>
      bounds.y1 - ((value - yDomain[0]) / ySpan) * (bounds.y1 - bounds.y0),
    start,
    end,
  };
}

function formatPoint(x: number, y: number): string {
  return `${x.toFixed(1)} ${y.toFixed(1)}`;
}

function buildAreaPath({
  rows,
  area,
  scales,
}: {
  rows: TotalMcapChartRow[];
  area: CohortArea;
  scales: ReturnType<typeof makeScales>;
}): string {
  if (rows.length === 0) return "";

  const topPoints: string[] = [];
  const bottomPoints: string[] = [];

  for (const row of rows) {
    let bottom = 0;
    for (const candidate of COHORT_AREAS) {
      if (candidate.key === area.key) break;
      bottom += row[candidate.key];
    }
    const top = bottom + row[area.key];
    topPoints.push(formatPoint(scales.x(row.ts), scales.y(top)));
    bottomPoints.push(formatPoint(scales.x(row.ts), scales.y(bottom)));
  }

  return `M ${topPoints.join(" L ")} L ${bottomPoints.reverse().join(" L ")} Z`;
}

function buildTopLinePath({
  rows,
  area,
  scales,
}: {
  rows: TotalMcapChartRow[];
  area: CohortArea;
  scales: ReturnType<typeof makeScales>;
}): string {
  if (rows.length === 0) return "";
  return rows
    .map((row, index) => {
      let top = 0;
      for (const candidate of COHORT_AREAS) {
        top += row[candidate.key];
        if (candidate.key === area.key) break;
      }
      return `${index === 0 ? "M" : "L"} ${formatPoint(scales.x(row.ts), scales.y(top))}`;
    })
    .join(" ");
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
  const bounds = { x0, x1, y0, y1 };
  const start = rows.length > 0 ? rows[0].ts : HOME_ALT_PLACEHOLDER_START;
  const end = rows.length > 0 ? rows[rows.length - 1].ts : HOME_ALT_PLACEHOLDER_END;
  const maxFromRows = rows.reduce((max, row) => Math.max(max, row.total), 0);
  const resolvedYDomain: [number, number] = [
    yDomain[0],
    typeof yDomain[1] === "number" ? yDomain[1] : maxFromRows,
  ];
  const visibleRows = sampleRows(rows);
  const scales = makeScales({ rows: visibleRows, bounds, yDomain: resolvedYDomain });

  return (
    <svg
      className="pharos-chart-shell-skeleton"
      width={width}
      height={height}
      role="img"
      aria-label="Stablecoin market cap history by major cohort"
    >
      <defs>
        {COHORT_AREAS.map((area) => (
          <linearGradient key={area.key} id={area.gradientId} x1={0} y1={0} x2={0} y2={1}>
            <stop offset="5%" stopColor={area.color} stopOpacity={area.topOpacity} />
            <stop offset="95%" stopColor={area.color} stopOpacity={area.bottomOpacity} />
          </linearGradient>
        ))}
      </defs>
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
        {visibleRows.length > 0 ? (
          <g>
            {COHORT_AREAS.map((area) => (
              <path
                key={area.key}
                d={buildAreaPath({
                  rows: visibleRows,
                  area,
                  scales,
                })}
                fill={`url(#${area.gradientId})`}
              />
            ))}
            {COHORT_AREAS.map((area) => (
              <path
                key={`${area.key}-line`}
                d={buildTopLinePath({
                  rows: visibleRows,
                  area,
                  scales,
                })}
                fill="none"
                stroke={area.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                <title>{area.label}</title>
              </path>
            ))}
          </g>
        ) : null}
      </g>
    </svg>
  );
}

export function HomeAltHeroChart({ rows }: HomeAltHeroChartProps) {
  const { chartContainerRef, isChartReady, width, height } = useChartShell<HTMLDivElement>();

  const yDomain = useMemo(
    () =>
      computeChartYDomain(
        rows.map((d) => d.total).filter((v): v is number => v != null),
        true,
      ),
    [rows],
  );
  const chartReady = isChartReady && rows.length > 0;

  return (
    <div
      ref={chartContainerRef}
      className="h-[260px] w-full sm:h-[320px] lg:h-auto lg:min-h-[360px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      {chartReady ? (
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
