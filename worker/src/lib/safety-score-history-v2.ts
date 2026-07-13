import { ReportCardsResponseSchema, type ReportCardGrade, type ReportCardsResponse } from "@shared/types/report-cards";
import { throwIfAborted } from "./abort";
import { getCache } from "./db-cache";
import {
  validateSafetyScoreModelCacheValue,
  type SafetyScoreModelIdentity,
  type SafetyScoreModelFamilyPointer,
} from "./safety-score-model-publication";
import { loadSafetyScorePublicationManifest } from "./safety-score-model-publication-store";

export const SAFETY_SCORE_HISTORY_V2_TABLE = "safety_score_history_v2";

export type SafetyScoreHistoryV2TransitionKind =
  | "initial-baseline"
  | "organic-grade-change"
  | "methodology-boundary-baseline"
  | "rollback-baseline"
  | "restoration-baseline";

export interface SafetyScoreHistoryV8Identity {
  model: "v8";
  methodologyVersion: string;
  policyId: null;
  policyDigest: null;
  evaluationBuildDigest: string;
  baseInputGenerationId: string;
  modelPublicationGenerationId: string;
  publicationEpoch: number;
}

export interface ActiveV8SafetyScoreHistorySource {
  snapshot: ReportCardsResponse;
  identity: SafetyScoreHistoryV8Identity;
  publishedAtSec: number;
}

export interface SafetyScoreHistoryCompatibilityRow {
  recorded_at: number;
  grade: ReportCardGrade;
  score: number | null;
  prev_grade: ReportCardGrade | null;
  prev_score: number | null;
  methodology_version: string;
}

export class SafetyScoreHistoryCutoverNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreHistoryCutoverNotImplementedError";
  }
}

type SafetyScoreV8ModelIdentity = Extract<SafetyScoreModelIdentity, { model: "v8" }>;
type SafetyScoreV8FamilyPointer = Omit<SafetyScoreModelFamilyPointer, "model" | "identity"> & {
  model: "v8";
  identity: SafetyScoreV8ModelIdentity;
};

function unwrapV8FullPayload(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "payload" in payload &&
    "generation" in payload &&
    "methodologyVersion" in payload
  ) {
    return (payload as { payload: unknown }).payload;
  }
  return payload;
}

function requireActiveV8Family(
  activeModel: "v8" | "v9",
  activeGenerationId: string,
  family: SafetyScoreModelFamilyPointer | null,
): SafetyScoreV8FamilyPointer {
  if (activeModel !== "v8") {
    throw new SafetyScoreHistoryCutoverNotImplementedError(
      "Safety Score V9 history cutover is not implemented; activation requires a gated V9 baseline writer",
    );
  }
  if (family === null || family.model !== "v8" || family.identity.model !== "v8") {
    throw new Error("Active Safety Score publication manifest has no valid V8 family");
  }
  if (family.generationId !== activeGenerationId) {
    throw new Error("Active Safety Score V8 family does not match the manifest generation");
  }
  return family as SafetyScoreV8FamilyPointer;
}

/**
 * Loads the immutable V8 full artifact selected by the publication manifest.
 * V9 is deliberately rejected until the cutover baseline and its authorization
 * gate are implemented.
 */
export async function loadActiveV8SafetyScoreHistorySource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveV8SafetyScoreHistorySource> {
  throwIfAborted(signal);
  const manifest = await loadSafetyScorePublicationManifest(db, signal);
  if (manifest === null) {
    throw new Error("Safety Score publication state is not initialized");
  }
  const family = requireActiveV8Family(
    manifest.selection.activeModel,
    manifest.selection.activeGenerationId,
    manifest.families.v8,
  );
  const cached = await getCache(db, family.artifacts.full.cacheKey);
  throwIfAborted(signal);
  if (cached === null) {
    throw new Error(`Active Safety Score V8 full artifact is missing: ${family.artifacts.full.cacheKey}`);
  }
  const validated = validateSafetyScoreModelCacheValue(cached.value, family);
  if (!validated.ok || validated.envelope.artifactKind !== "full") {
    throw new Error(
      `Active Safety Score V8 full artifact is invalid: ${
        validated.ok ? "artifact kind mismatch" : `${validated.reason}: ${validated.detail}`
      }`,
    );
  }
  const parsedSnapshot = ReportCardsResponseSchema.safeParse(unwrapV8FullPayload(validated.payload));
  if (!parsedSnapshot.success) {
    throw new Error(`Active Safety Score V8 snapshot is invalid: ${parsedSnapshot.error.message}`);
  }
  if (parsedSnapshot.data.publication?.generationId !== family.generationId) {
    throw new Error("Active Safety Score V8 snapshot generation does not match its family");
  }

  return {
    snapshot: parsedSnapshot.data,
    identity: {
      model: "v8",
      methodologyVersion: family.identity.methodologyVersion,
      policyId: null,
      policyDigest: null,
      evaluationBuildDigest: family.identity.evaluationBuildDigest,
      baseInputGenerationId: family.baseInputGenerationId,
      modelPublicationGenerationId: family.generationId,
      publicationEpoch: family.publicationEpoch,
    },
    publishedAtSec: family.publishedAtSec,
  };
}

export function safetyScoreLegacyHistoryV2Id(stablecoinId: string, recordedAt: number): string {
  return `safety-score-history:v2:legacy:${encodeURIComponent(stablecoinId)}:${recordedAt}`;
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
  if (input.transitionKind === "organic-grade-change" && input.prevGrade === null) {
    throw new Error("An organic Safety Score grade change requires a previous grade");
  }
  if (input.transitionKind === "initial-baseline" && (input.prevGrade !== null || input.prevScore !== null)) {
    throw new Error("An initial Safety Score baseline cannot carry comparable previous values");
  }

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

  const v2 = db
    .prepare(
      `INSERT INTO safety_score_history_v2
       (history_id, stablecoin_id, recorded_at, model, methodology_version,
        policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
        model_publication_generation_id, publication_epoch, transition_kind,
        grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(history_id) DO UPDATE SET
         created_at = CASE
           WHEN stablecoin_id = excluded.stablecoin_id
            AND recorded_at = excluded.recorded_at
            AND model = excluded.model
            AND methodology_version = excluded.methodology_version
            AND policy_id IS excluded.policy_id
            AND policy_digest IS excluded.policy_digest
            AND evaluation_build_digest = excluded.evaluation_build_digest
            AND base_input_generation_id = excluded.base_input_generation_id
            AND model_publication_generation_id = excluded.model_publication_generation_id
            AND publication_epoch = excluded.publication_epoch
            AND transition_kind = excluded.transition_kind
            AND grade = excluded.grade
            AND score IS excluded.score
            AND prev_grade IS excluded.prev_grade
            AND prev_score IS excluded.prev_score
            AND legacy_recorded_at = excluded.legacy_recorded_at
           THEN MIN(created_at, excluded.created_at)
           ELSE NULL
         END`,
    )
    .bind(
      safetyScoreLegacyHistoryV2Id(input.stablecoinId, input.recordedAt),
      input.stablecoinId,
      input.recordedAt,
      input.identity.model,
      input.identity.methodologyVersion,
      input.identity.policyId,
      input.identity.policyDigest,
      input.identity.evaluationBuildDigest,
      input.identity.baseInputGenerationId,
      input.identity.modelPublicationGenerationId,
      input.identity.publicationEpoch,
      input.transitionKind,
      input.grade,
      input.score,
      input.prevGrade,
      input.prevScore,
      input.recordedAt,
      input.createdAt,
    );

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
 * Dual-source relation used by the existing organic upgrade/downgrade Tape
 * projectors. V2 boundary baselines are intentionally absent.
 */
export const SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL = `(
  SELECT v2.stablecoin_id, v2.recorded_at, v2.grade, v2.score, v2.prev_grade,
         v2.prev_score, v2.methodology_version, v2.transition_kind,
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
