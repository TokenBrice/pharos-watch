"use client";

import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

/** Hover or active-peg cohort membership: hairlines from the focal coin to its same-peg siblings, in the peg's hue. */
export function CohortThreads({ coins }: { coins: readonly PlacedCoin[] }) {
  const { hoveredCoinId, hoveredPeg, selectedPeg } = useHoverState();
  const activePeg = hoveredPeg ?? selectedPeg;
  if (!activePeg) return null;
  const origin = hoveredCoinId
    ? coins.find((c) => c.id === hoveredCoinId)
    : coins.find((c) => c.pegCurrency === activePeg);
  if (!origin) return null;
  const siblings = coins.filter(
    (c) => c.pegCurrency === activePeg && c.id !== origin.id,
  );
  if (siblings.length === 0) return null;
  const colorHex = PEG_CHART_COLORS[activePeg]?.hex ?? PEG_CHART_COLORS.OTHER.hex;

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
