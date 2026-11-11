import { logWorkerEventArgs } from "./structured-log";
import {
  STATUS_CACHE_RATIO_THRESHOLDS,
  getCacheRatioThresholds,
} from "@shared/lib/status-thresholds";
import type { ApiMeta } from "@pharos/contracts/api-meta";
import {
  API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  measureFreshnessAge,
  assessFreshnessTimestamp,
} from "./api-freshness-age";
import { addFreshnessHeaders } from "./api-freshness-headers";
import { LATEST_CONFIRMED_CRON_OUTPUT_SQL } from "./cron-output";

export { addFreshnessHeaders } from "./api-freshness-headers";

export type FreshnessMeta = Required<Pick<ApiMeta,
  "updatedAt" | "ageSeconds" | "status" | "assessedAt" | "freshBudgetSec" | "degradedBudgetSec"
>>;

export type CronTimestampLookupStatus = "ok" | "missing" | "lookup_failed";

export interface CronTimestampLookupResult {
  timestamp: number | null;
  status: CronTimestampLookupStatus;
}

export function buildFreshnessMeta(
  updatedAt: number,
  maxAgeSec: number,
  cacheKey: string,
  options: { assessedAt?: number; freshBudgetSec?: number; degradedBudgetSec?: number } = {},
): FreshnessMeta {
  const assessedAt = options.assessedAt ?? Math.floor(Date.now() / 1000);
  const { ageSeconds, futureSkewSeconds } = measureFreshnessAge(
    assessedAt,
    updatedAt,
    API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  );
  if (!cacheKey.trim()) throw new Error("Freshness policy identity is required");
  const bands = getCacheRatioThresholds(cacheKey);
  const freshBudgetSec = options.freshBudgetSec ?? maxAgeSec * bands.degraded;
  const degradedBudgetSec = options.degradedBudgetSec ?? maxAgeSec * bands.stale;
  return {
    updatedAt,
    ageSeconds,
    assessedAt,
    freshBudgetSec,
    degradedBudgetSec,
    status: futureSkewSeconds > API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC
      ? "degraded"
      : ageSeconds <= freshBudgetSec ? "fresh"
        : ageSeconds <= degradedBudgetSec ? "degraded" : "stale",
  };
}

export function buildCronFreshnessMeta(result: CronTimestampLookupResult, maxAgeSec: number) {
  const assessedAt = Math.floor(Date.now() / 1000);
  const assessment = assessFreshnessTimestamp(assessedAt, result.timestamp);
  if (result.status === "ok" && result.timestamp != null && assessment.reason == null) {
    return buildFreshnessMeta(result.timestamp, maxAgeSec, "cron-output", { assessedAt });
  }
  return {
    assessedAt,
    freshBudgetSec: maxAgeSec * STATUS_CACHE_RATIO_THRESHOLDS.degraded,
    degradedBudgetSec: maxAgeSec * STATUS_CACHE_RATIO_THRESHOLDS.stale,
    updatedAt: null,
    ageSeconds: null,
    status: result.status === "lookup_failed" || result.status === "ok" ? "unknown" as const : "stale" as const,
    reason: result.status === "lookup_failed" ? "freshness-lookup-failed"
      : result.status === "ok" ? assessment.reason : "producer-history-missing",
  };
}

export function buildCronFreshnessHeaders(
  result: CronTimestampLookupResult,
  maxAgeSec: number,
  cacheControl: string,
): Record<string, string> {
  const meta = buildCronFreshnessMeta(result, maxAgeSec);
  if (meta.updatedAt != null) {
    return addFreshnessHeaders({ "Cache-Control": cacheControl }, meta.updatedAt, maxAgeSec);
  }
  return {
    "Cache-Control": "no-store",
    "X-Data-Age": "unavailable",
    "X-Data-Freshness": meta.status,
    "X-Data-Updated-At": "unknown",
    "X-Data-Freshness-Reason": meta.reason ?? "producer-history-missing",
    Warning: result.status === "lookup_failed"
      ? '199 - "Producer freshness lookup failed"'
      : result.status === "ok" ? '199 - "Producer freshness timestamp is invalid"'
        : '199 - "No authoritative confirmed producer output in retained history"',
  };
}

export async function getLatestSuccessfulCronTimestampResult(
  db: D1Database,
  job: string | readonly string[],
): Promise<CronTimestampLookupResult> {
  const jobs = typeof job === "string" ? [job] : [...job];
  try {
    // Several producer lanes can write one served row set; it is only as fresh
    // as its oldest lane, and a lane without confirmed output fails closed.
    const outputs = await Promise.all(jobs.map(async (lane) => (await db
      .prepare(LATEST_CONFIRMED_CRON_OUTPUT_SQL)
      .bind(lane)
      .first<{ started_at: number | null }>())?.started_at ?? null));
    if (outputs.length > 0 && outputs.every((output) => output != null && output > 0)) {
      return {
        timestamp: Math.min(...(outputs as number[])),
        status: "ok",
      };
    }
    return {
      timestamp: null,
      status: "missing",
    };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", `[api-freshness] Failed to read latest successful cron timestamp for ${jobs.join(", ")}`, error);
    return {
      timestamp: null,
      status: "lookup_failed",
    };
  }
}
