import type { ReportCardGrade } from "@shared/types/report-cards";
import {
  safetyScorePublicationIdentitiesAreComparable,
  safetyScorePublicationIdentitiesMatch,
} from "@shared/lib/safety-score-publication";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";

export type SafetyScoreHistoryV2TransitionKind =
  | "initial-baseline"
  | "organic-grade-change"
  | "methodology-boundary-baseline"
  | "rollback-baseline"
  | "restoration-baseline";

export type SafetyScoreHistoryV8Identity = SafetyScoreV8PublicationIdentity;
export type SafetyScoreHistoryIdentity = SafetyScorePublicationIdentity;

export interface SafetyScoreHistoryCompatibilityRow {
  recorded_at: number;
  grade: ReportCardGrade;
  score: number | null;
  prev_grade: ReportCardGrade | null;
  prev_score: number | null;
  methodology_version: string;
}

export interface SafetyScoreHistoryV2Row {
  history_id: string;
  stablecoin_id: string;
  recorded_at: number;
  model: SafetyScoreHistoryIdentity["model"];
  identity_schema_version: number;
  methodology_version: string;
  policy_id: string | null;
  policy_digest: string | null;
  evaluation_build_digest: string;
  base_input_generation_id: string;
  model_publication_generation_id: string;
  transition_kind: SafetyScoreHistoryV2TransitionKind;
  grade: ReportCardGrade;
  score: number | null;
  prev_grade: ReportCardGrade | null;
  prev_score: number | null;
}

export function safetyScoreHistoryIdentitiesMatch(
  left: SafetyScoreHistoryIdentity,
  right: SafetyScoreHistoryIdentity,
): boolean {
  return safetyScorePublicationIdentitiesMatch(left, right);
}

/**
 * Determines whether two history rows may represent one organic score series.
 * Publication and base-input generations change with ordinary refreshed data;
 * their exact values remain on each row but do not create a methodology boundary.
 */
export function safetyScoreHistoryIdentitiesAreComparable(
  left: SafetyScoreHistoryIdentity,
  right: SafetyScoreHistoryIdentity,
): boolean {
  return safetyScorePublicationIdentitiesAreComparable(left, right);
}

export function safetyScoreLegacyHistoryV2Id(stablecoinId: string, recordedAt: number): string {
  return `safety-score-history:v2:legacy:${encodeURIComponent(stablecoinId)}:${recordedAt}`;
}

function safetyScoreHistoryV2Id(input: {
  stablecoinId: string;
  recordedAt: number;
  identity: SafetyScoreHistoryIdentity;
}): string {
  return [
    "safety-score-history:v2",
    input.identity.model,
    input.identity.schemaVersion,
    encodeURIComponent(input.stablecoinId),
    input.recordedAt,
    encodeURIComponent(input.identity.publicationGenerationId),
  ].join(":");
}

export interface SafetyScoreHistoryV2WriteInput {
  stablecoinId: string;
  recordedAt: number;
  grade: ReportCardGrade;
  score: number | null;
  prevGrade: ReportCardGrade | null;
  prevScore: number | null;
  transitionKind: SafetyScoreHistoryV2TransitionKind;
  identity: SafetyScoreHistoryIdentity;
  /** Required for an organic row so callers cannot relabel a model cutover as a score movement. */
  previousIdentity?: SafetyScoreHistoryIdentity | null;
  createdAt: number;
  historyId?: string;
  legacyRecordedAt?: number | null;
}

function validateSafetyScoreHistoryV2Write(input: SafetyScoreHistoryV2WriteInput): SafetyScoreHistoryIdentity {
  const identity = SafetyScorePublicationIdentitySchema.parse(input.identity);
  const previousIdentity = input.previousIdentity == null
    ? null
    : SafetyScorePublicationIdentitySchema.parse(input.previousIdentity);
  if (input.transitionKind === "organic-grade-change") {
    if (input.prevGrade === null) {
      throw new Error("An organic Safety Score grade change requires a previous grade");
    }
    if (previousIdentity == null) {
      throw new Error("An organic Safety Score grade change requires a previous identity");
    }
    if (!safetyScoreHistoryIdentitiesAreComparable(previousIdentity, identity)) {
      throw new Error("An organic Safety Score grade change cannot cross model or policy identities");
    }
  }
  if (input.transitionKind !== "organic-grade-change" && (input.prevGrade !== null || input.prevScore !== null)) {
    throw new Error("A non-organic Safety Score baseline cannot carry comparable previous values");
  }
  if (input.transitionKind !== "organic-grade-change" && previousIdentity != null) {
    throw new Error("A non-organic Safety Score baseline cannot carry a previous identity");
  }
  if (
    input.legacyRecordedAt != null &&
    input.transitionKind !== "initial-baseline" &&
    input.transitionKind !== "organic-grade-change"
  ) {
    throw new Error("Only initial and organic Safety Score rows may have a legacy projection");
  }
  if (input.identity.model !== "v8" && input.legacyRecordedAt != null) {
    throw new Error("Only Safety Score V8 rows may have a legacy projection");
  }
  return identity;
}

/**
 * Writes one identity-rich V2 row. A conflicting replay deliberately turns
 * the non-null `created_at` column into a failed write rather than mutating
 * history with a different model or publication identity.
 */
export function prepareSafetyScoreHistoryV2Write(
  db: D1Database,
  input: SafetyScoreHistoryV2WriteInput,
): D1PreparedStatement {
  const identity = validateSafetyScoreHistoryV2Write(input);
  const historyId = input.historyId ?? safetyScoreHistoryV2Id({
    stablecoinId: input.stablecoinId,
    recordedAt: input.recordedAt,
    identity,
  });

  return db
    .prepare(
      `INSERT INTO safety_score_history_v2
       (history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version,
        policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
        model_publication_generation_id, transition_kind,
        grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(history_id) DO UPDATE SET
         created_at = CASE
           WHEN stablecoin_id = excluded.stablecoin_id
            AND recorded_at = excluded.recorded_at
            AND model = excluded.model
            AND identity_schema_version = excluded.identity_schema_version
            AND methodology_version = excluded.methodology_version
            AND policy_id IS excluded.policy_id
            AND policy_digest IS excluded.policy_digest
            AND evaluation_build_digest = excluded.evaluation_build_digest
            AND base_input_generation_id = excluded.base_input_generation_id
            AND model_publication_generation_id = excluded.model_publication_generation_id
            AND transition_kind = excluded.transition_kind
            AND grade = excluded.grade
            AND score IS excluded.score
            AND prev_grade IS excluded.prev_grade
            AND prev_score IS excluded.prev_score
            AND legacy_recorded_at IS excluded.legacy_recorded_at
           THEN MIN(created_at, excluded.created_at)
           ELSE NULL
         END`,
    )
    .bind(
      historyId,
      input.stablecoinId,
      input.recordedAt,
      identity.model,
      identity.schemaVersion,
      identity.methodologyVersion,
      identity.model === "v9" ? identity.policyId : null,
      identity.model === "v9" ? identity.policyDigest : null,
      identity.evaluationBuildDigest,
      identity.baseInputGenerationId,
      identity.publicationGenerationId,
      input.transitionKind,
      input.grade,
      input.score,
      input.prevGrade,
      input.prevScore,
      input.legacyRecordedAt ?? null,
      input.createdAt,
    );
}

/** Explicit cutover primitive; callers must choose the boundary kind. */
export function prepareSafetyScoreHistoryBoundaryWrite(
  db: D1Database,
  input: Omit<SafetyScoreHistoryV2WriteInput, "transitionKind" | "prevGrade" | "prevScore" | "legacyRecordedAt"> & {
    transitionKind: Extract<
      SafetyScoreHistoryV2TransitionKind,
      "methodology-boundary-baseline" | "rollback-baseline" | "restoration-baseline"
    >;
  },
): D1PreparedStatement {
  return prepareSafetyScoreHistoryV2Write(db, {
    ...input,
    prevGrade: null,
    prevScore: null,
    legacyRecordedAt: null,
  });
}

export interface SafetyScoreHistoryBoundaryCard {
  stablecoinId: string;
  grade: ReportCardGrade;
  score: number | null;
}

/**
 * Bounded activation, rollback, or restoration baseline writer. It is model
 * neutral and never creates a legacy row, so the caller can invoke it during
 * a cutover without implying an organic grade transition.
 */
export function prepareSafetyScoreHistoryBoundaryWrites(
  db: D1Database,
  input: {
    cards: readonly SafetyScoreHistoryBoundaryCard[];
    recordedAt: number;
    transitionKind: Extract<
      SafetyScoreHistoryV2TransitionKind,
      "methodology-boundary-baseline" | "rollback-baseline" | "restoration-baseline"
    >;
    identity: SafetyScoreHistoryIdentity;
    createdAt: number;
  },
): D1PreparedStatement[] {
  const seen = new Set<string>();
  return input.cards.map((card) => {
    if (seen.has(card.stablecoinId)) {
      throw new Error(`Duplicate Safety Score boundary card: ${card.stablecoinId}`);
    }
    seen.add(card.stablecoinId);
    return prepareSafetyScoreHistoryBoundaryWrite(db, {
      stablecoinId: card.stablecoinId,
      recordedAt: input.recordedAt,
      grade: card.grade,
      score: card.score,
      transitionKind: input.transitionKind,
      identity: input.identity,
      createdAt: input.createdAt,
    });
  });
}

export function prepareV8OrganicSafetyScoreHistoryWrites(
  db: D1Database,
  input: {
    stablecoinId: string;
    recordedAt: number;
    grade: ReportCardGrade;
    score: number | null;
    prevGrade: ReportCardGrade | null;
    prevScore: number | null;
    transitionKind: Extract<SafetyScoreHistoryV2TransitionKind, "initial-baseline" | "organic-grade-change">;
    identity: SafetyScoreHistoryV8Identity;
    createdAt: number;
  },
): readonly [D1PreparedStatement, D1PreparedStatement] {
  const legacy = db
    .prepare(
      `INSERT OR IGNORE INTO safety_grade_history
       (stablecoin_id, recorded_at, grade, score, prev_grade, prev_score, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.stablecoinId,
      input.recordedAt,
      input.grade,
      input.score,
      input.prevGrade,
      input.prevScore,
      input.identity.methodologyVersion,
    );

  const v2 = prepareSafetyScoreHistoryV2Write(db, {
    ...input,
    previousIdentity: input.transitionKind === "organic-grade-change" ? input.identity : null,
    historyId: safetyScoreLegacyHistoryV2Id(input.stablecoinId, input.recordedAt),
    legacyRecordedAt: input.recordedAt,
  });

  return [legacy, v2] as const;
}

/**
 * Compatibility projection for the existing public API. Boundary rows stay
 * out of this projection because the legacy response cannot express a
 * non-comparable methodology transition without implying a continuous series.
 */
export async function fetchSafetyScoreHistoryCompatibilityRows(
  db: D1Database,
  stablecoinId: string,
  cutoff: number,
): Promise<SafetyScoreHistoryCompatibilityRow[]> {
  const result = await db
    .prepare(
      `SELECT recorded_at, grade, score, prev_grade, prev_score, methodology_version
         FROM (
           SELECT v2.recorded_at, v2.grade, v2.score, v2.prev_grade, v2.prev_score,
                  v2.methodology_version, v2.history_id AS sort_id
             FROM safety_score_history_v2 v2
            WHERE v2.stablecoin_id = ?
              AND v2.recorded_at >= ?
              AND v2.model = 'v8'
              AND v2.transition_kind IN ('initial-baseline', 'organic-grade-change')
           UNION ALL
           SELECT legacy.recorded_at, legacy.grade, legacy.score, legacy.prev_grade,
                  legacy.prev_score, legacy.methodology_version,
                  'legacy:' || legacy.stablecoin_id || ':' || legacy.recorded_at AS sort_id
             FROM safety_grade_history legacy
            WHERE legacy.stablecoin_id = ?
              AND legacy.recorded_at >= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM safety_score_history_v2 v2
                 WHERE v2.stablecoin_id = legacy.stablecoin_id
                   AND v2.legacy_recorded_at = legacy.recorded_at
              )
         ) combined
        ORDER BY recorded_at ASC, sort_id ASC`,
    )
    .bind(stablecoinId, cutoff, stablecoinId, cutoff)
    .all<SafetyScoreHistoryCompatibilityRow>();
  return result.results ?? [];
}

/**
 * Rows for the versioned history contract. Unlike the V8 compatibility
 * projection, this deliberately includes non-comparable boundary baselines.
 */
export async function fetchSafetyScoreHistoryV2Rows(
  db: D1Database,
  stablecoinId: string,
  cutoff: number,
): Promise<SafetyScoreHistoryV2Row[]> {
  const result = await db
    .prepare(
      `SELECT history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version,
              policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
              model_publication_generation_id, transition_kind,
              grade, score, prev_grade, prev_score
         FROM safety_score_history_v2
        WHERE stablecoin_id = ?
          AND recorded_at >= ?
        ORDER BY recorded_at ASC, history_id ASC`,
    )
    .bind(stablecoinId, cutoff)
    .all<SafetyScoreHistoryV2Row>();
  return result.results ?? [];
}

/** Latest V2 row per stablecoin, used to prevent organic comparisons across identities. */
export async function fetchLatestSafetyScoreHistoryV2Rows(
  db: D1Database,
): Promise<SafetyScoreHistoryV2Row[]> {
  const result = await db
    .prepare(
      `SELECT history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version,
              policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
              model_publication_generation_id, transition_kind,
              grade, score, prev_grade, prev_score
         FROM safety_score_history_v2
        ORDER BY stablecoin_id ASC, recorded_at DESC, history_id DESC`,
    )
    .all<SafetyScoreHistoryV2Row>();
  const latest = new Map<string, SafetyScoreHistoryV2Row>();
  for (const row of result.results ?? []) {
    if (!latest.has(row.stablecoin_id)) latest.set(row.stablecoin_id, row);
  }
  return [...latest.values()];
}

export function safetyScoreHistoryIdentityFromV2Row(row: SafetyScoreHistoryV2Row): SafetyScoreHistoryIdentity {
  if (row.model === "v8") {
    if (row.policy_id !== null || row.policy_digest !== null) {
      throw new Error("Safety Score V8 history row unexpectedly carries V9 policy identity");
    }
    return SafetyScorePublicationIdentitySchema.parse({
      model: "v8",
      schemaVersion: row.identity_schema_version,
      methodologyVersion: row.methodology_version,
      evaluationBuildDigest: row.evaluation_build_digest,
      baseInputGenerationId: row.base_input_generation_id,
      publicationGenerationId: row.model_publication_generation_id,
    });
  }
  return SafetyScorePublicationIdentitySchema.parse({
    model: "v9",
    schemaVersion: row.identity_schema_version,
    methodologyVersion: row.methodology_version,
    policyId: row.policy_id,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    baseInputGenerationId: row.base_input_generation_id,
    publicationGenerationId: row.model_publication_generation_id,
  });
}

/**
 * Dual-source relation used by the existing organic upgrade/downgrade Tape
 * projectors. V2 boundary baselines are intentionally absent.
 */
export const SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL = `(
  SELECT v2.stablecoin_id, v2.recorded_at, v2.grade, v2.score, v2.prev_grade,
         v2.prev_score, v2.methodology_version, v2.transition_kind,
         v2.model, v2.identity_schema_version, v2.policy_id, v2.policy_digest, v2.evaluation_build_digest,
         v2.base_input_generation_id, v2.model_publication_generation_id,
         CASE
           WHEN v2.legacy_recorded_at IS NOT NULL THEN 'safety_grade_history'
           ELSE 'safety_score_history_v2'
         END AS source_table,
         CASE
           WHEN v2.legacy_recorded_at IS NOT NULL
             THEN v2.stablecoin_id || ':' || v2.legacy_recorded_at
           ELSE v2.history_id
         END AS source_row_id,
         'v2:' || v2.history_id AS row_sort_id
    FROM safety_score_history_v2 v2
   WHERE v2.transition_kind = 'organic-grade-change'
  UNION ALL
  SELECT legacy.stablecoin_id, legacy.recorded_at, legacy.grade, legacy.score,
         legacy.prev_grade, legacy.prev_score, legacy.methodology_version,
         'organic-grade-change' AS transition_kind,
         'v8' AS model, 1 AS identity_schema_version, NULL AS policy_id, NULL AS policy_digest,
         NULL AS evaluation_build_digest, NULL AS base_input_generation_id,
         NULL AS model_publication_generation_id,
         'safety_grade_history' AS source_table,
         legacy.stablecoin_id || ':' || legacy.recorded_at AS source_row_id,
         'legacy:' || legacy.stablecoin_id || ':' || legacy.recorded_at AS row_sort_id
    FROM safety_grade_history legacy
   WHERE legacy.prev_grade IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM safety_score_history_v2 v2
        WHERE v2.stablecoin_id = legacy.stablecoin_id
          AND v2.legacy_recorded_at = legacy.recorded_at
     )
)`;
