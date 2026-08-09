import type { CronResult } from "../lib/cron-logger";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getConditionBand } from "../lib/stability-index";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/stability-index";
import { round1 } from "@shared/lib/math";

export async function snapshotPsiDaily(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = now - (now % DAY_SECONDS);
  const yesterdayMidnight = todayMidnight - DAY_SECONDS;

  let row: { avg_score: number | null; avg_severity: number | null; avg_breadth: number | null; avg_stress_breadth: number | null; avg_trend: number | null; cnt: number } | null;
  let versionRows: D1Result<{ methodology_version: string; cnt: number }>;
  try {
    row = await db
      .prepare(
        `SELECT AVG(score) as avg_score,
                AVG(json_extract(components, '$.severity')) as avg_severity,
                AVG(json_extract(components, '$.breadth')) as avg_breadth,
                AVG(json_extract(components, '$.stressBreadth')) as avg_stress_breadth,
                AVG(json_extract(components, '$.trend')) as avg_trend,
                COUNT(*) as cnt
         FROM stability_index_samples
         WHERE stored_at >= ? AND stored_at < ?`
      )
      .bind(yesterdayMidnight, todayMidnight)
      .first<{ avg_score: number | null; avg_severity: number | null; avg_breadth: number | null; avg_stress_breadth: number | null; avg_trend: number | null; cnt: number }>();
    throwIfAborted(signal);

    versionRows = await db
      .prepare(
        `SELECT methodology_version, COUNT(*) as cnt
         FROM stability_index_samples
         WHERE stored_at >= ? AND stored_at < ?
         GROUP BY methodology_version
         ORDER BY cnt DESC, methodology_version DESC`
      )
      .bind(yesterdayMidnight, todayMidnight)
      .all<{ methodology_version: string; cnt: number }>();
    throwIfAborted(signal);
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.error("[snapshot-psi] DB query failed:", err);
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "db_query_failed", error: String(err).slice(0, 200) }) };
  }

  if (!row || !row.cnt || row.avg_score == null) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "no-samples-for-yesterday", sampleCount: row?.cnt ?? 0 }),
    };
  }

  const score = round1(row.avg_score);
  const band = getConditionBand(score);
  const components = {
    severity: Math.round((row.avg_severity ?? 0) * 100) / 100,
    breadth: Math.round((row.avg_breadth ?? 0) * 100) / 100,
    stressBreadth: Math.round((row.avg_stress_breadth ?? 0) * 100) / 100,
    trend: Math.round((row.avg_trend ?? 0) * 100) / 100,
  };
  const methodologyVersion = versionRows.results?.[0]?.methodology_version ?? PSI_METHODOLOGY_VERSION;
  const methodologyBreakdown = Object.fromEntries(
    (versionRows.results ?? []).map((r) => [r.methodology_version, r.cnt]),
  );

  throwIfAborted(signal);
  await db
    .prepare(
      `INSERT OR REPLACE INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      yesterdayMidnight,
      score,
      band,
      JSON.stringify(components),
      JSON.stringify({
        source: "daily-avg",
        sampleCount: row.cnt,
        methodologyVersion,
        methodologyBreakdown,
      }),
      methodologyVersion,
    )
    .run();
  throwIfAborted(signal);

  console.log(`[snapshot-psi] yesterday avg=${score} band=${band} samples=${row.cnt}`);
  return { itemCount: 1, metadata: `avg=${score} band=${band} samples=${row.cnt}` };
}
