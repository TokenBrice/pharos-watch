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

  const ticks: number[] = [];
  const d = new Date(first);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  if (step > 1 && d.getMonth() !== 0) {
    d.setFullYear(d.getFullYear() + 1, 0, 1);
  }
  while (d.getTime() <= last) {
    ticks.push(d.getTime());
    d.setMonth(d.getMonth() + step);
  }
  return ticks;
}
