import { useMemo, useState } from "react";

export type TimeRangeOption = "7d" | "30d" | "90d" | "1y" | "all";

const DEFAULT_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];

const RANGE_MS: Record<string, number> = {
  "7d": 7 * 86400000,
  "30d": 30 * 86400000,
  "90d": 90 * 86400000,
  "1y": 365 * 86400000,
};

export function useTimeRangeFilter<T>(
  data: T[],
  tsKey: keyof T,
  options: TimeRangeOption[] = DEFAULT_OPTIONS
) {
  const defaultRange = options[options.length - 1] ?? "all";
  const [range, setRange] = useState<TimeRangeOption>(defaultRange);

  const filteredData = useMemo(() => {
    if (range === "all" || data.length === 0) return data;
    const latest = (data[data.length - 1]?.[tsKey] as number) ?? 0;
    const cutoff = RANGE_MS[range];
    if (!cutoff) return data;
    return data.filter((d) => (d[tsKey] as number) >= latest - cutoff);
  }, [data, range, tsKey]);

  return { range, setRange, filteredData, options } as const;
}
