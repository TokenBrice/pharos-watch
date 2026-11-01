import { logWorkerEventArgs } from "./structured-log";
import { deleteCache, getCache, setCacheIfNewer, type CacheWriteResult } from "./db-cache";
import { decodeCachedJson } from "./cache-json";
import { recordJsonParseFailure } from "./api-cache-read";
import { assessFreshnessTimestamp } from "./api-freshness-age";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { PegSummaryCoinSchema, type PegSummaryCoin } from "@shared/types/peg";
import type { PegAnalyticsSnapshot } from "./peg-analytics";
import { toErrorMessage } from "@shared/lib/error-utils";
import { validatePayloadWithSchema } from "./api-schema";
import { z } from "zod";

const PEG_ANALYTICS_CACHE_KEY = "peg-analytics";

// Published every 30 minutes on the charts lane: by V9 input preparation at
// :16 and standalone at :46.
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
  | "stale-day"
  | "future-timestamp"
  | "json-parse-failed"
  | "invalid-payload";

export type PegAnalyticsCacheLoadResult =
  | { kind: "ok"; payload: PegAnalyticsCachePayload; pegDataById: Map<string, PegSummaryCoin>; updatedAt: number }
  | { kind: "miss"; reason: PegAnalyticsCacheFailureReason };

const PEG_DATA_SCHEMA = z.array(PegSummaryCoinSchema);

function parsePayload(value: unknown): PegAnalyticsCachePayload | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PegAnalyticsCachePayload>;
  if (
    !(typeof parsed.computedAtSec === "number" &&
      Number.isFinite(parsed.computedAtSec) &&
      typeof parsed.depegEventsToday === "number" &&
      typeof parsed.depegEventsYesterday === "number" &&
      Array.isArray(parsed.pegData))
  ) {
    return null;
  }
  // A row written by another deploy must still satisfy every published field
  // the route copies verbatim, not merely carry an id.
  const rows = validatePayloadWithSchema(
    PEG_DATA_SCHEMA,
    parsed.pegData,
    "peg-analytics:pegData",
  );
  if (!rows.ok) return null;
  return {
    computedAtSec: parsed.computedAtSec,
    depegEventsToday: parsed.depegEventsToday,
    depegEventsYesterday: parsed.depegEventsYesterday,
    pegData: rows.data,
  };
}

export async function writePegAnalyticsCache(
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
  if (existingTimestamp?.reason !== "future-timestamp") return result;
  await deleteCache(db, PEG_ANALYTICS_CACHE_KEY);
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
  pegAnalytics: Pick<PegAnalyticsSnapshot, "nowSec" | "allEvents" | "pegDataById">,
): Promise<boolean> {
  const todayStartSec = bucketUnixSecondsToUtcDay(pegAnalytics.nowSec);
  const yesterdayStartSec = todayStartSec - DAY_SECONDS;
  let depegEventsToday = 0;
  let depegEventsYesterday = 0;
  for (const event of pegAnalytics.allEvents ?? []) {
    if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
    if (isDisputedAuditVerdict(event.provenance?.auditVerdict)) continue;
    if (event.startedAt >= todayStartSec) depegEventsToday += 1;
    else if (event.startedAt >= yesterdayStartSec) depegEventsYesterday += 1;
  }
  try {
    const result = await writePegAnalyticsCache(db, {
      computedAtSec: pegAnalytics.nowSec,
      depegEventsToday,
      depegEventsYesterday,
      pegData: [...pegAnalytics.pegDataById.values()],
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
  if (!row) return { kind: "miss", reason: "missing-cache" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (assessFreshnessTimestamp(nowSec, row.updatedAt).reason === "future-timestamp") {
    // The row can never age out ahead of its own clock and would reject every
    // later publish; drop it so the next producer run writes a current one.
    await deleteCache(db, PEG_ANALYTICS_CACHE_KEY);
    return { kind: "miss", reason: "future-timestamp" };
  }
  if (Date.now() - row.updatedAt * 1000 > maxAgeMs) return { kind: "miss", reason: "stale-cache" };
  const decoded = decodeCachedJson<PegAnalyticsCachePayload, PegAnalyticsCacheFailureReason>(
    row,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const payload = parsePayload(parsed);
        return payload ? { ok: true, payload } : { ok: false, reason: "invalid-payload" };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure("peg-analytics:peg-analytics", message),
    },
  );
  if (!decoded.ok) {
    return { kind: "miss", reason: decoded.reason };
  }
  if (
    requireCurrentUtcDay
    && bucketUnixSecondsToUtcDay(decoded.payload.computedAtSec) !== bucketUnixSecondsToUtcDay(nowSec)
  ) {
    // depegEventsToday/Yesterday were bucketed against the publish-time UTC
    // day; republishing them after midnight would describe the wrong day.
    return { kind: "miss", reason: "stale-day" };
  }

  return {
    kind: "ok",
    payload: decoded.payload,
    pegDataById: new Map(decoded.payload.pegData.map((entry) => [entry.id, entry])),
    updatedAt: decoded.updatedAt ?? row.updatedAt,
  };
}
