"use client";

import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

export function CohortThreads({
  coins,
  colorHex,
}: {
  coins: readonly PlacedCoin[];
  colorHex: string;
}) {
  const { hoveredCoinId, hoveredPeg } = useHoverState();
  if (!hoveredCoinId || !hoveredPeg) return null;
  const origin = coins.find((c) => c.id === hoveredCoinId);
  if (!origin) return null;
  const siblings = coins.filter(
    (c) => c.pegCurrency === hoveredPeg && c.id !== hoveredCoinId,
  );
  if (siblings.length === 0) return null;

  return (
    <svg
      className="cohort-threads"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {siblings.map((s) => (
        <line
          key={s.id}
          x1={origin.x}
          y1={origin.y}
          x2={s.x}
          y2={s.y}
          stroke={colorHex}
          strokeOpacity={0.55}
          strokeWidth={0.25}
          strokeDasharray="0.8 1.4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
