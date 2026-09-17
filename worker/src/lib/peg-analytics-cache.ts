import { logWorkerEventArgs } from "./structured-log";
import { getCache, setCacheIfNewer } from "./db-cache";
import { decodeCachedJson } from "./cache-json";
import { recordJsonParseFailure } from "./api-cache-read";
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
type PegAnalyticsCacheFailureReason =
  | "missing-cache"
  | "stale-cache"
  | "json-parse-failed"
  | "invalid-payload";

export type PegAnalyticsCacheLoadResult =
  | { kind: "ok"; payload: PegAnalyticsCachePayload; pegDataById: Map<string, PegSummaryCoin>; updatedAt: number }
  | { kind: "miss"; reason: PegAnalyticsCacheFailureReason };

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
  const body = JSON.stringify(payload);
  await setCacheIfNewer(db, PEG_ANALYTICS_CACHE_KEY, body, payload.computedAtSec);
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
  const decoded = decodeCachedJson<PegAnalyticsCachePayload, PegAnalyticsCacheFailureReason>(
    row,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) =>
        isValidPayload(parsed)
          ? { ok: true, payload: parsed }
          : { ok: false, reason: "invalid-payload" },
      onParseFailure: ({ message }) => recordJsonParseFailure("peg-analytics:peg-analytics", message),
    },
  );
  if (!decoded.ok) {
    return { kind: "miss", reason: decoded.reason };
  }

  return {
    kind: "ok",
    payload: decoded.payload,
    pegDataById: new Map(decoded.payload.pegData.map((entry) => [entry.id, entry])),
    updatedAt: decoded.updatedAt ?? row.updatedAt,
  };
}
