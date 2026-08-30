"use client";

import { type ReactNode, useId, useMemo } from "react";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

/* Generic row sparkline.
   Pure-SVG, dependency-free, ~96×16 by default. Cheap enough to render ~400
   per page. Shared primitive for compact SVG trends. */

export interface RowSparklineProps {
  /** Time-ordered samples. `null` marks a gap; the path breaks across it. */
  data: ReadonlyArray<number | null>;
  /** Optional x-coordinate for each sample; defaults to the sample index. */
  xValues?: readonly number[];
  width?: number;
  height?: number;
  inset?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  strokeWidth?: number;
  yRangeMode?: "flat-unit" | "min-unit";
  pointPrecision?: number | null;
  nonScalingStroke?: boolean;
  fillStyle?: "solid" | Readonly<{
    kind: "vertical-gradient";
    id: string;
    startOpacity: number;
    endOpacity: number;
    baselineY: number;
  }>;
  /** Minimum number of finite samples required before rendering the SVG. */
  minPoints?: number;
  /** Draw the standard area fill beneath each line segment. */
  fill?: boolean;
  /** Hide the SVG from assistive technology. */
  decorative?: boolean;
  /** Replacement content for the empty-state fallback. */
  emptyContent?: ReactNode;
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
const DEFAULT_INSET = { top: 1, right: 1, bottom: 1, left: 1 } as const;
const FILL_OPACITY = 0.18;
const MIN_VALID_POINTS = 2;

interface PreparedPoint {
  /** Original index in the data array. */
  i: number;
  /** Sample value (already finite). */
  v: number;
  /** X-coordinate (sample index unless `xValues` is provided). */
  x: number;
}

function prepare(data: ReadonlyArray<number | null>, xValues?: readonly number[]): PreparedPoint[] {
  const out: PreparedPoint[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const raw = data[i];
    if (raw == null || !Number.isFinite(raw)) continue;
    const x = xValues?.[i] ?? i;
    if (!Number.isFinite(x)) continue;
    out.push({ i, v: raw, x });
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
  xStart: number,
  xSpan: number,
  yMin: number,
  yMax: number,
  width: number,
  height: number,
  inset: RowSparklineProps["inset"],
  yRangeMode: RowSparklineProps["yRangeMode"],
): { x: number; y: number } {
  const bounds = inset ?? DEFAULT_INSET;
  const rawYRange = yMax - yMin;
  const yRange = yRangeMode === "flat-unit"
    ? rawYRange || 1
    : yRangeMode === "min-unit" ? Math.max(rawYRange, 1) : Math.max(rawYRange, 1e-9);
  const x = bounds.left + ((p.x - xStart) / xSpan) * (width - bounds.left - bounds.right);
  const y = height - bounds.bottom - ((p.v - yMin) / yRange) * (height - bounds.top - bounds.bottom);
  return { x, y };
}

function formatCoord(value: number, precision: number | null): string {
  return precision === null ? String(value) : value.toFixed(precision);
}

function buildLinePoints(
  segment: Segment,
  project: (p: PreparedPoint) => { x: number; y: number },
  precision: number | null,
): string {
  return segment.points
    .map((p) => {
      const { x, y } = project(p);
      return `${formatCoord(x, precision)},${formatCoord(y, precision)}`;
    })
    .join(" ");
}

function buildLinePath(
  segment: Segment,
  project: (p: PreparedPoint) => { x: number; y: number },
  precision: number | null,
): string {
  return segment.points
    .map((p, idx) => {
      const { x, y } = project(p);
      return `${idx === 0 ? "M" : "L"}${formatCoord(x, precision)} ${formatCoord(y, precision)}`;
    })
    .join(" ");
}

function buildAreaPath(
  segment: Segment,
  project: (p: PreparedPoint) => { x: number; y: number },
  baselineY: number,
  precision: number | null,
): string {
  if (segment.points.length === 0) return "";
  const line = buildLinePath(segment, project, precision);
  const first = project(segment.points[0]);
  const last = project(segment.points[segment.points.length - 1]);
  return `${line} L${formatCoord(last.x, precision)} ${formatCoord(baselineY, precision)} L${formatCoord(first.x, precision)} ${formatCoord(baselineY, precision)} Z`;
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
      const crossX = prev.x + (cur.x - prev.x) * t;
      const crossPoint: PreparedPoint = { i: crossI, v: reference, x: crossX };
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
  xValues,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  inset = DEFAULT_INSET,
  strokeWidth = 1.25,
  yRangeMode,
  pointPrecision = 2,
  nonScalingStroke = true,
  fillStyle = "solid",
  minPoints = MIN_VALID_POINTS,
  fill = true,
  decorative = false,
  emptyContent,
  signed = false,
  referenceValue,
  positiveColor = CHART_GREEN,
  negativeColor = CHART_RED,
  ariaLabel,
  srSummary,
  className,
}: RowSparklineProps) {
  const reactId = useId();
  const plotXValues =
    xValues?.length === data.length && xValues.every((value) => Number.isFinite(value)) ? xValues : undefined;
  const prepared = useMemo(() => prepare(data, plotXValues), [data, plotXValues]);

  if (prepared.length < minPoints) {
    return emptyContent !== undefined ? emptyContent : (
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

  const values = prepared.map((p) => p.v);
  const maxAbs = Math.max(...values.map((value) => Math.abs(value - ref)));
  const signedRange = maxAbs <= 0 ? 1 : maxAbs;
  const yMin = signed ? ref - signedRange : Math.min(...values);
  const yMax = signed ? ref + signedRange : Math.max(...values);

  const xStart = plotXValues?.[0] ?? 0;
  const xEnd = plotXValues?.[plotXValues.length - 1] ?? data.length - 1;
  const xSpan = Math.max(xEnd - xStart, 1);
  const project = (p: PreparedPoint) => pointToCoords(
    p, xStart, xSpan, yMin, yMax, width, height, inset, yRangeMode,
  );
  const baselineProjected = project({ i: 0, v: signed ? ref : yMin, x: xStart }).y;
  const referenceProjected = referenceValue === undefined ? null : project({ i: 0, v: referenceValue, x: xStart }).y;

  const titleId = decorative ? undefined : `${reactId}-title`;
  const descId = !decorative && srSummary ? `${reactId}-desc` : undefined;
  const gradientFill = typeof fillStyle === "object" ? fillStyle : null;
  const renderSegment = (segment: Segment, key: string, color: string) => {
    if (segment.points.length < 2) return null;
    const lineProps = {
      fill: "none",
      stroke: color,
      strokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      vectorEffect: nonScalingStroke ? "non-scaling-stroke" : undefined,
    } as const;
    const line = decorative || !fill ? (
      <polyline {...lineProps} points={buildLinePoints(segment, project, pointPrecision)} />
    ) : (
      <path {...lineProps} d={buildLinePath(segment, project, pointPrecision)} />
    );
    return (
      <g key={key}>
        {fill && gradientFill ? (
          <polygon
            points={`${buildLinePoints(segment, project, pointPrecision)} ${width},${gradientFill.baselineY} 0,${gradientFill.baselineY}`}
            fill={`url(#${gradientFill.id})`}
            stroke="none"
          />
        ) : fill ? (
          <path
            d={buildAreaPath(segment, project, baselineProjected, pointPrecision)}
            fill={color}
            fillOpacity={FILL_OPACITY}
            stroke="none"
          />
        ) : null}
        {line}
      </g>
    );
  };

  return (
    <svg
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={!decorative && xValues ? ariaLabel : undefined}
      aria-labelledby={titleId ? `${titleId}${descId ? ` ${descId}` : ""}` : undefined}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("inline-block align-middle", className)}
    >
      {titleId ? <title id={titleId}>{ariaLabel}</title> : null}
      {descId ? <desc id={descId}>{srSummary}</desc> : null}
      {fill && gradientFill ? (
        <defs>
          <linearGradient id={gradientFill.id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={positiveColor} stopOpacity={gradientFill.startOpacity} />
            <stop offset="100%" stopColor={positiveColor} stopOpacity={gradientFill.endOpacity} />
          </linearGradient>
        </defs>
      ) : null}
      {referenceProjected !== null ? (
        <line
          x1={inset.left}
          x2={width - inset.right}
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
            return subs.map((sub, idx) => renderSegment(
              { points: sub.points },
              `s${sIdx}-${idx}`,
              sub.sign === "pos" ? positiveColor : sub.sign === "neg" ? negativeColor : CHART_SLATE,
            ));
          })
        : segments.map((segment, sIdx) => renderSegment(segment, `u${sIdx}`, positiveColor))}
    </svg>
  );
}
