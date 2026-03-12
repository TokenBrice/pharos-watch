import {
  withErrorHandler,
  handleStablecoinHistoryRequest,
  getLatestSuccessfulCronTimestamp,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import type { ReportCardGrade } from "@shared/types";

interface SafetyScoreHistoryRow {
  recorded_at: number;
  grade: ReportCardGrade;
  score: number | null;
  prev_grade: ReportCardGrade | null;
  prev_score: number | null;
  methodology_version: string;
}

export const handleSafetyScoreHistory = withErrorHandler("safety-score-history", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  return handleStablecoinHistoryRequest(db, url, {
    query: {
      defaultDays: 365,
      minDays: 1,
      maxDays: 3650,
    },
    cacheControl: CACHE_PROFILES.slow,
    fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
      const result = await database
        .prepare(
          `SELECT recorded_at, grade, score, prev_grade, prev_score, methodology_version
             FROM safety_grade_history
             WHERE stablecoin_id = ? AND recorded_at >= ?
             ORDER BY recorded_at ASC`,
        )
        .bind(stablecoinId, cutoff)
        .all<SafetyScoreHistoryRow>();
      return result.results ?? [];
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
      const latestTs = history.length > 0
        ? history[history.length - 1]?.date ?? Math.floor(Date.now() / 1000)
        : Math.floor(Date.now() / 1000);
      const updatedAt = await getLatestSuccessfulCronTimestamp(
        database,
        "snapshot-safety-grade-history",
        latestTs,
      );
      return { updatedAt, maxAgeSec: 86_400 };
    },
  });
});
