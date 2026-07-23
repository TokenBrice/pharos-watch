import { describe, expect, it } from "vitest";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import {
  computeV9HoldoutOutcomeSetDigest,
  createV9ReleaseCandidateSeal,
  evaluateV9HistoricalHoldout,
} from "@shared/lib/safety-score-v9/validation";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { V9ProductionGenerationVerificationReceipt } from "@shared/types/safety-score-v9-production-validation";
import {
  V9_HOLDOUT_VALIDATION_THRESHOLDS,
  type V9HistoricalHoldoutEvaluationInput,
  type V9HoldoutCaseEvaluation,
  type V9ReleaseCandidateSealPayload,
} from "@shared/types/safety-score-v9-validation";
import type {
  ReportCardsFixedInput,
  ReportCardsFixedInputCacheArtifact,
  ReportCardsFixedInputDraft,
} from "../report-cards-fixed-input";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import type { SafetyScoreV9CandidatePipelineResult } from "../safety-score-v9-candidate";
import { buildSafetyScoreV9CandidateFromNormalizedInput } from "../safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import {
  assessV9ProductionCaptureLedger,
  assessV9ProductionHoldoutBinding,
  computeV9ProductionHoldoutCaseSourceDigest,
  evaluateV9StrictProductionAcceptance,
  findV9ProductionDToNrNonCreditIds,
  verifyV9ProductionGeneration,
  type V9ProductionGenerationVerifierDependencies,
  type V9VerifiedProductionGeneration,
} from "../safety-score-v9-production-verifier";

const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"1".repeat(64)}`;
const CANDIDATE_IDENTITY = {
  schemaVersion: 1 as const,
  policyId: "safety-score-v9-candidate-v2",
  policyDigest: "a".repeat(64),
  evaluationBuildDigest: "b".repeat(64),
  compilerFactSchemaDigest: "c".repeat(64),
  producerCapabilityDigest: "d".repeat(64),
};
const HOLDOUT_ARCHETYPES = [
  "fiat-cash",
  "tbill",
  "cdp",
  "synthetic-delta-neutral",
] as const;
const HOLDOUT_FAILURE_FAMILIES = [
  "backing-loss",
  "exit-failure",
  "control-compromise",
] as const;

function holdoutDigest(value: string): string {
  return sha256Hex(`strict-production-holdout-test:${value}`);
}

function passingSelfReportedHoldout() {
  const manifests = Array.from({ length: 24 }, (_, index) => {
    const adverse = index < 12;
    const ordinal = (index % 12) + 1;
    const caseId = `case-${adverse ? "a" : "r"}-${String(ordinal).padStart(2, "0")}`;
    return {
      caseId,
      archetype: HOLDOUT_ARCHETYPES[(ordinal - 1) % HOLDOUT_ARCHETYPES.length]!,
      clusterId: `cluster-${caseId}`,
      failurePathFamily:
        HOLDOUT_FAILURE_FAMILIES[(ordinal - 1) % HOLDOUT_FAILURE_FAMILIES.length]!,
      evidenceCutoff: "1970-01-01T00:00:00.000Z",
      factDigest: holdoutDigest(`${caseId}:facts`),
      sourceDigest: holdoutDigest(`${caseId}:sources`),
      factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
    };
  });
  const cases: V9HoldoutCaseEvaluation[] = manifests.map((manifest, index) => {
    const adverse = index < 12;
    const ordinal = (index % 12) + 1;
    return {
      caseId: manifest.caseId,
      factDigest: manifest.factDigest,
      sourceDigest: manifest.sourceDigest,
      resultDigest: holdoutDigest(`${manifest.caseId}:result`),
      score: adverse ? 30 + ordinal : 74 + ordinal,
      notRatedReasons: [],
      outcome: {
        classification: adverse ? "adverse" : "stress-exposed-resilient",
        catastrophicOrClaimImpairing: adverse && ordinal <= 2,
        comparableStressVerified: true,
        stressFamily: manifest.failurePathFamily,
        observedFrom: "1970-01-02T00:00:00.000Z",
        observedThrough: "1970-01-03T00:00:00.000Z",
        outcomeReviewerId: "outcome-reviewer",
        censorReason: null,
      },
    };
  });
  const payload: V9ReleaseCandidateSealPayload = {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    methodologyRoundId: "v9-round-1",
    holdoutId: "v9-holdout-1",
    lifecycle: "sealed-candidate",
    sealedAt: "1970-01-01T12:00:00.000Z",
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: holdoutDigest("fact-set"),
      sourceArchiveDigest: holdoutDigest("source-archive"),
      policySemanticDigest: CANDIDATE_IDENTITY.policyDigest,
      evaluationBuildDigest: CANDIDATE_IDENTITY.evaluationBuildDigest,
      holdoutManifestDigest: holdoutDigest("manifest"),
      preregistrationDigest: holdoutDigest("preregistration"),
      outcomeCommitmentDigest: computeV9HoldoutOutcomeSetDigest(cases),
    },
    thresholds: V9_HOLDOUT_VALIDATION_THRESHOLDS,
    attemptBudget: {
      maximumAttempts: 1,
      attemptNumber: 1,
      attemptsUsedBeforeSeal: 0,
      priorAttemptIds: [],
      sequentialTestingRule: "one-shot-no-holdout-reuse",
    },
    prerequisites: {
      producerCapabilityFreeze: "passed",
      developmentStabilityGate: "passed",
      sourceRetrievalAudit: "passed",
      factAbstractionReliabilityAudit: "passed",
    },
    reviewers: {
      selectionOwnerId: "selection-owner",
      calibrationOwnerIds: ["calibration-owner"],
      outcomeReviewerIds: ["outcome-reviewer"],
      unsealAuthorityIds: ["unseal-authority"],
    },
    cases: manifests,
    matchedPairs: Array.from({ length: 8 }, (_, index) => {
      const ordinal = index + 1;
      return {
        pairId: `pair-${String(ordinal).padStart(2, "0")}`,
        caseIds: [
          `case-a-${String(ordinal).padStart(2, "0")}`,
          `case-r-${String(ordinal).padStart(2, "0")}`,
        ],
        archetype: HOLDOUT_ARCHETYPES[index % HOLDOUT_ARCHETYPES.length]!,
        failurePathFamily:
          HOLDOUT_FAILURE_FAMILIES[index % HOLDOUT_FAILURE_FAMILIES.length]!,
      };
    }),
  };
  const seal = createV9ReleaseCandidateSeal(payload);
  const input: V9HistoricalHoldoutEvaluationInput = {
    schemaVersion: 1,
    evaluatedAt: "1970-01-04T00:00:00.000Z",
    seal,
    bindings: {
      factSetDigest: seal.digests.factSetDigest,
      sourceArchiveDigest: seal.digests.sourceArchiveDigest,
      policySemanticDigest: seal.digests.policySemanticDigest,
      evaluationBuildDigest: seal.digests.evaluationBuildDigest,
      holdoutManifestDigest: seal.digests.holdoutManifestDigest,
    },
    unseal: {
      eventId: "unseal-event-1",
      releaseCandidateId: seal.releaseCandidateId,
      holdoutId: seal.holdoutId,
      sealDigest: seal.sealDigest,
      outcomeSetDigest: seal.digests.outcomeCommitmentDigest,
      unsealedAt: "1970-01-02T00:00:00.000Z",
      authorizedBy: "unseal-authority",
      attemptNumber: 1,
      priorUnsealEventCount: 0,
      outcomeAccessBeforeEvent: "withheld",
      outcomeAccessAfterEvent: "unsealed",
    },
    cases,
  };
  return { input, report: evaluateV9HistoricalHoldout(input) };
}

function scopedHoldoutFixedInput(adverse: boolean): ReportCardsFixedInput {
  const draft = structuredClone(
    miniCapture.draft,
  ) as unknown as ReportCardsFixedInputDraft;
  const assetId = "usdc-circle";
  draft.activeAssetIds = [assetId];
  draft.dexLiqMap = { [assetId]: draft.dexLiqMap[assetId]! };
  draft.resolvedBlacklistStatuses = {
    [assetId]: draft.resolvedBlacklistStatuses[assetId]!,
  };
  if (adverse) {
    draft.pegDataById = {
      ...draft.pegDataById,
      [assetId]: {
        ...draft.pegDataById[assetId]!,
        currentDeviationBps: 5_000,
        pegScore: 0,
        pegPct: 50,
        severityScore: 100,
        spreadPenalty: 100,
        activeDepeg: true,
        worstDeviationBps: 5_000,
      },
    };
    draft.activeDepegPeakBpsById = { [assetId]: 5_000 };
  }
  return createReportCardsFixedInput(draft);
}

function locallyScoredHoldout() {
  const releaseCandidateId = "v9-rc-1";
  const adverseFixedInput = scopedHoldoutFixedInput(true);
  const resilientFixedInput = scopedHoldoutFixedInput(false);
  const adversePipeline = buildSafetyScoreV9CandidateFromNormalizedInput({
    fixedInput: adverseFixedInput,
    extension:
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(
        adverseFixedInput,
      ),
    publishedAtSec: miniCapture.publishedAtSec,
    releaseCandidateId,
  });
  const resilientPipeline = buildSafetyScoreV9CandidateFromNormalizedInput({
    fixedInput: resilientFixedInput,
    extension:
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(
        resilientFixedInput,
      ),
    publishedAtSec: miniCapture.publishedAtSec,
    releaseCandidateId,
  });
  const adverseCard = adversePipeline.candidate.cards[0]!;
  const resilientCard = resilientPipeline.candidate.cards[0]!;
  if (
    adverseCard.score === null ||
    resilientCard.score === null ||
    resilientCard.score - adverseCard.score < 15
  ) {
    throw new Error(
      "Local scorer holdout fixture no longer satisfies the preregistered separation gate",
    );
  }
  if (
    stableJsonStringifyV1(adversePipeline.candidateIdentity) !==
    stableJsonStringifyV1(resilientPipeline.candidateIdentity)
  ) {
    throw new Error("Local scorer holdout fixture changed candidate identity");
  }

  const clockSec = resilientFixedInput.clockSec;
  const evidenceCutoff = new Date(clockSec * 1_000).toISOString();
  const sealedAt = new Date((clockSec + 60) * 1_000).toISOString();
  const createdAt = new Date((clockSec + 30) * 1_000).toISOString();
  const unsealedAt = new Date((clockSec + 86_400) * 1_000).toISOString();
  const observedThrough = new Date(
    (clockSec + 86_500) * 1_000,
  ).toISOString();
  const evaluatedAt = new Date((clockSec + 86_600) * 1_000).toISOString();
  const caseInputs = Array.from({ length: 24 }, (_, index) => {
    const adverse = index < 12;
    const ordinal = (index % 12) + 1;
    const caseId =
      `case-${adverse ? "a" : "r"}-${String(ordinal).padStart(2, "0")}`;
    const pipeline = adverse ? adversePipeline : resilientPipeline;
    const card = pipeline.candidate.cards[0]!;
    const sources = [{
      sourceId: `source:${caseId}`,
      title: `Frozen source for ${caseId}`,
      originalUrl: `https://example.com/${caseId}`,
      publishedAt: new Date((clockSec - 1_000) * 1_000).toISOString(),
      supports: [`case:${caseId}`],
      availabilityProof: {
        kind: "content-addressed-publication" as const,
        url: `https://example.com/${caseId}/availability`,
        observedAt: new Date((clockSec - 500) * 1_000).toISOString(),
        verifiedBy: ["source-verifier"],
      },
      archiveArtifact: {
        path: `sources/${caseId}.json`,
        sha256: holdoutDigest(`${caseId}:source-artifact`),
      },
    }];
    return {
      adverse,
      ordinal,
      caseId,
      pipeline,
      card,
      sources,
      sourceDigest:
        computeV9ProductionHoldoutCaseSourceDigest(sources),
    };
  });
  const manifests = caseInputs.map((entry) => ({
    caseId: entry.caseId,
    archetype:
      HOLDOUT_ARCHETYPES[(entry.ordinal - 1) % HOLDOUT_ARCHETYPES.length]!,
    clusterId: `cluster-${entry.caseId}`,
    failurePathFamily:
      HOLDOUT_FAILURE_FAMILIES[
        (entry.ordinal - 1) % HOLDOUT_FAILURE_FAMILIES.length
      ]!,
    evidenceCutoff,
    factDigest: entry.pipeline.compiledFacts.v9FactSetDigest,
    sourceDigest: entry.sourceDigest,
    factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
  }));
  const cases: V9HoldoutCaseEvaluation[] = caseInputs.map((entry) => ({
    caseId: entry.caseId,
    factDigest: entry.pipeline.compiledFacts.v9FactSetDigest,
    sourceDigest: entry.sourceDigest,
    resultDigest: entry.pipeline.candidate.resultDigest,
    score: entry.card.score,
    notRatedReasons: entry.card.nrReasons
      .map((reason) => stableJsonStringifyV1(reason))
      .sort(),
    outcome: {
      classification: entry.adverse
        ? "adverse"
        : "stress-exposed-resilient",
      catastrophicOrClaimImpairing:
        entry.adverse && entry.ordinal <= 2,
      comparableStressVerified: true,
      stressFamily:
        HOLDOUT_FAILURE_FAMILIES[
          (entry.ordinal - 1) % HOLDOUT_FAILURE_FAMILIES.length
        ]!,
      observedFrom: unsealedAt,
      observedThrough,
      outcomeReviewerId: "outcome-reviewer",
      censorReason: null,
    },
  }));
  const candidateIdentity = resilientPipeline.candidateIdentity;
  const payload: V9ReleaseCandidateSealPayload = {
    schemaVersion: 1,
    releaseCandidateId,
    methodologyRoundId: "v9-round-1",
    holdoutId: "v9-holdout-1",
    lifecycle: "sealed-candidate",
    sealedAt,
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: holdoutDigest("fact-set"),
      sourceArchiveDigest: holdoutDigest("source-archive"),
      policySemanticDigest: candidateIdentity.policyDigest,
      evaluationBuildDigest: candidateIdentity.evaluationBuildDigest,
      holdoutManifestDigest: holdoutDigest("manifest"),
      preregistrationDigest: holdoutDigest("preregistration"),
      outcomeCommitmentDigest: computeV9HoldoutOutcomeSetDigest(cases),
    },
    thresholds: V9_HOLDOUT_VALIDATION_THRESHOLDS,
    attemptBudget: {
      maximumAttempts: 1,
      attemptNumber: 1,
      attemptsUsedBeforeSeal: 0,
      priorAttemptIds: [],
      sequentialTestingRule: "one-shot-no-holdout-reuse",
    },
    prerequisites: {
      producerCapabilityFreeze: "passed",
      developmentStabilityGate: "passed",
      sourceRetrievalAudit: "passed",
      factAbstractionReliabilityAudit: "passed",
    },
    reviewers: {
      selectionOwnerId: "selection-owner",
      calibrationOwnerIds: ["calibration-owner"],
      outcomeReviewerIds: ["outcome-reviewer"],
      unsealAuthorityIds: ["unseal-authority"],
    },
    cases: manifests,
    matchedPairs: Array.from({ length: 8 }, (_, index) => {
      const ordinal = index + 1;
      return {
        pairId: `pair-${String(ordinal).padStart(2, "0")}`,
        caseIds: [
          `case-a-${String(ordinal).padStart(2, "0")}`,
          `case-r-${String(ordinal).padStart(2, "0")}`,
        ],
        archetype:
          HOLDOUT_ARCHETYPES[index % HOLDOUT_ARCHETYPES.length]!,
        failurePathFamily:
          HOLDOUT_FAILURE_FAMILIES[
            index % HOLDOUT_FAILURE_FAMILIES.length
          ]!,
      };
    }),
  };
  const seal = createV9ReleaseCandidateSeal(payload);
  const input: V9HistoricalHoldoutEvaluationInput = {
    schemaVersion: 1,
    evaluatedAt,
    seal,
    bindings: {
      factSetDigest: seal.digests.factSetDigest,
      sourceArchiveDigest: seal.digests.sourceArchiveDigest,
      policySemanticDigest: seal.digests.policySemanticDigest,
      evaluationBuildDigest: seal.digests.evaluationBuildDigest,
      holdoutManifestDigest: seal.digests.holdoutManifestDigest,
    },
    unseal: {
      eventId: "unseal-event-1",
      releaseCandidateId,
      holdoutId: seal.holdoutId,
      sealDigest: seal.sealDigest,
      outcomeSetDigest: seal.digests.outcomeCommitmentDigest,
      unsealedAt,
      authorizedBy: "unseal-authority",
      attemptNumber: 1,
      priorUnsealEventCount: 0,
      outcomeAccessBeforeEvent: "withheld",
      outcomeAccessAfterEvent: "unsealed",
    },
    cases,
  };
  const proof = {
    schemaVersion: 1 as const,
    kind: "safety-score-v9-holdout-scorer-proof" as const,
    releaseCandidateId,
    createdAt,
    cases: caseInputs.map((entry) => ({
      caseId: entry.caseId,
      assetId: entry.card.id,
      evidenceCutoff,
      publishedAtSec: miniCapture.publishedAtSec,
      fixedInput: entry.pipeline.fixedInput,
      extension: entry.pipeline.extension,
      sources: entry.sources,
    })),
  };
  const latest = verifiedGeneration(0, clockSec);
  latest.receipt.candidateId = releaseCandidateId;
  latest.receipt.candidateIdentity = candidateIdentity;
  return {
    input,
    report: evaluateV9HistoricalHoldout(input),
    proof,
    latest,
    validatedAtSec: clockSec + 86_700,
  };
}

function candidatePipeline(
  circulatingUsd = 100,
): SafetyScoreV9CandidatePipelineResult {
  return {
    extension: { schemaVersion: 2, assets: [] },
    fixedInput: {},
    compiledFacts: {
      assets: [{
        assetId: "asset-1",
        supply: { circulatingUsd },
      }],
    },
    evaluatedSet: {
      assets: [{
        assetId: "asset-1",
        stressState: {
          exitPortfolio: { circulatingUsd },
        },
      }],
    },
    candidate: {
      candidateId: "v9-rc-1",
      publishedAtSec: 1_000,
      factSetDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
      cards: [{ id: "asset-1", grade: "A" }],
    },
    candidateIdentity: CANDIDATE_IDENTITY,
  } as unknown as SafetyScoreV9CandidatePipelineResult;
}

function fixedInput(
  overrides: Partial<ReportCardsFixedInput> = {},
): ReportCardsFixedInput {
  return {
    capturedAt: "1970-01-01T00:16:40.000Z",
    sourceGeneration: "report-cards:8.17:900",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    activeAssetIds: ["asset-1"],
    clockSec: 1_000,
    updatedAt: 900,
    ...overrides,
  } as ReportCardsFixedInput;
}

function replay(pipeline: SafetyScoreV9CandidatePipelineResult): unknown {
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    lifecycle: "candidate",
    releaseAuthorization: {
      authorized: false,
      reason: "candidate-replay-only",
    },
    pipeline,
  };
}

function dependencies(
  rebuilt: SafetyScoreV9CandidatePipelineResult,
  input = fixedInput(),
): V9ProductionGenerationVerifierDependencies {
  const v8Identity = {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "8.17",
    evaluationBuildDigest: "9".repeat(64),
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId: input.sourceGeneration,
  };
  return {
    parseExactCacheArtifact: async (): Promise<ReportCardsFixedInputCacheArtifact> => ({
      input,
      safetyScoreIdentity: v8Identity,
    }),
    buildV8Snapshot: () =>
      ({
        safetyScoreIdentity: v8Identity,
        cards: [{ id: "asset-1", overallGrade: "D" }],
      }) as ReturnType<
        V9ProductionGenerationVerifierDependencies["buildV8Snapshot"]
      >,
    buildV9Candidate: () => structuredClone(rebuilt),
  };
}

function receipt(index: number, capturedAtSec: number): V9ProductionGenerationVerificationReceipt {
  return {
    inputIndex: index,
    verified: true,
    exactCachePayloadDigest: String(index + 1).repeat(64),
    replayPayloadDigest: String(index + 4).repeat(64),
    extensionPayloadDigest: "7".repeat(64),
    sourceGeneration: `report-cards:8.17:${capturedAtSec - 100}`,
    baseInputGenerationId: `report-cards-input:v1:${String(index + 1).repeat(64)}`,
    clockSec: capturedAtSec,
    sourceUpdatedAtSec: capturedAtSec - 100,
    capturedAtSec,
    v8PublicationIdentity: {
      model: "v8",
      schemaVersion: 1,
      methodologyVersion: "8.17",
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${String(index + 1).repeat(64)}`,
      publicationGenerationId: `report-cards:8.17:${capturedAtSec - 100}`,
    },
    candidateId: "v9-rc-1",
    factSetDigest: "8".repeat(64),
    resultDigest: "9".repeat(64),
    candidateIdentity: CANDIDATE_IDENTITY,
    activeAssetCount: 1,
    supplyTotalUsd: 100,
    issues: [],
  };
}

function verifiedGeneration(
  index: number,
  capturedAtSec: number,
): V9VerifiedProductionGeneration {
  return {
    receipt: receipt(index, capturedAtSec),
    replay: null,
    v8Cards: [],
  };
}

describe("Safety Score v9 strict production verifier", () => {
  it("accepts a replay only when it exactly equals the locally rebuilt pipeline", async () => {
    const pipeline = candidatePipeline();
    const result = await verifyV9ProductionGeneration(
      { exactCache: { cache: "raw" }, replay: replay(pipeline) },
      0,
      dependencies(pipeline),
    );

    expect(result.receipt).toMatchObject({
      verified: true,
      sourceGeneration: "report-cards:8.17:900",
      sourceUpdatedAtSec: 900,
      clockSec: 1_000,
      capturedAtSec: 1_000,
      candidateId: "v9-rc-1",
      supplyTotalUsd: 100,
      issues: [],
    });
    expect(result.v8Cards).toEqual([{ id: "asset-1", grade: "D" }]);
  });

  it("accepts fractional production supply after deterministic cent quantization", async () => {
    const pipeline = candidatePipeline(582_158_587.5483115);
    const result = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(pipeline) },
      0,
      dependencies(pipeline),
    );

    expect(result.receipt).toMatchObject({
      verified: true,
      supplyTotalUsd: 582_158_587.55,
      issues: [],
    });
  });

  it("rejects a replay whose self-reported result differs from the local rebuild", async () => {
    const rebuilt = candidatePipeline();
    const supplied = {
      ...rebuilt,
      candidate: {
        ...rebuilt.candidate,
        resultDigest: "0".repeat(64),
      },
    } as SafetyScoreV9CandidatePipelineResult;

    const result = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(supplied) },
      0,
      dependencies(rebuilt),
    );

    expect(result.receipt.verified).toBe(false);
    expect(result.receipt.issues).toContain(
      "Supplied replay pipeline does not equal the locally rebuilt production pipeline",
    );
  });

  it("rejects a fabricated extension even when the supplied candidate is recomputed around it", async () => {
    const rebuilt = candidatePipeline();
    const supplied = {
      ...rebuilt,
      extension: {
        schemaVersion: 2,
        assets: [{ assetId: "asset-1", fabricatedCredit: true }],
      },
    } as unknown as SafetyScoreV9CandidatePipelineResult;

    const result = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(supplied) },
      0,
      dependencies(rebuilt),
    );

    expect(result.receipt.verified).toBe(false);
    expect(result.receipt.issues).toContain(
      "Supplied replay extension does not equal the extension locally rebuilt from exact production input",
    );
  });

  it("binds publication time to the exact fixed-input evidence clock", async () => {
    const rebuilt = candidatePipeline();
    const supplied = {
      ...rebuilt,
      candidate: {
        ...rebuilt.candidate,
        publishedAtSec: 999,
      },
    } as SafetyScoreV9CandidatePipelineResult;

    const result = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(supplied) },
      0,
      dependencies(rebuilt),
    );

    expect(result.receipt.verified).toBe(false);
    expect(result.receipt.issues).toContain(
      "Supplied replay publication timestamp does not equal the exact production evidence clock",
    );
  });

  it("rejects mismatched and unbounded production supply receipts", async () => {
    for (const [compiled, stress, expectedIssue] of [
      [100, 99, /supply weight/],
      [10_000_000_000_001, 10_000_000_000_001, /bounded production supply/],
      [Number.MAX_VALUE, Number.MAX_VALUE, /canonical stable JSON/],
    ] as const) {
      const rebuilt = candidatePipeline(compiled);
      (
        rebuilt.evaluatedSet.assets[0]!.stressState.exitPortfolio as {
          circulatingUsd: number;
        }
      ).circulatingUsd = stress;
      const result = await verifyV9ProductionGeneration(
        { exactCache: {}, replay: replay(rebuilt) },
        0,
        dependencies(rebuilt),
      );

      expect(result.receipt.verified).toBe(false);
      expect(result.receipt.issues[0]).toMatch(expectedIssue);
    }

    const aggregateBase = candidatePipeline(10_000_000_000_000);
    const aggregate = {
      ...aggregateBase,
      compiledFacts: {
        ...aggregateBase.compiledFacts,
        assets: Array.from({ length: 337 }, (_, index) => ({
          assetId: `asset-${index}`,
          supply: { circulatingUsd: 10_000_000_000_000 },
        })),
      },
      evaluatedSet: {
        ...aggregateBase.evaluatedSet,
        assets: Array.from({ length: 337 }, (_, index) => ({
          assetId: `asset-${index}`,
          stressState: {
            exitPortfolio: { circulatingUsd: 10_000_000_000_000 },
          },
        })),
      },
      candidate: {
        ...aggregateBase.candidate,
        cards: Array.from({ length: 337 }, (_, index) => ({
          id: `asset-${index}`,
          grade: "A",
        })),
      },
    } as unknown as SafetyScoreV9CandidatePipelineResult;
    const aggregateResult = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(aggregate) },
      0,
      dependencies(aggregate),
    );

    expect(aggregateResult.receipt.verified).toBe(false);
    expect(aggregateResult.receipt.issues).toContain(
      "Aggregate production supply weight exceeds 20000000000000 USD",
    );
  });

  it("rejects a source generation timestamp detached from the fixed-input clock", async () => {
    const pipeline = candidatePipeline();
    const result = await verifyV9ProductionGeneration(
      { exactCache: {}, replay: replay(pipeline) },
      0,
      dependencies(
        pipeline,
        fixedInput({ sourceGeneration: "report-cards:8.17:899" }),
      ),
    );

    expect(result.receipt.verified).toBe(false);
    expect(result.receipt.issues).toContain(
      "Exact production source generation timestamp is not bound to its evidence clock",
    );
  });

  it("requires three reconciled, contiguous daily capture-ledger entries", () => {
    const captures = [
      verifiedGeneration(0, 100_000),
      verifiedGeneration(1, 186_400),
      verifiedGeneration(2, 272_800),
    ];
    const ledger = {
      schemaVersion: 1,
      kind: "safety-score-v9-production-capture-ledger",
      entries: captures.map((capture, index) => ({
        ordinal: index + 1,
        captureId: `capture-${index + 1}`,
        status: "complete",
        capturedAtSec: capture.receipt.capturedAtSec,
        sourceGeneration: capture.receipt.sourceGeneration,
        baseInputGenerationId: capture.receipt.baseInputGenerationId,
        exactCachePayloadDigest: capture.receipt.exactCachePayloadDigest,
        replayPayloadDigest: capture.receipt.replayPayloadDigest,
        failureReason: null,
      })),
    };

    expect(assessV9ProductionCaptureLedger(ledger, captures)).toMatchObject({
      provided: true,
      parsed: true,
      continuityPassed: true,
      trailingCompleteCaptureIds: ["capture-1", "capture-2", "capture-3"],
      issues: [],
    });

    const skipped = structuredClone(ledger);
    skipped.entries[2]!.capturedAtSec = 359_200;
    captures[2]!.receipt.capturedAtSec = 359_200;
    expect(assessV9ProductionCaptureLedger(skipped, captures)).toMatchObject({
      continuityPassed: false,
      issues: expect.arrayContaining([
        "Verified generation 3 is not a contiguous daily capture",
      ]),
    });
  });

  it("does not accept a holdout report without the sealed evaluation input", () => {
    const report = assessV9ProductionHoldoutBinding(
      undefined,
      { decision: "gate-passed", reportDigest: "a".repeat(64) },
      undefined,
      undefined,
      300_000,
    );

    expect(report).toMatchObject({
      provided: false,
      suppliedReportProvided: true,
      parsed: false,
      statisticsRecomputed: false,
      scoresRecomputed: false,
      decisionPassed: false,
    });
    expect(report.issues).toContain(
      "Sealed blind holdout evaluation input was not provided",
    );
  });

  it("blocks a statistically passing holdout until its scores are rebuilt from sealed scorer inputs", async () => {
    const holdout = passingSelfReportedHoldout();
    expect(holdout.report.decision).toBe("gate-passed");
    const latest = verifiedGeneration(0, 272_800);
    latest.receipt.candidateId = "v9-rc-1";
    const binding = assessV9ProductionHoldoutBinding(
      holdout.input,
      holdout.report,
      undefined,
      latest,
      300_000,
    );

    expect(binding).toMatchObject({
      provided: true,
      parsed: true,
      scorerProofProvided: false,
      scorerProofParsed: false,
      statisticsRecomputed: true,
      scoresRecomputed: false,
      recomputedCaseCount: 0,
      suppliedReportMatches: true,
      digestValid: true,
      decisionPassed: true,
      identityMatches: true,
      scorerIdentityMatches: false,
    });
    expect(binding.issues).toContain(
      "Holdout scorer proof was not provided",
    );

    const strict = await evaluateV9StrictProductionAcceptance({
      generations: [],
      holdoutInput: holdout.input,
      holdoutReport: holdout.report,
      source: {
        sourceCommit: "a".repeat(40),
        branch: "main",
        runtimeVersion: "v24.16.0",
        expectedRuntimeVersion: "v24.16.0",
        trackedWorktreeClean: true,
        validatedAtSec: 300_000,
      },
    });
    expect(strict.noGoReasons).toContain("holdout-scores-unverified");
  });

  it("satisfies scorer recomputation from frozen production inputs under the current build", () => {
    const holdout = locallyScoredHoldout();
    expect(holdout.report.decision).toBe("gate-passed");

    const binding = assessV9ProductionHoldoutBinding(
      holdout.input,
      holdout.report,
      holdout.proof,
      holdout.latest,
      holdout.validatedAtSec,
    );

    expect(binding).toMatchObject({
      provided: true,
      parsed: true,
      scorerProofProvided: true,
      scorerProofParsed: true,
      statisticsRecomputed: true,
      scoresRecomputed: true,
      recomputedCaseCount: 24,
      suppliedReportMatches: true,
      digestValid: true,
      decisionPassed: true,
      identityMatches: true,
      scorerIdentityMatches: true,
      issues: [],
    });
  });

  it("rejects tampered, incomplete, identity-detached, and late scorer proofs", () => {
    type LocalHoldout = ReturnType<typeof locallyScoredHoldout>;
    const mutations: Array<{
      label: string;
      mutate(value: LocalHoldout): void;
      expectedIssue: string;
      scorerProofParsed?: boolean;
      scorerIdentityMatches?: boolean;
    }> = [
      {
        label: "tampered score",
        mutate: (value) => {
          value.input.cases[0]!.score =
            (value.input.cases[0]!.score ?? 0) + 1;
        },
        expectedIssue: "score does not match the unsealed evaluation",
      },
      {
        label: "tampered extension fact",
        mutate: (value) => {
          const extension = value.proof.cases[0]!
            .extension as unknown as {
              assets: Array<{ launchedAtSec: number | null }>;
            };
          extension.assets[0]!.launchedAtSec =
            (extension.assets[0]!.launchedAtSec ?? 1_000) + 1;
        },
        expectedIssue: "fact digest does not match the sealed evaluation",
      },
      {
        label: "detached build identity",
        mutate: (value) => {
          const identity = value.latest.receipt.candidateIdentity!;
          value.latest.receipt.candidateIdentity = {
            ...identity,
            evaluationBuildDigest:
              identity.evaluationBuildDigest === "f".repeat(64)
                ? "e".repeat(64)
                : "f".repeat(64),
          };
        },
        expectedIssue:
          "candidate identity does not match the sealed production build",
        scorerIdentityMatches: false,
      },
      {
        label: "duplicate case",
        mutate: (value) => {
          value.proof.cases.push(
            structuredClone(value.proof.cases[0]!),
          );
        },
        expectedIssue:
          "Case IDs must be unique and in canonical ascending order",
        scorerProofParsed: false,
      },
      {
        label: "missing case",
        mutate: (value) => {
          value.proof.cases.pop();
        },
        expectedIssue:
          "case set does not exactly match the sealed and evaluated cases",
      },
      {
        label: "proof frozen after sealing",
        mutate: (value) => {
          value.proof.createdAt = new Date(
            Date.parse(value.input.seal.sealedAt) + 1_000,
          ).toISOString();
        },
        expectedIssue: "was not frozen by candidate sealing",
      },
      {
        label: "source after cutoff",
        mutate: (value) => {
          value.proof.cases[0]!.sources[0]!.publishedAt = new Date(
            Date.parse(value.proof.cases[0]!.evidenceCutoff) + 1_000,
          ).toISOString();
        },
        expectedIssue: "contains source evidence after its cutoff",
      },
      {
        label: "unauthorized unseal",
        mutate: (value) => {
          value.input.unseal.authorizedBy = "unregistered-authority";
        },
        expectedIssue:
          "cannot be reconciled before the authorized one-time unseal",
      },
    ];

    const base = locallyScoredHoldout();
    for (const mutation of mutations) {
      const holdout = structuredClone(base);
      mutation.mutate(holdout);
      const binding = assessV9ProductionHoldoutBinding(
        holdout.input,
        holdout.report,
        holdout.proof,
        holdout.latest,
        holdout.validatedAtSec,
      );

      expect(binding.scoresRecomputed, mutation.label).toBe(false);
      expect(
        binding.issues.some((issue) =>
          issue.includes(mutation.expectedIssue),
        ),
        mutation.label,
      ).toBe(true);
      if (mutation.scorerProofParsed !== undefined) {
        expect(binding.scorerProofParsed, mutation.label).toBe(
          mutation.scorerProofParsed,
        );
      }
      if (mutation.scorerIdentityMatches !== undefined) {
        expect(binding.scorerIdentityMatches, mutation.label).toBe(
          mutation.scorerIdentityMatches,
        );
      }
    }
  }, 30_000);

  it("identifies a V8 D to V9 NR transition as unresolved non-credit", () => {
    const pipeline = candidatePipeline();
    pipeline.candidate.cards[0]!.grade = "NR";
    const latest: V9VerifiedProductionGeneration = {
      receipt: receipt(0, 100_000),
      replay: replay(pipeline),
      v8Cards: [{ id: "asset-1", grade: "D" }],
    };

    expect(findV9ProductionDToNrNonCreditIds(latest)).toEqual(["asset-1"]);
  });

  it("returns structured source, runtime, recency, ledger, and holdout no-gos", async () => {
    const report = await evaluateV9StrictProductionAcceptance({
      generations: [],
      source: {
        sourceCommit: "not-a-commit",
        branch: "feature",
        runtimeVersion: "v22.0.0",
        expectedRuntimeVersion: "v24.16.0",
        trackedWorktreeClean: false,
        validatedAtSec: 300_000,
      },
    });

    expect(report.decision).toBe("no-go");
    expect(report.noGoReasons).toEqual(
      expect.arrayContaining([
        "acceptance-contract-failed",
        "capture-ledger-missing",
        "capture-recency-failed",
        "generation-verification-failed",
        "holdout-missing",
        "runtime-mismatch",
        "source-commit-unbound",
      ]),
    );
  });
});
