import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { batchExecute } from "../lib/db";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import {
  fetchLatestSafetyScoreHistoryV2Rows,
  prepareSafetyScoreHistoryBoundaryWrite,
  prepareSafetyScoreHistoryV2Write,
  safetyScoreHistoryIdentitiesAreComparable,
  safetyScoreHistoryIdentityFromV2Row,
} from "../lib/safety-score-history-v2";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";
import { loadSafetyScoreV9PublicationAttempt } from "../lib/safety-score-v9/publication-attempts";
import { isSafetyScoreV9SnapshotFresh } from "../lib/safety-score-v9/consumer-freshness";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { parseJson } from "../lib/json-parse";

const OPERATIONALLY_AFFECTED_HISTORY_CACHE_KEY =
  "safety-score-history:v2:operationally-affected";

function parseOperationallyAffectedAssetIds(value: string): string[] {
  const parsed = parseJson(value);
  const assetIds = parsed.ok ? parsed.value : null;
  if (
    !Array.isArray(assetIds) ||
    assetIds.some((assetId) => typeof assetId !== "string")
  ) {
    throw new Error(
      "Safety Score history operational state is malformed",
    );
  }
  return [...new Set(assetIds)].sort();
}

interface LegacySafetyGradeRow {
  stablecoin_id: string;
}

interface HistoryCard {
  id: string;
  grade: ReportCardGrade;
  score: number | null;
  operationallyAffected: boolean;
  recovering: boolean;
}

export async function snapshotSafetyGradeHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDay = bucketUnixSecondsToUtcDay(nowSec);
  let identity: SafetyScorePublicationIdentity;
  let liveCards: HistoryCard[];
  let degradedReportCardInputs: boolean;
  let pendingAffectedAssetIds: Set<string>;
  let previousAffectedCache:
    | { value: string; updatedAt: number }
    | null;
  try {
    const [active, attempt, affectedCache] = await Promise.all([
      loadActiveSafetyScoreIndex(db, signal),
      loadSafetyScoreV9PublicationAttempt(db, signal),
      getCache(db, OPERATIONALLY_AFFECTED_HISTORY_CACHE_KEY),
    ]);
    previousAffectedCache = affectedCache;
    if (active.kind === "error") {
      throw new Error(
        `Canonical Safety Score V9 source unavailable (${active.reason}): ${active.detail}`,
      );
    }
    if (active.kind === "held") {
      return createCronResult({
        status: "degraded" as const,
        itemCount: 0,
        metadata: { reason: active.reason, historyWritesSkipped: true },
      });
    }
    if (!isSafetyScoreV9SnapshotFresh(active.snapshot, nowSec)) {
      return createCronResult({
        status: "degraded" as const,
        itemCount: 0,
        metadata: { reason: "v9-publication-stale", historyWritesSkipped: true },
      });
    }
    identity = active.snapshot.safetyScoreIdentity;
    if (
      attempt?.outcome.startsWith("published-") &&
      attempt.publicationGenerationId !==
        identity.publicationGenerationId
    ) {
      throw new Error(
        "Safety Score v9 attempt metadata does not match the active publication",
      );
    }
    const currentAffectedAssetIds = new Set(
      attempt?.outcome === "published-partial"
        ? attempt.affectedAssetIds
        : [],
    );
    const previouslyAffectedAssetIds = new Set(
      affectedCache === null
        ? []
        : parseOperationallyAffectedAssetIds(affectedCache.value),
    );
    const currentAttemptPublished = attempt?.outcome === "published-clean" || attempt?.outcome === "published-partial";
    liveCards = active.snapshot.cards
      .filter((card) => !FROZEN_IDS.has(card.id))
      .flatMap((card) => card.ratingStatus === "pipeline-gap" || card.grade === null ? [] : [{
        id: card.id,
        grade: card.grade,
        score: card.score,
        operationallyAffected:
          currentAffectedAssetIds.has(card.id) ||
          previouslyAffectedAssetIds.has(card.id),
        recovering: currentAttemptPublished && previouslyAffectedAssetIds.has(card.id) && !currentAffectedAssetIds.has(card.id),
      }]);
    pendingAffectedAssetIds = new Set([...currentAffectedAssetIds, ...previouslyAffectedAssetIds]);
    degradedReportCardInputs = liveCards.some(
      (card) => card.operationallyAffected,
    );
  } catch (err) {
    recordCronFailure("snapshot-safety-grade-history", err, {
      metadata: { stage: "loadActiveSafetyScoreIndex" },
    });
    return createCronResult({
      status: "error" as const,
      itemCount: 0,
      metadata: { reason: "active-model-source-unavailable", error: String(err).slice(0, 200) },
    });
  }
  const methodologyVersion = identity.methodologyVersion;

  const [legacyRows, latestV2Rows] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT stablecoin_id
           FROM safety_grade_history`,
      )
      .all<LegacySafetyGradeRow>(),
    fetchLatestSafetyScoreHistoryV2Rows(db),
  ]);

  const legacyCoinIds = new Set(
    (legacyRows.results ?? []).map((row) => row.stablecoin_id),
  );
  const latestV2ByCoin = new Map(latestV2Rows.map((row) => [row.stablecoin_id, row]));

  let seeded = 0;
  let changed = 0;
  let skipped = 0;
  let suppressedSeeds = 0;
  let suppressedTransitions = 0;
  let suppressedIdentityTransitions = 0;
  let identityBoundaryBaselines = 0;
  let recoveryBaselines = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const card of liveCards) {
    throwIfAborted(signal);

    let latest: { grade: ReportCardGrade; score: number | null } | undefined;
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
            grade: latestV2.grade,
            score: latestV2.score,
          };
          previousIdentity = latestIdentity;
        }
      } catch {
        suppressedIdentityTransitions++;
        continue;
      }
    } else if (legacyCoinIds.has(card.id)) {
      // Legacy rows have no complete publication identity, so they cannot
      // establish an organic predecessor for the current V9 snapshot.
      requiresIdentityBoundary = true;
    }

    const alreadyRestored = card.recovering && latestV2?.transition_kind === "restoration-baseline" &&
      previousAffectedCache !== null && latestV2.recorded_at >= previousAffectedCache.updatedAt;
    if (alreadyRestored) pendingAffectedAssetIds.delete(card.id);
    const operationallyAffected = card.operationallyAffected && !alreadyRestored;
    const recordedAt = latestV2 && latestV2.recorded_at >= snapshotDay
      ? Math.max(nowSec, latestV2.recorded_at + 1) : snapshotDay;
    if (card.recovering && !alreadyRestored) {
      // Pin the clean observation so a retry can recognize a committed recovery.
      recoveryBaselines++;
      stmts.push(prepareSafetyScoreHistoryBoundaryWrite(db, {
        stablecoinId: card.id,
        recordedAt: Math.max(recordedAt, nowSec),
        grade: card.grade,
        score: card.score,
        transitionKind: "restoration-baseline",
        identity,
        createdAt: nowSec,
      }));
      pendingAffectedAssetIds.delete(card.id);
      continue;
    }

    if (requiresIdentityBoundary) {
      if (operationallyAffected) {
        suppressedIdentityTransitions++;
        suppressedTransitions++;
        continue;
      }
      identityBoundaryBaselines++;
      stmts.push(
        prepareSafetyScoreHistoryBoundaryWrite(db, {
          stablecoinId: card.id,
          recordedAt,
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
      if (operationallyAffected) {
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
      if (operationallyAffected) {
        suppressedTransitions++;
        continue;
      }
      changed++;
      stmts.push(prepareSafetyScoreHistoryV2Write(db, {
        stablecoinId: card.id,
        recordedAt,
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
  if (pendingAffectedAssetIds.size > 0) {
    await setCache(
      db,
      OPERATIONALLY_AFFECTED_HISTORY_CACHE_KEY,
      JSON.stringify([...pendingAffectedAssetIds].sort()),
      signal,
    );
  } else if (previousAffectedCache !== null) {
    await deleteCache(
      db,
      OPERATIONALLY_AFFECTED_HISTORY_CACHE_KEY,
    );
  }
  return createCronResult({
    ...(degradedReportCardInputs || suppressedIdentityTransitions > 0 ? { status: "degraded" as const } : {}),
    itemCount: seeded + changed + identityBoundaryBaselines + recoveryBaselines,
    // A completed scan is a confirmed observation even when no grade moved:
    // `outputPublishedAt` advances so producer freshness measures delivery,
    // not grade volatility. The held/stale early returns above stay clockless.
    productivity: { productive: true, reason: "grade-history-complete" },
    metadata: {
      reason: degradedReportCardInputs
        ? "degraded-report-card-inputs"
        : suppressedIdentityTransitions > 0
          ? "identity-transitions-suppressed"
          : "grade-history-completed",
      outputPublishedAt: nowSec,
      snapshotDay,
      methodologyVersion,
      model: identity.model,
      evaluationBuildDigest: identity.evaluationBuildDigest,
      baseInputGenerationId: identity.baseInputGenerationId,
      modelPublicationGenerationId: identity.publicationGenerationId,
      seeded,
      changed,
      v2RowsWritten: seeded + changed + identityBoundaryBaselines + recoveryBaselines,
      recoveryBaselines,
      skipped,
      degradedReportCardInputs,
      gradeHistorySuppressed: degradedReportCardInputs,
      suppressedSeeds,
      suppressedTransitions,
      identityHistorySuppressed: suppressedIdentityTransitions > 0,
      suppressedIdentityTransitions,
      identityBoundaryBaselines,
      publicationOwner: "compute-safety-score-v9",
    },
  });
}
