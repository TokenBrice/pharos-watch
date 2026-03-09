"use client";

import { Radar, RadarChart as RechartsRadarChart, PolarGrid, PolarAngleAxis } from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import type { ReportCard } from "@shared/types";
import {
  DIMENSION_LABELS,
  DIMENSION_SHORT_LABELS,
  DIMENSION_ORDER,
  gradeRange,
  GRADE_RADAR_COLORS,
} from "@shared/lib/report-cards";

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

export function ReportCardRadar({ card, size, labels = "full" }: ReportCardRadarProps) {
  const data = buildRadarData(card, labels);
  const color = GRADE_RADAR_COLORS[gradeRange(card.overallGrade)] ?? GRADE_RADAR_COLORS.NR;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const compact = labels === "short";

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
          outerRadius={compact ? "70%" : "80%"}
        >
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: compact ? 10 : 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          <Radar dataKey="score" stroke={color} fill={color} fillOpacity={0.25} strokeWidth={2} />
        </RechartsRadarChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompareRadar -- multiple coins overlaid
// ---------------------------------------------------------------------------

interface CompareRadarProps {
  cards: { card: ReportCard; color: string }[];
  size?: number;
}

export function CompareRadar({ cards, size = 300 }: CompareRadarProps) {
  // Build a merged dataset: each entry has dimension + one score key per card
  const data = DIMENSION_ORDER.map((key) => {
    const entry: Record<string, string | number> = {
      dimension: DIMENSION_LABELS[key],
      fullMark: 100,
    };
    for (const { card } of cards) {
      entry[card.id] = card.dimensions[key].score ?? 0;
    }
    return entry;
  });
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

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
          {cards.map(({ card, color }) => (
            <Radar key={card.id} dataKey={card.id} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />
          ))}
        </RechartsRadarChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
    </div>
  );
}
