import { SAFETY_SCORE_VERSION } from "@shared/lib/safety-score-version";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { batchExecute } from "../lib/db";
import { writeReportCardCache } from "../lib/report-card-cache";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import type { ReportCardGrade } from "@shared/types/report-cards";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { ReportCardsSnapshot } from "../lib/report-cards-snapshot";

interface LatestSafetyGradeRow {
  stablecoin_id: string;
  grade: ReportCardGrade;
  score: number | null;
  recorded_at: number;
}

function hasDegradedReportCardInputs(snapshot: ReportCardsSnapshot): boolean {
  return Boolean(
    snapshot.liquidityStale
    || snapshot.redemptionStale
    || snapshot.inputFreshness.dexLiquidity.stale
    || snapshot.inputFreshness.redemptionBackstops.stale,
  );
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
    recordCronFailure("snapshot-safety-grade-history", err, { metadata: { stage: "buildReportCardsSnapshot" } });
    return {
      status: "error" as const,
      itemCount: 0,
      metadata: JSON.stringify({ reason: "snapshot-build-failed", error: String(err).slice(0, 200) }),
    };
  }
  const liveCards = snapshot.cards.filter(
    (card) => card.isDefunct !== true && !FROZEN_IDS.has(card.id),
  );
  const degradedReportCardInputs = hasDegradedReportCardInputs(snapshot);

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
  let suppressedSeeds = 0;
  let suppressedTransitions = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const card of liveCards) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("snapshot-safety-grade-history aborted");
    }

    const latest = latestByCoin.get(card.id);

    if (!latest) {
      if (degradedReportCardInputs) {
        suppressedSeeds++;
        continue;
      }
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
      if (degradedReportCardInputs) {
        suppressedTransitions++;
        continue;
      }
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
    await batchExecute(db, stmts, { signal });
  }
  const cacheResult = await writeReportCardCache(db, snapshot.cards, snapshot.updatedAt, {
    liquidityStale: snapshot.liquidityStale,
    redemptionStale: snapshot.redemptionStale,
    inputFreshness: snapshot.inputFreshness,
  });

  return {
    ...(degradedReportCardInputs ? { status: "degraded" as const } : {}),
    itemCount: stmts.length,
    metadata: JSON.stringify({
      snapshotDay,
      methodologyVersion,
      seeded,
      changed,
      skipped,
      degradedReportCardInputs,
      gradeHistorySuppressed: degradedReportCardInputs,
      suppressedSeeds,
      suppressedTransitions,
      reportCardCacheRows: cacheResult.writtenCount,
    }),
  };
}
