"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ReferenceLine } from "recharts";
import { cn } from "@/lib/utils";
import type { ChartAnnotation, ChartAnnotationKind } from "@shared/types/chart-annotation";

/**
 * Hex literals — Recharts SVG `fill` / `stroke` cannot resolve CSS variables,
 * so the annotation palette is kept here as the canonical source.
 */
const ANNOTATION_HEX_COLORS: Record<ChartAnnotationKind, string> = {
  depeg: "#ef4444", // red-500
  "mint-burn-spike": "#3b82f6", // blue-500
  "blacklist-surge": "#f59e0b", // amber-500
  exploit: "#ea580c", // orange-600
  governance: "#a855f7", // purple-500
  regulatory: "#64748b", // slate-500
  "methodology-change": "#facc15", // amber-400
};

interface ChartAnnotationLinesProps {
  annotations: readonly ChartAnnotation[];
  /** When true, prefix each marker with a numbered badge (1, 2, 3...) tied to the legend order. */
  numbered?: boolean;
}

/**
 * Renders Recharts `<ReferenceLine>` markers for event annotations on
 * `McapChart` / `PegDeviationChart`. Vertical lines read clearly across the
 * full chart height and don't require a per-series y-value lookup.
 * `ifOverflow="hidden"` keeps out-of-range markers from extending the chart's
 * data domain (defence in depth with hook-side clamping).
 */
export function ChartAnnotationLines({ annotations, numbered = false }: ChartAnnotationLinesProps) {
  if (annotations.length === 0) return null;
  return (
    <>
      {annotations.map((a, i) => {
        const color = ANNOTATION_HEX_COLORS[a.kind];
        return (
          <ReferenceLine
            key={`${a.ts}-${a.kind}`}
            x={a.ts}
            ifOverflow="hidden"
            stroke={color}
            strokeWidth={1.25}
            strokeDasharray="2 4"
            strokeOpacity={0.7}
            label={
              numbered
                ? {
                    value: String(i + 1),
                    position: "insideTopRight",
                    fill: color,
                    fontSize: 10,
                    fontFamily: "var(--font-mono, monospace)",
                    fontWeight: 600,
                    offset: 4,
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}

const ANNOTATION_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Sighted legend rendered below `McapChart` / `PegDeviationChart`. Each entry
 * matches a `ChartAnnotationLines` reference line by `kind` color so users can
 * decode what the vertical lines mark. Keeps the `<ul>` semantic so screen
 * readers read the same event list.
 */
export function ChartAnnotationLegend({
  annotations,
  className = "mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground",
  numbered = false,
}: {
  annotations: readonly ChartAnnotation[];
  /**
   * Override the `<ul>` className. Default includes the `mt-3` spacing used
   * when the legend sits directly under a chart card. Pass a className without
   * `mt-3` when the legend is rendered inside an already-padded container
   * (e.g. the shared legend below the Market Cap / Peg Deviation pair).
   */
  className?: string;
  /** When true, prefix each entry with its 1-based index to match numbered chart markers. */
  numbered?: boolean;
}) {
  if (annotations.length === 0) return null;
  return (
    <ul aria-label="Chart events" className={className}>
      {annotations.map((a, i) => {
        const date = ANNOTATION_DATE_FMT.format(new Date(a.ts));
        const color = ANNOTATION_HEX_COLORS[a.kind];
        const content = (
          <>
            {numbered ? (
              <span
                aria-hidden
                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums"
                style={{
                  color,
                  border: `1px solid ${color}`,
                  backgroundColor: `${color}1a`,
                }}
              >
                {i + 1}
              </span>
            ) : (
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="font-mono tabular-nums text-foreground/80">{date}</span>
            <span aria-hidden className="text-muted-foreground/60">
              —
            </span>
            <span className="text-foreground/80">{a.label}</span>
          </>
        );
        return (
          <li key={`${a.ts}-${a.kind}`} className="inline-flex items-baseline gap-1.5 leading-tight">
            {a.href ? (
              <a
                href={a.href}
                target="_blank"
                rel="noreferrer noopener"
                className="pharos-focus-ring inline-flex items-baseline gap-1.5 rounded-sm underline-offset-2 hover:underline"
              >
                {content}
              </a>
            ) : (
              <span className="inline-flex items-baseline gap-1.5">{content}</span>
            )}
            {a.caseStudySlug ? (
              <Link
                href={`/learn/case-studies/${a.caseStudySlug}/`}
                className="pharos-focus-ring shrink-0 rounded-sm font-medium text-frost-blue underline-offset-2 hover:underline"
              >
                Case study &rarr;
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// D14 — Annotation density strip (1-D histogram by quarter)
// ---------------------------------------------------------------------------

/**
 * Bin annotations into calendar quarters. Returns one entry per quarter that
 * contains at least one annotation. Each entry carries the dominant
 * `ChartAnnotationKind` so the strip's bar can be colored by the
 * `ANNOTATION_HEX_COLORS` palette.
 */
function bucketAnnotationsByQuarter(
  annotations: readonly ChartAnnotation[],
): Array<{ startMs: number; endMs: number; count: number; dominantKind: ChartAnnotationKind }> {
  if (annotations.length === 0) return [];
  const buckets = new Map<string, { startMs: number; endMs: number; counts: Map<ChartAnnotationKind, number> }>();
  for (const a of annotations) {
    const d = new Date(a.ts);
    const year = d.getUTCFullYear();
    const q = Math.floor(d.getUTCMonth() / 3); // 0..3
    const key = `${year}-Q${q}`;
    let entry = buckets.get(key);
    if (!entry) {
      const start = Date.UTC(year, q * 3, 1);
      const end = Date.UTC(year, q * 3 + 3, 1) - 1;
      entry = { startMs: start, endMs: end, counts: new Map() };
      buckets.set(key, entry);
    }
    entry.counts.set(a.kind, (entry.counts.get(a.kind) ?? 0) + 1);
  }
  return Array.from(buckets.values()).map((b) => {
    let dominant: ChartAnnotationKind = "depeg";
    let maxCount = -1;
    let total = 0;
    for (const [kind, count] of b.counts) {
      total += count;
      if (count > maxCount) {
        maxCount = count;
        dominant = kind;
      }
    }
    return { startMs: b.startMs, endMs: b.endMs, count: total, dominantKind: dominant };
  });
}

interface AnnotationDensityStripProps {
  annotations: readonly ChartAnnotation[];
  /** Domain to scale bins to (full visible chart x-domain). */
  domain: readonly [number, number];
  /** Plotting plot-area width — matches the SVG x-axis pixel range. */
  width: number;
  /** Strip height in px. Default 6, matches the spec. */
  height?: number;
  /** Optional className for the wrapper. */
  className?: string;
}

/**
 * Thin "event density" strip. Quarterly bars sized by count, colored by the
 * dominant kind in each bin. Pure SVG — no Recharts dependency — so it can
 * sit below the chart's x-axis without disturbing Recharts' margin model.
 */
export function AnnotationDensityStrip({
  annotations,
  domain,
  width,
  height = 6,
  className,
}: AnnotationDensityStripProps) {
  const bins = useMemo(() => bucketAnnotationsByQuarter(annotations), [annotations]);
  if (bins.length === 0 || width <= 0) return null;
  const [from, to] = domain;
  const span = Math.max(1, to - from);
  const maxCount = bins.reduce((acc, b) => Math.max(acc, b.count), 0);
  return (
    <div className={cn("relative w-full", className)}>
      <svg width={width} height={height} aria-hidden>
        {bins.map((b, i) => {
          const clampedStart = Math.max(from, b.startMs);
          const clampedEnd = Math.min(to, b.endMs);
          if (clampedEnd <= clampedStart) return null;
          const x = ((clampedStart - from) / span) * width;
          const w = Math.max(2, ((clampedEnd - clampedStart) / span) * width);
          const alpha = 0.35 + 0.55 * (b.count / Math.max(1, maxCount));
          const color = ANNOTATION_HEX_COLORS[b.dominantKind];
          return (
            <rect
              key={`${b.startMs}-${i}`}
              x={x}
              y={0}
              width={w - 1}
              height={height}
              rx={1}
              fill={color}
              fillOpacity={alpha}
            >
              <title>
                {`${b.count} event${b.count === 1 ? "" : "s"} · ${new Date(b.startMs).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
