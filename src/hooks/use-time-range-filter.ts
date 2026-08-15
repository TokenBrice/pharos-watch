"use client";

import { useMemo, useState } from "react";
import type { TimeRangeOption } from "@/lib/chart-time-range";

export type { TimeRangeOption } from "@/lib/chart-time-range";

const DEFAULT_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];
const DEFAULT_RANGE: TimeRangeOption = "all";

const RANGE_MS: Record<string, number> = {
  "7d": 7 * 86400000,
  "30d": 30 * 86400000,
  "90d": 90 * 86400000,
  "1y": 365 * 86400000,
};

export function isTimeRangeOption(value: string): value is TimeRangeOption {
  return DEFAULT_OPTIONS.includes(value as TimeRangeOption);
}

interface UseTimeRangeFilterConfig {
  initialRange?: TimeRangeOption;
  /**
   * When provided, the hook is in controlled mode: filtering uses
   * `externalRange` instead of the internal state, and `setRange` is a no-op.
   * Used when a parent component (e.g. `MarketDataSection`) owns the range
   * state shared across multiple charts.
   */
  externalRange?: TimeRangeOption;
}

export function useTimeRangeFilter<T extends Record<K, number>, K extends keyof T>(
  data: T[],
  tsKey: K,
  options: TimeRangeOption[] = DEFAULT_OPTIONS,
  config: UseTimeRangeFilterConfig = {},
) {
  const fallbackRange = options[options.length - 1] ?? DEFAULT_RANGE;
  const initialRange =
    config.initialRange && options.includes(config.initialRange) ? config.initialRange : fallbackRange;
  const [internalRange, setInternalRange] = useState<TimeRangeOption>(initialRange);
  const range = config.externalRange ?? internalRange;
  const setRange = config.externalRange ? () => {} : setInternalRange;

  const filteredData = useMemo(() => {
    if (range === "all" || data.length === 0) return data;
    const latest = data[data.length - 1]?.[tsKey] ?? 0;
    const cutoff = RANGE_MS[range];
    if (!cutoff) return data;
    return data.filter((d) => d[tsKey] >= latest - cutoff);
  }, [data, range, tsKey]);

  return { range, setRange, filteredData, options } as const;
}
