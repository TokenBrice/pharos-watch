import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { errorResponse } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import {
  SafetyScoreHistoryV2ResponseSchema,
  type SafetyScoreHistoryV2Point,
} from "@shared/types/safety-score-history";
import { safetyScoreHistoryFreshness } from "./safety-score-history";
import {
  fetchSafetyScoreHistoryV2Rows,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";

class AllSafetyScoreHistoryRowsMalformedError extends Error {}

/**
 * Boundary-aware, identity-rich history. The legacy endpoint remains the V8
 * compatibility projection and intentionally omits these boundary rows.
 */
export const handleSafetyScoreHistoryV2 = async (db: D1Database, url: URL): Promise<Response> => {
  try {
    return await handleStablecoinHistoryRequest(db, url, {
      query: STABLECOIN_HISTORY_QUERY_CONTRACTS.safetyScore,
      cacheControl: CACHE_PROFILES.slow,
      fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
        return fetchSafetyScoreHistoryV2Rows(database, stablecoinId, cutoff);
      },
      mapRow: (row): SafetyScoreHistoryV2Point | null => {
        try {
          const parsed = SafetyScoreHistoryV2ResponseSchema.safeParse({
            schemaVersion: 2,
            malformedRows: 0,
            history: [{
              date: row.recorded_at,
              grade: row.grade,
              score: row.score,
              prevGrade: row.prev_grade,
              prevScore: row.prev_score,
              transitionKind: row.transition_kind,
              safetyScoreIdentity: safetyScoreHistoryIdentityFromV2Row(row),
            }],
          });
          return parsed.success ? parsed.data.history[0]! : null;
        } catch {
          return null;
        }
      },
      buildBody: ({ rows, history }) => {
        const validHistory = history.filter((row): row is SafetyScoreHistoryV2Point => row !== null);
        if (rows.length > 0 && validHistory.length === 0) {
          throw new AllSafetyScoreHistoryRowsMalformedError();
        }
        return SafetyScoreHistoryV2ResponseSchema.parse({
          schemaVersion: 2,
          history: validHistory,
          malformedRows: history.length - validHistory.length,
        });
      },
      freshness: ({ db: database, history }) => safetyScoreHistoryFreshness({
        db: database,
        history: history.filter((row): row is SafetyScoreHistoryV2Point => row !== null),
      }),
    });
  } catch (error) {
    if (error instanceof AllSafetyScoreHistoryRowsMalformedError) {
      return errorResponse(503, "Safety score history is temporarily unavailable");
    }
    throw error;
  }
};
