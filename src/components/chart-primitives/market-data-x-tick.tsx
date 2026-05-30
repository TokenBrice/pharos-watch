"use client";

import { formatChartDate } from "@shared/lib/format";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

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
  const isJanuary = date.getMonth() === 0;

  if (range === "all") {
    const month = date.toLocaleDateString("en-US", { month: "short" });
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={12}
          textAnchor="middle"
          fontSize={11}
          fontFamily="var(--font-mono, monospace)"
          fill={isJanuary ? "var(--color-foreground)" : "var(--color-muted-foreground)"}
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
            fontSize={10}
            fontFamily="var(--font-mono, monospace)"
            fill="var(--color-muted-foreground)"
          >
            {date.getFullYear()}
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
        fontSize={12}
        fontFamily="var(--font-mono, monospace)"
        fill="var(--color-muted-foreground)"
      >
        {label}
      </text>
    </g>
  );
}
