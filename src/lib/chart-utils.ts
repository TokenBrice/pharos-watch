import { DAY_MS } from "@/lib/constants";

/** Compute padded Y-axis domain for Recharts charts. */

export function computeChartYDomain(
  values: number[],
  isAllRange: boolean,
): [number, number | "auto"] {
  if (isAllRange || values.length === 0) return [0, "auto"];
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min;
  const padding = range > 0 ? range * 0.15 : max * 0.05;
  return [Math.max(0, min - padding), max + padding];
}

/** Merge multiple time series into a flat array keyed by timestamp. */
export function mergeSeriesByTimestamp<D extends { ts: number }>(
  series: { id: string; data: D[] }[],
  getValue: (d: D) => number,
): Record<string, number>[] {
  const tsMap = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const d of s.data) {
      let entry = tsMap.get(d.ts);
      if (!entry) { entry = { ts: d.ts }; tsMap.set(d.ts, entry); }
      entry[s.id] = getValue(d);
    }
  }
  return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
}

export function buildAdaptiveMonthlyTicks(first: number, last: number): number[] {
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return [];
  }

  const spanDays = (last - first) / DAY_MS;
  let step = 1;
  if (spanDays > 4 * 365) step = 6;
  else if (spanDays > 2 * 365) step = 3;
  else if (spanDays > 365) step = 2;

  // Ticks label a UTC data contract: building them from local calendar
  // arithmetic shifts a January tick into December for negative offsets.
  const ticks: number[] = [];
  const start = new Date(first);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  if (step > 1 && month !== 0) {
    year += 1;
    month = 0;
  }
  let tick = Date.UTC(year, month, 1);
  while (tick <= last) {
    ticks.push(tick);
    month += step;
    tick = Date.UTC(year, month, 1);
  }
  return ticks;
}
