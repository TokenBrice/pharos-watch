import { withErrorHandler, handleStablecoinHistoryRequest, getLatestSuccessfulCronTimestamp } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fetchSafetyScoreHistoryCompatibilityRows } from "../lib/safety-score-history-v2";

export const handleSafetyScoreHistory = withErrorHandler(
  "safety-score-history",
  async (db: D1Database, url: URL): Promise<Response> => {
    return handleStablecoinHistoryRequest(db, url, {
      query: {
        defaultDays: 365,
        minDays: 1,
        maxDays: 3650,
        rangePolicy: "reject",
      },
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
      freshness: async ({ db: database, history }) => {
        const latestTs =
          history.length > 0
            ? (history[history.length - 1]?.date ?? Math.floor(Date.now() / 1000))
            : Math.floor(Date.now() / 1000);
        const updatedAt = await getLatestSuccessfulCronTimestamp(database, "snapshot-safety-grade-history", latestTs);
        return { updatedAt, maxAgeSec: DAY_SECONDS };
      },
    });
  },
);
