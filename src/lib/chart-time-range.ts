import { formatChartDate } from "@shared/lib/format";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

/** Short windows need day-level labels; longer windows stay month-oriented. */
export function formatRangeTickDate(timestamp: number, range: TimeRangeOption): string {
  switch (range) {
    case "7d":
    case "30d":
      return formatChartDate(timestamp, "short");
    default:
      return formatChartDate(timestamp, "compact");
  }
}
