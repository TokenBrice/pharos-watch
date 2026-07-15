import { DAY_SECONDS } from "@shared/lib/time-constants";
import { batchExecute } from "../lib/db";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import type { ReportCardGrade } from "@shared/types/report-cards";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { ReportCardsResponse } from "@shared/types/report-cards";
import {
  fetchLatestSafetyScoreHistoryV2Rows,
  loadActiveV8SafetyScoreHistorySource,
  prepareV8OrganicSafetyScoreHistoryWrites,
  safetyScoreHistoryIdentitiesAreComparable,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";

interface LatestSafetyGradeRow {
  stablecoin_id: string;
  grade: ReportCardGrade;
  score: number | null;
  recorded_at: number;
}

function hasDegradedReportCardInputs(snapshot: ReportCardsResponse): boolean {
  if (!snapshot.inputFreshness) return true;
  return Boolean(
    snapshot.liquidityStale ||
    snapshot.redemptionStale ||
    snapshot.inputFreshness?.dexLiquidity.stale ||
    snapshot.inputFreshness?.redemptionBackstops.stale,
  );
}

export async function snapshotSafetyGradeHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDay = Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS;
  let source;
  try {
    source = await loadActiveV8SafetyScoreHistorySource(db, signal);
  } catch (err) {
    recordCronFailure("snapshot-safety-grade-history", err, {
      metadata: { stage: "loadActiveV8SafetyScoreHistorySource" },
    });
    return {
      status: "error" as const,
      itemCount: 0,
      metadata: JSON.stringify({ reason: "active-model-source-unavailable", error: String(err).slice(0, 200) }),
    };
  }
  const { snapshot, identity } = source;
  const methodologyVersion = identity.methodologyVersion;
  const liveCards = snapshot.cards.filter((card) => card.isDefunct !== true && !FROZEN_IDS.has(card.id));
  const degradedReportCardInputs = hasDegradedReportCardInputs(snapshot);

  const [latestRows, latestV2Rows] = await Promise.all([
    db
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
      .all<LatestSafetyGradeRow>(),
    fetchLatestSafetyScoreHistoryV2Rows(db),
  ]);

  const latestByCoin = new Map<string, LatestSafetyGradeRow>();
  for (const row of latestRows.results ?? []) {
    latestByCoin.set(row.stablecoin_id, row);
  }
  const latestV2ByCoin = new Map(latestV2Rows.map((row) => [row.stablecoin_id, row]));

  let seeded = 0;
  let changed = 0;
  let skipped = 0;
  let suppressedSeeds = 0;
  let suppressedTransitions = 0;
  let suppressedIdentityTransitions = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const card of liveCards) {
    throwIfAborted(signal);

    let latest = latestByCoin.get(card.id);
    const latestV2 = latestV2ByCoin.get(card.id);
    if (latestV2) {
      try {
        const latestIdentity = safetyScoreHistoryIdentityFromV2Row(latestV2);
        if (!safetyScoreHistoryIdentitiesAreComparable(identity, latestIdentity)) {
          suppressedIdentityTransitions++;
          continue;
        }
        latest = {
          stablecoin_id: latestV2.stablecoin_id,
          grade: latestV2.grade,
          score: latestV2.score,
          recorded_at: latestV2.recorded_at,
        };
      } catch {
        suppressedIdentityTransitions++;
        continue;
      }
    }

    if (!latest) {
      if (degradedReportCardInputs) {
        suppressedSeeds++;
        continue;
      }
      seeded++;
      stmts.push(
        ...prepareV8OrganicSafetyScoreHistoryWrites(db, {
          stablecoinId: card.id,
          recordedAt: snapshotDay,
          grade: card.overallGrade,
          score: card.overallScore,
          prevGrade: null,
          prevScore: null,
          transitionKind: "initial-baseline",
          identity,
          createdAt: nowSec,
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
        ...prepareV8OrganicSafetyScoreHistoryWrites(db, {
          stablecoinId: card.id,
          recordedAt: snapshotDay,
          grade: card.overallGrade,
          score: card.overallScore,
          prevGrade: latest.grade,
          prevScore: latest.score,
          transitionKind: "organic-grade-change",
          identity,
          createdAt: nowSec,
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
    ...(degradedReportCardInputs || suppressedIdentityTransitions > 0 ? { status: "degraded" as const } : {}),
    itemCount: seeded + changed,
    metadata: JSON.stringify({
      snapshotDay,
      methodologyVersion,
      model: identity.model,
      evaluationBuildDigest: identity.evaluationBuildDigest,
      baseInputGenerationId: identity.baseInputGenerationId,
      modelPublicationGenerationId: identity.publicationGenerationId,
      seeded,
      changed,
      v2RowsWritten: seeded + changed,
      skipped,
      degradedReportCardInputs,
      gradeHistorySuppressed: degradedReportCardInputs,
      suppressedSeeds,
      suppressedTransitions,
      identityHistorySuppressed: suppressedIdentityTransitions > 0,
      suppressedIdentityTransitions,
      reportCardCacheOwner: "publish-report-card-cache",
    }),
  };
}
