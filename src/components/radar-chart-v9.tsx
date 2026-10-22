"use client";

import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart as RechartsRadarChart } from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import type { SafetyScorePublicationIdentity } from "@shared/types";
import type { ReportCardsV9TableCard } from "@shared/types/report-cards-v9-projections";
import { median } from "@shared/lib/stats";
import { formatPricedUnknown } from "@/lib/safety-score-reason-labels";
import {
  hasCompleteV9RadarPillars,
  hasPlottableV9RadarPillars,
  readV9PricedUnknown,
  safetyScoreV9IdentitiesMatch,
  type V9ConsumerIdentity,
  type V9ConsumerResult,
  type V9PricedUnknownSource,
} from "@/lib/safety-score-v9-consumers";

const V9_PILLARS = ["backing", "exit", "control"] as const;
type V9Pillar = (typeof V9_PILLARS)[number];
export type CompareRadarCohort = "peg" | "mechanism" | "all";

const V9_PILLAR_LABELS: Record<V9Pillar, string> = {
  backing: "Backing",
  exit: "Exit",
  control: "Control",
};

const COMPACT_RADAR_BREAKPOINT = 280;
const NARROW_RADAR_BREAKPOINT = 160;

export interface V9RadarSeries {
  card: Pick<ReportCardsV9TableCard, "id" | "ratingStatus" | "partialEvidence" | "pillars"> & Pick<V9PricedUnknownSource, "scoreTrace">;
  identity: SafetyScorePublicationIdentity;
  color: string;
  /** Reader name for multi-series notes; falls back to the card id. */
  symbol?: string;
}

/** A pillar some series could not measure: drawn as an "Unknown" axis, never as a point. */
export interface V9RadarUnknownAxis {
  seriesIds: string[];
  /** Names of the series missing this pillar when others measure it; empty when every series lacks it. */
  missingNames: string[];
  /** Scoring assumptions behind the gap, for the axis tooltip; never plotted. */
  assumptions: string[];
}

export interface V9RadarDataset {
  identity: V9ConsumerIdentity;
  rows: Array<Record<string, string | number | null>>;
  cohortMedians: Record<V9Pillar, number> | null;
  unknownAxes: Partial<Record<string, V9RadarUnknownAxis>>;
}

export function buildV9RadarDataset(
  series: readonly V9RadarSeries[],
  cohortSeries: readonly V9RadarSeries[] = series,
): V9ConsumerResult<V9RadarDataset> {
  const anchor = series[0]?.identity;
  if (!anchor || anchor.model !== "v9") return { status: "unavailable", reason: "invalid-v9-response" };
  const combined = [...series, ...cohortSeries];
  if (combined.some((entry) => !safetyScoreV9IdentitiesMatch(anchor, entry.identity))) {
    return { status: "unavailable", reason: "identity-mismatch" };
  }
  if (series.some((entry) => !hasPlottableV9RadarPillars(entry.card))) {
    return { status: "unavailable", reason: "card-unavailable" };
  }
  const unknownAxes: Partial<Record<string, V9RadarUnknownAxis>> = {};
  for (const pillar of V9_PILLARS) {
    const missing = series.filter((entry) => !Number.isFinite(entry.card.pillars[pillar].score));
    if (missing.length === 0) continue;
    const partialAxis = missing.length < series.length;
    const names = new Map(series.map((entry) => [entry.card.id, entry.symbol ?? entry.card.id]));
    unknownAxes[V9_PILLAR_LABELS[pillar]] = {
      seriesIds: missing.map((entry) => entry.card.id),
      missingNames: partialAxis ? missing.map((entry) => names.get(entry.card.id)!) : [],
      assumptions: missing.flatMap((entry) => {
        const priced = readV9PricedUnknown(entry.card, pillar);
        return priced === null ? [] : [`${series.length > 1 ? `${names.get(entry.card.id)}: ` : ""}${formatPricedUnknown(priced)}`];
      }),
    };
  }

  const usableCohort = cohortSeries.filter((entry) => hasCompleteV9RadarPillars(entry.card));
  const cohortMedians = usableCohort.length < 3
    ? null
    : Object.fromEntries(
        V9_PILLARS.map((pillar) => [
          pillar,
          median(usableCohort.map((entry) => entry.card.pillars[pillar].score!)),
        ]),
      ) as Record<V9Pillar, number | null>;

  const completeMedians = cohortMedians && Object.values(cohortMedians).every((score) => score !== null)
    ? cohortMedians as Record<V9Pillar, number>
    : null;

  return {
    status: "available",
    identity: anchor,
    value: {
      identity: anchor,
      rows: V9_PILLARS.map((pillar) => ({
        pillar: V9_PILLAR_LABELS[pillar],
        ...Object.fromEntries(series.map((entry) => [entry.card.id, entry.card.pillars[pillar].score])),
        ...(completeMedians ? { __cohortMedian: completeMedians[pillar] } : {}),
      })),
      cohortMedians: completeMedians,
      unknownAxes,
    },
  };
}

interface RadarShapePoint { x: number; y: number; cx: number; cy: number; value: unknown; name?: unknown }

/** Spokes drawn per axis so an unknown pillar reads as a dashed, muted axis. */
function renderAxisSpokes(unknownAxes: V9RadarDataset["unknownAxes"]) {
  function AxisSpokes({ points }: { points?: readonly RadarShapePoint[] }) {
    return (
      <g className="text-border" aria-hidden="true">
        {(points ?? []).map((point) => {
          // Dashed only when no series measures the axis; a pillar one coin
          // lacks stays a solid axis for the coins that measure it.
          const unknown = unknownAxes[String(point.name)]?.missingNames.length === 0;
          return (
            <line
              key={String(point.name)}
              x1={point.cx} y1={point.cy} x2={point.x} y2={point.y}
              stroke="currentColor"
              strokeDasharray={unknown ? "3 3" : undefined}
              className={unknown ? "text-muted-foreground" : undefined}
              strokeOpacity={unknown ? 0.7 : 1}
            />
          );
        })}
      </g>
    );
  }
  return AxisSpokes;
}

/** Measured points only: open segments between adjacent measured axes, no fill, no imputed vertex. */
function renderMeasuredShape(color: string) {
  function MeasuredShape({ points }: { points?: readonly RadarShapePoint[] }) {
    const all = points ?? [];
    const measured = (point: RadarShapePoint | undefined) => point !== undefined && typeof point.value === "number" && Number.isFinite(point.value);
    const segments = all.flatMap((point, index) => {
      const next = all[(index + 1) % all.length];
      return measured(point) && measured(next) && next !== point ? [[point, next!] as const] : [];
    });
    return (
      <g>
        {segments.map(([from, to]) => (
          <line key={`${String(from.name)}-${String(to.name)}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={2} strokeLinecap="round" />
        ))}
        {all.filter(measured).map((point) => (
          <circle key={String(point.name)} cx={point.x} cy={point.y} r={3} fill={color} />
        ))}
      </g>
    );
  }
  return MeasuredShape;
}

function UnknownAwareTick({ x, y, textAnchor, payload, unknownAxes }: {
  x?: number; y?: number; textAnchor?: "start" | "middle" | "end" | "inherit"; payload?: { value?: unknown };
  unknownAxes: V9RadarDataset["unknownAxes"];
}) {
  const label = String(payload?.value ?? "");
  const unknown = unknownAxes[label];
  if (unknown === undefined) {
    return <text x={x} y={y} textAnchor={textAnchor} fontSize={11} fill="currentColor" dy="0.35em">{label}</text>;
  }
  const anchor = textAnchor ?? "middle";
  const note = unknown.missingNames.length === 0 ? "Unknown" : `Unknown for ${unknown.missingNames.join(", ")}`;
  const title = `${label}: ${note.toLowerCase()}, not plotted${unknown.assumptions.length > 0 ? ` (${unknown.assumptions.join("; ")})` : ""}`;
  if (anchor === "middle") {
    // The top axis keeps one line so the note never sits on the polygon apex.
    return (
      <text x={x} y={y} textAnchor="middle" fontSize={11} fill="currentColor" dy="0.35em">
        <title>{title}</title>
        {label}
        <tspan dx={4} fontSize={10} fontStyle="italic">{note}</tspan>
      </text>
    );
  }
  // Side axes stack the note under the label, aligned to the label's inner
  // edge so it grows toward the chart instead of past the card edge.
  const labelWidth = label.length * 6.2;
  const noteX = (x ?? 0) + (anchor === "start" ? labelWidth : -labelWidth);
  return (
    <g>
      <title>{title}</title>
      <text x={x} y={y} textAnchor={anchor} fontSize={11} fill="currentColor" dy="-0.2em">{label}</text>
      <text x={noteX} y={y} textAnchor={anchor === "start" ? "end" : "start"} fontSize={10} fontStyle="italic" fill="currentColor" dy="1.15em">{note}</text>
    </g>
  );
}

export function CompareRadarV9({
  series,
  cohortSeries = series,
  size = 300,
}: {
  series: readonly V9RadarSeries[];
  cohortSeries?: readonly V9RadarSeries[];
  size?: number;
}) {
  const dataset = buildV9RadarDataset(series, cohortSeries);
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  if (dataset.status === "unavailable") {
    return (
      <div
        className="flex w-full items-center justify-center text-sm text-muted-foreground"
        style={{ height: size }}
        role="alert"
      >
        {series.some((entry) => entry.card.ratingStatus === "pipeline-gap")
          ? "Pipeline gap — pillar radar unavailable." : "V10 safety comparison unavailable."}
      </div>
    );
  }

  const compact = width > 0 && width < COMPACT_RADAR_BREAKPOINT;
  const narrow = width > 0 && width < NARROW_RADAR_BREAKPOINT;
  const compactOuterRadius = Math.min(width * (narrow ? 0.3 : 0.32), height * 0.39);
  const { unknownAxes } = dataset.value;
  const hasUnknownAxis = Object.keys(unknownAxes).length > 0;
  const rows = hasUnknownAxis ? dataset.value.rows.map((row) => ({ ...row, __axis: 100 })) : dataset.value.rows;

  return (
    <div
      ref={ref}
      className="w-full"
      style={{ height: size }}
      role="figure"
      aria-label={`V10 safety score pillar comparison${Object.entries(unknownAxes).map(([pillar, axis]) =>
        `. ${pillar} ${axis!.missingNames.length === 0 ? "unknown" : `unknown for ${axis!.missingNames.join(", ")}`}, not plotted`).join("")}`}
    >
      {ready ? (
        <RechartsRadarChart
          style={{ overflow: "visible" }}
          width={width}
          height={height}
          data={rows}
          cx={narrow ? "57%" : compact ? "56%" : "50%"}
          cy={compact ? "52%" : "50%"}
          outerRadius={compact ? compactOuterRadius : "75%"}
        >
          <PolarGrid stroke="currentColor" className="text-border" radialLines={!hasUnknownAxis} />
          <PolarRadiusAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <PolarAngleAxis
            dataKey="pillar"
            tickSize={narrow ? 4 : compact ? 5 : 8}
            tick={hasUnknownAxis
              ? (props: object) => <UnknownAwareTick {...props} unknownAxes={unknownAxes} />
              : { fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          {hasUnknownAxis ? (
            <Radar dataKey="__axis" stroke="none" fill="none" isAnimationActive={false} shape={renderAxisSpokes(unknownAxes)} />
          ) : null}
          {dataset.value.cohortMedians ? (
            <Radar
              dataKey="__cohortMedian"
              stroke="currentColor"
              strokeOpacity={0.45}
              strokeDasharray="4 3"
              strokeWidth={1}
              fill="none"
              isAnimationActive={false}
              className="text-muted-foreground"
            />
          ) : null}
          {series.map(({ card, color }) => (
            V9_PILLARS.every((pillar) => Number.isFinite(card.pillars[pillar].score))
              ? <Radar key={card.id} dataKey={card.id} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
              : <Radar key={card.id} dataKey={card.id} stroke="none" fill="none" isAnimationActive={false} shape={renderMeasuredShape(color)} />
          ))}
        </RechartsRadarChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
    </div>
  );
}
