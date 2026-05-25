import { withErrorHandler, jsonFreshResponse, buildMethodologyEnvelope } from "../lib/api-utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { loadDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import { DDR_PUBLIC_WARNING, type DdrResponse } from "@shared/types/depeg-resolver";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SUPPORT_RULES_VERSION,
} from "@shared/lib/depeg-resolver-version";

function degradedResponse(reason: string): DdrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    _meta: {
      dataAsOf: nowSec,
      modelAsOf: nowSec,
      computedAt: nowSec,
      expiresAt: nowSec + 1800,
      degraded: true,
      degradedReason: reason,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage: null,
    },
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

function staleSnapshotResponse(snapshot: DdrResponse): DdrResponse {
  return {
    ...snapshot,
    _meta: {
      ...snapshot._meta,
      degraded: true,
      degradedReason: "stale-cache",
    },
    rows: snapshot.rows.map((row) => ({
      ...row,
      duration: {
        ...row.duration,
        suppressed: true,
        suppressedReason: "stale_cache",
        stratum: null,
        medianSec: null,
        iqrSec: null,
        ageStatus: null,
        horizons: [],
      },
    })),
  };
}

export const handleDepegResolver = withErrorHandler("depeg-resolver", async (db: D1Database): Promise<Response> => {
  const cached = await loadDepegResolverSnapshot(db);
  if (cached.kind === "ok") {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = nowSec > cached.payload._meta.expiresAt ? staleSnapshotResponse(cached.payload) : cached.payload;
    return jsonFreshResponse(payload, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: cached.payload._meta.computedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
    });
  }

  // No usable snapshot yet (e.g. before first cron run, or after a methodology bump):
  // serve a degraded 200 with no rows rather than failing — the module renders an
  // "unavailable" state and recovers on the next precompute.
  console.warn(`[depeg-resolver] snapshot unavailable; serving degraded reason=${cached.reason}`);
  const nowSec = Math.floor(Date.now() / 1000);
  return jsonFreshResponse(degradedResponse(cached.reason), {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: nowSec,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
  });
});
