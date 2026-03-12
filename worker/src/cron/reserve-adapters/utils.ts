import type { LiveReserveInput, LiveReservesConfig, ReserveSlice } from "@shared/types";

export function requireHttpJsonInput(
  config: LiveReservesConfig,
  adapterName: string,
): Extract<LiveReserveInput, { kind: "http-json" }> {
  const primaryInput = config.inputs.primary;
  if (primaryInput.kind !== "http-json") {
    throw new Error(`${adapterName} adapter requires an http-json primary input`);
  }
  return primaryInput;
}

interface SliceAmount extends Omit<ReserveSlice, "pct"> {
  value: number;
}

export function buildReserveSlicesFromValues(
  entries: SliceAmount[],
  decimals = 1,
): ReserveSlice[] {
  const validEntries = entries.filter((entry) => Number.isFinite(entry.value) && entry.value > 0);
  if (validEntries.length === 0) return [];

  const total = validEntries.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return [];

  const factor = 10 ** decimals;
  const slices = validEntries.map(({ value, ...slice }) => ({
    ...slice,
    pct: Math.round(((value / total) * 100) * factor) / factor,
  }));

  const roundedTotal = slices.reduce((sum, slice) => sum + slice.pct, 0);
  const adjustment = Math.round((100 - roundedTotal) * factor) / factor;
  if (adjustment !== 0 && slices.length > 0) {
    const largestIndex = slices.reduce(
      (maxIndex, slice, index, arr) => (slice.pct > arr[maxIndex].pct ? index : maxIndex),
      0,
    );
    const nextPct = Math.round((slices[largestIndex].pct + adjustment) * factor) / factor;
    if (nextPct > 0) {
      slices[largestIndex].pct = nextPct;
    }
  }

  return slices;
}
