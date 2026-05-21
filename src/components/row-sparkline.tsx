"use client";

import { useId, useMemo } from "react";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

/* Generic row sparkline.
   Pure-SVG, dependency-free, ~96×16 by default. Cheap enough to render ~400
   per page. Sibling primitive to `pys-history-sparkline.tsx` — same SVG
   vocabulary, no shared state. */

export interface RowSparklineProps {
  /** Time-ordered samples. `null` marks a gap; the path breaks across it. */
  data: ReadonlyArray<number | null>;
  width?: number;
  height?: number;
  /** Signed-deviation mode: baseline anchored at 0 with diverging fills. */
  signed?: boolean;
  /** Reference rule drawn at this value (e.g. 0 bps for peg deviation). */
  referenceValue?: number;
  /** Stroke/fill color for the positive area. */
  positiveColor?: string;
  /** Stroke/fill color for the negative area (signed mode). */
  negativeColor?: string;
  /** Required accessible label, e.g. "30-day peg deviation". */
  ariaLabel: string;
  /** Optional <desc> for screen readers. */
  srSummary?: string;
  className?: string;
}

const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 16;
const PAD_X = 1;
const PAD_Y = 1;
const FILL_OPACITY = 0.18;
const MIN_VALID_POINTS = 2;

interface PreparedPoint {
  /** Original index in the data array. */
  i: number;
  /** Sample value (already finite). */
  v: number;
}

function prepare(data: ReadonlyArray<number | null>): PreparedPoint[] {
  const out: PreparedPoint[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const raw = data[i];
    if (raw == null || !Number.isFinite(raw)) continue;
    out.push({ i, v: raw });
  }
  return out;
}

interface Segment {
  points: PreparedPoint[];
}

/** Split prepared points into contiguous segments wherever the original
 *  index jumps (i.e. a `null` lived between two valid samples). */
function segmentize(points: PreparedPoint[]): Segment[] {
  if (points.length === 0) return [];
  const segments: Segment[] = [];
  let current: PreparedPoint[] = [points[0]];
  for (let k = 1; k < points.length; k += 1) {
    const prev = points[k - 1];
    const cur = points[k];
    if (cur.i - prev.i > 1) {
      segments.push({ points: current });
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  segments.push({ points: current });
  return segments;
}

function pointToCoords(
  p: PreparedPoint,
  dataLen: number,
  yMin: number,
  yMax: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const xSpan = Math.max(dataLen - 1, 1);
  const yRange = Math.max(yMax - yMin, 1e-9);
  const x = PAD_X + (p.i / xSpan) * (width - PAD_X * 2);
  const y = PAD_Y + (1 - (p.v - yMin) / yRange) * (height - PAD_Y * 2);
  return { x, y };
}

function buildLinePath(segment: Segment, project: (p: PreparedPoint) => { x: number; y: number }): string {
  return segment.points
    .map((p, idx) => {
      const { x, y } = project(p);
      return `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildAreaPath(
  segment: Segment,
  project: (p: PreparedPoint) => { x: number; y: number },
  baselineY: number,
): string {
  if (segment.points.length === 0) return "";
  const line = buildLinePath(segment, project);
  const first = project(segment.points[0]);
  const last = project(segment.points[segment.points.length - 1]);
  return `${line} L${last.x.toFixed(2)} ${baselineY.toFixed(2)} L${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
}

/** For signed mode, walk a segment and split into above-/below-baseline
 *  sub-segments wherever the line crosses the reference value. Crossing
 *  points are linearly interpolated to land exactly on the baseline. */
function splitBySign(
  segment: Segment,
  reference: number,
): Array<{ sign: "pos" | "neg" | "zero"; points: PreparedPoint[] }> {
  if (segment.points.length === 0) return [];
  const result: Array<{ sign: "pos" | "neg" | "zero"; points: PreparedPoint[] }> = [];
  const signOf = (v: number): "pos" | "neg" | "zero" => {
    if (v > reference) return "pos";
    if (v < reference) return "neg";
    return "zero";
  };
  let currentSign = signOf(segment.points[0].v);
  let bucket: PreparedPoint[] = [segment.points[0]];
  for (let k = 1; k < segment.points.length; k += 1) {
    const prev = segment.points[k - 1];
    const cur = segment.points[k];
    const nextSign = signOf(cur.v);
    if (
      (currentSign === "pos" && nextSign === "neg") ||
      (currentSign === "neg" && nextSign === "pos")
    ) {
      const t = (reference - prev.v) / (cur.v - prev.v);
      const crossI = prev.i + (cur.i - prev.i) * t;
      const crossPoint: PreparedPoint = { i: crossI, v: reference };
      bucket.push(crossPoint);
      result.push({ sign: currentSign, points: bucket });
      bucket = [crossPoint, cur];
      currentSign = nextSign;
    } else {
      if (nextSign !== "zero" && nextSign !== currentSign) {
        currentSign = nextSign;
      }
      bucket.push(cur);
    }
  }
  result.push({ sign: currentSign, points: bucket });
  return result;
}

export function RowSparkline({
  data,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  signed = false,
  referenceValue,
  positiveColor = CHART_GREEN,
  negativeColor = CHART_RED,
  ariaLabel,
  srSummary,
  className,
}: RowSparklineProps) {
  const reactId = useId();
  const prepared = useMemo(() => prepare(data), [data]);

  if (prepared.length < MIN_VALID_POINTS) {
    return (
      <span
        className={cn("inline-flex font-mono text-[10px] text-muted-foreground", className)}
        aria-label={ariaLabel}
        data-testid="row-sparkline-empty"
      >
        —
      </span>
    );
  }

  const segments = segmentize(prepared);
  const ref = referenceValue ?? 0;

  let yMin: number;
  let yMax: number;
  if (signed) {
    let maxAbs = 0;
    for (const p of prepared) {
      const d = Math.abs(p.v - ref);
      if (d > maxAbs) maxAbs = d;
    }
    if (maxAbs <= 0) maxAbs = 1;
    yMin = ref - maxAbs;
    yMax = ref + maxAbs;
  } else {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of prepared) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    yMin = lo;
    yMax = hi;
  }

  const dataLen = data.length;
  const project = (p: PreparedPoint) => pointToCoords(p, dataLen, yMin, yMax, width, height);

  const baselineProjected = pointToCoords(
    { i: 0, v: signed ? ref : yMin },
    dataLen,
    yMin,
    yMax,
    width,
    height,
  ).y;

  const referenceProjected =
    referenceValue !== undefined
      ? pointToCoords({ i: 0, v: referenceValue }, dataLen, yMin, yMax, width, height).y
      : null;

  const titleId = `${reactId}-title`;
  const descId = srSummary ? `${reactId}-desc` : undefined;

  return (
    <svg
      role="img"
      aria-labelledby={`${titleId}${descId ? ` ${descId}` : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("inline-block align-middle", className)}
    >
      <title id={titleId}>{ariaLabel}</title>
      {srSummary ? <desc id={descId}>{srSummary}</desc> : null}
      {referenceProjected !== null ? (
        <line
          x1={PAD_X}
          x2={width - PAD_X}
          y1={referenceProjected}
          y2={referenceProjected}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={0.5}
          strokeDasharray="1.5 1.5"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {signed
        ? segments.flatMap((segment, sIdx) => {
            const subs = splitBySign(segment, ref);
            return subs.map((sub, idx) => {
              if (sub.points.length < 2) return null;
              const color =
                sub.sign === "pos"
                  ? positiveColor
                  : sub.sign === "neg"
                    ? negativeColor
                    : CHART_SLATE;
              return (
                <g key={`s${sIdx}-${idx}`}>
                  <path
                    d={buildAreaPath({ points: sub.points }, project, baselineProjected)}
                    fill={color}
                    fillOpacity={FILL_OPACITY}
                    stroke="none"
                  />
                  <path
                    d={buildLinePath({ points: sub.points }, project)}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            });
          })
        : segments.map((segment, sIdx) => {
            if (segment.points.length < 2) return null;
            return (
              <g key={`u${sIdx}`}>
                <path
                  d={buildAreaPath(segment, project, baselineProjected)}
                  fill={positiveColor}
                  fillOpacity={FILL_OPACITY}
                  stroke="none"
                />
                <path
                  d={buildLinePath(segment, project)}
                  fill="none"
                  stroke={positiveColor}
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
    </svg>
  );
}
