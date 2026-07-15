import { describe, expect, it } from "vitest";
import policyAsset from "../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { compileV9FactSetV2 } from "../../shared/lib/safety-score-v9/compile";
import { computeV9CoverageEvaluationProjectionDigest } from "../../shared/lib/safety-score-v9/coverage";
import { buildV9EvidenceGapQueue, parseV9EvidenceGapQueue } from "../../shared/lib/safety-score-v9/evidence-gap-queue";
import { loadV9MethodologyPolicy } from "../../shared/lib/safety-score-v9/policy";
import {
  computeV9HoldoutOutcomeSetDigest,
  createV9ReleaseCandidateSeal,
} from "../../shared/lib/safety-score-v9/validation";
import {
  V9ReleaseCoverageReportV1Schema,
  type V9CoverageEvaluationProjectionPayloadV1,
} from "../../shared/types/safety-score-v9-coverage";
import { V9EvidenceGapQueueV1Schema } from "../../shared/types/safety-score-v9-evidence-queue";
import type { V9FactSetCoreV2 } from "../../shared/types/safety-score-v9-facts";
import {
  V9_HOLDOUT_VALIDATION_THRESHOLDS,
  V9HistoricalHoldoutValidationReportSchema,
  type V9HistoricalHoldoutEvaluationInput,
  type V9ReleaseCandidateSealPayload,
} from "../../shared/types/safety-score-v9-validation";
import {
  runV9CoverageReportCli,
  type V9OperationalReportIo,
} from "../maintenance/generate-safety-score-v9-coverage-report";
import {
  runV9EvidenceGapQueueCli,
  type V9EvidenceGapQueueIo,
} from "../maintenance/generate-safety-score-v9-evidence-gap-queue";
import {
  runV9ValidationReportCli,
  type V9ValidationReportIo,
} from "../maintenance/generate-safety-score-v9-validation-report";

const AS_OF_SEC = 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 900 };
}

const SOURCES = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

const EVIDENCE = {
  evidenceId: "evidence:current",
  sourceId: "fixture",
  sourceGenerationId: "fixture:g1",
  disposition: "observed" as const,
  observedAtSec: 900,
  publishedAtSec: null,
  url: null,
  contentSha256: null,
  freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
  rejection: null,
};

function knownStatus(policyRuleId: string) {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function mechanismFact(policyRuleId: string) {
  return {
    status: knownStatus(policyRuleId),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function factSetCore(message = "Launch date evidence has not been established."): V9FactSetCoreV2 {
  const gapId = "asset-001:gap:implementation-date";
  return {
    schemaVersion: 2,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: 1_100,
    sourceFingerprints: SOURCES,
    activeAssetIds: ["asset-001"],
    assets: [
      {
        assetId: "asset-001",
        archetype: "algorithmic",
        evidence: [EVIDENCE],
        gaps: [
          {
            gapId,
            reasonCode: "missing-implementation-date",
            ownerDomain: "evidence",
            policyRuleId: "v9.implementation.launch-date",
            observationState: "missing",
            path: { kind: "local-component", componentKey: "implementation.launch-date" },
            message,
            evidenceRefIds: [],
          },
        ],
        implementation: {
          status: {
            applicability: {
              state: "required",
              policyRuleId: "v9.implementation.launch-date",
              rationale: null,
              gapId: null,
            },
            observationState: "missing",
            evidenceRefIds: [],
            gapIds: [gapId],
          },
          launchedAtSec: null,
        },
        mechanismRiskReview: {
          status: knownStatus("v9.backing.mechanism"),
          review: {
            archetype: "algorithmic",
            exogenousBackingShare: 1,
            reflexiveBackingShare: 0,
            contractionCapacityRatio: 1,
            contractionCapacity: mechanismFact("v9.backing.contraction"),
            confidenceAndIncentives: mechanismFact("v9.backing.confidence"),
            oracleAndControlAssumptions: mechanismFact("v9.backing.oracle"),
            emergencyRecovery: mechanismFact("v9.backing.emergency"),
            lossRecovery: mechanismFact("v9.backing.loss"),
          },
        },
        dependencies: {
          status: knownStatus("v9.dependencies"),
          sourceGenerationId: SOURCES.researchOverlays.generationId,
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveStatus: notApplicableStatus("v9.reserve.not-applicable"),
        reserveExposures: [],
        exitStatus: notApplicableStatus("v9.exit.not-applicable"),
        exitRoutes: [],
        controlStatus: notApplicableStatus("v9.control.not-applicable"),
        controls: [],
        economicControlReview: {
          mint: {
            status: notApplicableStatus("v9.control.mint.not-applicable"),
            controlKey: null,
            reconciliation: "not-applicable",
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("v9.control.oracle.not-applicable"),
            tier: null,
            branches: [],
          },
          bridge: { status: notApplicableStatus("v9.control.bridge.not-applicable"), routes: [] },
        },
        accessReview: {
          transfer: { status: knownStatus("v9.access.transfer"), posture: "permissionless" },
          freeze: { status: notApplicableStatus("v9.access.freeze.not-applicable"), reviews: [] },
        },
        peg: {
          status: knownStatus("v9.peg"),
          pegKey: "peg:usd",
          sourceGenerationId: SOURCES.peg.generationId,
          referenceKind: "fiat",
          referenceKey: "USD",
          methodologyVersion: "fixture-v1",
          pegScore: 99,
          currentDeviationBps: 1,
          activeDepeg: false,
          activeDepegBps: null,
          trackingSpanDays: 365,
          failureDomains: [{ kind: "oracle-feed", key: "peg:fixture" }],
        },
        supply: {
          status: knownStatus("v9.supply"),
          sourceGenerationId: SOURCES.chainSupply.generationId,
          sourceKind: "usd-denominated-circulating",
          circulatingUnits: null,
          referencePriceUsd: null,
          circulatingUsd: 10_000_000,
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [{ kind: "chain", key: "chain:fixture" }],
        },
      },
    ],
  };
}

function coverageArtifacts() {
  const policy = loadV9MethodologyPolicy(policyAsset);
  const factSet = compileV9FactSetV2(factSetCore());
  const evaluationPayload: V9CoverageEvaluationProjectionPayloadV1 = {
    schemaVersion: 1 as const,
    factSetDigest: factSet.v9FactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    producerCapabilityDigest: "8".repeat(64),
    evaluatedSetDigest: "9".repeat(64),
    scoreResultDigest: "a".repeat(64),
    asOfSec: factSet.asOfSec,
    sourceGenerations: Object.fromEntries(
      Object.entries(SOURCES).map(([key, identity]) => [key, identity.generationId]),
    ) as Record<keyof typeof SOURCES, string>,
    assets: [
      {
        assetId: "asset-001",
        finalScore: 80,
        nrReasonCodes: [],
        primaryExitRouteKey: null,
        includedExitRouteKeys: [],
      },
    ],
  };
  const evaluation = {
    ...evaluationPayload,
    evaluationProjectionDigest: computeV9CoverageEvaluationProjectionDigest(evaluationPayload),
  };
  const manifest = {
    schemaVersion: 1 as const,
    releaseCandidateId: "v9-rc-1",
    cohortId: "release-cohort-test",
    capturedAtSec: AS_OF_SEC,
    bindings: {
      factSetDigest: factSet.v9FactSetDigest,
      baseInputGenerationId: factSet.baseInputGenerationId,
      policyId: policy.policy.policyId,
      policyDigest: policy.semanticDigest,
      evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
      producerCapabilityDigest: evaluation.producerCapabilityDigest,
      evaluatedSetDigest: evaluation.evaluatedSetDigest,
      scoreResultDigest: evaluation.scoreResultDigest,
      evaluationProjectionDigest: evaluation.evaluationProjectionDigest,
      registryPayloadDigest: SOURCES.registry.payloadSha256,
      weightPayloadDigest: SOURCES.chainSupply.payloadSha256,
    },
    continuingActiveV8RateableCount: 1,
    assets: [
      {
        assetId: "asset-001",
        archetype: "algorithmic" as const,
        weight: {
          disposition: "current-valid" as const,
          canonicalUsd: 10_000_000,
          conservativeUpperBoundUsd: null,
          sourceGenerationId: SOURCES.chainSupply.generationId,
          observedAtSec: SOURCES.chainSupply.observedAtSec,
          rank: 1,
          topCutoffMember: true,
        },
        calibrationDisposition: "not-member" as const,
        nrReview: {
          state: "not-required" as const,
          reasonCodes: [],
          disposition: null,
          owner: null,
          reviewedAtSec: null,
        },
      },
    ],
  };
  return { factSet, evaluation, manifest };
}

function digest(character: string): string {
  return character.repeat(64);
}

function validationInput(): V9HistoricalHoldoutEvaluationInput {
  const caseManifest = {
    caseId: "case-adverse-01",
    archetype: "algorithmic" as const,
    clusterId: "cluster-adverse-01",
    failurePathFamily: "backing-loss",
    evidenceCutoff: "2025-12-01T00:00:00.000Z",
    factDigest: digest("1"),
    sourceDigest: digest("2"),
    factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
  };
  const payload: V9ReleaseCandidateSealPayload = {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    methodologyRoundId: "v9-round-1",
    holdoutId: "holdout-test-1",
    lifecycle: "sealed-candidate",
    sealedAt: "2026-01-01T00:00:00.000Z",
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: digest("3"),
      sourceArchiveDigest: digest("4"),
      policySemanticDigest: digest("5"),
      evaluationBuildDigest: digest("6"),
      holdoutManifestDigest: digest("7"),
      preregistrationDigest: digest("8"),
      outcomeCommitmentDigest: digest("9"),
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
      producerCapabilityFreeze: "not-run",
      developmentStabilityGate: "not-run",
      sourceRetrievalAudit: "not-run",
      factAbstractionReliabilityAudit: "not-run",
    },
    reviewers: {
      selectionOwnerId: "selection-owner",
      calibrationOwnerIds: ["calibration-owner"],
      outcomeReviewerIds: ["outcome-reviewer"],
      unsealAuthorityIds: ["unseal-authority"],
    },
    cases: [caseManifest],
    matchedPairs: [],
  };
  const cases = [
    {
      caseId: caseManifest.caseId,
      factDigest: caseManifest.factDigest,
      sourceDigest: caseManifest.sourceDigest,
      resultDigest: digest("a"),
      score: 40,
      notRatedReasons: [],
      outcome: {
        classification: "adverse" as const,
        catastrophicOrClaimImpairing: true,
        comparableStressVerified: true,
        stressFamily: caseManifest.failurePathFamily,
        observedFrom: "2026-01-02T00:00:00.000Z",
        observedThrough: "2026-02-01T00:00:00.000Z",
        outcomeReviewerId: "outcome-reviewer",
        censorReason: null,
      },
    },
  ];
  payload.digests.outcomeCommitmentDigest = computeV9HoldoutOutcomeSetDigest(cases);
  const seal = createV9ReleaseCandidateSeal(payload);
  return {
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
}

function memoryIo(inputs: Record<string, unknown>) {
  const writes = new Map<string, string>();
  let stdout = "";
  const io = {
    readJson(path: string) {
      if (!(path in inputs)) throw new Error(`Missing fixture ${path}`);
      return inputs[path];
    },
    writeText(path: string, contents: string) {
      writes.set(path, contents);
    },
    stdout: {
      write(text: string) {
        stdout += text;
        return true;
      },
    },
  } satisfies V9OperationalReportIo & V9EvidenceGapQueueIo & V9ValidationReportIo;
  return { io, writes, getStdout: () => stdout };
}

describe("Safety Score v9 evidence-gap queue", () => {
  it("derives policy, applicability, materiality, owner, and action from typed facts", () => {
    const factSet = compileV9FactSetV2(
      factSetCore("This message deliberately says unsupported but is not classified."),
    );
    const queue = buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) });

    expect(V9EvidenceGapQueueV1Schema.parse(queue)).toEqual(queue);
    expect(queue).toMatchObject({
      purpose: "evidence-work-queue-not-release-gate",
      status: "work-required",
      summary: {
        gapCount: 1,
        criticalGapCount: 0,
        knownSupplyWeightGapCount: 1,
        policyBindingMismatchGapCount: 0,
      },
    });
    expect(queue.entries[0]).toMatchObject({
      priority: 1,
      assetId: "asset-001",
      reasonCode: "missing-implementation-date",
      ownerDomain: "evidence",
      factOwnerDomain: "evidence",
      policyBindingIssues: [],
      applicability: "required",
      observationState: "missing",
      action: "collect-evidence",
      releaseSeverity: "review-required",
      treatment: "ceiling",
      critical: false,
      materiality: { basis: "asset-wide", fractionOfAsset: 1 },
      supplyWeight: { state: "current-valid", canonicalUsd: 10_000_000, materialityWeightedUsd: 10_000_000 },
    });
    expect(parseV9EvidenceGapQueue(queue)).toEqual(queue);
    expect(buildV9EvidenceGapQueue({ factSet, policy: loadV9MethodologyPolicy(policyAsset) }).queueDigest).toBe(
      queue.queueDigest,
    );
  });

  it("keeps the semantic queue key stable across message edits and rejects digest tampering", () => {
    const policy = loadV9MethodologyPolicy(policyAsset);
    const first = buildV9EvidenceGapQueue({ factSet: compileV9FactSetV2(factSetCore("First message.")), policy });
    const second = buildV9EvidenceGapQueue({ factSet: compileV9FactSetV2(factSetCore("Second message.")), policy });
    expect(second.entries[0]?.queueKey).toBe(first.entries[0]?.queueKey);
    expect(second.queueDigest).not.toBe(first.queueDigest);

    const tampered = structuredClone(first);
    tampered.summary.gapCount = 0;
    expect(() => parseV9EvidenceGapQueue(tampered)).toThrow();

    const validFactSet = compileV9FactSetV2(factSetCore());
    const invalidFactSet = { ...structuredClone(validFactSet), v9FactSetDigest: "f".repeat(64) };
    expect(() => buildV9EvidenceGapQueue({ factSet: invalidFactSet, policy })).toThrow("fact-set digest");
  });

  it("surfaces fact-to-policy ownership drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV2(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      ownerDomain: "evidence",
      factOwnerDomain: "control",
      policyBindingIssues: ["fact-owner-domain-mismatch"],
      action: "reconcile-policy-binding",
    });
  });

  it("surfaces fact-to-policy path-kind drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.path = {
      kind: "methodology",
      componentKey: "implementation.launch-date",
    };
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV2(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      ownerDomain: "evidence",
      factOwnerDomain: "evidence",
      path: { kind: "methodology" },
      policyBindingIssues: ["path-kind-not-permitted"],
      action: "reconcile-policy-binding",
    });
  });

  it("surfaces fact-to-policy archetype drift as reconciliation work", () => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = "incomplete-oracle-liquidation-branch";
    core.assets[0]!.gaps[0]!.ownerDomain = "control";
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV2(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(1);
    expect(queue.entries[0]).toMatchObject({
      archetype: "algorithmic",
      ownerDomain: "control",
      factOwnerDomain: "control",
      path: { kind: "local-component" },
      policyBindingIssues: ["archetype-not-permitted"],
      action: "reconcile-policy-binding",
    });
  });

  it.each([
    ["missing-pillar-evidence", "evidence"],
    ["missing-access-review", "control"],
  ] as const)("keeps %s %s-owned and locally bound", (reasonCode, ownerDomain) => {
    const core = factSetCore();
    core.assets[0]!.gaps[0]!.reasonCode = reasonCode;
    core.assets[0]!.gaps[0]!.ownerDomain = ownerDomain;
    const queue = buildV9EvidenceGapQueue({
      factSet: compileV9FactSetV2(core),
      policy: loadV9MethodologyPolicy(policyAsset),
    });

    expect(queue.summary.policyBindingMismatchGapCount).toBe(0);
    expect(queue.entries[0]).toMatchObject({
      reasonCode,
      ownerDomain,
      factOwnerDomain: ownerDomain,
      path: { kind: "local-component" },
      policyBindingIssues: [],
      action: "collect-evidence",
    });
  });
});

describe("Safety Score v9 operational report CLIs", () => {
  it("writes a deterministic no-go coverage report and optionally enforces pass", () => {
    const artifacts = coverageArtifacts();
    const { io, writes } = memoryIo({
      facts: artifacts.factSet,
      evaluation: artifacts.evaluation,
      manifest: artifacts.manifest,
    });
    const argv = [
      "--fact-set",
      "facts",
      "--evaluation",
      "evaluation",
      "--manifest",
      "manifest",
      "--output",
      "coverage.json",
    ];
    const report = runV9CoverageReportCli(argv, io);
    expect(report?.decision).toBe("no-go");
    expect(V9ReleaseCoverageReportV1Schema.parse(JSON.parse(writes.get("coverage.json")!))).toEqual(report);
    const firstOutput = writes.get("coverage.json");
    runV9CoverageReportCli(argv, io);
    expect(writes.get("coverage.json")).toBe(firstOutput);
    expect(() => runV9CoverageReportCli([...argv, "--require-pass"], io)).toThrow("coverage is no-go");
    expect(() => runV9CoverageReportCli(argv.slice(0, -4), io)).toThrow("--manifest is required");
  });

  it("writes no-go reports when coverage projection data is mutated behind retained identities", () => {
    const artifacts = coverageArtifacts();
    const evaluation = structuredClone(artifacts.evaluation);
    evaluation.assets[0]!.finalScore = null;
    evaluation.assets[0]!.nrReasonCodes = ["insufficient-evidence"];
    const { io } = memoryIo({ facts: artifacts.factSet, evaluation, manifest: artifacts.manifest });
    const report = runV9CoverageReportCli(
      ["--fact-set", "facts", "--evaluation", "evaluation", "--manifest", "manifest", "--output", "out"],
      io,
    );
    expect(report?.blockers.map((blocker) => blocker.code)).toContain("evaluation-projection-digest-mismatch");
  });

  it("writes a deterministic sealed-holdout no-go report and optionally enforces pass", () => {
    const input = validationInput();
    const { io, writes } = memoryIo({ input });
    const argv = ["--input", "input", "--output", "validation.json"];
    const report = runV9ValidationReportCli(argv, io);
    expect(report?.decision).toBe("no-go");
    expect(report?.noGoReasons).toContain("case-count-below-24");
    expect(V9HistoricalHoldoutValidationReportSchema.parse(JSON.parse(writes.get("validation.json")!))).toEqual(report);
    expect(() => runV9ValidationReportCli([...argv, "--require-pass"], io)).toThrow("validation is no-go");
  });

  it("writes a no-go validation report when a committed result changes after unseal", () => {
    const input = validationInput();
    input.cases[0]!.resultDigest = digest("b");
    const { io } = memoryIo({ input });
    const report = runV9ValidationReportCli(["--input", "input", "--output", "validation.json"], io);
    expect(report?.noGoReasons).toContain("outcome-commitment-digest-mismatch");
  });

  it("writes a policy-bound evidence queue and optionally enforces clear", () => {
    const factSet = compileV9FactSetV2(factSetCore());
    const { io, writes } = memoryIo({ facts: factSet, policy: policyAsset });
    const argv = ["--fact-set", "facts", "--policy", "policy", "--output", "queue.json"];
    const queue = runV9EvidenceGapQueueCli(argv, io);
    expect(queue?.status).toBe("work-required");
    expect(parseV9EvidenceGapQueue(JSON.parse(writes.get("queue.json")!))).toEqual(queue);
    expect(() => runV9EvidenceGapQueueCli([...argv, "--require-clear"], io)).toThrow("contains 1 gap");
  });
});
