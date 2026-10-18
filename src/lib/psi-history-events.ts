import { PSI_HEX_COLORS } from "@shared/lib/classification";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import type { PsiEvent } from "@shared/lib/psi-events";

export const BAND_ZONES = PSI_CONDITION_BANDS.map(({ min, band }, index) => ({
  y1: min,
  y2: index === 0 ? 100 : PSI_CONDITION_BANDS[index - 1].min,
  color: PSI_HEX_COLORS[band],
  label: band,
}));

export type PsiEventLabelPosition = "top" | "insideBottom";
export type PsiVisibleEvent = PsiEvent & { hideLabel: boolean; position: PsiEventLabelPosition };

const PSI_EVENT_LABEL_POSITIONS: readonly PsiEventLabelPosition[] = ["top", "insideBottom"] as const;
const DEFAULT_HIDE_THRESHOLD_RATIO = 0.05;

// Label positions are assigned by interleaving events across the available
// slots (index modulo position count): consecutive events alternate top /
// insideBottom so adjacent labels don't overlap. Adding events therefore shifts
// every subsequent event's slot — that interleaving is intentional. Because the
// modulo of a non-empty positions array is always in bounds, the indexed value
// is guaranteed defined; the assertion below makes that explicit and removes the
// previously unreachable `?? "top"` fallback.
function getPsiEventLabelPosition(index: number): PsiEventLabelPosition {
  const position = PSI_EVENT_LABEL_POSITIONS[index % PSI_EVENT_LABEL_POSITIONS.length];
  if (position === undefined) {
    throw new Error("PSI_EVENT_LABEL_POSITIONS must not be empty");
  }
  return position;
}

export function buildVisiblePsiChartEvents(
  events: readonly PsiEvent[],
  min?: number,
  max?: number,
  thresholdRatio = DEFAULT_HIDE_THRESHOLD_RATIO,
): PsiVisibleEvent[] {
  const orderedEvents = [...events].sort((a, b) => a.date - b.date);
  const visibleEvents = min === undefined || max === undefined
    ? orderedEvents
    : orderedEvents.filter((event) => event.date <= max && (event.dateEnd ?? event.date) >= min);
  const rangeMs = min === undefined || max === undefined ? 0 : max - min;
  const threshold = rangeMs * thresholdRatio;
  const lastShownEndByPosition: Partial<Record<PsiEventLabelPosition, number>> = {};

  return visibleEvents.map((event, index) => {
    const position = getPsiEventLabelPosition(index);
    const lastEnd = lastShownEndByPosition[position] ?? -Infinity;
    const hideLabel = event.date - lastEnd < threshold;

    if (!hideLabel) {
      lastShownEndByPosition[position] = event.dateEnd ?? event.date;
    }

    return {
      ...event,
      hideLabel,
      position,
    };
  });
}
