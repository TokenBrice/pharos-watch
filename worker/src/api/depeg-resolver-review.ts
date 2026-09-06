import { logWorkerEventArgs } from "../lib/structured-log";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import { jsonFreshDegradedResponse } from "../lib/api-response";
import { buildDdrrResponseEnvelope, buildEmptyDdrrSummary } from "../lib/depeg-resolver-review-response";
import { loadDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";

function degradedResponse(reason: string): DdrrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  const response = buildDdrrResponseEnvelope({
    nowSec,
    summary: buildEmptyDdrrSummary(),
    rows: [],
    assessedEventCount: 0,
    assessmentRowsTruncated: false,
    incidentRowLimit: 0,
    methodologyVersions: [],
    degradedReasons: [reason],
  });
  response._meta.assessmentRowLimit = 0;
  response._meta.publicRowLimit = 0;
  return response;
}

function staleSnapshotResponse(snapshot: DdrrResponse): DdrrResponse {
  return {
    ...snapshot,
    _meta: {
      ...snapshot._meta,
      degraded: true,
      degradedReason: "stale-cache",
    },
  };
}

export const handleDepegResolverReview = async (db: D1Database): Promise<Response> => {
    const cached = await loadDepegResolverReviewSnapshot(db);
    if (cached.kind === "ok") {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = nowSec > cached.payload._meta.expiresAt
        ? staleSnapshotResponse(cached.payload)
        : cached.payload;
      return jsonFreshDegradedResponse(payload, cached.payload._meta.computedAt, API_FRESHNESS_MAX_AGE_SEC.depegResolverReview);
    }

    logWorkerEventArgs("api", "warn", `[depeg-resolver-review] snapshot unavailable; serving degraded reason=${cached.reason}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = degradedResponse(cached.reason);
    return jsonFreshDegradedResponse(payload, nowSec, API_FRESHNESS_MAX_AGE_SEC.depegResolverReview);
  };
