import { formatChartDate } from "@shared/lib/format";

export type TimeRangeOption = "7d" | "30d" | "90d" | "1y" | "all";

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
