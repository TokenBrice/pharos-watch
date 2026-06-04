import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDRR_REVIEWER_VERSION,
} from "@shared/lib/depeg-resolver-version";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DDRR_PUBLIC_WARNING,
  type DdrrResponse,
} from "@shared/types/depeg-resolver-review";
import { buildMethodologyEnvelope, jsonFreshResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { buildEmptyDdrrSummary } from "../cron/compute-depeg-resolver-review";
import { loadDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";

function degradedResponse(reason: string): DdrrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    _meta: {
      computedAt: nowSec,
      expiresAt: nowSec + 1800,
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
      publicRowLimit: 0,
      publicRowsTruncated: false,
      methodologyVersions: [],
    },
    summary: buildEmptyDdrrSummary(),
    rows: [],
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: nowSec,
    }),
  };
}

function ddrrCacheControl(payload: DdrrResponse): string {
  return payload._meta.degraded ? CACHE_PROFILES.noStore : CACHE_PROFILES.standard;
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

export const handleDepegResolverReview = withErrorHandler(
  "depeg-resolver-review",
  async (db: D1Database): Promise<Response> => {
    const cached = await loadDepegResolverReviewSnapshot(db);
    if (cached.kind === "ok") {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = nowSec > cached.payload._meta.expiresAt
        ? staleSnapshotResponse(cached.payload)
        : cached.payload;
      return jsonFreshResponse(payload, {
        cacheControl: ddrrCacheControl(payload),
        updatedAt: cached.payload._meta.computedAt,
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
      });
    }

    console.warn(`[depeg-resolver-review] snapshot unavailable; serving degraded reason=${cached.reason}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = degradedResponse(cached.reason);
    return jsonFreshResponse(payload, {
      cacheControl: ddrrCacheControl(payload),
      updatedAt: nowSec,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
    });
  },
);
