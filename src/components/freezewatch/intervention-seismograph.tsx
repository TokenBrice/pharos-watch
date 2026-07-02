"use client";

import { useId, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { EVENT_LABELS } from "@shared/lib/classification";
import { formatCompactCount } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

interface InterventionSeismographProps {
  stats: BlacklistSummaryResponse["stats"] | undefined;
  chart: BlacklistSummaryResponse["chart"] | undefined;
  isLoading: boolean;
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
// shared/data/annotations/curated-annotations.ts, keyed by stablecoin id),
// these are macro/regulatory events with no single coin owner, so they stay
// co-located with the only component that renders them.
//
// Maintenance: append a new entry only for an event that materially shifted
// blacklist/destroy activity in its quarter (the same bar this chart plots).
// Expect roughly one addition per year; keep the list short so labels stay
// legible. `quarter` must match the point key format emitted by sortKeyToLabel()
// (shared/lib/blacklist-aggregates.ts): "Qn 'YY", e.g. "Q3 '22" — NOT "YYYY-Qn".
const NOTABLE_QUAKES: ReadonlyArray<{ quarter: string; label: string }> = [
  { quarter: "Q3 '22", label: "Tornado Cash" },
  { quarter: "Q1 '23", label: "Silvergate" },
  { quarter: "Q4 '23", label: "OFAC Hamas" },
];

const EVENT_COLORS = {
  destroy: "#ef4444",
  blacklist: "#f97316",
  unblacklist: "oklch(0.78 0.16 240)",
} as const;

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 220;
const PADDING_TOP = 28;
const PADDING_BOTTOM = 28;
const PLOT_HEIGHT = VIEWBOX_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
const BASELINE_Y = VIEWBOX_HEIGHT - PADDING_BOTTOM;

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
  for (const symbol of BLACKLIST_STABLECOINS) {
    const points = stats.perCoinQuarterlyEventTypes[symbol] ?? [];
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

export function InterventionSeismograph({ stats, chart, isLoading }: InterventionSeismographProps) {
  const titleId = useId();
  const points = useMemo(() => buildQuarterPoints(stats), [stats]);

  if (isLoading) {
    return (
      <section className="pharos-card-shell p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-7 w-80 max-w-full" />
          </div>
          <Skeleton className="h-10 w-44" />
        </div>
        <Skeleton className="mt-5 h-44 w-full rounded-xl" />
      </section>
    );
  }

  const totalEvents = points.reduce((sum, point) => sum + point.total, 0);
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
          <p className="pharos-kicker">Intervention Seismograph</p>
          <h2 id={titleId} className="pharos-section-title">
            Quarterly freeze, release, and wipe events
          </h2>
          <p className="text-sm text-muted-foreground">
            Event counts by quarter across every supported contract family.
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

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <LegendSwatch color={EVENT_COLORS.blacklist} label={EVENT_LABELS.blacklist} />
        <LegendSwatch color={EVENT_COLORS.destroy} label={EVENT_LABELS.destroy} />
        <LegendSwatch color={EVENT_COLORS.unblacklist} label={EVENT_LABELS.unblacklist} />
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          height = quarterly event count
        </span>
      </div>
    </section>
  );
}

function SeismographSvg({ points, peakTotal }: { points: QuarterPoint[]; peakTotal: number }) {
  const n = points.length;
  const slotWidth = VIEWBOX_WIDTH / Math.max(n, 1);
  const barWidth = Math.max(2, slotWidth * 0.78);
  const slotPad = (slotWidth - barWidth) / 2;
  const yForCount = (count: number) => BASELINE_Y - (count / peakTotal) * PLOT_HEIGHT;
  const labelInterval = Math.max(1, Math.ceil(n / 6));

  const annotations = NOTABLE_QUAKES.map((quake) => {
    const index = points.findIndex((p) => p.quarter === quake.quarter);
    if (index === -1) return null;
    const point = points[index];
    const x = index * slotWidth + slotWidth / 2;
    const topY = yForCount(point.total);
    return { ...quake, point, x, topY };
  }).filter(
    (entry): entry is { quarter: string; label: string; point: QuarterPoint; x: number; topY: number } =>
      entry !== null,
  );

  const horizonPoints = points
    .map((point, index) => {
      const x0 = index * slotWidth + slotPad;
      const x1 = x0 + barWidth;
      const topY = yForCount(point.total);
      return `${x0},${topY} ${x1},${topY}`;
    })
    .join(" ");
  const horizonPath = `M ${horizonPoints}`;

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-border/70 bg-muted/20 p-3">
      <svg
        role="img"
        aria-label="Quarterly intervention seismograph"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-44 w-full sm:h-56"
      >
        <defs>
          <linearGradient id="seismograph-frost" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.78 0.16 240)" stopOpacity="0.07" />
            <stop offset="100%" stopColor="oklch(0.78 0.16 240)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x={0} y={PADDING_TOP - 4} width={VIEWBOX_WIDTH} height={PLOT_HEIGHT + 4} fill="url(#seismograph-frost)" />

        <line
          x1={0}
          x2={VIEWBOX_WIDTH}
          y1={BASELINE_Y}
          y2={BASELINE_Y}
          stroke="var(--color-muted-foreground)"
          strokeOpacity={0.6}
          strokeWidth={0.5}
          strokeDasharray="3 3"
        />

        {points.map((point, index) => {
          const x = index * slotWidth + slotPad;
          const layers: Array<{ key: keyof typeof EVENT_COLORS; count: number }> = [
            { key: "destroy", count: point.destroy },
            { key: "blacklist", count: point.blacklist },
            { key: "unblacklist", count: point.unblacklist },
          ];
          let running = 0;
          return layers.map((layer) => {
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
                fill={EVENT_COLORS[layer.key]}
                opacity={0.88}
              >
                <title>{`${point.quarter} · ${EVENT_LABELS[layer.key]}: ${formatCompactCount(layer.count)}`}</title>
              </rect>
            );
          });
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
              y2={annotation.topY - 18}
              stroke="var(--color-muted-foreground)"
              strokeWidth={0.75}
            />
            <circle cx={annotation.x} cy={annotation.topY - 4} r={1.6} fill="var(--color-muted-foreground)" />
            <text
              x={annotation.x}
              y={annotation.topY - 22}
              textAnchor="middle"
              fontSize={10}
              fontFamily="ui-monospace, monospace"
              fill="var(--color-foreground)"
            >
              {annotation.label}
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          if (index % labelInterval !== 0 && index !== n - 1) return null;
          const x = index * slotWidth + slotWidth / 2;
          return (
            <text
              key={`tick-${point.quarter}`}
              x={x}
              y={BASELINE_Y + 14}
              textAnchor="middle"
              fontSize={10}
              fontFamily="ui-monospace, monospace"
              fill="var(--color-muted-foreground)"
            >
              {point.quarter}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function SignalStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border/65 bg-background/65 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 pharos-numeric text-sm font-semibold text-foreground">{value}</p>
      {detail ? <p className="text-[10px] text-muted-foreground">{detail}</p> : null}
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
