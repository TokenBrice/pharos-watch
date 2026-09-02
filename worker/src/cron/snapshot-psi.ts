import { logWorkerEventArgs } from "../lib/structured-log";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getConditionBand } from "../lib/stability-index";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/stability-index";
import { round1 } from "@shared/lib/math";

export async function snapshotPsiDaily(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = bucketUnixSecondsToUtcDay(now);
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
    logWorkerEventArgs("handler", "error", "[snapshot-psi] DB query failed:", err);
    return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason: "db_query_failed", error: String(err).slice(0, 200) } });
  }

  if (!row || !row.cnt || row.avg_score == null) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "no-samples-for-yesterday", sampleCount: row?.cnt ?? 0 },
    });
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
  // stability_index is keyed by a surrogate `id`, so `computed_at` carries no
  // UNIQUE constraint for INSERT OR REPLACE to resolve against; a plain upsert
  // appends a second row for the day. Delete-then-insert in one batch keeps the
  // midnight-keyed row single-valued and is idempotent across re-runs.
  await db.batch([
    db.prepare("DELETE FROM stability_index WHERE computed_at = ?").bind(yesterdayMidnight),
    db
      .prepare(
        `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
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
      ),
  ]);
  throwIfAborted(signal);

  logWorkerEventArgs("handler", "info", `[snapshot-psi] yesterday avg=${score} band=${band} samples=${row.cnt}`);
  return { itemCount: 1, metadata: `avg=${score} band=${band} samples=${row.cnt}` };
}
