import type { HomepageHistory } from "@shared/types/homepage";
import { formatLongDate } from "@shared/lib/format";
import { MARKET_PERIMETER_MARKERS } from "@shared/lib/supply-perimeter-changes";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { HomeAltHeroChartFallback } from "@/components/homepage/home-alt-hero-chart-fallback";
import { CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import {
  CHART_AXIS_TICK,
  CHART_GRID_DASH,
  CHART_GRID_STROKE,
  CHART_REFERENCE_DASH,
  CHART_STROKE_WIDTH,
  CHART_TICK_FONT_SIZE,
} from "@/lib/chart-theme";
import { formatCurrencyTick, niceTicks, niceTimeTicks } from "@/lib/chart-ticks";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 216;
const PLOT_X0 = 62;
const PLOT_X1 = 622;
const PLOT_Y0 = 14;
const PLOT_Y1 = 184;

const DATE_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/** A bounded dated preview, never a live query seed or a replacement census. */
export function HomeAltHeroStaticChart({
  history,
  nowMs,
  settled = false,
}: {
  history?: HomepageHistory;
  nowMs: number;
  settled?: boolean;
}): React.JSX.Element {
  const updatedAt = history?.sources.total.updatedAt;
  if (!history || updatedAt == null || updatedAt * 1000 > nowMs || nowMs - updatedAt * 1000 > HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) {
    return <HomeAltHeroChartFallback settled={settled} />;
  }
  const rows = history.rows;
  const observed = rows.filter((row) => row.total !== null);
  if (rows.length < 2 || observed.length < 2) return <HomeAltHeroChartFallback settled={settled} />;

  const start = rows[0]!.ts;
  const end = rows[rows.length - 1]!.ts;
  const span = Math.max(1, end - start);
  const maxVal = Math.max(1, ...observed.map((row) => row.total!));
  const { domain: yDomain, ticks: yTicks } = niceTicks(0, maxVal, { kind: "currency", includeZero: true, count: 4 });
  const ySpan = Math.max(1, yDomain[1] - yDomain[0]);
  const xScale = (ts: number) => PLOT_X0 + ((ts - start) / span) * (PLOT_X1 - PLOT_X0);
  const yScale = (value: number) => PLOT_Y1 - ((value - yDomain[0]) / ySpan) * (PLOT_Y1 - PLOT_Y0);
  const xTicks = niceTimeTicks(start, end, 4);

  const strokePath = buildStaticStrokePath(rows, xScale, yScale);
  const fillPath = buildStaticAreaPath(rows, xScale, yScale, PLOT_Y1);
  const visibleMarkers = MARKET_PERIMETER_MARKERS.filter((marker) => marker.tsMs > start && marker.tsMs <= end);

  return (
    <figure className="flex h-[268px] flex-col justify-between gap-2 p-4 sm:h-[296px] sm:p-5 lg:h-full">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label="Recent total stablecoin market cap history"
        className="min-h-0 w-full flex-1"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="home-alt-static-total-fill" x1={0} y1={0} x2={0} y2={1}>
            <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.22} />
            <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <g aria-hidden="true">
          {yTicks.map((value) => {
            const y = yScale(value);
            return (
              <g key={value}>
                <line
                  x1={PLOT_X0}
                  x2={PLOT_X1}
                  y1={y}
                  y2={y}
                  stroke={CHART_GRID_STROKE}
                  strokeDasharray={CHART_GRID_DASH}
                  strokeWidth={CHART_STROKE_WIDTH.guide}
                />
                <text x={PLOT_X0 - 8} y={y + CHART_TICK_FONT_SIZE / 2 - 2} textAnchor="end" {...CHART_AXIS_TICK}>
                  {formatCurrencyTick(value)}
                </text>
              </g>
            );
          })}
          {xTicks.ticks.map((ts) => (
            <text
              key={ts}
              x={xScale(ts)}
              y={PLOT_Y1 + 12 + CHART_TICK_FONT_SIZE}
              textAnchor="middle"
              {...CHART_AXIS_TICK}
            >
              {DATE_TICK_FORMATTER.format(new Date(ts))}
            </text>
          ))}
        </g>
        <path
          d={strokePath}
          fill="none"
          stroke={CHART_BLUE}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {fillPath ? <path d={fillPath} fill="url(#home-alt-static-total-fill)" /> : null}
        {visibleMarkers.map((marker) => {
          const markerX = xScale(marker.tsMs);
          const anchorEnd = markerX > PLOT_X0 + (PLOT_X1 - PLOT_X0) * 0.72;
          return (
            <g key={marker.id} data-perimeter-marker={marker.id}>
              <line
                x1={markerX}
                x2={markerX}
                y1={PLOT_Y0}
                y2={PLOT_Y1}
                stroke={CHART_SLATE}
                strokeDasharray={CHART_REFERENCE_DASH}
                strokeWidth={CHART_STROKE_WIDTH.guide}
              >
                <title>{marker.note}</title>
              </line>
              <text
                x={anchorEnd ? markerX - 6 : markerX + 6}
                y={PLOT_Y0 + CHART_TICK_FONT_SIZE + 2}
                textAnchor={anchorEnd ? "end" : "start"}
                {...CHART_AXIS_TICK}
              >
                {marker.shortLabel}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="pharos-meta">
        <span>Total market cap history · as of {formatLongDate(new Date(updatedAt * 1000), { utc: true })}</span>
        {visibleMarkers.map((marker) => (
          <span key={marker.id} data-perimeter-note={marker.id} className="block">
            {marker.note}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function buildStaticStrokePath(
  rows: HomepageHistory["rows"],
  xScale: (ts: number) => number,
  yScale: (value: number) => number,
): string {
  const parts: string[] = [];
  let inSegment = false;
  for (const row of rows) {
    if (row.total === null || !Number.isFinite(row.total)) {
      inSegment = false;
      continue;
    }
    parts.push(`${inSegment ? "L" : "M"}${xScale(row.ts).toFixed(1)},${yScale(row.total).toFixed(1)}`);
    inSegment = true;
  }
  return parts.join(" ");
}

function buildStaticAreaPath(
  rows: HomepageHistory["rows"],
  xScale: (ts: number) => number,
  yScale: (value: number) => number,
  baselineY: number,
): string {
  const commands: string[] = [];
  const baseY = baselineY.toFixed(1);
  let firstX: string | null = null;
  let lastX = "";
  let segmentPoints = 0;

  const closeSegment = () => {
    if (firstX !== null) {
      if (segmentPoints > 1) commands.push(`L${lastX},${baseY} L${firstX},${baseY} Z`);
      else commands.pop();
      firstX = null;
      segmentPoints = 0;
    }
  };

  for (const row of rows) {
    if (row.total === null || !Number.isFinite(row.total)) {
      closeSegment();
      continue;
    }
    const x = xScale(row.ts).toFixed(1);
    const y = yScale(row.total).toFixed(1);
    commands.push(`${firstX === null ? "M" : "L"}${x},${y}`);
    firstX ??= x;
    lastX = x;
    segmentPoints += 1;
  }
  closeSegment();
  return commands.join(" ");
}
