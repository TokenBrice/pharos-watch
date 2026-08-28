import { logWorkerEventArgs } from "../lib/structured-log";
import {
  DDRR_REVIEWER_VERSION,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrResponse,
} from "@shared/types/depeg-resolver-review";
import { cacheControlForDegradedPayload, jsonFreshResponse } from "../lib/api-response";
import { buildDdrMethodologyEnvelope } from "../lib/depeg-resolver-methodology";
import { buildEmptyDdrrSummary } from "../lib/depeg-resolver-review-response";
import { loadDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";

function degradedResponse(reason: string): DdrrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    _meta: {
      computedAt: nowSec,
      expiresAt: nowSec + API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
      degraded: true,
      degradedReason: reason,
      reviewerVersion: DDRR_REVIEWER_VERSION,
      publicWarning: DDRR_PUBLIC_WARNING,
      assessedEventCount: 0,
      reviewedEventCount: 0,
      pendingEventCount: 0,
      durationScoredCount: 0,
      verdictScoredCount: 0,
      assessmentRowLimit: 0,
      assessmentRowsTruncated: false,
      incidentRowLimit: 0,
      incidentRowsTruncated: false,
      publicRowLimit: 0,
      publicRowsTruncated: false,
      methodologyVersions: [],
    },
    summary: buildEmptyDdrrSummary(),
    rows: [],
    methodology: buildDdrMethodologyEnvelope(nowSec),
  };
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
      return jsonFreshResponse(payload, {
        cacheControl: cacheControlForDegradedPayload(payload),
        updatedAt: cached.payload._meta.computedAt,
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
      });
    }

    logWorkerEventArgs("api", "warn", `[depeg-resolver-review] snapshot unavailable; serving degraded reason=${cached.reason}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = degradedResponse(cached.reason);
    return jsonFreshResponse(payload, {
      cacheControl: cacheControlForDegradedPayload(payload),
      updatedAt: nowSec,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
    });
  };
