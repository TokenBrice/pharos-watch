import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { batchExecute } from "../lib/db";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
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

function buildHistoryInsert(
  db: D1Database,
  input: {
    stablecoinId: string;
    snapshotDay: number;
    grade: ReportCardGrade;
    score: number | null;
    prevGrade: ReportCardGrade | null;
    prevScore: number | null;
    methodologyVersion: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO safety_grade_history
       (stablecoin_id, recorded_at, grade, score, prev_grade, prev_score, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.stablecoinId,
      input.snapshotDay,
      input.grade,
      input.score,
      input.prevGrade,
      input.prevScore,
      input.methodologyVersion,
    );
}

export async function snapshotSafetyGradeHistory(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDay = Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS;
  const methodologyVersion = SAFETY_SCORE_METHODOLOGY_VERSION;

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
    throwIfAborted(signal);

    const latest = latestByCoin.get(card.id);

    if (!latest) {
      if (degradedReportCardInputs) {
        suppressedSeeds++;
        continue;
      }
      seeded++;
      stmts.push(
        buildHistoryInsert(db, {
          stablecoinId: card.id,
          snapshotDay,
          grade: card.overallGrade,
          score: card.overallScore,
          prevGrade: null,
          prevScore: null,
          methodologyVersion,
        }),
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
        buildHistoryInsert(db, {
          stablecoinId: card.id,
          snapshotDay,
          grade: card.overallGrade,
          score: card.overallScore,
          prevGrade: latest.grade,
          prevScore: latest.score,
          methodologyVersion,
        }),
      );
      continue;
    }

    skipped++;
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts, { signal });
  }
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
      reportCardCacheOwner: "publish-report-card-cache",
    }),
  };
}
