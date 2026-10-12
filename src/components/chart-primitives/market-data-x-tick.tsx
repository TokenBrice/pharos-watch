"use client";

import { formatChartDate } from "@shared/lib/format";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { CHART_TICK_FILL, CHART_TICK_FONT_FAMILY, CHART_TICK_FONT_SIZE } from "@/lib/chart-theme";

export function MarketDataXTick({
  x,
  y,
  payload,
  range,
}: {
  x?: number;
  y?: number;
  payload?: { value: number };
  range: TimeRangeOption;
}) {
  if (x === undefined || y === undefined || !payload) return null;
  const date = new Date(payload.value);
  const isJanuary = date.getUTCMonth() === 0;

  if (range === "all") {
    const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={12}
          textAnchor="middle"
          fontSize={CHART_TICK_FONT_SIZE}
          fontFamily={CHART_TICK_FONT_FAMILY}
          fill={isJanuary ? "var(--color-foreground)" : CHART_TICK_FILL}
          fontWeight={isJanuary ? 600 : 400}
        >
          {month}
        </text>
        {isJanuary ? (
          <text
            x={0}
            y={0}
            dy={23}
            textAnchor="middle"
            fontSize={CHART_TICK_FONT_SIZE}
            fontFamily={CHART_TICK_FONT_FAMILY}
            fill={CHART_TICK_FILL}
          >
            {date.getUTCFullYear()}
          </text>
        ) : null}
      </g>
    );
  }

  const label =
    range === "7d" || range === "30d"
      ? formatChartDate(payload.value, "short")
      : formatChartDate(payload.value, "compact");

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="middle"
        fontSize={CHART_TICK_FONT_SIZE}
        fontFamily={CHART_TICK_FONT_FAMILY}
        fill={CHART_TICK_FILL}
      >
        {label}
      </text>
    </g>
  );
}
