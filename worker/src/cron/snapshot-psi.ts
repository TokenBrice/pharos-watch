import type { CronResult } from "../lib/db";
import { getConditionBand } from "../lib/stability-index";

export async function snapshotPsiDaily(db: D1Database): Promise<CronResult> {
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = now - (now % 86400);
  const yesterdayMidnight = todayMidnight - 86400;

  const row = await db
    .prepare(
      `SELECT AVG(score) as avg_score,
              AVG(json_extract(components, '$.severity')) as avg_severity,
              AVG(json_extract(components, '$.breadth')) as avg_breadth,
              AVG(json_extract(components, '$.freezes')) as avg_freezes,
              AVG(json_extract(components, '$.trend')) as avg_trend,
              COUNT(*) as cnt
       FROM stability_index_samples
       WHERE stored_at >= ? AND stored_at < ?`
    )
    .bind(yesterdayMidnight, todayMidnight)
    .first<{ avg_score: number | null; avg_severity: number | null; avg_breadth: number | null; avg_freezes: number | null; avg_trend: number | null; cnt: number }>();

  if (!row || !row.cnt || row.avg_score == null) {
    return { metadata: "skipped: no samples for yesterday" };
  }

  const score = Math.round(row.avg_score * 10) / 10;
  const band = getConditionBand(score);
  const components = {
    severity: Math.round((row.avg_severity ?? 0) * 100) / 100,
    breadth: Math.round((row.avg_breadth ?? 0) * 100) / 100,
    freezes: Math.round((row.avg_freezes ?? 0) * 100) / 100,
    trend: Math.round((row.avg_trend ?? 0) * 100) / 100,
  };

  await db
    .prepare(
      `INSERT OR REPLACE INTO stability_index (computed_at, score, band, components, input_snapshot)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      yesterdayMidnight,
      score,
      band,
      JSON.stringify(components),
      JSON.stringify({ source: "daily-avg", sampleCount: row.cnt }),
    )
    .run();

  console.log(`[snapshot-psi] yesterday avg=${score} band=${band} samples=${row.cnt}`);
  return { metadata: `avg=${score} band=${band} samples=${row.cnt}` };
}
