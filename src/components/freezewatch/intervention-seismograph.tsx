"use client";

import { useId, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { ChartTooltipSurface, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { QueryStateNotice } from "@/components/query-state-notice";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { EVENT_CHART_COLORS, EVENT_LABELS } from "@shared/lib/classification";
import { formatCompactCount } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types/blacklist";

interface InterventionSeismographProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  chart: BlacklistSummaryResponse["chart"] | undefined;
  /** Producer-counted ledger total; the quarterly payload may omit archived rows. */
  totalEvents?: number;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
}

interface QuarterPoint {
  quarter: string;
  blacklist: number;
  unblacklist: number;
  destroy: number;
  total: number;
}

// Quarter-keyed annotations for market-wide intervention milestones that map
// onto this seismograph's timeline. Unlike per-coin chart pins (which live in
// shared/data/annotations/coins/<stablecoin-id>.json),
// these are macro/regulatory events with no single coin owner, so they stay
// co-located with the only component that renders them.
//
// Maintenance: append a new entry only for an event that materially shifted
// blacklist/destroy activity in its quarter (the same bar this chart plots).
// Expect roughly one addition per year; keep the list short so labels stay
// legible. `quarter` must match the point key format emitted by sortKeyToLabel()
// in `worker/src/lib/blacklist-summary-service.ts`: "Qn 'YY", e.g. "Q3 '22" —
// NOT "YYYY-Qn".
const NOTABLE_QUAKES: ReadonlyArray<{ quarter: string; label: string }> = [
  { quarter: "Q3 '22", label: "Tornado Cash" },
  { quarter: "Q1 '23", label: "Silvergate" },
  { quarter: "Q4 '23", label: "OFAC Hamas" },
];

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 248;
const PADDING_LEFT = 46;
const PADDING_RIGHT = 12;
const PADDING_TOP = 54;
const PADDING_BOTTOM = 28;
const PLOT_WIDTH = VIEWBOX_WIDTH - PADDING_LEFT - PADDING_RIGHT;
const PLOT_HEIGHT = VIEWBOX_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
const ANNOTATION_LIFT = 16;
const BASELINE_Y = VIEWBOX_HEIGHT - PADDING_BOTTOM;

function computeNiceAxis(peakTotal: number): { ceiling: number; ticks: number[] } {
  const safePeak = Number.isFinite(peakTotal) && peakTotal > 0 ? peakTotal : 1;
  if (safePeak <= 3) {
    const ceiling = Math.max(1, Math.ceil(safePeak));
    return { ceiling, ticks: [0, ceiling] };
  }
  // Reserve headroom above the tallest spike so bars and milestone callouts never clip.
  const padded = safePeak > Number.MAX_VALUE / 1.12 ? safePeak : safePeak * 1.12;
  const rawStep = padded / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceStep = Math.max(
    1,
    normalized <= 1
      ? 1 * magnitude
      : normalized <= 2
        ? 2 * magnitude
        : normalized <= 2.5
          ? 2.5 * magnitude
          : normalized <= 5
            ? 5 * magnitude
            : 10 * magnitude,
  );
  const rawCeiling = Math.ceil(padded / niceStep) * niceStep;
  const ceiling = Number.isFinite(rawCeiling) && rawCeiling > 0 ? Math.max(niceStep, rawCeiling) : safePeak;
  const tickSet = new Set<number>([0]);
  for (let step = 1; step <= 4; step += 1) {
    const value = Math.round(step * niceStep);
    if (value <= ceiling && Number.isFinite(value)) tickSet.add(value);
  }
  tickSet.add(Math.round(ceiling));
  return { ceiling, ticks: [...tickSet].sort((a, b) => a - b) };
}

function quarterLabelSortKey(label: string): number | null {
  const match = /^Q([1-4]) '(\d{2})$/.exec(label);
  if (!match) return null;
  return (2000 + Number(match[2])) * 4 + (Number(match[1]) - 1);
}

function compareQuarterLabels(a: string, b: string): number {
  const aKey = quarterLabelSortKey(a);
  const bKey = quarterLabelSortKey(b);
  if (aKey != null && bKey != null && aKey !== bKey) return aKey - bKey;
  if (aKey != null && bKey == null) return -1;
  if (aKey == null && bKey != null) return 1;
  return a.localeCompare(b);
}

export function buildQuarterPoints(stats: BlacklistSummaryResponse["stats"] | undefined): QuarterPoint[] {
  if (!stats) return [];
  const map = new Map<string, { blacklist: number; unblacklist: number; destroy: number }>();
  // Aggregate the payload rather than the compiled list: retired assets and a
  // newly deployed symbol the client bundle does not know still belong to it.
  for (const points of Object.values(stats.perCoinQuarterlyEventTypes)) {
    for (const point of points) {
      const existing = map.get(point.quarter) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
      existing.blacklist += point.blacklist;
      existing.unblacklist += point.unblacklist;
      existing.destroy += point.destroy;
      map.set(point.quarter, existing);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => compareQuarterLabels(a, b))
    .map(([quarter, counts]) => ({
      quarter,
      ...counts,
      total: counts.blacklist + counts.unblacklist + counts.destroy,
    }));
}

export function InterventionSeismograph({
  stats,
  chart,
  totalEvents: authoritativeTotalEvents,
  isLoading,
  error,
  onRetry,
}: InterventionSeismographProps) {
  const titleId = useId();
  const points = useMemo(() => buildQuarterPoints(stats), [stats]);
  const hasData = stats != null && chart != null;
  const state = resolveQueryViewState({ hasData, isLoading, error });

  if (state === "loading") {
    return (
      <section className="pharos-card-shell p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-7 w-80 max-w-full" />
          </div>
          <Skeleton className="h-10 w-44" />
        </div>
        <ChartSkeleton variant="bars" className="mt-5 h-44 w-full sm:h-56" />
      </section>
    );
  }

  if (!hasData) {
    return (
      <section className="pharos-card-shell p-4 sm:p-5">
        <QueryStateNotice state="unavailable" label="Intervention seismograph" onRetry={onRetry} />
      </section>
    );
  }

  const totalEvents = authoritativeTotalEvents ?? points.reduce((sum, point) => sum + point.total, 0);
  const peakPoint = points.reduce<QuarterPoint | null>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    null,
  );
  const peakDestroyQuarter = points.reduce<QuarterPoint | null>(
    (peak, point) => (!peak || point.destroy > peak.destroy ? point : peak),
    null,
  );
  const peakTotal = peakPoint?.total ?? 0;
  const liveChartHasData = (chart ?? []).length > 0;

  return (
    <section aria-labelledby={titleId} className="pharos-card-shell p-4 animate-in fade-in duration-300 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-label">Intervention seismograph</p>
          <h2 id={titleId} className="pharos-section-title">
            Quarterly freeze, release, and wipe events
          </h2>
          <p className="text-sm text-muted-foreground">
            Event counts by quarter across every supported contract family. Use the ledger above for address-level rows.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:gap-3">
          <SignalStat label="Events tracked" value={formatCompactCount(totalEvents)} />
          <SignalStat
            label="Peak quarter"
            value={peakPoint?.quarter ?? "—"}
            detail={peakPoint ? `${formatCompactCount(peakPoint.total)} events` : undefined}
          />
          <SignalStat
            label="Largest wipe quarter"
            value={peakDestroyQuarter && peakDestroyQuarter.destroy > 0 ? peakDestroyQuarter.quarter : "—"}
            detail={
              peakDestroyQuarter && peakDestroyQuarter.destroy > 0
                ? `${formatCompactCount(peakDestroyQuarter.destroy)} wipes`
                : undefined
            }
          />
        </div>
      </div>

      {points.length === 0 ? (
        <div className="mt-5 flex h-44 items-center justify-center rounded-xl border border-border/70 bg-muted/20 text-sm text-muted-foreground">
          {liveChartHasData
            ? "No quarterly event-type breakdown is available yet."
            : "No freeze-ledger quarter data yet."}
        </div>
      ) : (
        <SeismographSvg points={points} peakTotal={Math.max(1, peakTotal)} />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-muted-foreground">
        <LegendSwatch color={EVENT_CHART_COLORS.blacklist} label={EVENT_LABELS.blacklist} />
        <LegendSwatch color={EVENT_CHART_COLORS.destroy} label={EVENT_LABELS.destroy} />
        <LegendSwatch color={EVENT_CHART_COLORS.unblacklist} label={EVENT_LABELS.unblacklist} />
        <span className="pharos-meta ml-auto">
          height = quarterly event count
        </span>
      </div>
    </section>
  );
}

function SeismographSvg({ points, peakTotal }: { points: QuarterPoint[]; peakTotal: number }) {
  const gradientId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const n = points.length;
  const { ceiling, ticks } = useMemo(() => computeNiceAxis(peakTotal), [peakTotal]);
  const slotWidth = PLOT_WIDTH / Math.max(n, 1);
  const barWidth = Math.max(2, slotWidth * 0.76);
  const slotPad = (slotWidth - barWidth) / 2;
  const yForCount = (count: number) => {
    const ratio = Number.isFinite(count) && Number.isFinite(ceiling) && ceiling > 0
      ? Math.min(1, Math.max(0, count / ceiling))
      : 0;
    return BASELINE_Y - ratio * PLOT_HEIGHT;
  };
  const labelInterval = Math.max(1, Math.ceil(n / 6));

  const placed = NOTABLE_QUAKES.map((quake) => {
    const index = points.findIndex((p) => p.quarter === quake.quarter);
    if (index === -1) return null;
    const point = points[index];
    const x = PADDING_LEFT + index * slotWidth + slotWidth / 2;
    const topY = yForCount(point.total);
    return { ...quake, point, x, topY };
  }).filter(
    (entry): entry is { quarter: string; label: string; point: QuarterPoint; x: number; topY: number } =>
      entry !== null,
  );
  // A label whose neighbour sits within ~12% of the width is lifted one step so the two never overprint.
  const annotations = placed.map((annotation, index) => {
    const previous = index > 0 ? placed[index - 1] : null;
    const lift = previous && annotation.x - previous.x < PLOT_WIDTH * 0.12 ? ANNOTATION_LIFT : 0;
    const labelY = Math.max(14, annotation.topY - 18 - lift);
    return { ...annotation, lift, labelY };
  });
  // Drop a regular tick that would sit on top of the final (always-shown) tick.
  const showTick = (index: number) =>
    index === n - 1 || (index % labelInterval === 0 && n - 1 - index >= labelInterval * 0.75);

  const horizonPoints = points
    .map((point, index) => {
      const x0 = PADDING_LEFT + index * slotWidth + slotPad;
      const x1 = x0 + barWidth;
      const topY = yForCount(point.total);
      return `${x0},${topY} ${x1},${topY}`;
    })
    .join(" ");
  const horizonPath = `M ${horizonPoints}`;
  const activePoint = activeIndex != null ? points[activeIndex] ?? null : null;
  const activeCenterPct =
    activeIndex != null
      ? ((PADDING_LEFT + activeIndex * slotWidth + slotWidth / 2) / VIEWBOX_WIDTH) * 100
      : 50;

  return (
    <div
      className="relative mt-5 overflow-visible rounded-xl border border-border/70 bg-muted/20 p-3"
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg
        role="img"
        aria-label="Quarterly intervention seismograph"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-48 w-full sm:h-60"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.78 0.16 240)" stopOpacity="0.07" />
            <stop offset="100%" stopColor="oklch(0.78 0.16 240)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect
          x={PADDING_LEFT}
          y={PADDING_TOP - 4}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT + 4}
          fill={`url(#${gradientId})`}
        />

        {ticks.map((tick) => {
          const y = yForCount(tick);
          return (
            <line
              key={`grid-${tick}`}
              x1={PADDING_LEFT}
              x2={VIEWBOX_WIDTH - PADDING_RIGHT}
              y1={y}
              y2={y}
              stroke={tick === 0 ? "var(--color-muted-foreground)" : "var(--color-border)"}
              strokeOpacity={tick === 0 ? 0.65 : 0.7}
              strokeWidth={tick === 0 ? 0.65 : 0.5}
              strokeDasharray={tick === 0 ? "3 3" : "2 5"}
            />
          );
        })}

        {points.map((point, index) => {
          const x = PADDING_LEFT + index * slotWidth + slotPad;
          const isActive = activeIndex === index;
          const layers: Array<{ key: keyof typeof EVENT_CHART_COLORS; count: number }> = [
            { key: "destroy", count: point.destroy },
            { key: "blacklist", count: point.blacklist },
            { key: "unblacklist", count: point.unblacklist },
          ];
          let running = 0;
          return (
            <g
              key={point.quarter}
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
            >
              {isActive ? (
                <rect
                  x={PADDING_LEFT + index * slotWidth}
                  y={PADDING_TOP}
                  width={slotWidth}
                  height={PLOT_HEIGHT}
                  fill="var(--color-foreground)"
                  fillOpacity={0.05}
                />
              ) : null}
              {layers.map((layer) => {
                if (layer.count <= 0) return null;
                const yTop = yForCount(running + layer.count);
                const yBottom = yForCount(running);
                const height = Math.max(0, yBottom - yTop);
                running += layer.count;
                return (
                  <rect
                    key={`${point.quarter}-${layer.key}`}
                    x={x}
                    y={yTop}
                    width={barWidth}
                    height={height}
                    fill={EVENT_CHART_COLORS[layer.key]}
                    opacity={isActive ? 1 : 0.88}
                  >
                    <title>{`${point.quarter} · ${EVENT_LABELS[layer.key]}: ${formatCompactCount(layer.count)}`}</title>
                  </rect>
                );
              })}
              {/* Full-height invisible hover column so short quarters are easy to inspect. */}
              <rect
                x={PADDING_LEFT + index * slotWidth}
                y={PADDING_TOP}
                width={slotWidth}
                height={PLOT_HEIGHT}
                fill="transparent"
                className="cursor-crosshair"
              />
            </g>
          );
        })}

        <path
          d={horizonPath}
          fill="none"
          stroke="var(--color-foreground)"
          strokeOpacity={0.8}
          strokeWidth={1.25}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />

        {annotations.map((annotation) => (
          <g key={annotation.quarter}>
            <line
              x1={annotation.x}
              x2={annotation.x}
              y1={annotation.topY - 4}
              y2={annotation.labelY + 2}
              stroke="var(--color-muted-foreground)"
              strokeWidth={0.75}
            />
            <circle cx={annotation.x} cy={annotation.topY - 4} r={1.6} fill="var(--color-muted-foreground)" />
          </g>
        ))}
      </svg>

      {/* Labels are HTML over the stretched SVG so preserveAspectRatio="none" cannot distort the type. */}
      <div className="pointer-events-none absolute font-mono text-3xs" style={{ inset: "0.75rem" }} aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={`ytick-${tick}`}
            data-seismograph-ytick={tick}
            className="absolute right-[calc(100%-38px)] -translate-y-1/2 whitespace-nowrap text-right leading-none text-muted-foreground"
            style={{
              top: `${(yForCount(tick) / VIEWBOX_HEIGHT) * 100}%`,
            }}
          >
            {formatCompactCount(tick)}
          </span>
        ))}
        {annotations.map((annotation) => (
          <span
            key={`label-${annotation.quarter}`}
            className="absolute whitespace-nowrap leading-none text-foreground"
            style={{
              transform: "translate(-50%, -100%)",
              left: `${(annotation.x / VIEWBOX_WIDTH) * 100}%`,
              top: `${(annotation.labelY / VIEWBOX_HEIGHT) * 100}%`,
            }}
          >
            {annotation.label}
          </span>
        ))}
        {points.map((point, index) =>
          showTick(index) ? (
            <span
              key={`tick-${point.quarter}`}
              className="absolute whitespace-nowrap leading-none text-muted-foreground"
              style={{
                transform: index === 0 ? undefined : index === n - 1 ? "translateX(-100%)" : "translateX(-50%)",
                left: `${((PADDING_LEFT + (index === n - 1 ? n : index === 0 ? 0 : index + 0.5) * slotWidth) / VIEWBOX_WIDTH) * 100}%`,
                top: `${((BASELINE_Y + 6) / VIEWBOX_HEIGHT) * 100}%`,
              }}
            >
              {point.quarter}
            </span>
          ) : null,
        )}
      </div>

      {activePoint ? (
        <ChartTooltipSurface
          data-testid="seismograph-tooltip"
          className="pointer-events-none absolute top-2 z-10 min-w-[168px]"
          style={{
            left: `${Math.min(82, Math.max(18, activeCenterPct))}%`,
            transform: "translateX(-50%)",
          }}
        >
          <TooltipLabel>{activePoint.quarter}</TooltipLabel>
          <div className="space-y-1">
            <TooltipRow
              color={EVENT_CHART_COLORS.blacklist}
              label={EVENT_LABELS.blacklist}
              value={formatCompactCount(activePoint.blacklist)}
            />
            <TooltipRow
              color={EVENT_CHART_COLORS.destroy}
              label={EVENT_LABELS.destroy}
              value={formatCompactCount(activePoint.destroy)}
            />
            <TooltipRow
              color={EVENT_CHART_COLORS.unblacklist}
              label={EVENT_LABELS.unblacklist}
              value={formatCompactCount(activePoint.unblacklist)}
            />
            <div className="mt-1 border-t border-border/50 pt-1">
              <TooltipRow label="Total" value={formatCompactCount(activePoint.total)} bold />
            </div>
          </div>
        </ChartTooltipSurface>
      ) : null}
    </div>
  );
}

function SignalStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border/65 bg-background/65 px-3 py-2">
      <p className="pharos-label">{label}</p>
      <p className="mt-0.5 pharos-numeric text-sm font-semibold text-foreground">{value}</p>
      {detail ? <p className="text-3xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}
