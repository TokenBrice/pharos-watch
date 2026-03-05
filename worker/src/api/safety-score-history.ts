import {
  withErrorHandler,
  parseStablecoinHistoryQuery,
  jsonResponse,
  addFreshnessHeaders,
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
  const parsed = parseStablecoinHistoryQuery(url, {
    defaultDays: 365,
    minDays: 1,
    maxDays: 3650,
  });
  if (parsed instanceof Response) {
    return parsed;
  }

  const { stablecoinId, cutoff } = parsed;

  const result = await db
    .prepare(
      `SELECT recorded_at, grade, score, prev_grade, prev_score, methodology_version
         FROM safety_grade_history
         WHERE stablecoin_id = ? AND recorded_at >= ?
         ORDER BY recorded_at ASC`,
    )
    .bind(stablecoinId, cutoff)
    .all<SafetyScoreHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    date: row.recorded_at,
    grade: row.grade,
    score: row.score,
    prevGrade: row.prev_grade,
    prevScore: row.prev_score,
    methodologyVersion: row.methodology_version,
  }));

  const latestTs = history.length > 0
    ? history[history.length - 1]?.date ?? Math.floor(Date.now() / 1000)
    : Math.floor(Date.now() / 1000);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "snapshot-safety-grade-history", latestTs);

  return jsonResponse(history, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.slow,
  }, freshnessTs, 86_400));
});
