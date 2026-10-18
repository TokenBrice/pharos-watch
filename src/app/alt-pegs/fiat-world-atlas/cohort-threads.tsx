"use client";

import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

/** Hover-only cohort membership: hairlines from the hovered coin to its same-peg siblings, in the peg's hue. */
export function CohortThreads({ coins }: { coins: readonly PlacedCoin[] }) {
  const { hoveredCoinId, hoveredPeg } = useHoverState();
  if (!hoveredCoinId || !hoveredPeg) return null;
  const origin = coins.find((c) => c.id === hoveredCoinId);
  if (!origin) return null;
  const siblings = coins.filter(
    (c) => c.pegCurrency === hoveredPeg && c.id !== hoveredCoinId,
  );
  if (siblings.length === 0) return null;
  const colorHex = PEG_CHART_COLORS[hoveredPeg]?.hex ?? PEG_CHART_COLORS.OTHER.hex;

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
          strokeOpacity={0.7}
          strokeWidth={0.6}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
