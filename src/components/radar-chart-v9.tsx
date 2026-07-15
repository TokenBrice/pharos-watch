"use client";

import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from "recharts";
import type { SafetyScorePublicationIdentity, SafetyScoreV9Card } from "@shared/types";
import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import { median } from "@shared/lib/stats";
import { ChartDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import {
  safetyScoreV9IdentitiesMatch,
  type V9ConsumerIdentity,
  type V9ConsumerResult,
} from "@/lib/safety-score-v9-consumers";

const V9_PILLARS = ["backing", "exit", "control"] as const;
type V9Pillar = (typeof V9_PILLARS)[number];

const V9_PILLAR_LABELS: Record<V9Pillar, string> = {
  backing: "Backing",
  exit: "Exit",
  control: "Control",
};

export interface V9RadarSeries {
  card: SafetyScoreV9Card;
  identity: SafetyScorePublicationIdentity;
  color: string;
}

export interface V9RadarDataset {
  identity: V9ConsumerIdentity;
  rows: Array<Record<string, string | number>>;
  cohortMedians: Record<V9Pillar, number> | null;
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
  if (
    series.some((entry) => V9_PILLARS.some((pillar) => entry.card.pillars[pillar].score === null))
  ) {
    return { status: "unavailable", reason: "card-unavailable" };
  }

  const cohortMedians = cohortSeries.length < 3
    ? null
    : Object.fromEntries(
        V9_PILLARS.map((pillar) => [
          pillar,
          median(
            cohortSeries.flatMap((entry) => {
              const score = entry.card.pillars[pillar].score;
              return score === null ? [] : [score];
            }),
          ),
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
        fullMark: 100,
        ...Object.fromEntries(series.map((entry) => [entry.card.id, entry.card.pillars[pillar].score ?? 0])),
        ...(completeMedians ? { __cohortMedian: completeMedians[pillar] } : {}),
      })),
      cohortMedians: completeMedians,
    },
  };
}

export function CompareV9Radar({ series, cohortSeries, size = 300 }: {
  series: readonly V9RadarSeries[];
  cohortSeries?: readonly V9RadarSeries[];
  size?: number;
}) {
  const dataset = buildV9RadarDataset(series, cohortSeries);
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  if (dataset.status === "unavailable") {
    return <p role="alert" className="text-sm text-muted-foreground">V9 radar unavailable: {dataset.reason}</p>;
  }

  const tableColumns: ChartDataTableColumn<Record<string, string | number>>[] = [
    { id: "pillar", label: "Pillar", format: (row) => String(row.pillar) },
    ...series.map(({ card }) => ({
      id: card.id,
      label: card.id,
      format: (row: Record<string, string | number>) => `${Number(row[card.id]).toFixed(0)} / 100`,
    })),
    ...(dataset.value.cohortMedians
      ? [{
          id: "__cohortMedian",
          label: "Cohort median",
          format: (row: Record<string, string | number>) => `${Number(row.__cohortMedian).toFixed(0)} / 100`,
        }]
      : []),
  ];

  return (
    <div
      ref={ref}
      className="w-full"
      style={{ height: size }}
      role="figure"
      aria-label={`V9 safety pillar comparison for ${series.map(({ card }) => card.id).join(", ")}`}
      data-safety-model="v9"
    >
      {ready ? (
        <RadarChart width={width} height={height} data={dataset.value.rows} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="pillar"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
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
            <Radar
              key={card.id}
              dataKey={card.id}
              stroke={color || GRADE_RADAR_COLORS[gradeRange(card.grade)]}
              fill={color || GRADE_RADAR_COLORS[gradeRange(card.grade)]}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </RadarChart>
      ) : <ChartSkeleton className="h-full w-full" />}
      <ChartDataTable
        caption={`V9 safety pillar comparison across ${series.length} assets`}
        data={dataset.value.rows}
        columns={tableColumns}
      />
    </div>
  );
}
