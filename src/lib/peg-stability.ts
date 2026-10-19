import type { DepegEvent } from "@shared/types";
import { formatTrackingSpanSeconds } from "@shared/lib/format";
import { computePegScore } from "@shared/lib/peg-score";
import { DAY_SECONDS } from "@/lib/constants";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import { classifyDepegClosure, type DepegClosureClassification } from "@shared/lib/depeg-closure";

interface PegStabilityMetrics {
  /** Record-derived peg occupancy estimate (0–100), not proof of continuous observation */
  pegPct: number | null;
  /** Human-readable tracking span (e.g. "3y 8m") */
  trackingSpan: string;
  /** Whether tracking history is < 7 days */
  limited: boolean;
  /** Total number of depeg events */
  eventCount: number;
  /** Worst (most extreme) peak deviation in bps, signed */
  worstDeviationBps: number | null;
  /** Days since the latest recorded recovery, not a continuously observed at-peg streak */
  currentStreakDays: number | null;
  /** Latest terminal boundary, including non-recovery tracking closures */
  latestClosure: DepegClosureClassification | null;
  /** Whether there is an ongoing depeg event right now */
  depeggedNow: boolean;
}

/**
 * Compute peg stability metrics from depeg events and tracking history.
 *
 * @param events       Depeg events for this stablecoin
 * @param earliestDate Producer history observation boundary, not a display/chart window
 * @param now          Current time in seconds (defaults to Date.now()/1000)
 */
export function computePegStability(
  events: DepegEvent[],
  earliestDate: number | null,
  now?: number,
): PegStabilityMetrics | null {
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  // Producer coverage can be scoring-window bounded; every loaded incident is
  // nevertheless observed history. Include the oldest incident, never a chart seed.
  const earliestSec = events.reduce(
    (earliest, event) => Math.min(earliest, event.startedAt),
    earliestDate != null ? Math.floor(earliestDate) : Infinity,
  );

  if (!Number.isFinite(earliestSec)) return null;

  const historySpanSec = nowSec - earliestSec;
  if (historySpanSec <= 0) return null;

  // Shared peg-score logic is the single source for pegPct, eventCount, worst deviation, and active-depeg state.
  const pegMetrics = computePegScore(events, earliestSec, nowSec);
  const limited = historySpanSec < WEEK_SECONDS;

  // Inspect the latest terminal boundary before considering recovery; never skip
  // a tracking closure and resurrect an older recovered episode.
  const depeggedNow = pegMetrics.activeDepeg;
  let latestClosed: DepegEvent | null = null;
  for (const event of events) {
    if (event.endedAt == null || event.endedAt > nowSec) continue;
    if (latestClosed == null || event.endedAt >= latestClosed.endedAt!) {
      latestClosed = event;
    }
  }
  const latestClosure = latestClosed ? classifyDepegClosure(latestClosed) : null;
  const recovered = latestClosure === "recovered" || latestClosure === "legacy_recovered";
  const currentStreakDays = !depeggedNow && recovered && latestClosed
    ? Math.floor((nowSec - latestClosed.endedAt!) / DAY_SECONDS)
    : null;

  return {
    pegPct: pegMetrics.pegPct,
    trackingSpan: formatTrackingSpanSeconds(historySpanSec),
    limited,
    eventCount: pegMetrics.eventCount,
    worstDeviationBps: pegMetrics.worstDeviationBps,
    currentStreakDays,
    latestClosure,
    depeggedNow,
  };
}
