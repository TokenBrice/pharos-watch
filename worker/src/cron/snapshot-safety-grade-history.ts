import { DAY_SECONDS } from "@shared/lib/time-constants";
import { batchExecute } from "../lib/db";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import type { ReportCardGrade } from "@shared/types/report-cards";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import {
  fetchLatestSafetyScoreHistoryV2Rows,
  prepareSafetyScoreHistoryBoundaryWrite,
  prepareSafetyScoreHistoryV2Write,
  safetyScoreHistoryIdentitiesAreComparable,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";

interface LatestSafetyGradeRow {
  stablecoin_id: string;
  grade: ReportCardGrade;
  score: number | null;
  recorded_at: number;
}

interface HistoryCard {
  id: string;
  grade: ReportCardGrade;
  score: number | null;
}

export async function snapshotSafetyGradeHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDay = Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS;
  let identity: SafetyScorePublicationIdentity;
  let liveCards: HistoryCard[];
  let degradedReportCardInputs: boolean;
  try {
    const active = await loadActiveSafetyScoreSource(db, signal);
    if (active.kind === "error") {
      throw new Error(
        `Canonical Safety Score V9 source unavailable (${active.reason}): ${active.detail}`,
      );
    }
    if (active.snapshot.publicationHealth.status === "held") {
      return {
        status: "degraded" as const,
        itemCount: 0,
        metadata: JSON.stringify({
          reason: "v9-publication-held",
          expectedModel: "v9",
          historyWritesSkipped: true,
        }),
      };
    }
    identity = active.snapshot.safetyScoreIdentity;
    liveCards = active.snapshot.cards
      .filter((card) => !FROZEN_IDS.has(card.id))
      .map((card) => ({
        id: card.id,
        grade: card.grade,
        score: card.score,
      }));
    degradedReportCardInputs = false;
  } catch (err) {
    recordCronFailure("snapshot-safety-grade-history", err, {
      metadata: { stage: "loadActiveSafetyScoreSource" },
    });
    return {
      status: "error" as const,
      itemCount: 0,
      metadata: JSON.stringify({ reason: "active-model-source-unavailable", error: String(err).slice(0, 200) }),
    };
  }
  const methodologyVersion = identity.methodologyVersion;

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
  let identityBoundaryBaselines = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const card of liveCards) {
    throwIfAborted(signal);

    let latest = latestByCoin.get(card.id);
    const latestV2 = latestV2ByCoin.get(card.id);
    let requiresIdentityBoundary = false;
    let previousIdentity: SafetyScorePublicationIdentity | null = null;
    if (latestV2) {
      try {
        const latestIdentity = safetyScoreHistoryIdentityFromV2Row(latestV2);
        if (!safetyScoreHistoryIdentitiesAreComparable(identity, latestIdentity)) {
          requiresIdentityBoundary = true;
        } else {
          latest = {
            stablecoin_id: latestV2.stablecoin_id,
            grade: latestV2.grade,
            score: latestV2.score,
            recorded_at: latestV2.recorded_at,
          };
          previousIdentity = latestIdentity;
        }
      } catch {
        suppressedIdentityTransitions++;
        continue;
      }
    } else if (latest) {
      // Legacy rows have no complete publication identity, so they cannot
      // establish an organic predecessor for the current V9 snapshot.
      requiresIdentityBoundary = true;
    }

    if (requiresIdentityBoundary) {
      if (degradedReportCardInputs) {
        suppressedIdentityTransitions++;
        suppressedTransitions++;
        continue;
      }
      identityBoundaryBaselines++;
      stmts.push(
        prepareSafetyScoreHistoryBoundaryWrite(db, {
          stablecoinId: card.id,
          recordedAt: snapshotDay,
          grade: card.grade,
          score: card.score,
          transitionKind: "methodology-boundary-baseline",
          identity,
          createdAt: nowSec,
        }),
      );
      continue;
    }

    if (!latest) {
      if (degradedReportCardInputs) {
        suppressedSeeds++;
        continue;
      }
      seeded++;
      stmts.push(prepareSafetyScoreHistoryV2Write(db, {
        stablecoinId: card.id,
        recordedAt: snapshotDay,
        grade: card.grade,
        score: card.score,
        prevGrade: null,
        prevScore: null,
        transitionKind: "initial-baseline",
        identity,
        createdAt: nowSec,
      }));
      continue;
    }

    if (latest.grade !== card.grade) {
      if (degradedReportCardInputs) {
        suppressedTransitions++;
        continue;
      }
      changed++;
      if (previousIdentity === null) {
        suppressedIdentityTransitions++;
        suppressedTransitions++;
        changed--;
        continue;
      }
      stmts.push(prepareSafetyScoreHistoryV2Write(db, {
        stablecoinId: card.id,
        recordedAt: snapshotDay,
        grade: card.grade,
        score: card.score,
        prevGrade: latest.grade,
        prevScore: latest.score,
        transitionKind: "organic-grade-change",
        identity,
        previousIdentity,
        createdAt: nowSec,
      }));
      continue;
    }

    skipped++;
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts, { signal });
  }
  return {
    ...(degradedReportCardInputs || suppressedIdentityTransitions > 0 ? { status: "degraded" as const } : {}),
    itemCount: seeded + changed + identityBoundaryBaselines,
    metadata: JSON.stringify({
      snapshotDay,
      methodologyVersion,
      model: identity.model,
      evaluationBuildDigest: identity.evaluationBuildDigest,
      baseInputGenerationId: identity.baseInputGenerationId,
      modelPublicationGenerationId: identity.publicationGenerationId,
      seeded,
      changed,
      v2RowsWritten: seeded + changed + identityBoundaryBaselines,
      skipped,
      degradedReportCardInputs,
      gradeHistorySuppressed: degradedReportCardInputs,
      suppressedSeeds,
      suppressedTransitions,
      identityHistorySuppressed: suppressedIdentityTransitions > 0,
      suppressedIdentityTransitions,
      identityBoundaryBaselines,
      publicationOwner: "compute-safety-score-v9",
    }),
  };
}
