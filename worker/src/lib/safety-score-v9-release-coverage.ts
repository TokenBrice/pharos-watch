import {
  computeV9CoverageEvaluationProjectionDigest,
  evaluateV9ReleaseCoverage,
} from "@shared/lib/safety-score-v9/coverage";
import type { V9EvaluatedSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { CompiledV9FactSetV2 } from "@shared/types/safety-score-v9-facts";
import {
  V9CoverageEvaluationSnapshotV1Schema,
  V9ReleaseCohortAssetV1Schema,
  V9ReleaseCohortManifestV1Schema,
  type V9CoverageEvaluationSnapshotV1,
  type V9ReleaseCohortManifestV1,
  type V9ReleaseCoverageReportV1,
} from "@shared/types/safety-score-v9-coverage";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { parseJson } from "./json-parse";
import type { SafetyScoreV9CoverageFloor } from "./safety-score-v9-shadow";

/**
 * Ratified release coverage (V9-9). An owner-ratified frozen cohort record is
 * stored once per sealed release candidate; every shadow run re-pins the
 * cohort's identity bindings to the day's exact candidate (policy digest,
 * evaluation-build digest, fact-set digest, result digest), replays the
 * strict release-coverage evaluation against the current compiled facts, and
 * passes the ratified-release-coverage floor only when the resulting digested
 * report is gate-passed and bound to this exact candidate. Any identity or
 * cohort drift — or a missing, unreadable, or no-go record — fails closed
 * with the legacy blocker string.
 */
export const SAFETY_SCORE_V9_RELEASE_COVERAGE_FLOOR_ID = "ratified-release-coverage";
export const SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER = "ratified-release-coverage-unavailable";

const SAFETY_SCORE_V9_RELEASE_COHORT_DIGEST_DOMAIN = "safety-score-v9.release-cohort.v1";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonEmptyTextSchema = z.string().trim().min(1);
const UnixSecondsSchema = z.number().int().nonnegative();
const ReleaseCandidateIdSchema = z.string().regex(/^v9-rc-[1-9][0-9]*$/);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

const SafetyScoreV9ReleaseCohortPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseCandidateId: ReleaseCandidateIdSchema,
    cohortId: NonEmptyTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    continuingActiveV8RateableCount: z.number().int().nonnegative(),
    ratifiedBy: NonEmptyTextSchema,
    rationale: NonEmptyTextSchema,
    ratifiedAtSec: UnixSecondsSchema,
    assets: z
      .array(V9ReleaseCohortAssetV1Schema)
      .min(1)
      .superRefine((assets, ctx) => {
        const ids = assets.map((asset) => asset.assetId);
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id, index) => index > 0 && compareText(ids[index - 1]!, id) >= 0)
        ) {
          ctx.addIssue({ code: "custom", path: ["assets"], message: "Cohort assets must be sorted and unique" });
        }
      }),
  })
  .strict();
type SafetyScoreV9ReleaseCohortPayload = z.infer<typeof SafetyScoreV9ReleaseCohortPayloadSchema>;

function cohortPayload(record: SafetyScoreV9ReleaseCohortPayload & { cohortDigest?: string }) {
  const { cohortDigest: _cohortDigest, ...payload } = record;
  return payload;
}

export function computeSafetyScoreV9ReleaseCohortDigest(payload: SafetyScoreV9ReleaseCohortPayload): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: SAFETY_SCORE_V9_RELEASE_COHORT_DIGEST_DOMAIN,
      cohort: SafetyScoreV9ReleaseCohortPayloadSchema.parse(cohortPayload(payload)),
    }),
  );
}

export const SafetyScoreV9ReleaseCohortRecordSchema = SafetyScoreV9ReleaseCohortPayloadSchema.extend({
  cohortDigest: Sha256Schema,
})
  .strict()
  .superRefine((record, ctx) => {
    if (record.cohortDigest !== computeSafetyScoreV9ReleaseCohortDigest(record)) {
      ctx.addIssue({
        code: "custom",
        path: ["cohortDigest"],
        message: "V9 release cohort digest does not match its canonical payload",
      });
    }
  });
export type SafetyScoreV9ReleaseCohortRecord = z.infer<typeof SafetyScoreV9ReleaseCohortRecordSchema>;

export class SafetyScoreV9ReleaseCohortConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9ReleaseCohortConflictError";
  }
}

/** Builds the owner-ratified frozen cohort record for one sealed release candidate. */
export function createSafetyScoreV9ReleaseCohortRecord(
  payload: SafetyScoreV9ReleaseCohortPayload,
): SafetyScoreV9ReleaseCohortRecord {
  const parsed = SafetyScoreV9ReleaseCohortPayloadSchema.parse(payload);
  return SafetyScoreV9ReleaseCohortRecordSchema.parse({
    ...parsed,
    cohortDigest: computeSafetyScoreV9ReleaseCohortDigest(parsed),
  });
}

interface ReleaseCohortRow {
  release_candidate_id: string;
  cohort_id: string;
  policy_digest: string;
  evaluation_build_digest: string;
  continuing_active_v8_rateable_count: number;
  active_asset_count: number;
  ratified_by: string;
  rationale: string;
  ratified_at_sec: number;
  cohort_digest: string;
  cohort_json: string;
}

function parseCohortRow(row: ReleaseCohortRow): SafetyScoreV9ReleaseCohortRecord {
  const parsed = parseJson(row.cohort_json);
  if (!parsed.ok) throw new Error(`Malformed Safety Score v9 release cohort JSON: ${parsed.message}`);
  const record = SafetyScoreV9ReleaseCohortRecordSchema.parse(parsed.value);
  if (stableJsonStringifyV1(record) !== row.cohort_json) {
    throw new Error("Safety Score v9 release cohort JSON is not canonical");
  }
  const projection = {
    releaseCandidateId: row.release_candidate_id,
    cohortId: row.cohort_id,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    continuingActiveV8RateableCount: row.continuing_active_v8_rateable_count,
    ratifiedBy: row.ratified_by,
    rationale: row.rationale,
    ratifiedAtSec: row.ratified_at_sec,
    cohortDigest: row.cohort_digest,
  };
  const expected = {
    releaseCandidateId: record.releaseCandidateId,
    cohortId: record.cohortId,
    policyDigest: record.policyDigest,
    evaluationBuildDigest: record.evaluationBuildDigest,
    continuingActiveV8RateableCount: record.continuingActiveV8RateableCount,
    ratifiedBy: record.ratifiedBy,
    rationale: record.rationale,
    ratifiedAtSec: record.ratifiedAtSec,
    cohortDigest: record.cohortDigest,
  };
  if (stableJsonStringifyV1(projection) !== stableJsonStringifyV1(expected)) {
    throw new Error(`Safety Score v9 release cohort row projection mismatch for ${record.releaseCandidateId}`);
  }
  if (row.active_asset_count !== record.assets.length) {
    throw new Error(`Safety Score v9 release cohort asset count mismatch for ${record.releaseCandidateId}`);
  }
  return record;
}

const RELEASE_COHORT_SELECT = `SELECT release_candidate_id, cohort_id, policy_digest, evaluation_build_digest,
  continuing_active_v8_rateable_count, active_asset_count, ratified_by, rationale, ratified_at_sec,
  cohort_digest, cohort_json FROM safety_score_v9_release_cohorts`;

export async function loadSafetyScoreV9ReleaseCohort(
  db: D1Database,
  releaseCandidateId: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ReleaseCohortRecord | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(`${RELEASE_COHORT_SELECT} WHERE release_candidate_id = ?`)
        .bind(releaseCandidateId)
        .first<ReleaseCohortRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseCohortRow(row) : null;
}

/** Persists one frozen cohort record; cohorts are immutable per release candidate. */
export async function persistSafetyScoreV9ReleaseCohort(
  db: D1Database,
  recordInput: SafetyScoreV9ReleaseCohortRecord,
  signal?: AbortSignal,
): Promise<{ status: "recorded" | "unchanged"; record: SafetyScoreV9ReleaseCohortRecord }> {
  throwIfAborted(signal);
  const record = SafetyScoreV9ReleaseCohortRecordSchema.parse(recordInput);
  const existing = await loadSafetyScoreV9ReleaseCohort(db, record.releaseCandidateId, signal);
  if (existing) {
    if (existing.cohortDigest !== record.cohortDigest) {
      throw new SafetyScoreV9ReleaseCohortConflictError(
        `Immutable Safety Score v9 release cohort conflict for ${record.releaseCandidateId}`,
      );
    }
    return { status: "unchanged", record: existing };
  }
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `INSERT INTO safety_score_v9_release_cohorts
           (release_candidate_id, cohort_id, policy_digest, evaluation_build_digest,
            continuing_active_v8_rateable_count, active_asset_count, ratified_by, rationale,
            ratified_at_sec, cohort_digest, cohort_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          record.releaseCandidateId,
          record.cohortId,
          record.policyDigest,
          record.evaluationBuildDigest,
          record.continuingActiveV8RateableCount,
          record.assets.length,
          record.ratifiedBy,
          record.rationale,
          record.ratifiedAtSec,
          record.cohortDigest,
          stableJsonStringifyV1(record),
        )
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (Number(result.meta.changes ?? 0) > 0) return { status: "recorded", record };
  const raced = await loadSafetyScoreV9ReleaseCohort(db, record.releaseCandidateId, signal);
  if (!raced || raced.cohortDigest !== record.cohortDigest) {
    throw new SafetyScoreV9ReleaseCohortConflictError(
      `Immutable Safety Score v9 release cohort conflict for ${record.releaseCandidateId}`,
    );
  }
  return { status: "unchanged", record: raced };
}

const EVALUATION_SOURCE_KEYS = [
  "registry",
  "dex",
  "redemption",
  "liveReserves",
  "chainSupply",
  "peg",
  "researchOverlays",
] as const;

/** Identity-preserving release-gate projection of the candidate's evaluated set. */
export function projectSafetyScoreV9CoverageEvaluation(input: {
  evaluatedSet: Readonly<V9EvaluatedSet>;
  producerCapabilityDigest: string;
}): V9CoverageEvaluationSnapshotV1 {
  const { evaluatedSet } = input;
  const sourceGenerations = Object.fromEntries(
    EVALUATION_SOURCE_KEYS.map((source) => {
      const generation = evaluatedSet.sourceGenerations[source];
      if (typeof generation !== "string" || generation.length === 0) {
        throw new Error(`Safety Score v9 evaluated set is missing its ${source} source generation`);
      }
      return [source, generation];
    }),
  ) as V9CoverageEvaluationSnapshotV1["sourceGenerations"];
  const payload = {
    schemaVersion: 1 as const,
    factSetDigest: evaluatedSet.factSetDigest,
    baseInputGenerationId: evaluatedSet.baseInputGenerationId,
    policyId: evaluatedSet.policyId,
    policyDigest: evaluatedSet.policyDigest,
    evaluationBuildDigest: evaluatedSet.evaluationBuildDigest,
    producerCapabilityDigest: input.producerCapabilityDigest,
    evaluatedSetDigest: evaluatedSet.evaluatedSetDigest,
    scoreResultDigest: evaluatedSet.scoreResultDigest,
    asOfSec: evaluatedSet.asOfSec,
    sourceGenerations,
    assets: evaluatedSet.assets
      .map((asset) => ({
        assetId: asset.assetId,
        finalScore: asset.trace.finalScore,
        nrReasonCodes: sortedUnique(
          [...asset.trace.nrReasons, ...asset.trace.propagatedParentReasons].map((reason) => reason.code),
        ),
        primaryExitRouteKey: asset.exit.primaryRouteKey,
        includedExitRouteKeys: sortedUnique(
          asset.exit.routes.filter((route) => route.included).map((route) => route.routeKey),
        ),
      }))
      .sort((left, right) => compareText(left.assetId, right.assetId)),
  };
  return V9CoverageEvaluationSnapshotV1Schema.parse({
    ...payload,
    evaluationProjectionDigest: computeV9CoverageEvaluationProjectionDigest(payload),
  });
}

/**
 * Rebuilds the release-cohort manifest for the current candidate generation:
 * the frozen cohort content (asset roster, weights, calibration dispositions,
 * NR reviews) comes from the ratified record; the identity bindings re-pin to
 * the day's exact fact set and evaluation. The strict coverage evaluator then
 * proves the frozen content still matches the current facts — drift produces
 * blockers, and the report goes no-go.
 */
export function buildSafetyScoreV9ReleaseCohortManifest(input: {
  cohort: SafetyScoreV9ReleaseCohortRecord;
  factSet: Readonly<CompiledV9FactSetV2>;
  evaluation: V9CoverageEvaluationSnapshotV1;
}): V9ReleaseCohortManifestV1 {
  const cohort = SafetyScoreV9ReleaseCohortRecordSchema.parse(input.cohort);
  const evaluation = V9CoverageEvaluationSnapshotV1Schema.parse(input.evaluation);
  return V9ReleaseCohortManifestV1Schema.parse({
    schemaVersion: 1,
    releaseCandidateId: cohort.releaseCandidateId,
    cohortId: cohort.cohortId,
    capturedAtSec: input.factSet.asOfSec,
    bindings: {
      factSetDigest: input.factSet.v9FactSetDigest,
      baseInputGenerationId: input.factSet.baseInputGenerationId,
      policyId: evaluation.policyId,
      policyDigest: evaluation.policyDigest,
      evaluationBuildDigest: evaluation.evaluationBuildDigest,
      producerCapabilityDigest: evaluation.producerCapabilityDigest,
      evaluatedSetDigest: evaluation.evaluatedSetDigest,
      scoreResultDigest: evaluation.scoreResultDigest,
      evaluationProjectionDigest: evaluation.evaluationProjectionDigest,
      registryPayloadDigest: input.factSet.sourceFingerprints.registry.payloadSha256,
      weightPayloadDigest: input.factSet.sourceFingerprints.chainSupply.payloadSha256,
    },
    continuingActiveV8RateableCount: cohort.continuingActiveV8RateableCount,
    assets: cohort.assets,
  });
}

export interface SafetyScoreV9ShadowReleaseCoverageAssessment {
  floor: SafetyScoreV9CoverageFloor;
  unresolvedReleaseBlockers: string[];
  report: V9ReleaseCoverageReportV1 | null;
}

const RATIFIED_RELEASE_COVERAGE_REQUIRED = "a gate-passed V9-9 release coverage report bound to this exact candidate";

function failAssessment(detail: string): SafetyScoreV9ShadowReleaseCoverageAssessment {
  return {
    floor: {
      id: SAFETY_SCORE_V9_RELEASE_COVERAGE_FLOOR_ID,
      status: "fail",
      observed: 0,
      required: RATIFIED_RELEASE_COVERAGE_REQUIRED,
      detail,
    },
    unresolvedReleaseBlockers: [SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER],
    report: null,
  };
}

/**
 * Evaluates the ratified-release-coverage floor for one shadow candidate. The
 * floor passes only when a frozen cohort ratified for this exact release
 * candidate exists, its policy/build identity matches, and the freshly
 * computed V9-9 release coverage report — bound to the candidate's policy,
 * evaluation-build, fact-set, and result digests — is gate-passed.
 */
export async function assessSafetyScoreV9ShadowReleaseCoverage(args: {
  db: D1Database;
  candidateId: string;
  candidatePolicyDigest: string;
  candidateEvaluationBuildDigest: string;
  candidateFactSetDigest: string;
  candidateResultDigest: string;
  compiledFacts: Readonly<CompiledV9FactSetV2>;
  evaluatedSet: Readonly<V9EvaluatedSet>;
  producerCapabilityDigest: string;
  signal?: AbortSignal;
}): Promise<SafetyScoreV9ShadowReleaseCoverageAssessment> {
  let cohort: SafetyScoreV9ReleaseCohortRecord | null;
  try {
    cohort = await loadSafetyScoreV9ReleaseCohort(args.db, args.candidateId, args.signal);
  } catch (error) {
    console.warn(
      "[safety-score-v9] release cohort record failed integrity verification:",
      error instanceof Error ? error.message : String(error),
    );
    return failAssessment("The stored V9-9 release cohort record failed integrity verification");
  }
  if (cohort === null) {
    return failAssessment("No frozen V9-9 release cohort and passing coverage report is wired into the shadow candidate");
  }
  if (
    cohort.policyDigest !== args.candidatePolicyDigest ||
    cohort.evaluationBuildDigest !== args.candidateEvaluationBuildDigest
  ) {
    return failAssessment("The frozen V9-9 release cohort belongs to a different policy or evaluation build");
  }
  const evaluation = projectSafetyScoreV9CoverageEvaluation({
    evaluatedSet: args.evaluatedSet,
    producerCapabilityDigest: args.producerCapabilityDigest,
  });
  const manifest = buildSafetyScoreV9ReleaseCohortManifest({ cohort, factSet: args.compiledFacts, evaluation });
  const report = evaluateV9ReleaseCoverage({ factSet: args.compiledFacts, evaluation, manifest });
  const identities = report.identities;
  if (
    report.releaseCandidateId !== args.candidateId ||
    identities.policyDigest !== args.candidatePolicyDigest ||
    identities.evaluationBuildDigest !== args.candidateEvaluationBuildDigest ||
    identities.factSetDigest !== args.candidateFactSetDigest ||
    identities.scoreResultDigest !== args.candidateResultDigest
  ) {
    return failAssessment("The V9-9 release coverage report is not bound to this exact candidate");
  }
  if (report.decision !== "gate-passed") {
    const codes = sortedUnique(report.blockers.map((blocker) => blocker.code)).slice(0, 5);
    return failAssessment(
      `The V9-9 release coverage report is no-go (${report.blockers.length} blocker(s)): ${codes.join(", ")}`,
    );
  }
  return {
    floor: {
      id: SAFETY_SCORE_V9_RELEASE_COVERAGE_FLOOR_ID,
      status: "pass",
      observed: report.rateability.rateableCount,
      required: RATIFIED_RELEASE_COVERAGE_REQUIRED,
      detail: `Gate-passed V9-9 release coverage report ${report.reportDigest} covers ${report.activeSet.factCount} active assets with ${report.rateability.rateableCount} rateable`,
    },
    unresolvedReleaseBlockers: [],
    report,
  };
}
