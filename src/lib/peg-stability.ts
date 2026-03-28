import type { DepegEvent } from "@shared/types";
import { formatTrackingSpanSeconds } from "@shared/lib/format";
import { computePegScore } from "@shared/lib/peg-score";
import { DAY_SECONDS } from "@/lib/constants";
import { WEEK_SECONDS } from "@shared/lib/time-constants";

interface PegStabilityMetrics {
  /** Percentage of tracked history at peg (0–100) */
  pegPct: number;
  /** Human-readable tracking span (e.g. "3y 8m") */
  trackingSpan: string;
  /** Whether tracking history is < 7 days */
  limited: boolean;
  /** Total number of depeg events */
  eventCount: number;
  /** Worst (most extreme) peak deviation in bps, signed */
  worstDeviationBps: number | null;
  /** Days since last event ended, or null if currently depegged or no events */
  currentStreakDays: number | null;
  /** Whether there is an ongoing depeg event right now */
  depeggedNow: boolean;
}

/**
 * Compute peg stability metrics from depeg events and tracking history.
 *
 * @param events       Depeg events for this stablecoin
 * @param earliestDate Earliest data point date string (from detail chart data)
 * @param now          Current time in seconds (defaults to Date.now()/1000)
 */
export function computePegStability(
  events: DepegEvent[],
  earliestDate: number | null,
  now?: number,
): PegStabilityMetrics | null {
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  // Determine tracking start
  const earliestSec = earliestDate != null
    ? Math.floor(earliestDate)
    : events.length > 0
      ? events.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
      : null;

  if (earliestSec === null) return null;

  const historySpanSec = nowSec - earliestSec;
  if (historySpanSec <= 0) return null;

  // Shared peg-score logic is the single source for pegPct, eventCount, worst deviation, and active-depeg state.
  const pegMetrics = computePegScore(events, earliestSec, nowSec);
  const limited = historySpanSec < WEEK_SECONDS;

  // Current streak: days since last closed event ended
  const depeggedNow = pegMetrics.activeDepeg;
  let currentStreakDays: number | null = null;
  if (!depeggedNow && events.length > 0) {
    const lastEnded = events.filter((e) => e.endedAt !== null).reduce((m, e) => Math.max(m, e.endedAt!), -Infinity);
    if (lastEnded > 0) {
      currentStreakDays = Math.floor((nowSec - lastEnded) / DAY_SECONDS);
    }
  }

  return {
    pegPct: pegMetrics.pegPct,
    trackingSpan: formatTrackingSpanSeconds(historySpanSec),
    limited,
    eventCount: pegMetrics.eventCount,
    worstDeviationBps: pegMetrics.worstDeviationBps,
    currentStreakDays,
    depeggedNow,
  };
}
