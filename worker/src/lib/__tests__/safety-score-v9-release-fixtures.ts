import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN } from "@shared/lib/safety-score-v9/coverage";
import {
  computeV9HoldoutOutcomeSetDigest,
  createV9ReleaseCandidateSeal,
  evaluateV9HistoricalHoldout,
} from "@shared/lib/safety-score-v9/validation";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9_RELEASE_COVERAGE_FLOORS,
  V9ReleaseCoverageReportV1Schema,
  type V9ReleaseCoverageReportV1,
} from "@shared/types/safety-score-v9-coverage";
import {
  V9_HOLDOUT_VALIDATION_THRESHOLDS,
  type V9HistoricalHoldoutEvaluationInput,
  type V9HoldoutCaseEvaluation,
  type V9HoldoutCaseManifestEntry,
  type V9ReleaseCandidateSealPayload,
} from "@shared/types/safety-score-v9-validation";
import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";
import {
  computeSafetyScoreV9DailyCoverageSeriesDigest,
  type SafetyScoreV9DailyCoverageSeriesPayload,
  type SafetyScoreV9ReleaseEvidenceInput,
  type SafetyScoreV9ReleaseWindowIdentity,
} from "../safety-score-v9-release-window";

const ARCHETYPES = ["fiat-cash", "tbill", "cdp", "synthetic-delta-neutral"] as const;
const FAILURE_FAMILIES = ["backing-loss", "exit-failure", "control-compromise"] as const;

export function fixtureDigest(value: string): string {
  return sha256Hex(`safety-score-v9-release-fixture:${value}`);
}

function caseId(kind: "a" | "r", ordinal: number): string {
  return `case-${kind}-${String(ordinal).padStart(2, "0")}`;
}

function stratum(ordinal: number): { archetype: MechanismArchetype; failurePathFamily: string } {
  return {
    archetype: ARCHETYPES[(ordinal - 1) % ARCHETYPES.length],
    failurePathFamily: FAILURE_FAMILIES[(ordinal - 1) % FAILURE_FAMILIES.length],
  };
}

function manifestCase(kind: "a" | "r", ordinal: number): V9HoldoutCaseManifestEntry {
  const id = caseId(kind, ordinal);
  return {
    caseId: id,
    ...stratum(ordinal),
    clusterId: `cluster-${kind}-${String(ordinal).padStart(2, "0")}`,
    evidenceCutoff: "2025-12-01T00:00:00.000Z",
    factDigest: fixtureDigest(`${id}:facts`),
    sourceDigest: fixtureDigest(`${id}:sources`),
    factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
  };
}

function sealPayload(policyDigest: string): V9ReleaseCandidateSealPayload {
  return {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    methodologyRoundId: "v9-round-1",
    holdoutId: "v9-independent-holdout-1",
    lifecycle: "sealed-candidate",
    sealedAt: "2026-01-01T00:00:00.000Z",
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: fixtureDigest("holdout-fact-set"),
      sourceArchiveDigest: fixtureDigest("source-archive"),
      policySemanticDigest: policyDigest,
      evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
      holdoutManifestDigest: fixtureDigest("holdout-manifest"),
      preregistrationDigest: fixtureDigest("preregistration"),
      outcomeCommitmentDigest: fixtureDigest("outcomes"),
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
    cases: [
      ...Array.from({ length: 12 }, (_, index) => manifestCase("a", index + 1)),
      ...Array.from({ length: 12 }, (_, index) => manifestCase("r", index + 1)),
    ],
    matchedPairs: Array.from({ length: 8 }, (_, index) => {
      const ordinal = index + 1;
      return {
        pairId: `pair-${String(ordinal).padStart(2, "0")}`,
        caseIds: [caseId("a", ordinal), caseId("r", ordinal)],
        ...stratum(ordinal),
      };
    }),
  };
}

function evaluatedCase(manifest: V9HoldoutCaseManifestEntry): V9HoldoutCaseEvaluation {
  const adverse = manifest.caseId.startsWith("case-a-");
  const ordinal = Number(manifest.caseId.slice(-2));
  return {
    caseId: manifest.caseId,
    factDigest: manifest.factDigest,
    sourceDigest: manifest.sourceDigest,
    resultDigest: fixtureDigest(`${manifest.caseId}:result`),
    score: adverse ? 30 + ordinal : 74 + ordinal,
    notRatedReasons: [],
    outcome: {
      classification: adverse ? "adverse" : "stress-exposed-resilient",
      catastrophicOrClaimImpairing: adverse && ordinal <= 2,
      comparableStressVerified: true,
      stressFamily: manifest.failurePathFamily,
      observedFrom: "2026-01-02T00:00:00.000Z",
      observedThrough: "2026-02-01T00:00:00.000Z",
      outcomeReviewerId: "outcome-reviewer",
      censorReason: null,
    },
  };
}

function historicalValidation(policyDigest: string) {
  const payload = sealPayload(policyDigest);
  const cases = payload.cases.map(evaluatedCase);
  const seal = createV9ReleaseCandidateSeal({
    ...payload,
    digests: {
      ...payload.digests,
      outcomeCommitmentDigest: computeV9HoldoutOutcomeSetDigest(cases),
    },
  });
  const input: V9HistoricalHoldoutEvaluationInput = {
    schemaVersion: 1,
    evaluatedAt: "2026-02-02T00:00:00.000Z",
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
      unsealedAt: "2026-01-02T00:00:00.000Z",
      authorizedBy: "unseal-authority",
      attemptNumber: 1,
      priorUnsealEventCount: 0,
      outcomeAccessBeforeEvent: "withheld",
      outcomeAccessAfterEvent: "unsealed",
    },
    cases,
  };
  return { seal, report: evaluateV9HistoricalHoldout(input) };
}

function source(generationId: string, seed: string) {
  return { generationId, payloadSha256: fixtureDigest(seed), observedAtSec: 1_000 };
}

function releaseCoverage(args: {
  policyId: string;
  policyDigest: string;
  producerCapabilityDigest: string;
  baseInputGenerationId: string;
  factSetDigest: string;
  evaluatedSetDigest: string;
  resultDigest: string;
  evaluationProjectionDigest?: string;
  asOfSec?: number;
  sourceFingerprints?: V9ReleaseCoverageReportV1["identities"]["sourceFingerprints"];
}): V9ReleaseCoverageReportV1 {
  const sourceFingerprints = args.sourceFingerprints ?? {
    registry: source("registry:g1", "registry"),
    dex: source("dex:g1", "dex"),
    redemption: source("redemption:g1", "redemption"),
    liveReserves: source("reserves:g1", "reserves"),
    chainSupply: source("supply:g1", "supply"),
    peg: source("peg:g1", "peg"),
    researchOverlays: source("research:g1", "research"),
  };
  const lane = (name: "dex" | "redemption", count: number) => ({
    lane: name,
    routeCount: count,
    scoreEligibleRouteCount: count,
    exactCoverageRouteCount: count,
    currentRouteCount: count,
    capabilityCompleteRouteCount: count,
    outputResolvedRouteCount: count,
    valuationCurrentRouteCount: count,
    v9ContributingRouteCount: count,
    v9ContributingAssetIds: Array.from({ length: count }, (_, index) => `${name}-${String(index).padStart(2, "0")}`),
    minimumContributingAssets: count,
    floorPassed: true,
  });
  const review = (domain: "backing" | "control" | "access" | "peg" | "supply" | "implementation") => ({
    domain,
    activeCount: 305,
    applicabilityReviewedCount: 305,
    currentCompleteCount: 305,
    currentCompleteBps: 10_000,
    incompleteAssetIds: [],
    unresolvedApplicabilityAssetIds: [],
  });
  const placeholderDigest = "0".repeat(64);
  const withoutDigest = {
    schemaVersion: 1 as const,
    releaseCandidateId: "v9-rc-1",
    cohortId: "release-cohort-1",
    decision: "gate-passed" as const,
    identities: {
      factSetDigest: args.factSetDigest,
      baseInputGenerationId: args.baseInputGenerationId,
      policyId: args.policyId,
      policyDigest: args.policyDigest,
      evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
      producerCapabilityDigest: args.producerCapabilityDigest,
      evaluatedSetDigest: args.evaluatedSetDigest,
      scoreResultDigest: args.resultDigest,
      evaluationProjectionDigest: args.evaluationProjectionDigest ?? fixtureDigest("evaluation-projection"),
      asOfSec: args.asOfSec ?? 1_000,
      sourceFingerprints,
    },
    identityChecks: {
      factSetDigest: true,
      baseInputGenerationId: true,
      policyId: true,
      policyDigest: true,
      evaluationBuildDigest: true,
      producerCapabilityDigest: true,
      evaluationBuildCurrent: true,
      evaluatedSetDigest: true,
      scoreResultDigest: true,
      evaluationProjectionDigest: true,
      registryDigest: true,
      weightDigest: true,
      asOf: true,
      sourceGenerations: true,
    },
    floors: V9_RELEASE_COVERAGE_FLOORS,
    activeSet: {
      factCount: 305,
      evaluationCount: 305,
      manifestCount: 305,
      exactBijection: true,
      differences: {
        factOnly: [],
        evaluationOnly: [],
        manifestOnly: [],
        missingFromEvaluation: [],
        missingFromManifest: [],
      },
    },
    rateability: {
      activeCount: 305,
      rateableCount: 305,
      notRatedCount: 0,
      continuingActiveV8RateableCount: 305,
      requiredRateableCount: 305,
      passed: true,
    },
    weights: {
      currentValidAssetIds: [],
      missingAssetIds: [],
      invalidAssetIds: [],
      unboundedAssetIds: [],
      boundedCanonicalWeightUsd: 1,
      rateableCanonicalWeightUsd: 1,
      rateableWeightBps: 10_000,
      passed: true,
    },
    topCutoff: {
      position: 25 as const,
      cutoffUsd: 1,
      determinate: true,
      derivedMemberIds: [],
      manifestMemberIds: [],
      currentValidMemberIds: [],
      rateableMemberIds: [],
      evidenceCompleteMemberIds: [],
      ranksConsistent: true,
      membershipConsistent: true,
      passed: true,
    },
    calibration: {
      memberIds: [],
      requiredRateableIds: [],
      intentionalEvidenceGapIds: [],
      ratedRequiredIds: [],
      passed: true,
    },
    nrReviews: {
      notRatedAssetIds: [],
      reviewedAssetIds: [],
      missingReviewAssetIds: [],
      reasonMismatchAssetIds: [],
      passed: true,
    },
    reserves: {
      exposureCount: 0,
      sourceNativeExposureCount: 0,
      curatedExposureCount: 0,
      curatedFallbackExposureCount: 0,
      structuredExposureCount: 0,
      unstructuredExposureCount: 0,
      totalExposureWeight: 0,
      sourceNativeExposureWeight: 0,
      structuredExposureWeight: 0,
      assets: [],
    },
    exit: { lanes: [lane("dex", 45), lane("redemption", 27)], assets: [], passed: true },
    reviews: [
      review("backing"),
      review("control"),
      review("access"),
      review("peg"),
      review("supply"),
      review("implementation"),
    ],
    archetypes: [
      {
        archetype: "fiat-cash" as const,
        activeCount: 305,
        rateableCount: 305,
        requiredRateableCount: 3,
        countFloorPassed: true,
        boundedWeightUsd: 1,
        rateableWeightUsd: 1,
        unboundedWeightAssetIds: [],
        rateableWeightBps: 10_000,
        weightFloorPassed: true,
        passed: true,
      },
    ],
    producerCapabilityDigest: args.producerCapabilityDigest,
    blockers: [],
  };
  const provisional = V9ReleaseCoverageReportV1Schema.parse({
    ...withoutDigest,
    reportDigest: placeholderDigest,
  });
  const { reportDigest: _reportDigest, ...payload } = provisional;
  const reportDigest = sha256Hex(
    stableJsonStringifyV1({
      domain: V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN,
      report: payload,
    }),
  );
  return V9ReleaseCoverageReportV1Schema.parse({ ...payload, reportDigest });
}

export function buildPassingReleaseFixture(args: {
  policyId?: string;
  policyVersion?: string;
  policyDigest?: string;
  compilerFactSchemaDigest?: string;
  producerCapabilityDigest?: string;
  publicationEpoch?: number;
  baseInputGenerationId?: string;
  factSetDigest?: string;
  evaluatedSetDigest?: string;
  resultDigest?: string;
  evaluationProjectionDigest?: string;
  asOfSec?: number;
  sourceFingerprints?: V9ReleaseCoverageReportV1["identities"]["sourceFingerprints"];
  dailyCoverageIdentities?: readonly ({ utcDay: string } & Partial<{
    baseInputGenerationId: string;
    factSetDigest: string;
    evaluatedSetDigest: string;
    resultDigest: string;
    evaluationProjectionDigest: string;
    asOfSec: number;
    sourceFingerprints: V9ReleaseCoverageReportV1["identities"]["sourceFingerprints"];
  }>)[];
} = {}): {
  identity: SafetyScoreV9ReleaseWindowIdentity;
  evidence: SafetyScoreV9ReleaseEvidenceInput;
} {
  const policyId = args.policyId ?? "safety-score-v9-candidate-v1";
  const policyVersion = args.policyVersion ?? "candidate-v1";
  const policyDigest = args.policyDigest ?? fixtureDigest("policy");
  const compilerFactSchemaDigest = args.compilerFactSchemaDigest ?? fixtureDigest("compiler");
  const producerCapabilityDigest = args.producerCapabilityDigest ?? fixtureDigest("producer");
  const baseInputGenerationId = args.baseInputGenerationId ?? `report-cards-input:v1:${fixtureDigest("base")}`;
  const factSetDigest = args.factSetDigest ?? fixtureDigest("facts");
  const evaluatedSetDigest = args.evaluatedSetDigest ?? fixtureDigest("evaluated");
  const resultDigest = args.resultDigest ?? fixtureDigest("result");
  const historical = historicalValidation(policyDigest);
  const dailyOverrides = new Map(args.dailyCoverageIdentities?.map((entry) => [entry.utcDay, entry]) ?? []);
  const coveragePayload: SafetyScoreV9DailyCoverageSeriesPayload = {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    entries: Array.from({ length: 30 }, (_, index) => {
      const utcDay = `2026-06-${String(index + 1).padStart(2, "0")}`;
      const override = dailyOverrides.get(utcDay);
      return {
        utcDay,
        report: releaseCoverage({
          policyId,
          policyDigest,
          producerCapabilityDigest,
          baseInputGenerationId: override?.baseInputGenerationId ?? baseInputGenerationId,
          factSetDigest: override?.factSetDigest ?? factSetDigest,
          evaluatedSetDigest: override?.evaluatedSetDigest ?? evaluatedSetDigest,
          resultDigest: override?.resultDigest ?? resultDigest,
          evaluationProjectionDigest:
            override?.evaluationProjectionDigest ?? args.evaluationProjectionDigest,
          asOfSec: override?.asOfSec ?? args.asOfSec,
          sourceFingerprints: override?.sourceFingerprints ?? args.sourceFingerprints,
        }),
      };
    }),
  };
  const coverage = {
    ...coveragePayload,
    seriesDigest: computeSafetyScoreV9DailyCoverageSeriesDigest(coveragePayload),
  };
  const identity: SafetyScoreV9ReleaseWindowIdentity = {
    candidateId: "v9-rc-1",
    policyVersion,
    policyId,
    policyDigest,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
    publicationEpoch: args.publicationEpoch ?? 0,
    candidateSealDigest: historical.seal.sealDigest,
    historicalValidationReportDigest: historical.report.reportDigest,
    releaseCoverageReportDigest: coverage.seriesDigest,
  };
  return {
    identity,
    evidence: {
      candidateSeal: historical.seal,
      historicalValidationReport: historical.report,
      releaseCoverageReport: coverage,
    },
  };
}
