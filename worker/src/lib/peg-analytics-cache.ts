import { logWorkerEventArgs } from "./structured-log";
import { getCache, setCache } from "./db-cache";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import type { PegSummaryCoin } from "@shared/types/market";
import type { PegAnalyticsSnapshot } from "./peg-analytics";
import { toErrorMessage } from "@shared/lib/error-utils";

const PEG_ANALYTICS_CACHE_KEY = "peg-analytics";

// Published by the quarter-hourly report-cards pass; 2x producer cadence.
const PEG_ANALYTICS_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export interface PegAnalyticsCachePayload {
  computedAtSec: number;
  depegEventsToday: number;
  depegEventsYesterday: number;
  /** Nav-token-inclusive; consumers filter as needed. */
  pegData: PegSummaryCoin[];
}

export type PegAnalyticsCacheLoadResult =
  | { kind: "ok"; payload: PegAnalyticsCachePayload; pegDataById: Map<string, PegSummaryCoin>; updatedAt: number }
  | { kind: "miss"; reason: "missing-cache" | "stale-cache" | "invalid-payload" };

function isValidPayload(value: unknown): value is PegAnalyticsCachePayload {
  if (!value || typeof value !== "object") return false;
  const parsed = value as Partial<PegAnalyticsCachePayload>;
  return (
    typeof parsed.computedAtSec === "number" &&
    Number.isFinite(parsed.computedAtSec) &&
    typeof parsed.depegEventsToday === "number" &&
    typeof parsed.depegEventsYesterday === "number" &&
    Array.isArray(parsed.pegData) &&
    parsed.pegData.every(
      (entry) => !!entry && typeof entry === "object" && typeof (entry as PegSummaryCoin).id === "string",
    )
  );
}

export async function writePegAnalyticsCache(db: D1Database, payload: PegAnalyticsCachePayload): Promise<void> {
  await setCache(db, PEG_ANALYTICS_CACHE_KEY, JSON.stringify(payload));
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
  pegAnalytics: Pick<PegAnalyticsSnapshot, "nowSec" | "allEvents" | "pegDataById">,
): Promise<boolean> {
  const todayStartSec = bucketUnixSecondsToUtcDay(pegAnalytics.nowSec);
  const yesterdayStartSec = todayStartSec - DAY_SECONDS;
  let depegEventsToday = 0;
  let depegEventsYesterday = 0;
  for (const event of pegAnalytics.allEvents ?? []) {
    if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
    if (event.startedAt >= todayStartSec) depegEventsToday += 1;
    else if (event.startedAt >= yesterdayStartSec) depegEventsYesterday += 1;
  }
  try {
    await writePegAnalyticsCache(db, {
      computedAtSec: pegAnalytics.nowSec,
      depegEventsToday,
      depegEventsYesterday,
      pegData: [...pegAnalytics.pegDataById.values()],
    });
    return true;
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
  { maxAgeMs = PEG_ANALYTICS_CACHE_MAX_AGE_MS }: { maxAgeMs?: number } = {},
): Promise<PegAnalyticsCacheLoadResult> {
  const row = await getCache(db, PEG_ANALYTICS_CACHE_KEY);
  if (!row) return { kind: "miss", reason: "missing-cache" };
  if (Date.now() - row.updatedAt * 1000 > maxAgeMs) return { kind: "miss", reason: "stale-cache" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return { kind: "miss", reason: "invalid-payload" };
  }
  if (!isValidPayload(parsed)) return { kind: "miss", reason: "invalid-payload" };

  return {
    kind: "ok",
    payload: parsed,
    pegDataById: new Map(parsed.pegData.map((entry) => [entry.id, entry])),
    updatedAt: row.updatedAt,
  };
}
