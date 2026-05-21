"use client";

import { Radar, RadarChart as RechartsRadarChart, PolarGrid, PolarAngleAxis } from "recharts";
import { ChartDataTable, type ChartDataTableColumn } from "@/components/chart-primitives";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import type { DimensionKey, ReportCard } from "@shared/types";
import {
  DIMENSION_LABELS,
  DIMENSION_SHORT_LABELS,
  DIMENSION_ORDER,
  gradeRange,
  GRADE_RADAR_COLORS,
} from "@shared/lib/report-cards";

// ---------------------------------------------------------------------------
// Cohort median helpers (D10)
// ---------------------------------------------------------------------------

export type CompareRadarCohort = "peg" | "mechanism" | "all";

const COHORT_MIN_MEMBERS = 3;

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeCohortMedians(cards: readonly ReportCard[]): Record<DimensionKey, number> | null {
  if (cards.length < COHORT_MIN_MEMBERS) return null;
  const medians = {} as Record<DimensionKey, number>;
  for (const key of DIMENSION_ORDER) {
    const values: number[] = [];
    for (const card of cards) {
      const score = card.dimensions[key].score;
      if (score != null && Number.isFinite(score)) values.push(score);
    }
    const median = computeMedian(values);
    if (median == null) return null;
    medians[key] = median;
  }
  return medians;
}

export interface CohortBaseline {
  /** Cohort that was actually applied (after fallback to "all" if needed). */
  effectiveCohort: CompareRadarCohort;
  /** Per-dimension median for the resolved cohort; null when too thin to compute. */
  medians: Record<DimensionKey, number> | null;
  /** Number of report cards in the resolved cohort. */
  memberCount: number;
}

export function resolveCohortBaseline(
  cohort: CompareRadarCohort,
  allCards: readonly ReportCard[],
  cohortCards: readonly ReportCard[],
): CohortBaseline {
  if (cohort === "all" || cohortCards.length < COHORT_MIN_MEMBERS) {
    return {
      effectiveCohort: "all",
      medians: computeCohortMedians(allCards),
      memberCount: allCards.length,
    };
  }
  return {
    effectiveCohort: cohort,
    medians: computeCohortMedians(cohortCards),
    memberCount: cohortCards.length,
  };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function buildRadarData(card: ReportCard, labels: "full" | "short" | "none") {
  const labelMap = labels === "full" ? DIMENSION_LABELS : labels === "short" ? DIMENSION_SHORT_LABELS : null;
  return DIMENSION_ORDER.map((key) => ({
    dimension: labelMap ? labelMap[key] : key,
    score: card.dimensions[key].score ?? 0,
    fullMark: 100,
  }));
}

// ---------------------------------------------------------------------------
// ReportCardRadar -- single coin
// ---------------------------------------------------------------------------

interface ReportCardRadarProps {
  card: ReportCard;
  size?: number;
  labels?: "full" | "short" | "none";
}

const RADAR_TABLE_COLUMNS: ChartDataTableColumn<{ dimension: string; score: number }>[] = [
  { id: "dimension", label: "Dimension", format: (row) => row.dimension },
  { id: "score", label: "Score", format: (row) => `${row.score.toFixed(0)} / 100` },
];

export function ReportCardRadar({ card, size, labels = "full" }: ReportCardRadarProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const autoCompact = labels === "full" && width > 0 && width < 420;
  const shortLabels = labels === "short";
  const compact = shortLabels || autoCompact;
  const effectiveLabels = labels === "none" ? "none" : compact ? "short" : labels;
  const data = buildRadarData(card, effectiveLabels);
  const tableData = buildRadarData(card, "full");
  const color = GRADE_RADAR_COLORS[gradeRange(card.overallGrade)] ?? GRADE_RADAR_COLORS.NR;
  const outerRadius = shortLabels ? "72%" : autoCompact ? "60%" : "80%";
  const tickFontSize = shortLabels ? 10 : autoCompact ? 9 : 11;

  return (
    <div
      ref={chartContainerRef}
      className="w-full"
      style={size !== undefined ? { height: size } : { height: "100%" }}
      role="figure"
      aria-label={`Safety score radar chart for ${card.symbol}`}
    >
      {isChartReady ? (
        <RechartsRadarChart
          width={width}
          height={height}
          data={data}
          cx="50%"
          cy="50%"
          outerRadius={outerRadius}
        >
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: tickFontSize, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          <Radar dataKey="score" stroke={color} fill={color} fillOpacity={0.25} strokeWidth={2} />
        </RechartsRadarChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
      <ChartDataTable
        caption={`Safety score radar values for ${card.symbol}: ${DIMENSION_ORDER.length} dimensions`}
        data={tableData}
        columns={RADAR_TABLE_COLUMNS}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompareRadar -- multiple coins overlaid
// ---------------------------------------------------------------------------

interface CompareRadarProps {
  cards: { card: ReportCard; color: string }[];
  size?: number;
  /**
   * Optional cohort medians for a faint dashed reference polygon. When omitted
   * or null no baseline is drawn. Compute via `resolveCohortBaseline`.
   */
  cohortMedians?: Record<DimensionKey, number> | null;
}

const COHORT_BASELINE_KEY = "__cohortBaseline";

export function CompareRadar({ cards, size = 300, cohortMedians }: CompareRadarProps) {
  // Build a merged dataset: each entry has dimension + one score key per card
  const data = DIMENSION_ORDER.map((key) => {
    const entry: Record<string, string | number> = {
      dimension: DIMENSION_LABELS[key],
      fullMark: 100,
    };
    for (const { card } of cards) {
      entry[card.id] = card.dimensions[key].score ?? 0;
    }
    if (cohortMedians) {
      entry[COHORT_BASELINE_KEY] = cohortMedians[key];
    }
    return entry;
  });
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const compareTableColumns: ChartDataTableColumn<Record<string, string | number>>[] = buildCompareTableColumns(
    cards,
    Boolean(cohortMedians),
  );

  return (
    <div
      ref={chartContainerRef}
      className="w-full"
      style={{ height: size }}
      role="figure"
      aria-label={`Safety score comparison for ${cards.map(({ card }) => card.symbol).join(", ")}`}
    >
      {isChartReady ? (
        <RechartsRadarChart width={width} height={height} data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          {cohortMedians ? (
            <Radar
              key={COHORT_BASELINE_KEY}
              dataKey={COHORT_BASELINE_KEY}
              stroke="currentColor"
              strokeOpacity={0.45}
              strokeDasharray="4 3"
              strokeWidth={1}
              fill="none"
              isAnimationActive={false}
              className="text-muted-foreground"
            />
          ) : null}
          {cards.map(({ card, color }) => (
            <Radar key={card.id} dataKey={card.id} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />
          ))}
        </RechartsRadarChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
      <ChartDataTable
        caption={`Safety score comparison across ${cards.length} stablecoin${cards.length === 1 ? "" : "s"}: ${cards.map(({ card }) => card.symbol).join(", ")}`}
        data={data}
        columns={compareTableColumns}
      />
    </div>
  );
}

function buildCompareTableColumns(
  cards: { card: ReportCard; color: string }[],
  hasCohort: boolean,
): ChartDataTableColumn<Record<string, string | number>>[] {
  const cols: ChartDataTableColumn<Record<string, string | number>>[] = [
    { id: "dimension", label: "Dimension", format: (row) => String(row.dimension) },
  ];
  for (const { card } of cards) {
    cols.push({
      id: card.id,
      label: card.symbol,
      format: (row) => {
        const v = row[card.id];
        return typeof v === "number" ? `${v.toFixed(0)} / 100` : "—";
      },
    });
  }
  if (hasCohort) {
    cols.push({
      id: COHORT_BASELINE_KEY,
      label: "Cohort median",
      format: (row) => {
        const v = row[COHORT_BASELINE_KEY];
        return typeof v === "number" ? `${v.toFixed(0)} / 100` : "—";
      },
    });
  }
  return cols;
}
