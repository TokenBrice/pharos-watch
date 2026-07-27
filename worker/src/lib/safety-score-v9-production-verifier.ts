import { z } from "zod";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";
import {
  evaluateV9ProductionAcceptance,
  toV9ProductionSupplyCents,
} from "@shared/lib/safety-score-v9/production-validation";
import {
  evaluateV9HistoricalHoldout,
  verifyV9HistoricalHoldoutValidationReportDigest,
} from "@shared/lib/safety-score-v9/validation";
import {
  V9HistoricalHoldoutEvaluationInputSchema,
  V9HistoricalHoldoutValidationReportSchema,
  type V9HistoricalHoldoutEvaluationInput,
  type V9HistoricalHoldoutValidationReport,
} from "@shared/types/safety-score-v9-validation";
import {
  type V9ProductionCaptureLedger,
  type V9ProductionCaptureLedgerReport,
  type V9ProductionGenerationVerificationReceipt,
  type V9ProductionHoldoutBindingReport,
  type V9ProductionSourceReceipt,
  type V9ProductionSupplementalValidationEvidence,
  type V9StrictProductionAcceptanceReport,
  type V9StrictProductionNoGoReason,
} from "@shared/types/safety-score-v9-production-validation";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import {
  buildReportCardsSnapshotFromFixedInput,
  normalizeFixedInput,
  parseReportCardsFixedInputCacheArtifact,
  type ReportCardsFixedInputCacheArtifact,
} from "./report-cards-fixed-input";
import {
  buildSafetyScoreV9CandidateFromNormalizedInput,
  type SafetyScoreV9CandidatePipelineResult,
} from "./safety-score-v9-candidate";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const HoldoutIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const ReplayShellSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-candidate-replay"),
    lifecycle: z.literal("active"),
    releaseAuthorization: z
      .object({
        authorized: z.literal(false),
        reason: z.literal("v9-replay-only"),
      })
      .strict(),
    pipeline: z
      .object({
        extension: z.unknown(),
        candidate: z
          .object({
            candidateId: z.string().min(1),
            publishedAtSec: z.number().int().nonnegative(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict();

const D1ExactCacheExportSchema = z
  .array(
    z
      .object({
        success: z.literal(true),
        results: z.array(z.object({ value: z.string().min(1) }).strict()).length(1),
      })
      .passthrough(),
  )
  .length(1);

const CaptureLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-production-capture-ledger"),
    entries: z
      .array(
        z
          .object({
            ordinal: z.number().int().positive(),
            captureId: z.string().trim().min(1),
            status: z.enum(["complete", "failed"]),
            capturedAtSec: z.number().int().nonnegative(),
            sourceGeneration: z.string().trim().min(1).nullable(),
            baseInputGenerationId: BaseInputGenerationIdSchema.nullable(),
            exactCachePayloadDigest: Sha256Schema.nullable(),
            replayPayloadDigest: Sha256Schema.nullable(),
            failureReason: z.string().trim().min(1).nullable(),
          })
          .strict()
          .superRefine((entry, ctx) => {
            if (
              entry.status === "complete" &&
              (
                entry.sourceGeneration === null ||
                entry.baseInputGenerationId === null ||
                entry.exactCachePayloadDigest === null ||
                entry.replayPayloadDigest === null ||
                entry.failureReason !== null
              )
            ) {
              ctx.addIssue({
                code: "custom",
                message: "A complete capture requires exact identities and cannot carry a failure reason",
              });
            }
            if (entry.status === "failed" && entry.failureReason === null) {
              ctx.addIssue({ code: "custom", path: ["failureReason"], message: "A failed capture requires a reason" });
            }
          }),
      )
      .min(3),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    ledger.entries.forEach((entry, index) => {
      if (entry.ordinal !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "ordinal"],
          message: "Capture ordinals must be contiguous and canonical",
        });
      }
      if (ids.has(entry.captureId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "captureId"],
          message: "Capture IDs must be unique",
        });
      }
      ids.add(entry.captureId);
      if (index > 0 && entry.capturedAtSec <= ledger.entries[index - 1]!.capturedAtSec) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "capturedAtSec"],
          message: "Capture timestamps must increase strictly",
        });
      }
    });
  });

const HoldoutScorerArtifactRefSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !/^[a-z]:[\\/]/iu.test(path) &&
          !path.split(/[\\/]+/u).includes(".."),
        "Artifact path must be portable and relative",
      ),
    sha256: Sha256Schema,
  })
  .strict();

const HoldoutScorerSourceSchema = z
  .object({
    sourceId: HoldoutIdentifierSchema,
    title: z.string().min(1),
    originalUrl: z.string().url(),
    publishedAt: IsoTimestampSchema,
    supports: z.array(z.string().min(1)).min(1),
    availabilityProof: z
      .object({
        kind: z.enum([
          "third-party-snapshot",
          "content-addressed-publication",
          "immutable-publisher-record",
        ]),
        url: z.string().url(),
        observedAt: IsoTimestampSchema,
        verifiedBy: z.array(HoldoutIdentifierSchema).min(1),
      })
      .strict(),
    archiveArtifact: HoldoutScorerArtifactRefSchema,
  })
  .strict();

const HoldoutScorerProofCaseSchema = z
  .object({
    caseId: HoldoutIdentifierSchema,
    assetId: z.string().min(1),
    evidenceCutoff: IsoTimestampSchema,
    publishedAtSec: z.number().int().nonnegative(),
    fixedInput: z.unknown(),
    extension: z.unknown(),
    sources: z.array(HoldoutScorerSourceSchema).min(1),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const sourceIds = entry.sources.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Source IDs must be unique",
      });
    }
    if (
      sourceIds.some(
        (sourceId, index) =>
          index > 0 && sourceIds[index - 1]! >= sourceId,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Sources must be in canonical source-ID order",
      });
    }
  });

const HoldoutScorerProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-holdout-scorer-proof"),
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    createdAt: IsoTimestampSchema,
    cases: z.array(HoldoutScorerProofCaseSchema).min(1),
  })
  .strict()
  .superRefine((proof, ctx) => {
    proof.cases.forEach((entry, index) => {
      if (
        index > 0 &&
        proof.cases[index - 1]!.caseId >= entry.caseId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "caseId"],
          message: "Case IDs must be unique and in canonical ascending order",
        });
      }
    });
  });

type HoldoutScorerSource = z.infer<typeof HoldoutScorerSourceSchema>;

const MAX_VALIDATED_ASSET_CIRCULATING_USD = 10_000_000_000_000;
const MAX_VALIDATED_AGGREGATE_CIRCULATING_USD = 20_000_000_000_000;
const MAX_SOURCE_TO_CLOCK_LAG_SEC = 6 * 60 * 60;
const MIN_CAPTURE_INTERVAL_SEC = 12 * 60 * 60;
const MAX_CAPTURE_INTERVAL_SEC = 36 * 60 * 60;
const MAX_LATEST_CAPTURE_AGE_SEC = 36 * 60 * 60;
const MAX_FUTURE_CAPTURE_SKEW_SEC = 5 * 60;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function payloadDigest(value: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ payload: value ?? null }));
}

export function computeV9ProductionHoldoutCaseSourceDigest(
  sources: readonly HoldoutScorerSource[],
): string {
  const parsed = z.array(HoldoutScorerSourceSchema).min(1).parse(sources);
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.holdout-case-source-archive.v1",
      sources: [...parsed].sort((left, right) =>
        compareText(left.sourceId, right.sourceId)
      ),
    }),
  );
}

function safePayloadDigest(
  value: unknown,
  label: string,
): { digest: string; issue: string | null } {
  try {
    return { digest: payloadDigest(value), issue: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unserializable value";
    return {
      digest: sha256Hex(
        stableJsonStringifyV1({
          domain: "safety-score-v9.invalid-production-artifact.v1",
          label,
          error: message,
        }),
      ),
      issue: `${label} is not canonical stable JSON: ${message}`,
    };
  }
}

function exactCacheEnvelope(raw: unknown): unknown {
  const d1 = D1ExactCacheExportSchema.safeParse(raw);
  if (!d1.success) return raw;
  const value = d1.data[0]!.results[0]!.value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Production exact-cache export contains malformed JSON");
  }
}

function releaseCandidateOverride(candidateId: string): string | undefined {
  return /^v9-rc-[1-9][0-9]*$/.test(candidateId) ? candidateId : undefined;
}

function supplyReceipt(
  pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>,
): { totalUsd: number; issues: string[] } {
  const issues: string[] = [];
  const compiledById = new Map(pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  let totalCents = 0n;
  for (const evaluated of pipeline.evaluatedSet.assets) {
    const compiled = compiledById.get(evaluated.assetId);
    const compiledSupply = compiled?.supply.circulatingUsd ?? null;
    const stressSupply = evaluated.stressState.exitPortfolio?.circulatingUsd ?? null;
    const compiledSupplyCents = toV9ProductionSupplyCents(compiledSupply);
    const stressSupplyCents = toV9ProductionSupplyCents(stressSupply);
    if (
      compiledSupplyCents === null ||
      stressSupplyCents === null ||
      BigInt(compiledSupplyCents) >
        BigInt(MAX_VALIDATED_ASSET_CIRCULATING_USD) * 100n ||
      BigInt(stressSupplyCents) >
        BigInt(MAX_VALIDATED_ASSET_CIRCULATING_USD) * 100n
    ) {
      issues.push(`${evaluated.assetId} does not carry a bounded production supply weight`);
      continue;
    }
    if (compiledSupplyCents !== stressSupplyCents) {
      issues.push(`${evaluated.assetId} compiled and stress-state supply weights do not match`);
      continue;
    }
    totalCents += BigInt(stressSupplyCents);
  }
  if (
    totalCents >
    BigInt(MAX_VALIDATED_AGGREGATE_CIRCULATING_USD) * 100n
  ) {
    issues.push(
      `Aggregate production supply weight exceeds ${MAX_VALIDATED_AGGREGATE_CIRCULATING_USD} USD`,
    );
  }
  return {
    totalUsd: Number(totalCents) / 100,
    issues: [...new Set(issues)].sort(compareText),
  };
}

export interface V9ProductionGenerationVerificationInput {
  exactCache: unknown;
  replay: unknown;
}

export interface V9VerifiedProductionGeneration {
  receipt: V9ProductionGenerationVerificationReceipt;
  replay: unknown | null;
  v8Cards: readonly { id: string; grade: z.infer<typeof V9GradeSchema> }[];
}

export interface V9ProductionGenerationVerifierDependencies {
  parseExactCacheArtifact(value: unknown): Promise<ReportCardsFixedInputCacheArtifact>;
  buildV8Snapshot(value: unknown): ReturnType<typeof buildReportCardsSnapshotFromFixedInput>;
  buildV9Candidate(
    input: Parameters<typeof buildSafetyScoreV9CandidateFromNormalizedInput>[0],
  ): SafetyScoreV9CandidatePipelineResult;
}

const DEFAULT_GENERATION_VERIFIER_DEPENDENCIES: V9ProductionGenerationVerifierDependencies = {
  parseExactCacheArtifact: parseReportCardsFixedInputCacheArtifact,
  buildV8Snapshot: buildReportCardsSnapshotFromFixedInput,
  buildV9Candidate: buildSafetyScoreV9CandidateFromNormalizedInput,
};

export async function verifyV9ProductionGeneration(
  input: V9ProductionGenerationVerificationInput,
  inputIndex: number,
  dependencies: V9ProductionGenerationVerifierDependencies =
    DEFAULT_GENERATION_VERIFIER_DEPENDENCIES,
): Promise<V9VerifiedProductionGeneration> {
  const exactCacheDigest = safePayloadDigest(input.exactCache, "Exact-cache artifact");
  const replayDigest = safePayloadDigest(input.replay, "Replay artifact");
  const exactCachePayloadDigest = exactCacheDigest.digest;
  const replayPayloadDigest = replayDigest.digest;
  const failure = (issues: readonly string[]): V9VerifiedProductionGeneration => ({
    receipt: {
      inputIndex,
      verified: false,
      exactCachePayloadDigest,
      replayPayloadDigest,
      extensionPayloadDigest: null,
      sourceGeneration: null,
      baseInputGenerationId: null,
      clockSec: null,
      sourceUpdatedAtSec: null,
      capturedAtSec: null,
      v8PublicationIdentity: null,
      candidateId: null,
      factSetDigest: null,
      resultDigest: null,
      candidateIdentity: null,
      activeAssetCount: null,
      supplyTotalUsd: null,
      issues: [...new Set(issues)].sort(compareText),
    },
    replay: null,
    v8Cards: [],
  });

  const rawDigestIssues = [exactCacheDigest.issue, replayDigest.issue].filter(
    (issue): issue is string => issue !== null,
  );
  if (rawDigestIssues.length > 0) return failure(rawDigestIssues);

  try {
    const replay = ReplayShellSchema.parse(input.replay);
    const cache = await dependencies.parseExactCacheArtifact(exactCacheEnvelope(input.exactCache));
    if (cache.safetyScoreIdentity === null) {
      return failure(["Exact production cache lacks its V8 publication identity"]);
    }
    const v8 = dependencies.buildV8Snapshot(cache.input);
    if (
      v8.safetyScoreIdentity === undefined ||
      stableJsonStringifyV1(v8.safetyScoreIdentity) !==
        stableJsonStringifyV1(cache.safetyScoreIdentity)
    ) {
      return failure([
        "Locally rebuilt V8 identity does not equal the exact cache publication identity",
      ]);
    }
    const activeAssetIds = new Set(cache.input.activeAssetIds);
    const v8ActiveCards = v8.cards.filter((card) => activeAssetIds.has(card.id));
    if (
      v8ActiveCards.length !== activeAssetIds.size ||
      new Set(v8ActiveCards.map((card) => card.id)).size !== activeAssetIds.size
    ) {
      return failure(["Locally rebuilt V8 cards do not cover the exact active asset set"]);
    }
    const rebuilt = dependencies.buildV9Candidate({
      fixedInput: cache.input,
      publishedAtSec: cache.input.clockSec,
      ...(releaseCandidateOverride(replay.pipeline.candidate.candidateId) === undefined
        ? {}
        : { releaseCandidateId: replay.pipeline.candidate.candidateId }),
    });
    if (
      stableJsonStringifyV1(replay.pipeline.extension) !==
      stableJsonStringifyV1(rebuilt.extension)
    ) {
      return failure([
        "Supplied replay extension does not equal the extension locally rebuilt from exact production input",
      ]);
    }
    if (replay.pipeline.candidate.publishedAtSec !== cache.input.clockSec) {
      return failure([
        "Supplied replay publication timestamp does not equal the exact production evidence clock",
      ]);
    }
    if (stableJsonStringifyV1(replay.pipeline) !== stableJsonStringifyV1(rebuilt)) {
      return failure(["Supplied replay pipeline does not equal the locally rebuilt production pipeline"]);
    }
    const supply = supplyReceipt(rebuilt);
    if (supply.issues.length > 0) return failure(supply.issues);
    const capturedAtSec = Date.parse(cache.input.capturedAt) / 1_000;
    const sourceUpdatedAtSec = cache.input.updatedAt;
    const generationTimestampMatch = cache.input.sourceGeneration.match(/:([0-9]+)$/);
    const generationTimestampSec =
      generationTimestampMatch === null ? null : Number(generationTimestampMatch[1]);
    if (
      !Number.isInteger(sourceUpdatedAtSec) ||
      sourceUpdatedAtSec < 0 ||
      generationTimestampSec !== sourceUpdatedAtSec ||
      sourceUpdatedAtSec > cache.input.clockSec ||
      cache.input.clockSec - sourceUpdatedAtSec > MAX_SOURCE_TO_CLOCK_LAG_SEC
    ) {
      return failure(["Exact production source generation timestamp is not bound to its evidence clock"]);
    }
    if (
      !Number.isInteger(capturedAtSec) ||
      capturedAtSec < cache.input.clockSec ||
      capturedAtSec - cache.input.clockSec > MAX_SOURCE_TO_CLOCK_LAG_SEC
    ) {
      return failure(["Exact production capture timestamp is invalid or not bound to its evidence clock"]);
    }
    const canonicalReplay = {
      schemaVersion: 1 as const,
      kind: "safety-score-v9-candidate-replay" as const,
      lifecycle: "active" as const,
      releaseAuthorization: {
        authorized: false as const,
        reason: "v9-replay-only" as const,
      },
      pipeline: rebuilt,
    };
    return {
      receipt: {
        inputIndex,
        verified: true,
        exactCachePayloadDigest,
        replayPayloadDigest,
        extensionPayloadDigest: payloadDigest(replay.pipeline.extension),
        sourceGeneration: cache.input.sourceGeneration,
        baseInputGenerationId: cache.input.baseInputGenerationId,
        clockSec: cache.input.clockSec,
        sourceUpdatedAtSec,
        capturedAtSec,
        v8PublicationIdentity: cache.safetyScoreIdentity,
        candidateId: rebuilt.candidate.candidateId,
        factSetDigest: rebuilt.candidate.factSetDigest,
        resultDigest: rebuilt.candidate.resultDigest,
        candidateIdentity: rebuilt.candidateIdentity,
        activeAssetCount: rebuilt.candidate.cards.length,
        supplyTotalUsd: supply.totalUsd,
        issues: [],
      },
      replay: canonicalReplay,
      v8Cards: v8ActiveCards.map((card) => ({
        id: card.id,
        grade: V9GradeSchema.parse(card.overallGrade),
      })),
    };
  } catch (error) {
    return failure([error instanceof Error ? error.message : "Production generation verification failed"]);
  }
}

export function assessV9ProductionCaptureLedger(
  rawLedger: unknown,
  verified: readonly V9VerifiedProductionGeneration[],
): V9ProductionCaptureLedgerReport {
  if (rawLedger === undefined) {
    return {
      provided: false,
      parsed: false,
      continuityPassed: false,
      trailingCompleteCaptureIds: [],
      issues: ["Production capture ledger was not provided"],
    };
  }
  const parsed = CaptureLedgerSchema.safeParse(rawLedger);
  if (!parsed.success) {
    return {
      provided: true,
      parsed: false,
      continuityPassed: false,
      trailingCompleteCaptureIds: [],
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
    };
  }
  const ledger = parsed.data as V9ProductionCaptureLedger;
  const issues: string[] = [];
  const trailing = ledger.entries.slice(-3);
  if (trailing.length !== 3 || trailing.some((entry) => entry.status !== "complete")) {
    issues.push("The capture ledger does not end in three consecutive complete captures");
  }
  const verifiedComplete = verified
    .filter((entry) => entry.receipt.verified)
    .sort((left, right) => (left.receipt.clockSec ?? 0) - (right.receipt.clockSec ?? 0))
    .slice(-3);
  if (verifiedComplete.length !== 3) {
    issues.push("Fewer than three locally verified generations are available for ledger reconciliation");
  } else {
    for (let index = 1; index < verifiedComplete.length; index += 1) {
      const previous = verifiedComplete[index - 1]!.receipt.capturedAtSec;
      const current = verifiedComplete[index]!.receipt.capturedAtSec;
      const intervalSec =
        previous === null || current === null ? null : current - previous;
      if (
        intervalSec === null ||
        intervalSec < MIN_CAPTURE_INTERVAL_SEC ||
        intervalSec > MAX_CAPTURE_INTERVAL_SEC
      ) {
        issues.push(
          `Verified generation ${index + 1} is not a contiguous daily capture`,
        );
      }
    }
    trailing.forEach((entry, index) => {
      const receipt = verifiedComplete[index]!.receipt;
      if (
        entry.status !== "complete" ||
        entry.sourceGeneration !== receipt.sourceGeneration ||
        entry.baseInputGenerationId !== receipt.baseInputGenerationId ||
        entry.exactCachePayloadDigest !== receipt.exactCachePayloadDigest ||
        entry.replayPayloadDigest !== receipt.replayPayloadDigest ||
        entry.capturedAtSec !== receipt.capturedAtSec
      ) {
        issues.push(`Capture ledger entry ${entry.captureId} does not match verified generation ${index + 1}`);
      }
    });
  }
  return {
    provided: true,
    parsed: true,
    continuityPassed: issues.length === 0,
    trailingCompleteCaptureIds: trailing
      .filter((entry) => entry.status === "complete")
      .map((entry) => entry.captureId),
    issues: [...new Set(issues)].sort(compareText),
  };
}

interface HoldoutScorerProofAssessment {
  provided: boolean;
  parsed: boolean;
  scoresRecomputed: boolean;
  recomputedCaseCount: number;
  identityMatches: boolean;
  issues: string[];
}

function canonicalHoldoutNotRatedReasons(
  reasons: readonly unknown[],
): string[] {
  // The holdout contract stores strings, so retain the full canonical public
  // reason identity rather than collapsing distinct reasons to a shared code.
  return reasons
    .map((reason) => stableJsonStringifyV1(reason))
    .sort(compareText);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return stableJsonStringifyV1(left) === stableJsonStringifyV1(right);
}

function assessV9ProductionHoldoutScorerProof(
  rawProof: unknown,
  input: V9HistoricalHoldoutEvaluationInput,
  latest: V9VerifiedProductionGeneration | undefined,
): HoldoutScorerProofAssessment {
  if (rawProof === undefined) {
    return {
      provided: false,
      parsed: false,
      scoresRecomputed: false,
      recomputedCaseCount: 0,
      identityMatches: false,
      issues: ["Holdout scorer proof was not provided"],
    };
  }
  const parsedProof = HoldoutScorerProofSchema.safeParse(rawProof);
  if (!parsedProof.success) {
    return {
      provided: true,
      parsed: false,
      scoresRecomputed: false,
      recomputedCaseCount: 0,
      identityMatches: false,
      issues: parsedProof.error.issues.map(
        (issue) =>
          `scorerProof.${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    };
  }

  const proof = parsedProof.data;
  const issues: string[] = [];
  const manifestById = new Map(
    input.seal.cases.map((entry) => [entry.caseId, entry]),
  );
  const evaluationById = new Map(
    input.cases.map((entry) => [entry.caseId, entry]),
  );
  const expectedCaseIds = [...manifestById.keys()].sort(compareText);
  const evaluatedCaseIds = [...evaluationById.keys()].sort(compareText);
  const proofCaseIds = proof.cases.map((entry) => entry.caseId);
  if (
    !sameCanonicalValue(expectedCaseIds, evaluatedCaseIds) ||
    !sameCanonicalValue(expectedCaseIds, proofCaseIds)
  ) {
    issues.push(
      "Holdout scorer proof case set does not exactly match the sealed and evaluated cases",
    );
  }

  const sealSec = Date.parse(input.seal.sealedAt) / 1_000;
  const proofCreatedSec = Date.parse(proof.createdAt) / 1_000;
  if (proofCreatedSec > sealSec) {
    issues.push("Holdout scorer proof was not frozen by candidate sealing");
  }
  const unsealSec = Date.parse(input.unseal.unsealedAt) / 1_000;
  const evaluatedAtSec = Date.parse(input.evaluatedAt) / 1_000;
  const authorizedUnseal =
    unsealSec > sealSec &&
    evaluatedAtSec >= unsealSec &&
    input.unseal.releaseCandidateId === input.seal.releaseCandidateId &&
    input.unseal.holdoutId === input.seal.holdoutId &&
    input.unseal.sealDigest === input.seal.sealDigest &&
    input.unseal.attemptNumber === input.seal.attemptBudget.attemptNumber &&
    input.unseal.priorUnsealEventCount === 0 &&
    input.seal.reviewers.unsealAuthorityIds.includes(
      input.unseal.authorizedBy,
    );
  if (!authorizedUnseal) {
    issues.push(
      "Holdout scorer proof cannot be reconciled before the authorized one-time unseal",
    );
  }

  const latestIdentity = latest?.receipt.candidateIdentity ?? null;
  let identityMatches =
    latestIdentity !== null &&
    latest?.receipt.candidateId === input.seal.releaseCandidateId &&
    proof.releaseCandidateId === input.seal.releaseCandidateId;
  if (!identityMatches) {
    issues.push(
      "Holdout scorer proof release candidate does not match the verified production candidate",
    );
  }

  let recomputedCaseCount = 0;
  for (const proofCase of proof.cases) {
    const manifest = manifestById.get(proofCase.caseId);
    const evaluation = evaluationById.get(proofCase.caseId);
    if (!manifest || !evaluation) continue;

    const cutoffSec = Date.parse(proofCase.evidenceCutoff) / 1_000;
    if (
      proofCase.evidenceCutoff !== manifest.evidenceCutoff ||
      cutoffSec > proofCreatedSec ||
      cutoffSec > sealSec
    ) {
      issues.push(
        `Holdout scorer proof case ${proofCase.caseId} has an invalid evidence cutoff`,
      );
    }
    if (
      proofCase.publishedAtSec > proofCreatedSec ||
      proofCase.publishedAtSec > sealSec
    ) {
      issues.push(
        `Holdout scorer proof case ${proofCase.caseId} was scored after the proof freeze or candidate seal`,
      );
    }
    if (
      proofCase.sources.some(
        (source) =>
          Date.parse(source.publishedAt) / 1_000 > cutoffSec ||
          Date.parse(source.availabilityProof.observedAt) / 1_000 > cutoffSec,
      )
    ) {
      issues.push(
        `Holdout scorer proof case ${proofCase.caseId} contains source evidence after its cutoff`,
      );
    }

    const sourceDigest =
      computeV9ProductionHoldoutCaseSourceDigest(proofCase.sources);
    if (
      sourceDigest !== manifest.sourceDigest ||
      sourceDigest !== evaluation.sourceDigest
    ) {
      issues.push(
        `Holdout scorer proof case ${proofCase.caseId} source digest does not match the sealed evaluation`,
      );
    }

    try {
      const fixedInput = normalizeFixedInput(proofCase.fixedInput);
      if (!sameCanonicalValue(proofCase.fixedInput, fixedInput)) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} fixed input is not canonical`,
        );
      }
      if (
        fixedInput.clockSec > cutoffSec ||
        fixedInput.updatedAt > cutoffSec ||
        Date.parse(fixedInput.capturedAt) / 1_000 > proofCreatedSec ||
        Date.parse(fixedInput.capturedAt) / 1_000 > sealSec
      ) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} evidence clock is later than its cutoff or seal`,
        );
      }

      const rebuilt = buildSafetyScoreV9CandidateFromNormalizedInput({
        fixedInput,
        extension: proofCase.extension,
        publishedAtSec: proofCase.publishedAtSec,
        releaseCandidateId: input.seal.releaseCandidateId,
      });
      recomputedCaseCount += 1;
      if (!sameCanonicalValue(proofCase.extension, rebuilt.extension)) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} extension is not canonical`,
        );
      }

      const compiled = rebuilt.compiledFacts.assets;
      const evaluated = rebuilt.evaluatedSet.assets;
      const cards = rebuilt.candidate.cards;
      if (
        fixedInput.activeAssetIds.length !== 1 ||
        compiled.length !== 1 ||
        evaluated.length !== 1 ||
        cards.length !== 1 ||
        fixedInput.activeAssetIds[0] !== proofCase.assetId ||
        compiled[0]?.assetId !== proofCase.assetId ||
        evaluated[0]?.assetId !== proofCase.assetId ||
        cards[0]?.id !== proofCase.assetId
      ) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} does not map to exactly one evaluated asset`,
        );
        continue;
      }

      const card = cards[0]!;
      const notRatedReasons = canonicalHoldoutNotRatedReasons(
        card.nrReasons,
      );
      if (card.score !== evaluation.score) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} score does not match the unsealed evaluation`,
        );
      }
      if (!sameCanonicalValue(notRatedReasons, evaluation.notRatedReasons)) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} not-rated reasons do not match the unsealed evaluation`,
        );
      }
      if (
        rebuilt.compiledFacts.v9FactSetDigest !== manifest.factDigest ||
        rebuilt.compiledFacts.v9FactSetDigest !== evaluation.factDigest
      ) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} fact digest does not match the sealed evaluation`,
        );
      }
      if (rebuilt.candidate.resultDigest !== evaluation.resultDigest) {
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} result digest does not match the unsealed evaluation`,
        );
      }

      const caseIdentityMatches =
        latestIdentity !== null &&
        sameCanonicalValue(rebuilt.candidateIdentity, latestIdentity) &&
        rebuilt.candidateIdentity.policyDigest ===
          input.seal.digests.policySemanticDigest &&
        rebuilt.candidateIdentity.policyDigest ===
          input.bindings.policySemanticDigest &&
        rebuilt.candidateIdentity.evaluationBuildDigest ===
          input.seal.digests.evaluationBuildDigest &&
        rebuilt.candidateIdentity.evaluationBuildDigest ===
          input.bindings.evaluationBuildDigest &&
        rebuilt.candidate.candidateId === input.seal.releaseCandidateId;
      if (!caseIdentityMatches) {
        identityMatches = false;
        issues.push(
          `Holdout scorer proof case ${proofCase.caseId} candidate identity does not match the sealed production build`,
        );
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "unknown scorer failure";
      issues.push(
        `Holdout scorer proof case ${proofCase.caseId} did not rebuild: ${detail}`,
      );
    }
  }

  const canonicalIssues = [...new Set(issues)].sort(compareText);
  return {
    provided: true,
    parsed: true,
    scoresRecomputed:
      recomputedCaseCount === expectedCaseIds.length &&
      canonicalIssues.length === 0,
    recomputedCaseCount,
    identityMatches,
    issues: canonicalIssues,
  };
}

export function assessV9ProductionHoldoutBinding(
  rawInput: unknown,
  rawReport: unknown,
  rawScorerProof: unknown,
  latest: V9VerifiedProductionGeneration | undefined,
  validatedAtSec: number,
): V9ProductionHoldoutBindingReport {
  const inputProvided = rawInput !== undefined;
  const suppliedReportProvided = rawReport !== undefined;
  const scorerProofProvided = rawScorerProof !== undefined;
  if (!inputProvided || !suppliedReportProvided) {
    return {
      provided: false,
      suppliedReportProvided,
      scorerProofProvided,
      parsed: false,
      scorerProofParsed: false,
      statisticsRecomputed: false,
      scoresRecomputed: false,
      recomputedCaseCount: 0,
      suppliedReportMatches: false,
      digestValid: false,
      decisionPassed: false,
      identityMatches: false,
      scorerIdentityMatches: false,
      releaseCandidateId: null,
      reportDigest: null,
      issues: [
        ...(!inputProvided ? ["Sealed blind holdout evaluation input was not provided"] : []),
        ...(!suppliedReportProvided ? ["Blind holdout validation report was not provided"] : []),
        ...(!scorerProofProvided ? ["Holdout scorer proof was not provided"] : []),
      ],
    };
  }
  const parsedInput = V9HistoricalHoldoutEvaluationInputSchema.safeParse(rawInput);
  const parsedReport = V9HistoricalHoldoutValidationReportSchema.safeParse(rawReport);
  if (!parsedInput.success || !parsedReport.success) {
    return {
      provided: true,
      suppliedReportProvided: true,
      scorerProofProvided,
      parsed: false,
      scorerProofParsed: false,
      statisticsRecomputed: false,
      scoresRecomputed: false,
      recomputedCaseCount: 0,
      suppliedReportMatches: false,
      digestValid: false,
      decisionPassed: false,
      identityMatches: false,
      scorerIdentityMatches: false,
      releaseCandidateId: null,
      reportDigest: null,
      issues: [
        ...(parsedInput.success
          ? []
          : parsedInput.error.issues.map(
              (issue) => `input.${issue.path.join(".") || "$"}: ${issue.message}`,
            )),
        ...(parsedReport.success
          ? []
          : parsedReport.error.issues.map(
              (issue) => `report.${issue.path.join(".") || "$"}: ${issue.message}`,
            )),
        ...(!scorerProofProvided ? ["Holdout scorer proof was not provided"] : []),
      ],
    };
  }
  const suppliedReport = parsedReport.data as V9HistoricalHoldoutValidationReport;
  const report = evaluateV9HistoricalHoldout(parsedInput.data);
  const suppliedReportMatches =
    stableJsonStringifyV1(suppliedReport) === stableJsonStringifyV1(report);
  const digestValid =
    verifyV9HistoricalHoldoutValidationReportDigest(report) &&
    verifyV9HistoricalHoldoutValidationReportDigest(suppliedReport);
  const decisionPassed = report.decision === "gate-passed";
  const identity = latest?.receipt.candidateIdentity;
  const identityMatches =
    latest !== undefined &&
    identity !== undefined &&
    identity !== null &&
    report.releaseCandidateId === latest.receipt.candidateId &&
    report.digests.policySemanticDigest === identity.policyDigest &&
    report.digests.evaluationBuildDigest === identity.evaluationBuildDigest;
  const evaluatedAtSec = Date.parse(report.evaluatedAt) / 1_000;
  const scorerProof = assessV9ProductionHoldoutScorerProof(
    rawScorerProof,
    parsedInput.data,
    latest,
  );
  const issues: string[] = [];
  if (!suppliedReportMatches) {
    issues.push("Supplied blind holdout report does not equal the locally recomputed report");
  }
  if (!digestValid) issues.push("Blind holdout validation report digest does not verify");
  if (!decisionPassed) issues.push("Blind holdout validation decision is no-go");
  if (!identityMatches) issues.push("Blind holdout validation identity does not match the production candidate");
  if (!Number.isInteger(evaluatedAtSec) || evaluatedAtSec > validatedAtSec) {
    issues.push("Blind holdout validation timestamp is invalid or lies in the future");
  }
  issues.push(...scorerProof.issues);
  return {
    provided: true,
    suppliedReportProvided: true,
    scorerProofProvided: scorerProof.provided,
    parsed: true,
    scorerProofParsed: scorerProof.parsed,
    statisticsRecomputed: true,
    scoresRecomputed: scorerProof.scoresRecomputed,
    recomputedCaseCount: scorerProof.recomputedCaseCount,
    suppliedReportMatches,
    digestValid,
    decisionPassed,
    identityMatches,
    scorerIdentityMatches: scorerProof.identityMatches,
    releaseCandidateId: report.releaseCandidateId,
    reportDigest: report.reportDigest,
    issues: [...new Set(issues)].sort(compareText),
  };
}

function matchedV8Evidence(
  latest: V9VerifiedProductionGeneration,
): V9ProductionSupplementalValidationEvidence {
  const receipt = latest.receipt;
  if (
    receipt.candidateIdentity === null ||
    receipt.candidateId === null ||
    receipt.baseInputGenerationId === null ||
    receipt.factSetDigest === null ||
    receipt.resultDigest === null
  ) {
    throw new Error("Verified production generation lacks candidate identity");
  }
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-production-validation-evidence",
    candidateIdentity: receipt.candidateIdentity,
    candidateResult: {
      candidateId: receipt.candidateId,
      baseInputGenerationId: receipt.baseInputGenerationId,
      factSetDigest: receipt.factSetDigest,
      resultDigest: receipt.resultDigest,
    },
    // These proof classes remain empty until deterministic runners or
    // content-addressed owner rulings generate them. The core gate fails closed.
    qualitativeSentinels: [],
    syntheticAPlusScenarios: [],
    monotonicControls: [],
    v8: {
      cards: latest.v8Cards,
      movementClassifications: [],
    },
  };
}

export function findV9ProductionDToNrNonCreditIds(
  latest: V9VerifiedProductionGeneration | undefined,
): string[] {
  if (!latest || latest.replay === null) return [];
  const replay = ReplayShellSchema.parse(latest.replay);
  const pipeline = replay.pipeline as unknown as SafetyScoreV9CandidatePipelineResult;
  const v8ById = new Map(latest.v8Cards.map((card) => [card.id, card.grade]));
  return pipeline.candidate.cards
    .filter((card) => card.grade === "NR" && v8ById.get(card.id) === "D")
    .map((card) => card.id)
    .sort(compareText);
}

export interface V9StrictProductionAcceptanceInput {
  generations: readonly V9ProductionGenerationVerificationInput[];
  captureLedger?: unknown;
  holdoutInput?: unknown;
  holdoutReport?: unknown;
  holdoutScorerProof?: unknown;
  source: V9ProductionSourceReceipt;
  generationVerifierDependencies?: V9ProductionGenerationVerifierDependencies;
}

export async function evaluateV9StrictProductionAcceptance(
  input: V9StrictProductionAcceptanceInput,
): Promise<V9StrictProductionAcceptanceReport> {
  const verifications = await Promise.all(
    input.generations.map((generation, index) =>
      verifyV9ProductionGeneration(
        generation,
        index,
        input.generationVerifierDependencies,
      ),
    ),
  );
  const successful = verifications
    .filter((entry) => entry.receipt.verified && entry.replay !== null)
    .sort((left, right) => (left.receipt.clockSec ?? 0) - (right.receipt.clockSec ?? 0));
  const latest = successful[successful.length - 1];
  const ledger = assessV9ProductionCaptureLedger(input.captureLedger, verifications);
  const holdout = assessV9ProductionHoldoutBinding(
    input.holdoutInput,
    input.holdoutReport,
    input.holdoutScorerProof,
    latest,
    input.source.validatedAtSec,
  );
  const dToNrIds = findV9ProductionDToNrNonCreditIds(latest);
  const acceptance =
    successful.length === 0
      ? null
      : evaluateV9ProductionAcceptance(
          successful.map((entry) => entry.replay),
          {
            validationEvidence: latest ? matchedV8Evidence(latest) : undefined,
          },
        );
  const noGoReasons = new Set<V9StrictProductionNoGoReason>();
  if (
    !/^[a-f0-9]{40,64}$/.test(input.source.sourceCommit) ||
    input.source.branch !== "main" ||
    !input.source.trackedWorktreeClean ||
    !Number.isInteger(input.source.validatedAtSec) ||
    input.source.validatedAtSec < 0
  ) {
    noGoReasons.add("source-commit-unbound");
  }
  if (input.source.runtimeVersion !== input.source.expectedRuntimeVersion) {
    noGoReasons.add("runtime-mismatch");
  }
  if (verifications.some((entry) => !entry.receipt.verified) || successful.length < 3) {
    noGoReasons.add("generation-verification-failed");
  }
  const latestCaptureAgeSec =
    latest?.receipt.capturedAtSec === null || latest?.receipt.capturedAtSec === undefined
      ? null
      : input.source.validatedAtSec - latest.receipt.capturedAtSec;
  if (
    latestCaptureAgeSec === null ||
    latestCaptureAgeSec < -MAX_FUTURE_CAPTURE_SKEW_SEC ||
    latestCaptureAgeSec > MAX_LATEST_CAPTURE_AGE_SEC
  ) {
    noGoReasons.add("capture-recency-failed");
  }
  if (!ledger.provided) noGoReasons.add("capture-ledger-missing");
  else if (!ledger.continuityPassed) noGoReasons.add("capture-ledger-continuity-failed");
  if (!holdout.provided) noGoReasons.add("holdout-missing");
  else {
    if (
      !holdout.parsed ||
      !holdout.statisticsRecomputed ||
      !holdout.suppliedReportMatches ||
      !holdout.digestValid ||
      !holdout.decisionPassed
    ) {
      noGoReasons.add("holdout-gate-failed");
    }
    if (
      !holdout.identityMatches ||
      (holdout.scorerProofProvided && !holdout.scorerIdentityMatches)
    ) {
      noGoReasons.add("holdout-identity-mismatch");
    }
    if (!holdout.scoresRecomputed) noGoReasons.add("holdout-scores-unverified");
  }
  if (dToNrIds.length > 0) noGoReasons.add("d-to-nr-noncredit-unresolved");
  if (acceptance === null || acceptance.decision !== "gate-passed") {
    noGoReasons.add("acceptance-contract-failed");
  }
  const orderedNoGoReasons = [...noGoReasons].sort(compareText);
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-strict-production-acceptance",
    decision: orderedNoGoReasons.length === 0 ? "gate-passed" : "no-go",
    noGoReasons: orderedNoGoReasons,
    source: input.source,
    generationVerifications: verifications.map((entry) => entry.receipt),
    captureLedger: ledger,
    holdout,
    dToNrNonCreditAssetIds: dToNrIds,
    acceptance,
  };
}
