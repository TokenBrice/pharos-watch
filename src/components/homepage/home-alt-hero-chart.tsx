"use client";

import { useCallback, useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import {
  CHART_BLUE,
  CHART_ORANGE,
  CHART_PALETTE,
  CHART_SLATE_STRONG,
  USDC_BLUE,
  USDT_GREEN,
} from "@/lib/chart-colors";
import {
  CHART_AXIS_TICK,
  CHART_GRID_DASH,
  CHART_GRID_STROKE,
  CHART_STROKE_WIDTH,
  CHART_TICK_FONT_SIZE,
} from "@/lib/chart-theme";
import { formatCurrencyTick, niceTicks, niceTimeTicks } from "@/lib/chart-ticks";
import { computeChartYDomain } from "@/lib/chart-utils";
import { ChartTooltipSurface } from "@/components/pharos-chart-tooltip";
import type { TotalMcapChartRow } from "@shared/lib/total-mcap-chart";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { DAY_MS } from "@shared/lib/time-constants";

const HOME_ALT_CHART_MARGIN = { top: 10, right: 24, bottom: 10, left: 0 } as const;
const HOME_ALT_Y_AXIS_WIDTH = 64;
const HOME_ALT_X_AXIS_HEIGHT = 26;
const HOME_ALT_DATE_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const HOME_ALT_YEAR_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "UTC" });
const HOME_ALT_NARROW_WIDTH = 640;

type HeroChartRange = "90d" | "1y" | "all";

const RANGE_OPTIONS: readonly { value: HeroChartRange; label: string; days: number | null }[] = [
  { value: "90d", label: "90D", days: 90 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "ALL", days: null },
];

interface HomeAltHeroChartProps {
  rows: TotalMcapChartRow[];
}

interface ChartBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

type StackedCohortKey = "usdt" | "usdc" | "sky" | "others";

interface StackedBand {
  key: StackedCohortKey;
  label: string;
  color: string;
  topOpacity: number;
  bottomOpacity: number;
}

// True stacked cohort areas matching the left breakdown shares bottom-to-top:
// USDT + USDC + USDS + DAI + Others = Total market cap.
const STACKED_BANDS: readonly StackedBand[] = [
  { key: "usdt", label: "USDT", color: USDT_GREEN, topOpacity: 0.34, bottomOpacity: 0.14 },
  { key: "usdc", label: "USDC", color: USDC_BLUE, topOpacity: 0.3, bottomOpacity: 0.12 },
  { key: "sky", label: "USDS + DAI", color: CHART_ORANGE, topOpacity: 0.3, bottomOpacity: 0.12 },
  { key: "others", label: "Others", color: CHART_PALETTE[1], topOpacity: 0.24, bottomOpacity: 0.08 },
];

const TOTAL_SERIES_COLOR = CHART_BLUE;
const NON_USD_LINE = {
  key: "nonUsd" as const,
  label: "Non-USD share",
  color: CHART_SLATE_STRONG,
  dashArray: "4 4",
};

const HOVER_SERIES: readonly {
  key: keyof Pick<TotalMcapChartRow, "total" | StackedCohortKey | "nonUsd">;
  label: string;
  color: string;
}[] = [
  { key: "total", label: "Total market cap", color: TOTAL_SERIES_COLOR },
  ...STACKED_BANDS.map(({ key, label, color }) => ({ key, label, color })),
  { key: NON_USD_LINE.key, label: NON_USD_LINE.label, color: NON_USD_LINE.color },
];

function filterRowsByRange(rows: TotalMcapChartRow[], range: HeroChartRange): TotalMcapChartRow[] {
  if (range === "all" || rows.length <= 2) return rows;
  const days = range === "90d" ? 90 : 365;
  const lastTs = rows[rows.length - 1]!.ts;
  const cutoff = lastTs - days * DAY_MS;
  const filtered = rows.filter((row) => row.ts >= cutoff);
  return filtered.length >= 2 ? filtered : rows;
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
  const start = rows[0]!.ts;
  const end = rows[rows.length - 1]!.ts;
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

/**
 * Resolve stacked [y0, y1] cumulative bounds for a cohort band on one row.
 * Returns null if any underlying cohort operand is missing so gaps stay gaps (R1).
 */
function resolveBandBounds(row: TotalMcapChartRow, key: StackedCohortKey): [number, number] | null {
  const usdt = row.usdt;
  if (usdt === null || !Number.isFinite(usdt)) return null;
  if (key === "usdt") return [0, usdt];
  const usdc = row.usdc;
  if (usdc === null || !Number.isFinite(usdc)) return null;
  if (key === "usdc") return [usdt, usdt + usdc];
  const sky = row.sky;
  if (sky === null || !Number.isFinite(sky)) return null;
  if (key === "sky") return [usdt + usdc, usdt + usdc + sky];
  const others = row.others;
  if (others === null || !Number.isFinite(others)) return null;
  return [usdt + usdc + sky, usdt + usdc + sky + others];
}

function buildRibbonPaths({
  rows,
  key,
  scales,
}: {
  rows: TotalMcapChartRow[];
  key: StackedCohortKey;
  scales: ReturnType<typeof makeScales>;
}): { area: string; topLine: string } {
  const areaCommands: string[] = [];
  const lineCommands: string[] = [];
  let upperPoints: string[] = [];
  let lowerPoints: string[] = [];

  const flushSegment = () => {
    if (upperPoints.length > 0) {
      lineCommands.push(`M ${upperPoints[0]}`);
      for (let i = 1; i < upperPoints.length; i += 1) {
        lineCommands.push(`L ${upperPoints[i]}`);
      }
    }
    // Omit degenerate filled singletons; gaps stay clean.
    if (upperPoints.length > 1) {
      areaCommands.push(`M ${upperPoints[0]}`);
      for (let i = 1; i < upperPoints.length; i += 1) {
        areaCommands.push(`L ${upperPoints[i]}`);
      }
      for (let i = lowerPoints.length - 1; i >= 0; i -= 1) {
        areaCommands.push(`L ${lowerPoints[i]}`);
      }
      areaCommands.push("Z");
    }
    upperPoints = [];
    lowerPoints = [];
  };

  for (const row of rows) {
    const band = resolveBandBounds(row, key);
    if (!band) {
      flushSegment();
      continue;
    }
    const x = scales.x(row.ts);
    upperPoints.push(formatPoint(x, scales.y(band[1])));
    lowerPoints.push(formatPoint(x, scales.y(band[0])));
  }
  flushSegment();

  return { area: areaCommands.join(" "), topLine: lineCommands.join(" ") };
}

function buildTotalAreaPath({
  rows,
  scales,
}: {
  rows: TotalMcapChartRow[];
  scales: ReturnType<typeof makeScales>;
}): string {
  const commands: string[] = [];
  const baseY = scales.y(0).toFixed(1);
  let firstX: string | null = null;
  let lastX = "";
  let segmentPoints = 0;
  const closeSegment = () => {
    if (firstX !== null) {
      if (segmentPoints > 1) commands.push(`L ${lastX} ${baseY} L ${firstX} ${baseY} Z`);
      else commands.pop();
      firstX = null;
      segmentPoints = 0;
    }
  };
  for (const row of rows) {
    const value = row.total;
    if (value === null || !Number.isFinite(value)) {
      closeSegment();
      continue;
    }
    const x = scales.x(row.ts);
    commands.push(`${firstX === null ? "M" : "L"} ${formatPoint(x, scales.y(value))}`);
    firstX ??= x.toFixed(1);
    lastX = x.toFixed(1);
    segmentPoints++;
  }
  closeSegment();
  return commands.join(" ");
}

function buildLinePath({
  rows,
  key,
  scales,
}: {
  rows: TotalMcapChartRow[];
  key: "total" | "nonUsd";
  scales: ReturnType<typeof makeScales>;
}): string {
  let hasPreviousPoint = false;
  const commands: string[] = [];

  for (const row of rows) {
    const value = row[key];
    if (value === null || !Number.isFinite(value)) {
      hasPreviousPoint = false;
      continue;
    }
    commands.push(`${hasPreviousPoint ? "L" : "M"} ${formatPoint(scales.x(row.ts), scales.y(value))}`);
    hasPreviousPoint = true;
  }

  return commands.join(" ");
}

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

function resolveHoverYValue(
  row: TotalMcapChartRow,
  key: (typeof HOVER_SERIES)[number]["key"],
): number | null {
  if (key === "total") return row.total;
  if (key === "nonUsd") return row.nonUsd;
  const band = resolveBandBounds(row, key);
  return band ? band[1] : null;
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
  const rawId = useId();
  const idPrefix = `home-hero-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const totalGradId = `${idPrefix}-total`;

  const geometry = useMemo(() => {
    const x0 = HOME_ALT_CHART_MARGIN.left + HOME_ALT_Y_AXIS_WIDTH;
    const x1 = Math.max(x0, width - HOME_ALT_CHART_MARGIN.right);
    const y0 = HOME_ALT_CHART_MARGIN.top;
    const y1 = Math.max(y0, height - HOME_ALT_CHART_MARGIN.bottom - HOME_ALT_X_AXIS_HEIGHT);
    const bounds = { x0, x1, y0, y1 };
    const start = rows[0]!.ts;
    const end = rows[rows.length - 1]!.ts;
    const maxFromRows = rows.reduce((max, row) => {
      const top = row.total ?? 0;
      return Math.max(max, Number.isFinite(top) ? top : 0);
    }, 0);
    const { domain: resolvedYDomain, ticks: yTicks } = niceTicks(
      yDomain[0],
      typeof yDomain[1] === "number" ? yDomain[1] : maxFromRows,
      { kind: "currency", includeZero: true },
    );
    const visibleRows = rows;
    const scales = makeScales({ rows: visibleRows, bounds, yDomain: resolvedYDomain });
    const xTicks = niceTimeTicks(start, end, width < HOME_ALT_NARROW_WIDTH ? 4 : 6);

    return { bounds, resolvedYDomain, visibleRows, scales, yTicks, xTicks };
  }, [height, rows, width, yDomain]);

  const { bounds, visibleRows, scales, yTicks, xTicks } = geometry;
  const paths = useMemo(() => ({
    totalArea: buildTotalAreaPath({ rows: visibleRows, scales }),
    totalLine: buildLinePath({ rows: visibleRows, key: "total", scales }),
    stacked: STACKED_BANDS.map((band) => buildRibbonPaths({ rows: visibleRows, key: band.key, scales })),
    nonUsdLine: buildLinePath({ rows: visibleRows, key: "nonUsd", scales }),
  }), [visibleRows, scales]);
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
        aria-label="Stablecoin market cap history stacked by major cohort"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerLeave}
      >
        <defs>
          <linearGradient id={totalGradId} x1={0} y1={0} x2={0} y2={1}>
            <stop offset="5%" stopColor={TOTAL_SERIES_COLOR} stopOpacity={0.14} />
            <stop offset="95%" stopColor={TOTAL_SERIES_COLOR} stopOpacity={0.01} />
          </linearGradient>
          {STACKED_BANDS.map((band) => (
            <linearGradient key={band.key} id={`${idPrefix}-${band.key}`} x1={0} y1={0} x2={0} y2={1}>
              <stop offset="5%" stopColor={band.color} stopOpacity={band.topOpacity} />
              <stop offset="95%" stopColor={band.color} stopOpacity={band.bottomOpacity} />
            </linearGradient>
          ))}
        </defs>
        <g aria-hidden="true">
          {yTicks.map((value) => {
            const y = scales.y(value);
            return (
              <g key={value}>
                <line
                  x1={x0}
                  x2={x1}
                  y1={y}
                  y2={y}
                  stroke={CHART_GRID_STROKE}
                  strokeDasharray={CHART_GRID_DASH}
                  strokeWidth={CHART_STROKE_WIDTH.guide}
                />
                <text x={x0 - 8} y={y + CHART_TICK_FONT_SIZE / 2 - 2} textAnchor="end" {...CHART_AXIS_TICK}>
                  {formatCurrencyTick(value)}
                </text>
              </g>
            );
          })}
          {xTicks.ticks.map((ts) => (
            <text key={ts} x={scales.x(ts)} y={y1 + 10 + CHART_TICK_FONT_SIZE} textAnchor="middle" {...CHART_AXIS_TICK}>
              {(xTicks.stepMonths >= 12 ? HOME_ALT_YEAR_TICK_FORMATTER : HOME_ALT_DATE_TICK_FORMATTER).format(new Date(ts))}
            </text>
          ))}
          {visibleRows.length > 0 ? (
            <g>
              {/* Soft total envelope backdrop stays visible even when cohort history has gaps. */}
              <path
                data-series="total-area"
                d={paths.totalArea}
                fill={`url(#${totalGradId})`}
              />
              {STACKED_BANDS.map((band, index) => (
                <path
                  key={`${band.key}-area`}
                  data-series={`${band.key}-area`}
                  d={paths.stacked[index]!.area}
                  fill={`url(#${idPrefix}-${band.key})`}
                />
              ))}
              {STACKED_BANDS.map((band, index) => (
                <path
                  key={`${band.key}-line`}
                  d={paths.stacked[index]!.topLine}
                  fill="none"
                  stroke={band.color}
                  strokeWidth={1.25}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                >
                  <title>{band.label}</title>
                </path>
              ))}
              <path
                d={paths.nonUsdLine}
                fill="none"
                stroke={NON_USD_LINE.color}
                strokeDasharray={NON_USD_LINE.dashArray}
                strokeWidth={1.35}
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                <title>{NON_USD_LINE.label}</title>
              </path>
              <path
                d={paths.totalLine}
                fill="none"
                stroke={TOTAL_SERIES_COLOR}
                strokeWidth={2.2}
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                <title>Total market cap</title>
              </path>
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
              const yValue = resolveHoverYValue(hoveredRow, series.key);
              if (yValue === null || !Number.isFinite(yValue)) return null;
              return (
                <circle
                  key={series.key}
                  cx={hoverX}
                  cy={scales.y(yValue)}
                  r={series.key === "total" ? 4 : 3}
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
  const flip = hoverX > chartWidth / 2;

  return (
    <ChartTooltipSurface
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-[12.5rem]"
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
          const share = series.key !== "total" && value != null && row.total != null && row.total > 0
            ? (value / row.total) * 100
            : null;
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
              <dd className="pharos-numeric text-foreground">
                {value === null || !Number.isFinite(value) ? "—" : (
                  <>
                    {formatCurrency(value)}
                    {share !== null ? (
                      <span className="ml-1 text-2xs text-muted-foreground">({share.toFixed(0)}%)</span>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </ChartTooltipSurface>
  );
}

export function HomeAltHeroChart({ rows }: HomeAltHeroChartProps) {
  const [range, setRange] = useState<HeroChartRange>("all");
  const { chartContainerRef, isChartReady, width, height } = useChartShell<HTMLDivElement>();

  const rangedRows = useMemo(() => filterRowsByRange(rows, range), [rows, range]);

  const yDomain = useMemo(
    () =>
      computeChartYDomain(
        rangedRows.map((d) => d.total).filter((v): v is number => v != null),
        true,
      ),
    [rangedRows],
  );
  const chartReady = isChartReady && rangedRows.length > 0;

  return (
    <div
      className="flex h-[268px] w-full flex-col sm:h-[296px] lg:h-full"
      role="figure"
      aria-label="Stablecoin market cap history stacked by major cohort"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-0.5 sm:px-5">
        <div className="flex items-center gap-3 text-2xs text-muted-foreground">
          <span className="pharos-chart-legend-chip">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: TOTAL_SERIES_COLOR }} aria-hidden="true" />
            <span>Total</span>
          </span>
          <span className="hidden sm:inline">Stacked cohorts</span>
        </div>
        <div role="group" aria-label="Market cap chart range" className="pharos-segmented">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={range === option.value}
              onClick={() => setRange(option.value)}
              className="pharos-focus-ring pharos-segmented-item min-h-11 px-2.5 font-mono text-2xs sm:min-h-7"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={chartContainerRef} className="relative min-h-0 flex-1 w-full">
        {chartReady ? (
          <HomeAltChartFrame width={width} height={height} rows={rangedRows} yDomain={yDomain} />
        ) : (
          <div className="h-full p-4">
            <ChartSkeleton aria-hidden className="h-full w-full" />
          </div>
        )}
      </div>
    </div>
  );
}
