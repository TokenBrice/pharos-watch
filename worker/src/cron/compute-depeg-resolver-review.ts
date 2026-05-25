import { reviewDepegResolverAssessments } from "@shared/lib/depeg-resolver-review";
import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-resolver-version";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  DDRR_PUBLIC_WARNING,
  DDRR_REVIEWER_VERSION,
  DdrrAssessmentSchema,
  type DdrrActualEvent,
  type DdrrAssessment,
  type DdrrResponse,
  type DdrrSummary,
} from "@shared/types/depeg-resolver-review";
import { buildMethodologyEnvelope } from "../lib/api-utils";
import type { CronResult } from "../lib/cron-logger";
import { buildInClause, chunkArray } from "../lib/db";
import { writeDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";

const DDRR_SNAPSHOT_TTL_SEC = 1800;
const DDRR_ASSESSMENT_ROW_CAP = 20_000;
const DDRR_PUBLIC_ROW_CAP = 100;

interface AssessmentDbRow {
  event_id: number;
  stablecoin_id: string;
  symbol: string;
  name: string;
  peg_currency: string;
  governance: string;
  direction: "above" | "below";
  started_at: number;
  assessed_at: number;
  event_age_sec: number;
  checkpoint: DdrrAssessment["checkpoint"];
  methodology_version: string;
  resolution_tier: DdrrAssessment["resolutionTier"];
  duration_suppressed: number;
  duration_suppressed_reason: string | null;
  median_remaining_sec: number | null;
  iqr_low_remaining_sec: number | null;
  iqr_high_remaining_sec: number | null;
  stratum: string | null;
  horizons_json: string;
  factors_json: string;
}

interface ActualEventDbRow {
  id: number;
  stablecoin_id: string;
  started_at: number;
  ended_at: number | null;
  recovery_price: number | null;
}

export function buildEmptyDdrrSummary(): DdrrSummary {
  return {
    recoveryLikelihoodCorrectCount: 0,
    recoveryLikelihoodScoredCount: 0,
    recoveryLikelihoodAccuracyPct: null,
    durationScoredCount: 0,
    averageSignedDurationErrorSec: null,
    averageAbsoluteDurationErrorSec: null,
    correctRecoverable: 0,
    correctTerminal: 0,
    falseTerminal: 0,
    falseRecoverable: 0,
    riskNotedTerminal: 0,
    unscoredInsufficientSignal: 0,
    pending: 0,
    dataIssue: 0,
    verdictScoredCount: 0,
    durationUnscoredCount: 0,
    withinIqrCount: 0,
    iqrScoredCount: 0,
    withinIqrPct: null,
    medianAbsoluteErrorSec: null,
    horizonHitRates: [
      { horizon: "6h", scored: 0, hits: 0, misses: 0, hitRate: null },
      { horizon: "24h", scored: 0, hits: 0, misses: 0, hitRate: null },
      { horizon: "7d", scored: 0, hits: 0, misses: 0, hitRate: null },
      { horizon: "30d", scored: 0, hits: 0, misses: 0, hitRate: null },
    ],
  };
}

function abortIf(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);
}

function safeJsonParse(value: string): unknown {
  return JSON.parse(value);
}

function toIqrRemainingSec(row: AssessmentDbRow): DdrrAssessment["iqrRemainingSec"] {
  if (row.iqr_low_remaining_sec == null || row.iqr_high_remaining_sec == null) return null;
  return [row.iqr_low_remaining_sec, row.iqr_high_remaining_sec];
}

function parseAssessmentRow(row: AssessmentDbRow): DdrrAssessment | null {
  const parsed = DdrrAssessmentSchema.safeParse({
    eventId: row.event_id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.peg_currency,
    governance: row.governance,
    direction: row.direction,
    startedAt: row.started_at,
    assessedAt: row.assessed_at,
    eventAgeSec: row.event_age_sec,
    checkpoint: row.checkpoint,
    methodologyVersion: row.methodology_version,
    resolutionTier: row.resolution_tier,
    durationSuppressed: row.duration_suppressed === 1,
    durationSuppressedReason: row.duration_suppressed_reason,
    predictedRemainingSec: row.median_remaining_sec,
    iqrRemainingSec: toIqrRemainingSec(row),
    horizonCells: safeJsonParse(row.horizons_json),
    stratum: row.stratum,
    factors: safeJsonParse(row.factors_json),
  });

  return parsed.success ? parsed.data : null;
}

async function loadAssessments(
  db: D1Database,
): Promise<{ assessments: DdrrAssessment[]; parseIssueCount: number; truncated: boolean }> {
  const result = await db
    .prepare(
      `SELECT event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
              started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
              resolution_tier, duration_suppressed, duration_suppressed_reason,
              median_remaining_sec, iqr_low_remaining_sec, iqr_high_remaining_sec,
              stratum, horizons_json, factors_json
       FROM depeg_resolver_assessments
       WHERE checkpoint = 'first' AND methodology_version = ?
       ORDER BY started_at DESC, event_id DESC, assessed_at ASC, checkpoint ASC
       LIMIT ?`,
    )
    .bind(DDR_METHODOLOGY_VERSION, DDRR_ASSESSMENT_ROW_CAP + 1)
    .all<AssessmentDbRow>();

  const sourceRows = result.results ?? [];
  const truncated = sourceRows.length > DDRR_ASSESSMENT_ROW_CAP;
  const assessments: DdrrAssessment[] = [];
  let parseIssueCount = 0;
  for (const row of sourceRows.slice(0, DDRR_ASSESSMENT_ROW_CAP)) {
    try {
      const assessment = parseAssessmentRow(row);
      if (assessment) assessments.push(assessment);
      else parseIssueCount += 1;
    } catch {
      parseIssueCount += 1;
    }
  }
  return { assessments, parseIssueCount, truncated };
}

async function loadActualEventsById(
  db: D1Database,
  assessments: readonly DdrrAssessment[],
): Promise<Map<number, DdrrActualEvent>> {
  const eventIds = [...new Set(assessments.map((assessment) => assessment.eventId))];
  const actualEventsById = new Map<number, DdrrActualEvent>();

  for (const ids of chunkArray(eventIds)) {
    const inClause = buildInClause(ids);
    const result = await db
      .prepare(
        `SELECT id, stablecoin_id, started_at, ended_at, recovery_price
         FROM depeg_events
         WHERE id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ActualEventDbRow>();

    for (const row of result.results ?? []) {
      actualEventsById.set(row.id, {
        eventId: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        recoveryPrice: row.recovery_price,
        stablecoinStatus: TRACKED_META_BY_ID.get(row.stablecoin_id)?.status ?? null,
        terminalObserved: null,
      });
    }
  }

  return actualEventsById;
}

export async function buildDepegResolverReviewSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  signal?: AbortSignal,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const { assessments, parseIssueCount, truncated: assessmentRowsTruncated } = await loadAssessments(db);
  abortIf(signal, "compute-depeg-resolver-review");

  const actualEventsById = await loadActualEventsById(db, assessments);
  abortIf(signal, "compute-depeg-resolver-review");

  const { rows, summary } = assessments.length
    ? reviewDepegResolverAssessments({ assessments, actualEventsById, nowSec })
    : { rows: [], summary: buildEmptyDdrrSummary() };
  const publicRows = rows.slice(0, DDRR_PUBLIC_ROW_CAP);
  const publicRowsTruncated = rows.length > publicRows.length;
  const methodologyVersions = [...new Set(assessments.map((assessment) => assessment.methodologyVersion))].sort();
  const degradedReasons = [
    parseIssueCount > 0 ? "invalid-assessment-row" : null,
    assessmentRowsTruncated ? "assessment-row-cap" : null,
  ].filter((reason): reason is string => reason != null);

  return {
    _meta: {
      computedAt: nowSec,
      expiresAt: nowSec + DDRR_SNAPSHOT_TTL_SEC,
      degraded: degradedReasons.length > 0,
      degradedReason: degradedReasons.length > 0 ? degradedReasons.join(",") : null,
      reviewerVersion: DDRR_REVIEWER_VERSION,
      publicWarning: DDRR_PUBLIC_WARNING,
      assessedEventCount: new Set(assessments.map((assessment) => assessment.eventId)).size,
      reviewedEventCount: rows.length,
      pendingEventCount: summary.pending,
      durationScoredCount: summary.durationScoredCount,
      verdictScoredCount: summary.verdictScoredCount,
      assessmentRowLimit: DDRR_ASSESSMENT_ROW_CAP,
      assessmentRowsTruncated,
      publicRowLimit: DDRR_PUBLIC_ROW_CAP,
      publicRowsTruncated,
      methodologyVersions,
    },
    summary,
    rows: publicRows,
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: nowSec,
    }),
  };
}

export async function computeAndStoreDepegResolverReview(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  const snapshot = await buildDepegResolverReviewSnapshot(db, Math.floor(Date.now() / 1000), signal);
  await writeDepegResolverReviewSnapshot(db, snapshot);

  return {
    itemCount: snapshot._meta.reviewedEventCount,
    metadata: JSON.stringify({
      assessedEvents: snapshot._meta.assessedEventCount,
      reviewedRows: snapshot._meta.reviewedEventCount,
      publicRows: snapshot.rows.length,
      verdictScored: snapshot.summary.recoveryLikelihoodScoredCount,
      durationScored: snapshot.summary.durationScoredCount,
      degraded: snapshot._meta.degraded,
      degradedReason: snapshot._meta.degradedReason,
      assessmentRowsTruncated: snapshot._meta.assessmentRowsTruncated,
      publicRowsTruncated: snapshot._meta.publicRowsTruncated,
    }),
  };
}
