import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { CACHE_PROFILES } from "../lib/constants";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { SafetyScoreHistoryV2ResponseSchema } from "@shared/types/safety-score-history";
import { safetyScoreHistoryFreshness } from "./safety-score-history";
import {
  fetchSafetyScoreHistoryV2Rows,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";

/**
 * Boundary-aware, identity-rich history. The legacy endpoint remains the V8
 * compatibility projection and intentionally omits these boundary rows.
 */
export const handleSafetyScoreHistoryV2 = async (db: D1Database, url: URL): Promise<Response> => {
    return handleStablecoinHistoryRequest(db, url, {
      query: STABLECOIN_HISTORY_QUERY_CONTRACTS.safetyScore,
      cacheControl: CACHE_PROFILES.slow,
      fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
        return fetchSafetyScoreHistoryV2Rows(database, stablecoinId, cutoff);
      },
      mapRow: (row) => ({
        date: row.recorded_at,
        grade: row.grade,
        score: row.score,
        prevGrade: row.prev_grade,
        prevScore: row.prev_score,
        transitionKind: row.transition_kind,
        safetyScoreIdentity: safetyScoreHistoryIdentityFromV2Row(row),
      }),
      buildBody: ({ history }) => SafetyScoreHistoryV2ResponseSchema.parse({ schemaVersion: 2, history }),
      freshness: safetyScoreHistoryFreshness,
    });
  };
