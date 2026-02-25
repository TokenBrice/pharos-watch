"use client";

import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";
import type { ReportCard, DimensionKey } from "@/lib/types";
import { DIMENSION_LABELS, DIMENSION_SHORT_LABELS, DIMENSION_ORDER, gradeRange, GRADE_RADAR_COLORS } from "@/lib/report-cards";

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
  className?: string;
}

export function ReportCardRadar({
  card,
  size = 250,
  labels = "full",
  className,
}: ReportCardRadarProps) {
  const data = buildRadarData(card, labels);
  const color = GRADE_RADAR_COLORS[gradeRange(card.overallGrade)] ?? GRADE_RADAR_COLORS.NR;

  return (
    <div className={`w-full ${className ?? ""}`} style={{ height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          <Radar
            dataKey="score"
            stroke={color}
            fill={color}
            fillOpacity={0.25}
            strokeWidth={2}
          />
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompareRadar -- multiple coins overlaid
// ---------------------------------------------------------------------------

interface CompareRadarProps {
  cards: { card: ReportCard; color: string }[];
  size?: number;
  className?: string;
}

export function CompareRadar({ cards, size = 300, className }: CompareRadarProps) {
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

  return (
    <div className={`w-full ${className ?? ""}`} style={{ height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          {cards.map(({ card, color }) => (
            <Radar
              key={card.id}
              dataKey={card.id}
              stroke={color}
              fill={color}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
