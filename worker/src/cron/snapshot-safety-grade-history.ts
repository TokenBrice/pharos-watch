import { SAFETY_SCORE_VERSION } from "@shared/lib/safety-score-version";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { batchExecute } from "../lib/db";
import type { CronResult } from "../lib/cron-logger";
import type { ReportCardGrade } from "@shared/types/report-cards";

interface LatestSafetyGradeRow {
  stablecoin_id: string;
  grade: ReportCardGrade;
  score: number | null;
  recorded_at: number;
}

export async function snapshotSafetyGradeHistory(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("snapshot-safety-grade-history aborted");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDay = Math.floor(nowSec / 86_400) * 86_400;
  const methodologyVersion = SAFETY_SCORE_VERSION;

  let snapshot;
  try {
    snapshot = await buildReportCardsSnapshot(db);
  } catch (err) {
    console.error("[snapshot-safety-grade-history] buildReportCardsSnapshot failed:", err);
    return {
      status: "error" as const,
      itemCount: 0,
      metadata: JSON.stringify({ reason: "snapshot-build-failed", error: String(err).slice(0, 200) }),
    };
  }
  const liveCards = snapshot.cards.filter((card) => card.isDefunct !== true);

  const latestRows = await db
    .prepare(
      `SELECT h.stablecoin_id, h.grade, h.score, h.recorded_at
         FROM safety_grade_history h
         INNER JOIN (
           SELECT stablecoin_id, MAX(recorded_at) AS max_recorded_at
           FROM safety_grade_history
           GROUP BY stablecoin_id
         ) latest
         ON latest.stablecoin_id = h.stablecoin_id
        AND latest.max_recorded_at = h.recorded_at`,
    )
    .all<LatestSafetyGradeRow>();

  const latestByCoin = new Map<string, LatestSafetyGradeRow>();
  for (const row of latestRows.results ?? []) {
    latestByCoin.set(row.stablecoin_id, row);
  }

  let seeded = 0;
  let changed = 0;
  let skipped = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const card of liveCards) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("snapshot-safety-grade-history aborted");
    }

    const latest = latestByCoin.get(card.id);

    if (!latest) {
      seeded++;
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO safety_grade_history
             (stablecoin_id, recorded_at, grade, score, prev_grade, prev_score, methodology_version)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            card.id,
            snapshotDay,
            card.overallGrade,
            card.overallScore,
            null,
            null,
            methodologyVersion,
          ),
      );
      continue;
    }

    if (latest.grade !== card.overallGrade) {
      changed++;
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO safety_grade_history
             (stablecoin_id, recorded_at, grade, score, prev_grade, prev_score, methodology_version)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            card.id,
            snapshotDay,
            card.overallGrade,
            card.overallScore,
            latest.grade,
            latest.score,
            methodologyVersion,
          ),
      );
      continue;
    }

    skipped++;
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }

  return {
    itemCount: stmts.length,
    metadata: JSON.stringify({
      snapshotDay,
      methodologyVersion,
      seeded,
      changed,
      skipped,
    }),
  };
}
