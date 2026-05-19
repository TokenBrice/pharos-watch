"use client";

import { useMemo } from "react";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

/* Compact PYS history sparkline.
   Reads optional `pysAtPublish` snapshots persisted per published row, draws a
   horizontal polyline over the last N days. Null values are gaps and skipped.
   Pure SVG — no chart library. */

export interface PysHistorySparklinePoint {
  ts: number;
  pysAtPublish?: number | null;
}

export interface PysHistorySparklineProps {
  history: PysHistorySparklinePoint[];
  windowDays?: number;
  className?: string;
}

const DEFAULT_WINDOW_DAYS = 30;
const MIN_POINTS_REQUIRED = 7;
const FLAT_DELTA_TOLERANCE = 1;
const SVG_WIDTH = 300;
const SVG_HEIGHT = 24;
const SVG_PAD_X = 1;
const SVG_PAD_Y = 2;

interface PreparedSeries {
  /** Non-null points inside the window, sorted ascending by ts. */
  points: Array<{ ts: number; pys: number }>;
  /** Min/max for vertical scaling. */
  min: number;
  max: number;
}

function preparePysSeries(
  history: ReadonlyArray<PysHistorySparklinePoint>,
  windowMs: number,
): PreparedSeries {
  if (history.length === 0) {
    return { points: [], min: 0, max: 0 };
  }
  const sorted = [...history]
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    return { points: [], min: 0, max: 0 };
  }
  const cutoff = sorted[sorted.length - 1].ts - windowMs;
  const points: Array<{ ts: number; pys: number }> = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of sorted) {
    if (p.ts < cutoff) continue;
    if (p.pysAtPublish === undefined || p.pysAtPublish === null) continue;
    if (!Number.isFinite(p.pysAtPublish)) continue;
    points.push({ ts: p.ts, pys: p.pysAtPublish });
    if (p.pysAtPublish < min) min = p.pysAtPublish;
    if (p.pysAtPublish > max) max = p.pysAtPublish;
  }
  if (points.length === 0) {
    return { points: [], min: 0, max: 0 };
  }
  return { points, min, max };
}

function formatSignedDelta(delta: number): string {
  if (delta > 0) return `+${delta.toFixed(0)}`;
  if (delta < 0) return delta.toFixed(0);
  return "0";
}

function getTrendColor(first: number, last: number): string {
  const delta = last - first;
  if (delta > FLAT_DELTA_TOLERANCE) return CHART_GREEN;
  if (delta < -FLAT_DELTA_TOLERANCE) return CHART_RED;
  return CHART_SLATE;
}

export function PysHistorySparkline({
  history,
  windowDays = DEFAULT_WINDOW_DAYS,
  className,
}: PysHistorySparklineProps) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const series = useMemo(() => preparePysSeries(history, windowMs), [history, windowMs]);

  if (series.points.length < MIN_POINTS_REQUIRED) {
    return (
      <span
        className={cn("text-[10px] text-muted-foreground", className)}
        data-testid="pys-sparkline-placeholder"
      >
        PYS history collecting…
      </span>
    );
  }

  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  const range = Math.max(series.max - series.min, 1);
  const tsSpan = Math.max(last.ts - first.ts, 1);
  const plotWidth = SVG_WIDTH - SVG_PAD_X * 2;
  const plotHeight = SVG_HEIGHT - SVG_PAD_Y * 2;

  const polylinePoints = series.points
    .map((p) => {
      const x = SVG_PAD_X + ((p.ts - first.ts) / tsSpan) * plotWidth;
      const y = SVG_PAD_Y + (1 - (p.pys - series.min) / range) * plotHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const stroke = getTrendColor(first.pys, last.pys);
  const delta = last.pys - first.pys;
  const ariaLabel = `${windowDays}-day PYS history: starts at ${first.pys.toFixed(0)}, ends at ${last.pys.toFixed(0)}, ranges ${series.min.toFixed(0)} to ${series.max.toFixed(0)}`;

  return (
    <div className={cn("flex flex-col gap-0.5", className)} data-testid="pys-sparkline">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        preserveAspectRatio="none"
        width="100%"
        height={SVG_HEIGHT}
        className="block"
      >
        <polyline
          points={polylinePoints}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        PYS {last.pys.toFixed(0)} ({formatSignedDelta(delta)})
      </span>
    </div>
  );
}
