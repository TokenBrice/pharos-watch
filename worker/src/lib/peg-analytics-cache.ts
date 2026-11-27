import { logWorkerEventArgs } from "./structured-log";
import { getCache, setCacheIfNewer, type CacheWriteResult } from "./db-cache";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { assessFreshnessTimestamp } from "./api-freshness-age";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import type { PegAnalyticsSnapshot } from "./peg-analytics";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  decodePegAnalyticsCacheRow,
  PEG_ANALYTICS_CACHE_KEY,
  PEG_ANALYTICS_CACHE_MAX_AGE_MS,
  type PegAnalyticsCacheLoadResult,
  type PegAnalyticsCachePayload,
} from "./peg-analytics-cache-decode";

export type {
  PegAnalyticsCacheLoadResult,
  PegAnalyticsCachePayload,
  PegAnalyticsOpenIncident,
} from "./peg-analytics-cache-decode";

export interface PegEventDayCounts {
  todayStartSec: number;
  today: number;
  yesterday: number;
}

/**
 * One authority for the "today"/"yesterday" UTC-day counters, shared by the
 * publish path and read-time re-bucketing.
 */
export function countPegEventDays(
  events: Iterable<{
    stablecoinId: string;
    startedAt: number;
    provenance?: { auditVerdict?: string | null } | null;
  }>,
  nowSec: number,
): PegEventDayCounts {
  const todayStartSec = bucketUnixSecondsToUtcDay(nowSec);
  const yesterdayStartSec = todayStartSec - DAY_SECONDS;
  let today = 0;
  let yesterday = 0;
  for (const event of events) {
    if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
    if (isDisputedAuditVerdict(event.provenance?.auditVerdict)) continue;
    if (event.startedAt >= todayStartSec) today += 1;
    else if (event.startedAt >= yesterdayStartSec) yesterday += 1;
  }
  return { todayStartSec, today, yesterday };
}

async function deleteInspectedPegAnalyticsCache(
  db: D1Database,
  row: { value: string; updatedAt: number },
): Promise<void> {
  await runWithOverloadRetry(() => db
    .prepare("DELETE FROM cache WHERE key = ? AND value = ? AND updated_at = ?")
    .bind(PEG_ANALYTICS_CACHE_KEY, row.value, row.updatedAt)
    .run());
}

async function writePegAnalyticsCache(
  db: D1Database,
  payload: PegAnalyticsCachePayload,
): Promise<CacheWriteResult> {
  const body = JSON.stringify(payload);
  const result = await setCacheIfNewer(db, PEG_ANALYTICS_CACHE_KEY, body, payload.computedAtSec);
  if (result.written || !result.skippedBecauseNewer) return result;
  // A row ahead of the writer clock would otherwise reject every later publish
  // until wall time catches up. The publish wins over a future-dated row.
  const existing = await getCache(db, PEG_ANALYTICS_CACHE_KEY);
  const existingTimestamp = existing
    ? assessFreshnessTimestamp(Math.floor(Date.now() / 1000), existing.updatedAt)
    : null;
  if (!existing || existingTimestamp?.reason !== "future-timestamp") return result;
  await deleteInspectedPegAnalyticsCache(db, existing);
  return setCacheIfNewer(db, PEG_ANALYTICS_CACHE_KEY, body, payload.computedAtSec);
}

/**
 * Publishes the request-hot aggregate at producer cadence: peg-summary and the
 * per-coin OG renderer would otherwise re-scan ~21K depeg_events rows per edge
 * miss to rebuild this exact snapshot.
 *
 * Read paths fall back to direct compute, so a failed publish degrades latency
 * and never correctness — it is reported, not thrown.
 */
export async function publishPegAnalyticsCache(
  db: D1Database,
  pegAnalytics: Pick<PegAnalyticsSnapshot, "nowSec" | "allEvents" | "pegDataById" | "openIncidents" | "openIncidentCandidates">,
): Promise<boolean> {
  const { today, yesterday } = countPegEventDays(pegAnalytics.allEvents ?? [], pegAnalytics.nowSec);
  try {
    const result = await writePegAnalyticsCache(db, {
      computedAtSec: pegAnalytics.nowSec,
      depegEventsToday: today,
      depegEventsYesterday: yesterday,
      pegData: [...pegAnalytics.pegDataById.values()],
      ...(pegAnalytics.openIncidents !== undefined ? { openIncidents: pegAnalytics.openIncidents } : {}),
      ...(pegAnalytics.openIncidentCandidates !== undefined && Object.keys(pegAnalytics.openIncidentCandidates).length > 0
        ? { openIncidentCandidates: pegAnalytics.openIncidentCandidates }
        : {}),
    });
    return result.written;
  } catch (error) {
    logWorkerEventArgs("lib", "warn",
      "[peg-analytics-cache] publish failed (read paths fall back to direct compute):",
      toErrorMessage(error),
    );
    return false;
  }
}

export async function loadPegAnalyticsCache(
  db: D1Database,
  { maxAgeMs = PEG_ANALYTICS_CACHE_MAX_AGE_MS, requireCurrentUtcDay = false }: {
    maxAgeMs?: number;
    /** Reject day-scoped counters published on a previous UTC day. */
    requireCurrentUtcDay?: boolean;
  } = {},
): Promise<PegAnalyticsCacheLoadResult> {
  const row = await getCache(db, PEG_ANALYTICS_CACHE_KEY);
  const result = decodePegAnalyticsCacheRow(row, Date.now(), { maxAgeMs, requireCurrentUtcDay });
  if (row && result.kind === "miss" && result.reason === "future-timestamp") {
    // The row can never age out ahead of its own clock and would reject every
    // later publish; drop only the inspected row, preserving any replacement.
    await deleteInspectedPegAnalyticsCache(db, row);
  }
  return result;
}
