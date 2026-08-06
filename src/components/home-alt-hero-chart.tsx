"use client";

import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { HomeAltInlineChartSkeleton } from "@/components/home-alt-inline-chart-skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import {
  CHART_ORANGE,
  CHART_PALETTE,
  CHART_SLATE_SOFT,
  CHART_SLATE_STRONG,
  USDC_BLUE,
  USDT_GREEN,
} from "@/lib/chart-colors";
import { computeChartYDomain } from "@/lib/chart-utils";
import type { TotalMcapChartRow } from "@/lib/total-mcap-chart";
import { formatChartDate, formatCurrency } from "@shared/lib/format";

const HOME_ALT_CHART_MARGIN = { top: 24, right: 32, bottom: 12, left: 0 } as const;
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

interface ChartLayer {
  key: keyof Pick<TotalMcapChartRow, "usdt" | "total">;
  label: string;
  color: string;
  gradientId: string;
  topOpacity: number;
  bottomOpacity: number;
}

interface CohortLine {
  key: keyof Pick<TotalMcapChartRow, "usdc" | "sky" | "others" | "nonUsd">;
  label: string;
  color: string;
  dashArray?: string;
}

// Two-tone chart per the Figma: a gray total-market-cap envelope with the
// dominant USDT cohort filled green beneath it. Both areas baseline at zero and
// draw gray-first so the green cohort reads at the bottom and gray above.
const CHART_LAYERS: readonly ChartLayer[] = [
  {
    key: "total",
    label: "Total market cap",
    color: CHART_SLATE_SOFT,
    gradientId: "homeAltTotalGrad",
    topOpacity: 0.65,
    bottomOpacity: 0.06,
  },
  {
    key: "usdt",
    label: "USDT",
    color: USDT_GREEN,
    gradientId: "homeAltUsdtGrad",
    topOpacity: 0.55,
    bottomOpacity: 0.1,
  },
];

const COHORT_LINES: readonly CohortLine[] = [
  { key: "usdc", label: "USDC", color: USDC_BLUE },
  { key: "sky", label: "USDS + DAI", color: CHART_ORANGE },
  { key: "others", label: "Others", color: CHART_PALETTE[1] },
  { key: "nonUsd", label: "Non-USD share", color: CHART_SLATE_STRONG, dashArray: "4 4" },
];

/**
 * Series shown in the hover readout, ordered the way the chart stacks them:
 * total envelope first, then the cohorts drawn beneath it. Derived from the
 * drawn layers/lines so colors can never drift from the plotted series.
 */
const HOVER_SERIES: readonly {
  key: ChartLayer["key"] | CohortLine["key"];
  label: string;
  color: string;
}[] = [
  ...CHART_LAYERS.map(({ key, label, color }) => ({ key, label, color })),
  ...COHORT_LINES.map(({ key, label, color }) => ({ key, label, color })),
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
    y: (value: number) => bounds.y1 - ((value - yDomain[0]) / ySpan) * (bounds.y1 - bounds.y0),
    start,
    end,
  };
}

function formatPoint(x: number, y: number): string {
  return `${x.toFixed(1)} ${y.toFixed(1)}`;
}

function buildAreaPath({
  rows,
  layer,
  scales,
}: {
  rows: TotalMcapChartRow[];
  layer: ChartLayer;
  scales: ReturnType<typeof makeScales>;
}): string {
  if (rows.length === 0) return "";
  const topPoints = rows.map((row) => formatPoint(scales.x(row.ts), scales.y(row[layer.key])));
  const baseY = scales.y(0).toFixed(1);
  const firstX = scales.x(rows[0]!.ts).toFixed(1);
  const lastX = scales.x(rows[rows.length - 1]!.ts).toFixed(1);
  return `M ${topPoints.join(" L ")} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
}

function buildTopLinePath({
  rows,
  layer,
  scales,
}: {
  rows: TotalMcapChartRow[];
  layer: ChartLayer;
  scales: ReturnType<typeof makeScales>;
}): string {
  if (rows.length === 0) return "";
  return rows
    .map((row, index) => `${index === 0 ? "M" : "L"} ${formatPoint(scales.x(row.ts), scales.y(row[layer.key]))}`)
    .join(" ");
}

function buildCohortLinePath({
  rows,
  line,
  scales,
}: {
  rows: TotalMcapChartRow[];
  line: CohortLine;
  scales: ReturnType<typeof makeScales>;
}): string {
  let hasPreviousPoint = false;
  const commands: string[] = [];

  for (const row of rows) {
    const value = row[line.key];
    if (value === null || !Number.isFinite(value)) {
      hasPreviousPoint = false;
      continue;
    }

    commands.push(`${hasPreviousPoint ? "L" : "M"} ${formatPoint(scales.x(row.ts), scales.y(value))}`);
    hasPreviousPoint = true;
  }

  return commands.join(" ");
}

/**
 * Nearest drawn point to a timestamp. The crosshair snaps to sampled rows so
 * the readout always matches a point the chart actually plotted.
 */
function findNearestRowIndex(rows: TotalMcapChartRow[], ts: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  const prev = Math.max(0, lo - 1);
  return Math.abs(rows[prev]!.ts - ts) <= Math.abs(rows[lo]!.ts - ts) ? prev : lo;
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Geometry is memoized so pointer moves only re-render the hover overlay --
  // path building walks every sampled row and must not run per mouse event.
  const geometry = useMemo(() => {
    const x0 = HOME_ALT_CHART_MARGIN.left + HOME_ALT_Y_AXIS_WIDTH;
    const x1 = Math.max(x0, width - HOME_ALT_CHART_MARGIN.right);
    const y0 = HOME_ALT_CHART_MARGIN.top;
    const y1 = Math.max(y0, height - HOME_ALT_CHART_MARGIN.bottom - HOME_ALT_X_AXIS_HEIGHT);
    const bounds = { x0, x1, y0, y1 };
    const start = rows.length > 0 ? rows[0]!.ts : HOME_ALT_PLACEHOLDER_START;
    const end = rows.length > 0 ? rows[rows.length - 1]!.ts : HOME_ALT_PLACEHOLDER_END;
    const maxFromRows = rows.reduce((max, row) => Math.max(max, row.total), 0);
    const resolvedYDomain: [number, number] = [yDomain[0], typeof yDomain[1] === "number" ? yDomain[1] : maxFromRows];
    const visibleRows = sampleRows(rows);
    const scales = makeScales({ rows: visibleRows, bounds, yDomain: resolvedYDomain });

    return { bounds, start, end, resolvedYDomain, visibleRows, scales };
  }, [height, rows, width, yDomain]);

  const { bounds, start, end, resolvedYDomain, visibleRows, scales } = geometry;
  const { x0, x1, y0, y1 } = bounds;

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (visibleRows.length === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const pointerX = Math.max(x0, Math.min(x1, event.clientX - rect.left));
      const ts = scales.start + ((pointerX - x0) / Math.max(1, x1 - x0)) * (scales.end - scales.start);
      setHoverIndex(findNearestRowIndex(visibleRows, ts));
    },
    [scales, visibleRows, x0, x1],
  );

  const handlePointerLeave = useCallback(() => setHoverIndex(null), []);

  const hoveredRow = hoverIndex != null ? (visibleRows[hoverIndex] ?? null) : null;
  const hoverX = hoveredRow ? scales.x(hoveredRow.ts) : 0;

  if (width <= 0 || height <= 0) return null;

  return (
    <>
      <svg
        className="pharos-chart-shell-skeleton touch-pan-y"
        width={width}
        height={height}
        role="img"
        aria-label="Stablecoin market cap history by major cohort"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
      >
        <defs>
          {CHART_LAYERS.map((layer) => (
            <linearGradient key={layer.key} id={layer.gradientId} x1={0} y1={0} x2={0} y2={1}>
              <stop offset="5%" stopColor={layer.color} stopOpacity={layer.topOpacity} />
              <stop offset="95%" stopColor={layer.color} stopOpacity={layer.bottomOpacity} />
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
              {CHART_LAYERS.map((layer) => (
                <path
                  key={layer.key}
                  d={buildAreaPath({ rows: visibleRows, layer, scales })}
                  fill={`url(#${layer.gradientId})`}
                />
              ))}
              {CHART_LAYERS.map((layer) => (
                <path
                  key={`${layer.key}-line`}
                  d={buildTopLinePath({ rows: visibleRows, layer, scales })}
                  fill="none"
                  stroke={layer.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                >
                  <title>{layer.label}</title>
                </path>
              ))}
              {COHORT_LINES.map((line) => (
                <path
                  key={`${line.key}-line`}
                  d={buildCohortLinePath({ rows: visibleRows, line, scales })}
                  fill="none"
                  stroke={line.color}
                  strokeDasharray={line.dashArray}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                >
                  <title>{line.label}</title>
                </path>
              ))}
            </g>
          ) : null}
        </g>
        {hoveredRow ? (
          <g aria-hidden="true" pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={y0}
              y2={y1}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="3 4"
              strokeWidth={1}
              style={{ opacity: 0.7 }}
            />
            {HOVER_SERIES.map((series) => {
              const value = hoveredRow[series.key];
              if (value === null || !Number.isFinite(value)) return null;
              return (
                <circle
                  key={series.key}
                  cx={hoverX}
                  cy={scales.y(value)}
                  r={3.5}
                  fill="var(--color-card)"
                  stroke={series.color}
                  strokeWidth={2}
                />
              );
            })}
          </g>
        ) : null}
      </svg>
      {hoveredRow ? (
        <HomeAltHoverReadout row={hoveredRow} chartWidth={width} hoverX={hoverX} top={y0} />
      ) : null}
    </>
  );
}

function HomeAltHoverReadout({
  row,
  chartWidth,
  hoverX,
  top,
}: {
  row: TotalMcapChartRow;
  chartWidth: number;
  hoverX: number;
  top: number;
}) {
  // Flip the card to the left of the crosshair once the pointer passes the
  // midpoint so it never spills past the chart's right edge.
  const flip = hoverX > chartWidth / 2;

  return (
    <div
      // Pointer-only affordance: a live region would announce on every mouse
      // move, and the SVG already carries the chart's accessible name.
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-[11.5rem] rounded-xl border border-border/70 bg-card/95 px-3.5 py-3 shadow-[var(--elevation-rest)]"
      style={
        flip
          ? { right: Math.max(8, chartWidth - hoverX + 12), top }
          : { left: Math.min(chartWidth - 8, hoverX + 12), top }
      }
    >
      <p className="mb-2 text-xs font-medium text-foreground">{formatChartDate(row.ts, "short-year")}</p>
      <dl className="space-y-1">
        {HOVER_SERIES.map((series) => {
          const value = row[series.key];
          return (
            <div key={series.key} className="flex items-center justify-between gap-4 text-xs">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: series.color }}
                />
                {series.label}
              </dt>
              <dd className="font-mono tabular-nums text-foreground">
                {value === null || !Number.isFinite(value) ? "—" : formatCurrency(value)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
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
      className="relative h-[260px] w-full sm:h-[320px] lg:h-auto lg:min-h-[305px]"
      role="figure"
      aria-label="Stablecoin market cap history by major cohort"
    >
      {chartReady ? (
        <HomeAltChartFrame width={width} height={height} rows={rows} yDomain={yDomain} />
      ) : (
        <div className="h-full p-5">
          <HomeAltInlineChartSkeleton />
        </div>
      )}
    </div>
  );
}
