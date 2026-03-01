import type { DepegEvent } from "./types";
import { mergeDepegSeconds, worstDeviation } from "./peg-utils";

interface PegStabilityMetrics {
  /** Percentage of tracked history at peg (0–100) */
  pegPct: number;
  /** Human-readable tracking span (e.g. "3y 8m") */
  trackingSpan: string;
  /** Whether tracking history is < 30 days */
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
  earliestDate: string | null,
  now?: number,
): PegStabilityMetrics | null {
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  // Determine tracking start
  // DefiLlama date field is a Unix timestamp in seconds (as a string)
  const earliestSec = earliestDate
    ? Math.floor(Number(earliestDate))
    : events.length > 0
      ? events.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
      : null;

  if (earliestSec === null) return null;

  const historySpanSec = nowSec - earliestSec;
  if (historySpanSec <= 0) return null;

  // Total depeg time — merge overlapping intervals to avoid double-counting
  const totalDepegSec = mergeDepegSeconds(events, earliestSec, nowSec);

  const pegPct = Math.max(0, (1 - totalDepegSec / historySpanSec) * 100);
  const limited = historySpanSec < 30 * 86400;

  // Worst deviation (largest absolute value, keep sign)
  const worstDeviationBps = worstDeviation(events);

  // Current streak: days since last closed event ended
  const depeggedNow = events.some((e) => e.endedAt === null);
  let currentStreakDays: number | null = null;
  if (!depeggedNow && events.length > 0) {
    const lastEnded = events.filter((e) => e.endedAt !== null).reduce((m, e) => Math.max(m, e.endedAt!), -Infinity);
    if (lastEnded > 0) {
      currentStreakDays = Math.floor((nowSec - lastEnded) / 86400);
    }
  }

  return {
    pegPct,
    trackingSpan: formatTrackingSpan(historySpanSec),
    limited,
    eventCount: events.length,
    worstDeviationBps,
    currentStreakDays,
    depeggedNow,
  };
}

function formatTrackingSpan(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem > 0 ? `${years}y ${rem}mo` : `${years}y`;
}
