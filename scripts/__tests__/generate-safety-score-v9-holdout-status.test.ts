import { describe, expect, it } from "vitest";
import historicalFixtures from "../../shared/data/safety-score-v9/historical-fixtures-v1.json";
import { sha256Hex } from "../../shared/lib/sha256";
import {
  V9_HOLDOUT_VALIDATION_THRESHOLDS,
  type V9HoldoutCaseManifestEntry,
  type V9ReleaseCandidateSealPayload,
} from "../../shared/types/safety-score-v9-validation";
import { createV9ReleaseCandidateSeal } from "../../shared/lib/safety-score-v9/validation";
import {
  buildV9HoldoutStatus,
  computeV9HoldoutCaseSourceDigest,
  computeV9HoldoutSourceArchiveDigest,
  renderV9HoldoutStatusMarkdown,
  runV9HoldoutStatusCli,
  type ArtifactInspection,
  type V9HoldoutBlindReviewManifest,
  type V9HoldoutSourceArchiveManifest,
} from "../maintenance/generate-safety-score-v9-holdout-status";

const ARCHETYPES = ["fiat-cash", "tbill", "cdp", "synthetic-delta-neutral"] as const;
const FAILURE_FAMILIES = ["backing-loss", "exit-failure", "control-compromise"] as const;
const BUNDLE_ROOT = "/holdout-bundle";

function digest(value: string): string {
  return sha256Hex(`v9-holdout-status-test:${value}`);
}

function caseId(ordinal: number): string {
  return `case-${String(ordinal).padStart(2, "0")}`;
}

function ref(path: string, artifacts: Map<string, string>) {
  const sha256 = digest(path);
  artifacts.set(`${BUNDLE_ROOT}/${path}`, sha256);
  return { path, sha256 };
}

function preparedPackage() {
  const artifacts = new Map<string, string>();
  const preregistrationArtifact = ref("governance/preregistration.json", artifacts);
  const archiveCases: V9HoldoutSourceArchiveManifest["cases"] = Array.from(
    { length: 24 },
    (_, index) => {
      const id = caseId(index + 1);
      return {
        caseId: id,
        evidenceCutoff: "2024-01-01T00:00:00.000Z",
        exactProductionInputArtifact: ref(`cases/${id}/exact-input.json`, artifacts),
        compiledFactArtifact: ref(`cases/${id}/compiled-facts.json`, artifacts),
        sources: [
          {
            sourceId: `source-${String(index + 1).padStart(2, "0")}`,
            title: `Archived source ${index + 1}`,
            originalUrl: `https://example.com/source-${index + 1}`,
            publishedAt: "2023-11-01T00:00:00.000Z",
            supports: ["Point-in-time mechanism and reserve facts."],
            availabilityProof: {
              kind: "third-party-snapshot" as const,
              url: `https://archive.example.com/source-${index + 1}`,
              observedAt: "2023-12-01T00:00:00.000Z",
              verifiedBy: ["archive-reviewer"],
            },
            archiveArtifact: ref(`cases/${id}/sources/source.bin`, artifacts),
          },
        ],
      };
    },
  );

  const manifestCases: V9HoldoutCaseManifestEntry[] = archiveCases.map((entry, index) => {
    const pairOrdinal = Math.floor(index / 2);
    return {
      caseId: entry.caseId,
      archetype: ARCHETYPES[pairOrdinal % ARCHETYPES.length],
      clusterId: `cluster-${String(index + 1).padStart(2, "0")}`,
      failurePathFamily: FAILURE_FAMILIES[pairOrdinal % FAILURE_FAMILIES.length],
      evidenceCutoff: entry.evidenceCutoff,
      factDigest: entry.compiledFactArtifact.sha256,
      sourceDigest: computeV9HoldoutCaseSourceDigest(entry.sources),
      factReviewerIds: ["fact-reviewer-a", "fact-reviewer-b"],
    };
  });

  const archiveManifest: V9HoldoutSourceArchiveManifest = {
    schemaVersion: 1,
    holdoutId: "holdout-1",
    createdAt: "2025-12-20T00:00:00.000Z",
    createdBy: "archive-owner",
    split: {
      selectedAt: "2025-12-01T00:00:00.000Z",
      selectedBy: "selection-owner",
      calibrationCaseIds: ["calibration-01"],
      holdoutCaseIds: manifestCases.map((entry) => entry.caseId),
      v8OutputAccessAtSelection: "withheld",
      v9OutputAccessAtSelection: "withheld",
      preregistrationArtifact,
    },
    productionCompilation: {
      entrypoint: "worker/src/lib/safety-score-v9-fact-set.ts#compileSafetyScoreV9FactSetFromFixedInput",
      factSetDigest: digest("fact-set"),
      evaluationBuildDigest: digest("evaluation-build"),
      compilerFactSchemaDigest: digest("compiler-schema"),
      producerCapabilityDigest: digest("producer-capability"),
      auditStatus: "passed",
      auditedBy: ["fact-auditor"],
    },
    cases: archiveCases,
  };

  const payload: V9ReleaseCandidateSealPayload = {
    schemaVersion: 1,
    releaseCandidateId: "v9-rc-1",
    methodologyRoundId: "round-1",
    holdoutId: archiveManifest.holdoutId,
    lifecycle: "sealed-candidate",
    sealedAt: "2026-01-01T00:00:00.000Z",
    sealedBy: "release-owner",
    outcomeAccess: "withheld",
    digests: {
      factSetDigest: archiveManifest.productionCompilation.factSetDigest,
      sourceArchiveDigest: computeV9HoldoutSourceArchiveDigest(archiveManifest),
      policySemanticDigest: digest("policy"),
      evaluationBuildDigest: archiveManifest.productionCompilation.evaluationBuildDigest,
      holdoutManifestDigest: digest("holdout-manifest"),
      preregistrationDigest: preregistrationArtifact.sha256,
      outcomeCommitmentDigest: digest("outcome-commitment"),
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
      outcomeReviewerIds: ["safety-reviewer-a", "safety-reviewer-b"],
      unsealAuthorityIds: ["unseal-authority"],
    },
    cases: manifestCases,
    matchedPairs: Array.from({ length: 8 }, (_, index) => {
      const left = manifestCases[index * 2]!;
      const right = manifestCases[index * 2 + 1]!;
      return {
        pairId: `pair-${String(index + 1).padStart(2, "0")}`,
        caseIds: [left.caseId, right.caseId],
        archetype: left.archetype,
        failurePathFamily: left.failurePathFamily,
      };
    }),
  };
  const seal = createV9ReleaseCandidateSeal(payload);
  const reviewCaseIds = manifestCases.map((entry) => entry.caseId);
  const blindReviewManifest: V9HoldoutBlindReviewManifest = {
    schemaVersion: 1,
    holdoutId: seal.holdoutId,
    createdAt: "2025-12-31T00:00:00.000Z",
    reviewers: ["safety-reviewer-a", "safety-reviewer-b"],
    reviews: [
      {
        reviewId: "review-a",
        reviewerId: "safety-reviewer-a",
        mode: "semantic-grade",
        caseIds: reviewCaseIds,
        reviewedAt: "2025-12-29T00:00:00.000Z",
        v8OutputAccess: "withheld",
        v9OutputAccess: "withheld",
        independenceAttestation: "I reviewed the frozen cases without access to either scoring output.",
        judgmentArtifact: ref("reviews/reviewer-a.json", artifacts),
      },
      {
        reviewId: "review-b",
        reviewerId: "safety-reviewer-b",
        mode: "pairwise-order",
        caseIds: reviewCaseIds,
        reviewedAt: "2025-12-30T00:00:00.000Z",
        v8OutputAccess: "withheld",
        v9OutputAccess: "withheld",
        independenceAttestation: "I reviewed the frozen cases without access to either scoring output.",
        judgmentArtifact: ref("reviews/reviewer-b.json", artifacts),
      },
    ],
    disagreementCaseIds: [],
    adjudications: [],
  };

  const inspectArtifact = (absolutePath: string): ArtifactInspection => {
    const sha256 = artifacts.get(absolutePath) ?? null;
    return { exists: sha256 !== null, sha256, error: sha256 === null ? "not found" : null };
  };
  return { archiveManifest, blindReviewManifest, inspectArtifact, seal };
}

describe("Safety Score V9 Gate 3 holdout preparation status", () => {
  it("fails closed on the real retrospective corpus without substituting protocol tests for evidence", () => {
    const report = buildV9HoldoutStatus({
      generatedAt: "2026-07-23T12:00:00.000Z",
      historicalCorpus: historicalFixtures,
    });

    expect(report).toMatchObject({
      decision: "blocked",
      releaseClaim: "not-a-gate-3-pass",
      suppliedArtifacts: {
        seal: "not-supplied",
        sourceArchiveManifest: "not-supplied",
        blindReviewManifest: "not-supplied",
      },
      legacyCorpus: {
        fixtureCount: 26,
        adverseCount: 12,
        resilientCount: 14,
        sourceCount: 26,
        captureStatuses: { unarchived: 26 },
        blindingModes: { "retrospective-unverified": 26 },
        outcomeAccess: { "not-attested": 26 },
        sameFactAndOutcomeReviewerCount: 26,
        chronologyStatus: "passed",
        immutableSourceStatus: "blocked",
        independentBlindingStatus: "blocked",
        admissibleAsReleaseHoldout: false,
      },
      protocolImplementation: {
        syntheticExerciseAdmissibleAsReleaseEvidence: false,
        preparationAddsTwoReviewerFloor: true,
      },
    });
    expect(report.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "release-candidate-seal",
        "source-archive-manifest",
        "blind-review-manifest",
      ]),
    );
    expect(renderV9HoldoutStatusMarkdown(report)).toContain("Decision: **blocked**");
  });

  it("can verify a fully content-bound preparation package without claiming a holdout result", () => {
    const prepared = preparedPackage();
    const report = buildV9HoldoutStatus({
      generatedAt: "2026-01-01T01:00:00.000Z",
      historicalCorpus: historicalFixtures,
      seal: prepared.seal,
      sourceArchiveManifest: prepared.archiveManifest,
      sourceArchiveBaseDir: BUNDLE_ROOT,
      blindReviewManifest: prepared.blindReviewManifest,
      blindReviewBaseDir: BUNDLE_ROOT,
      inspectArtifact: prepared.inspectArtifact,
    });

    expect(report.decision).toBe("preparation-ready");
    expect(report.releaseClaim).toBe("not-a-gate-3-pass");
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("blocks a digest mismatch even when the manifest claims a passed audit", () => {
    const prepared = preparedPackage();
    prepared.archiveManifest.cases[0]!.compiledFactArtifact.sha256 = digest("tampered-facts");
    const report = buildV9HoldoutStatus({
      generatedAt: "2026-01-01T01:00:00.000Z",
      seal: prepared.seal,
      sourceArchiveManifest: prepared.archiveManifest,
      sourceArchiveBaseDir: BUNDLE_ROOT,
      blindReviewManifest: prepared.blindReviewManifest,
      blindReviewBaseDir: BUNDLE_ROOT,
      inspectArtifact: prepared.inspectArtifact,
    });

    expect(report.decision).toBe("blocked");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "case-fact-and-source-bindings", status: "failed" }),
    );
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "archive-file-integrity", status: "failed" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "source-archive-digest", status: "failed" }));
  });

  it("writes a blocked JSON packet through the CLI", () => {
    const writes = new Map<string, string>();
    const report = runV9HoldoutStatusCli(
      [
        "--generated-at",
        "2026-07-23T12:00:00.000Z",
        "--output",
        "status.json",
        "--format",
        "json",
      ],
      {
        readJson(path) {
          if (path === "shared/data/safety-score-v9/historical-fixtures-v1.json") return historicalFixtures;
          throw new Error(`unexpected path ${path}`);
        },
        inspectArtifact() {
          return { exists: false, sha256: null, error: "not used" };
        },
        writeText(path, contents) {
          writes.set(path, contents);
        },
        stdout: { write: () => true },
      },
    );

    expect(report?.decision).toBe("blocked");
    expect(JSON.parse(writes.get("status.json")!)).toMatchObject({
      purpose: "gate-3-preparation-status-not-holdout-result",
      decision: "blocked",
    });
  });
});
