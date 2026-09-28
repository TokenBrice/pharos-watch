import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { buildCronFreshnessHeaders, getLatestSuccessfulCronTimestampResult } from "../lib/api-freshness";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { fetchSafetyScoreHistoryCompatibilityRows } from "../lib/safety-score-history-v2";

export async function safetyScoreHistoryHeaders(context: {
  db: D1Database;
}): Promise<Record<string, string>> {
  const freshness = await getLatestSuccessfulCronTimestampResult(context.db, "snapshot-safety-grade-history");
  return buildCronFreshnessHeaders(freshness, DAY_SECONDS, CACHE_PROFILES.slow);
}

export const handleSafetyScoreHistory = async (db: D1Database, url: URL): Promise<Response> => {
    return handleStablecoinHistoryRequest(db, url, {
      query: STABLECOIN_HISTORY_QUERY_CONTRACTS.safetyScore,
      cacheControl: CACHE_PROFILES.slow,
      fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
        return fetchSafetyScoreHistoryCompatibilityRows(database, stablecoinId, cutoff);
      },
      mapRow: (row) => ({
        date: row.recorded_at,
        grade: row.grade,
        score: row.score,
        prevGrade: row.prev_grade,
        prevScore: row.prev_score,
        methodologyVersion: row.methodology_version,
      }),
      buildHeaders: safetyScoreHistoryHeaders,
    });
  };
