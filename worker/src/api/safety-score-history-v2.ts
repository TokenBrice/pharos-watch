import { getLatestSuccessfulCronTimestamp } from "../lib/api-freshness";
import { jsonFreshResponse } from "../lib/api-response";
import { parseStablecoinHistoryQuery } from "../lib/api-history";
import { CACHE_PROFILES } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { SafetyScoreHistoryV2ResponseSchema } from "@shared/types/safety-score-history";
import {
  fetchSafetyScoreHistoryV2Rows,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";

/**
 * Boundary-aware, identity-rich history. The legacy endpoint remains the V8
 * compatibility projection and intentionally omits these boundary rows.
 */
export const handleSafetyScoreHistoryV2 = async (db: D1Database, url: URL): Promise<Response> => {
    const query = parseStablecoinHistoryQuery(url, STABLECOIN_HISTORY_QUERY_CONTRACTS.safetyScore);
    if (query instanceof Response) return query;

    const rows = await fetchSafetyScoreHistoryV2Rows(db, query.stablecoinId, query.cutoff);
    const history = rows.map((row) => ({
      date: row.recorded_at,
      grade: row.grade,
      score: row.score,
      prevGrade: row.prev_grade,
      prevScore: row.prev_score,
      transitionKind: row.transition_kind,
      safetyScoreIdentity: safetyScoreHistoryIdentityFromV2Row(row),
    }));
    const body = SafetyScoreHistoryV2ResponseSchema.parse({ schemaVersion: 2, history });
    const latestTs = history.length > 0
      ? (history[history.length - 1]?.date ?? Math.floor(Date.now() / 1000))
      : Math.floor(Date.now() / 1000);
    const updatedAt = await getLatestSuccessfulCronTimestamp(db, "snapshot-safety-grade-history", latestTs);

    return jsonFreshResponse(body, {
      cacheControl: CACHE_PROFILES.slow,
      updatedAt,
      maxAgeSec: DAY_SECONDS,
    });
  };
