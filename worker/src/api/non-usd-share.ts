import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { NonUsdSharePoint } from "@shared/types/market";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { jsonResponse, jsonResponseWithHeaders } from "../lib/api-response";
import { parseQueryParams } from "../lib/api-params";
import {
  NON_USD_SHARE_MAX_DAYS,
  computeNonUsdShareHistory,
  readNonUsdShareHistory,
  sampleNonUsdShareHistory,
} from "../lib/non-usd-share-history";
import type { ComputedNonUsdShareHistory } from "../lib/non-usd-share-history";

export const handleNonUsdShare = async (db: D1Database, url: URL): Promise<Response> => {
  const params = parseQueryParams(url.searchParams, {
    days: { type: "int", default: NON_USD_SHARE_MAX_DAYS, min: 30, max: NON_USD_SHARE_MAX_DAYS, rangePolicy: "reject" },
  });
  if (params instanceof Response) return params;
  const publication = await readNonUsdShareHistory(db);
  if (publication.status === "invalid") {
    return jsonResponse({
      error: "Non-USD share data is unavailable", reason: "non-usd-share-publication-unavailable",
    }, { status: 503, noStore: true });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - params.days * DAY_SECONDS;
  let points: NonUsdSharePoint[];
  let updatedAt: number | null;
  if (publication.status === "missing") {
    // Preserve availability during rollout only. A present rejected generation
    // must never be hidden by an on-demand recomputation.
    let computed: ComputedNonUsdShareHistory;
    try {
      computed = await computeNonUsdShareHistory(db, nowSec, cutoff);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "non-usd-share:invalid-history") throw error;
      return jsonResponse({
        error: "Non-USD share data is unavailable", reason: "non-usd-share-history-unavailable",
      }, { status: 503, noStore: true });
    }
    points = sampleNonUsdShareHistory(computed.points, cutoff, nowSec);
    updatedAt = computed.snapshotUpdatedAt ?? points.reduce<number | null>(
      (latest, point) => latest == null ? point.date : Math.max(latest, point.date), null,
    );
  } else {
    points = sampleNonUsdShareHistory(publication.points, cutoff, nowSec);
    updatedAt = publication.updatedAt;
  }
  const headers = updatedAt == null ? { "Cache-Control": CACHE_PROFILES.slow } : addFreshnessHeaders(
    { "Cache-Control": CACHE_PROFILES.slow }, updatedAt, API_FRESHNESS_MAX_AGE_SEC.nonUsdShare,
  );
  return jsonResponseWithHeaders(points, headers);
};
