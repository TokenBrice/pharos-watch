/**
 * score.upgraded / score.downgraded projectors. Sources: the version-aware
 * Safety Score history plus legacy rows that have not been dual-written.
 * Methodology-boundary baselines are never projected as organic movements.
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  ScoreTapeEventPayloadSchema,
  type SafetyScoreTapeProvenance,
} from "@shared/types/tape-event";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL } from "../safety-score-history-v2";
import { buildTapeEventId, deriveIssuerId, gradeRank, severityForScoreDowngrade } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";
import {
  finalizeProjectorBatch,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

interface SafetyGradeSourceRow {
  stablecoin_id: string;
  recorded_at: number;
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  methodology_version: string;
  transition_kind: "organic-grade-change";
  model: "v8" | "v9";
  identity_schema_version: number;
  policy_id: string | null;
  policy_digest: string | null;
  evaluation_build_digest: string | null;
  base_input_generation_id: string | null;
  model_publication_generation_id: string | null;
  source_table: "safety_grade_history" | "safety_score_history_v2";
  source_row_id: string;
  row_sort_id: string;
}

function scoreProvenance(row: SafetyGradeSourceRow): SafetyScoreTapeProvenance | null {
  const hasPersistedIdentity =
    row.evaluation_build_digest !== null ||
    row.base_input_generation_id !== null ||
    row.model_publication_generation_id !== null ||
    row.policy_id !== null ||
    row.policy_digest !== null;
  if (row.source_table === "safety_grade_history" && !hasPersistedIdentity) {
    return {
      identityStatus: "legacy-v8-unidentified",
      identity: null,
    };
  }

  if (row.source_table === "safety_grade_history" && row.model !== "v8") return null;

  if (
    row.evaluation_build_digest === null ||
    row.base_input_generation_id === null ||
    row.model_publication_generation_id === null
  ) {
    return null;
  }

  if (row.model === "v8") {
    if (row.policy_id !== null || row.policy_digest !== null) return null;
    const identity = SafetyScorePublicationIdentitySchema.safeParse({
      model: "v8",
      schemaVersion: row.identity_schema_version,
      methodologyVersion: row.methodology_version,
      evaluationBuildDigest: row.evaluation_build_digest,
      baseInputGenerationId: row.base_input_generation_id,
      publicationGenerationId: row.model_publication_generation_id,
    });
    if (!identity.success) return null;
    return {
      identityStatus: "complete",
      identity: identity.data,
    };
  }

  if (row.policy_id === null || row.policy_digest === null) return null;
  const identity = SafetyScorePublicationIdentitySchema.safeParse({
    model: "v9",
    schemaVersion: row.identity_schema_version,
    methodologyVersion: row.methodology_version,
    policyId: row.policy_id,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    baseInputGenerationId: row.base_input_generation_id,
    publicationGenerationId: row.model_publication_generation_id,
  });
  if (!identity.success) return null;
  return {
    identityStatus: "complete",
    identity: identity.data,
  };
}

function coinSourceUrl(coinId: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/#report-card`;
}

async function fetchGradeRowsSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<SafetyGradeSourceRow[]> {
  return fetchRowsWithTieExpansion<SafetyGradeSourceRow>(db, {
    selectSql: `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score,
                      methodology_version, transition_kind, model, identity_schema_version, policy_id, policy_digest,
                      evaluation_build_digest, base_input_generation_id,
                      model_publication_generation_id, source_table, source_row_id,
                      row_sort_id`,
    fromSql: SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL,
    timePredicatePrefix: "prev_grade IS NOT NULL AND ",
    timeColumn: "recorded_at",
    orderBySql: "recorded_at ASC, row_sort_id ASC",
    since,
    until,
    limit,
    getTime: (row) => row.recorded_at,
  });
}

async function projectScoreByVariant(
  db: D1Database,
  variant: "upgraded" | "downgraded",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = variant === "upgraded" ? "score.upgraded" : "score.downgraded";
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchGradeRowsSince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    if (row.recorded_at > maxCursor) maxCursor = row.recorded_at;
    if (row.transition_kind !== "organic-grade-change") continue;
    if (!row.prev_grade) continue;
    const safetyScore = scoreProvenance(row);
    // V9 rows without a complete persisted identity are not projectable.
    if (!safetyScore) continue;
    const prevRank = gradeRank(row.prev_grade);
    const newRank = gradeRank(row.grade);
    if (prevRank === newRank) continue;
    const isUpgrade = newRank > prevRank;
    if (variant === "upgraded" && !isUpgrade) continue;
    if (variant === "downgraded" && isUpgrade) continue;

    const tsMs = row.recorded_at * 1000;
    const type = variant === "upgraded" ? "score.upgraded" : "score.downgraded";
    const severity = variant === "upgraded" ? ("info" as const) : severityForScoreDowngrade(row.prev_grade, row.grade);
    const transition = "updated";
    const sourceRowId = row.source_row_id;

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type,
        sourceTable: row.source_table,
        sourceRowId,
        transition,
      }),
      type,
      severity,
      ts: tsMs,
      endsAt: null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: null,
      chain: null,
      title: `${TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id} grade ${row.prev_grade} → ${row.grade}`,
      summary: `Safety grade ${isUpgrade ? "upgraded" : "downgraded"} from ${row.prev_grade} to ${row.grade}.`,
      payload: ScoreTapeEventPayloadSchema.parse({
        prevGrade: row.prev_grade,
        newGrade: row.grade,
        prevScore: row.prev_score,
        newScore: row.score,
        safetyScore,
      }),
      sourceTable: row.source_table,
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id),
      methodologyVersion: row.methodology_version,
    });
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}

export function projectScoreUpgraded(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectScoreByVariant(db, "upgraded", options);
}

export function projectScoreDowngraded(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectScoreByVariant(db, "downgraded", options);
}
