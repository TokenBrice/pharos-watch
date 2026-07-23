import { describe, expect, it } from "vitest";
import {
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
  V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
} from "../../../shared/lib/safety-score-v9/operational-gate";
import { stableJsonStringifyV1 } from "../../../shared/lib/stable-json";
import { SafetyScoreV9ShadowDailySchema, type SafetyScoreV9ShadowDaily } from "../../src/lib/safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_ARCHIVED_REPLAY_EVIDENCE_SCHEMA_VERSION,
  evaluateSafetyScoreV9ShadowGate,
  parseSafetyScoreV9ShadowSummaryExport,
  runSafetyScoreV9ShadowGateCli,
  type SafetyScoreV9ArchivedReplayEvidence,
} from "../check-safety-score-v9-shadow-gate";

const digest = (character: string) => character.repeat(64);
const POLICY_DIGEST = digest("a");
const EVALUATION_BUILD_DIGEST = digest("b");
const COMPILER_FACT_SCHEMA_DIGEST = digest("9");
const PRODUCER_CAPABILITY_DIGEST = digest("c");
const ACTIVE_IDS_DIGEST = digest("d");
const ARTIFACT_KEYS = [
  `base-input:${digest("1")}`,
  `evaluation-build:${digest("2")}`,
  `fact-set:${digest("3")}`,
  `policy:${digest("4")}`,
  `result:${digest("5")}`,
];

function utcDay(index: number): string {
  return `2026-06-${String(index + 1).padStart(2, "0")}`;
}

function dailySummary(
  index: number,
  selectionReasons: Array<"anomaly" | "final" | "first"> = [],
): SafetyScoreV9ShadowDaily {
  const day = utcDay(index);
  const timestamp = Date.parse(`${day}T12:00:00.000Z`) / 1_000;
  return SafetyScoreV9ShadowDailySchema.parse({
    schemaVersion: 1,
    utcDay: day,
    updatedAtSec: timestamp,
    attemptCounts: { successful: 1, failed: 0 },
    selectedRun: {
      selectedAtSec: timestamp,
      identity: {
        candidateId: "v9-release-candidate",
        policyVersion: "v9.0",
        publicationGenerationId: `v9-shadow:${day}`,
        baseInputGenerationId: `report-cards-input:v1:${digest("6")}`,
        factSetDigest: digest("7"),
        policyId: "safety-score-v9",
        policyDigest: POLICY_DIGEST,
        evaluationBuildDigest: EVALUATION_BUILD_DIGEST,
        resultDigest: digest("8"),
        compilerFactSchemaDigest: COMPILER_FACT_SCHEMA_DIGEST,
        producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
        releaseCoveragePolicyDigest: V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
        consumerThresholdRegistryDigest: V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
        envelopeDigest: digest("0"),
        sourceGenerations: {
          registry: `registry:${day}`,
          liveReserves: `live-reserves:cycle-${Math.floor(index / 2)}`,
          redemption: `redemption:cycle-${Math.floor(index / 2)}`,
        },
      },
      coverage: {
        expectedActiveCount: 2,
        observedResultCount: 2,
        presentExpectedCount: 2,
        ratedResultCount: 2,
        notRatedResultCount: 0,
        expectedActiveIdsDigest: ACTIVE_IDS_DIGEST,
        presentExpectedIdsDigest: ACTIVE_IDS_DIGEST,
        missingIds: [],
        unexpectedIds: [],
        duplicateIds: [],
        compilerExceptions: [],
        futureDatedEvidenceIds: [],
        coverageFloors: [
          {
            id: "active-result-count",
            status: "pass",
            observed: 2,
            required: "= 2",
            detail: "Every active asset is present",
          },
          {
            id: "minimum-rateable-assets",
            status: "pass",
            observed: 305,
            required: ">= 305",
            detail: "The rateability floor passes",
          },
          {
            id: "ratified-release-coverage",
            status: "pass",
            observed: 1,
            required: "gate passed",
            detail: "The ratified release coverage report passes",
          },
          {
            id: "scheduled-start-latency",
            status: "pass",
            observed: 0,
            required: "<= 3600 seconds",
            detail: "The candidate started on schedule",
          },
        ],
        publicationRegression: false,
        unresolvedReleaseBlockers: [],
        unresolvedCriticalMovementIds: [],
      },
      movement: {
        expectedCount: 2,
        comparedCount: 2,
        missingInputCount: 0,
        gradeOrNrTransitionCount: 0,
        bindingCapChangeCount: 0,
        largeScoreMovementCount: 0,
        topCutoffMovementCount: 0,
        downstreamCrossingCount: 0,
        requiresReviewCount: 0,
        pendingReviewCount: 0,
        comparableSupplyUsd: 1_000_000,
        supplyWeightedMeanAbsoluteDelta: 0,
      },
      qualification: { qualifies: true, blockers: [] },
      diffReportDigest: digest("e"),
      archiveSelectionReasons: selectionReasons,
      artifactKeys: selectionReasons.length > 0 ? ARTIFACT_KEYS : [],
    },
    latestError: null,
  });
}

function passingSummaries(): SafetyScoreV9ShadowDaily[] {
  return Array.from({ length: 14 }, (_, index) =>
    dailySummary(index, index === 0 ? ["first"] : index === 5 ? ["anomaly"] : index === 13 ? ["final"] : []),
  );
}

function replayEvidence(summaries: readonly SafetyScoreV9ShadowDaily[]): SafetyScoreV9ArchivedReplayEvidence {
  return {
    schemaVersion: SAFETY_SCORE_V9_ARCHIVED_REPLAY_EVIDENCE_SCHEMA_VERSION,
    replays: summaries.flatMap((summary) => {
      const run = summary.selectedRun;
      if (!run || run.archiveSelectionReasons.length === 0) return [];
      return [
        {
          utcDay: summary.utcDay,
          selectionReasons: [...run.archiveSelectionReasons],
          artifactKeys: [...run.artifactKeys],
          expectedResultDigest: run.identity.resultDigest,
          status: "passed" as const,
          replayedResultDigest: run.identity.resultDigest,
        },
      ];
    }),
  };
}

function blockerCodes(report: ReturnType<typeof evaluateSafetyScoreV9ShadowGate>): string[] {
  return report.blockers.map((blocker) => blocker.code);
}

describe("Safety Score v9 offline shadow gate", () => {
  it("passes a qualifying window above the 8-day minimum with frozen identities and verified selected replays", () => {
    const summaries = passingSummaries();
    const report = evaluateSafetyScoreV9ShadowGate({
      summaries: [...summaries].reverse(),
      replayEvidence: replayEvidence(summaries),
    });

    expect(report).toMatchObject({
      decision: "gate-passed",
      observedDayCount: 14,
      windowStartUtcDay: "2026-06-01",
      windowEndUtcDay: "2026-06-14",
      frozenIdentity: {
        candidateId: "v9-release-candidate",
        policyDigest: POLICY_DIGEST,
        evaluationBuildDigest: EVALUATION_BUILD_DIGEST,
        compilerFactSchemaDigest: COMPILER_FACT_SCHEMA_DIGEST,
        producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
        releaseCoveragePolicyDigest: V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
        consumerThresholdRegistryDigest: V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
      },
      minimumProducerCycleCount: 2,
      slowestScoreBearingProducerIntervalSec: 4 * 60 * 60,
      observedProducerCycleCount: 78,
      observedWindowSec: 13 * 24 * 60 * 60,
      producerGenerationEvidence: [
        { sourceKey: "liveReserves", observedGenerationCount: 7, archivedGenerationCount: 3 },
        { sourceKey: "redemption", observedGenerationCount: 7, archivedGenerationCount: 3 },
      ],
      blockers: [],
    });
    expect(report.requiredReplayDays.map((entry) => entry.utcDay)).toEqual(["2026-06-01", "2026-06-06", "2026-06-14"]);
    expect(report.verifiedReplayDays).toEqual(["2026-06-01", "2026-06-06", "2026-06-14"]);
  });

  it("rejects short or non-consecutive windows and days without a successful selection", () => {
    const summaries = passingSummaries().slice(7);
    summaries.splice(3, 1);
    const noSuccess = summaries[5]!;
    summaries[5] = SafetyScoreV9ShadowDailySchema.parse({
      ...noSuccess,
      attemptCounts: { successful: 0, failed: 1 },
      selectedRun: null,
      latestError: {
        atSec: noSuccess.updatedAtSec,
        stage: "score",
        code: "fixture-failure",
        message: "Fixture shadow scoring failed",
      },
    });

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(report.decision).toBe("no-go");
    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining([
        "insufficient-day-count",
        "calendar-gap",
        "no-successful-attempt",
        "selected-run-missing",
      ]),
    );
  });

  it("rejects frozen identity drift", () => {
    const summaries = passingSummaries();
    const drifted = summaries[7]!.selectedRun!;
    summaries[7] = SafetyScoreV9ShadowDailySchema.parse({
      ...summaries[7],
      selectedRun: {
        ...drifted,
        identity: {
          ...drifted.identity,
          candidateId: "v9-release-candidate-2",
          policyDigest: digest("f"),
          evaluationBuildDigest: digest("1"),
          compilerFactSchemaDigest: digest("3"),
          producerCapabilityDigest: digest("2"),
          releaseCoveragePolicyDigest: digest("4"),
          consumerThresholdRegistryDigest: digest("5"),
        },
      },
    });

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining([
        "candidate-id-drift",
        "policy-drift",
        "evaluation-build-drift",
        "compiler-fact-schema-drift",
        "producer-capability-drift",
        "release-coverage-policy-drift",
        "consumer-threshold-registry-drift",
      ]),
    );
  });

  it("rejects a consistently stale operational registry across the full window", () => {
    const summaries = passingSummaries().map((summary) =>
      SafetyScoreV9ShadowDailySchema.parse({
        ...summary,
        selectedRun: {
          ...summary.selectedRun!,
          identity: {
            ...summary.selectedRun!.identity,
            releaseCoveragePolicyDigest: digest("4"),
            consumerThresholdRegistryDigest: digest("5"),
          },
        },
      }),
    );

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining(["release-coverage-policy-drift", "consumer-threshold-registry-drift"]),
    );
  });

  it("rejects a selected run timestamp outside its claimed UTC day", () => {
    const summaries = passingSummaries();
    const selectedRun = summaries[4]!.selectedRun!;
    summaries[4] = SafetyScoreV9ShadowDailySchema.parse({
      ...summaries[4],
      updatedAtSec: selectedRun.selectedAtSec + 24 * 60 * 60,
      selectedRun: { ...selectedRun, selectedAtSec: selectedRun.selectedAtSec + 24 * 60 * 60 },
    });

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(blockerCodes(report)).toContain("selected-run-day-mismatch");
  });

  it("rejects mid-window coverage, compiler, future-evidence, and release blockers", () => {
    const summaries = passingSummaries();
    const selectedRun = summaries[4]!.selectedRun!;
    summaries[4] = SafetyScoreV9ShadowDailySchema.parse({
      ...summaries[4],
      selectedRun: {
        ...selectedRun,
        coverage: {
          ...selectedRun.coverage,
          presentExpectedCount: 1,
          expectedActiveIdsDigest: digest("3"),
          presentExpectedIdsDigest: digest("4"),
          missingIds: ["missing-asset"],
          compilerExceptions: ["asset:compile"],
          futureDatedEvidenceIds: ["asset:future"],
          coverageFloors: [
            {
              id: "active-asset-coverage",
              status: "fail",
              observed: 0.5,
              required: "100%",
              detail: "One active asset is absent",
            },
          ],
          publicationRegression: true,
          unresolvedReleaseBlockers: ["candidate-defect"],
          unresolvedCriticalMovementIds: ["asset:movement"],
        },
        movement: { ...selectedRun.movement, pendingReviewCount: 1 },
        qualification: {
          qualifies: false,
          blockers: [
            "active-id-bijection-failed",
            "compiler-exception",
            "coverage-floor-failed",
            "future-dated-evidence",
            "publication-regression",
            "unresolved-critical-movement",
            "unresolved-release-blocker",
          ],
        },
      },
    });

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining([
        "active-id-bijection-failed",
        "coverage-floor-set-mismatch",
        "coverage-floor-failed",
        "compiler-exception",
        "future-dated-evidence",
        "publication-regression",
        "unresolved-release-blocker",
        "qualification-failed",
      ]),
    );
    // Adjudication is a window-end question, so an unresolved movement on a mid-window day is
    // recorded but does not block. Every pipeline-stability blocker above still fires per-day.
    expect(blockerCodes(report)).not.toContain("unresolved-critical-movement");
    expect(blockerCodes(report)).not.toContain("unresolved-review");
  });

  it("rejects unresolved movement adjudication at window end", () => {
    const summaries = passingSummaries();
    const finalIndex = summaries.length - 1;
    const selectedRun = summaries[finalIndex]!.selectedRun!;
    summaries[finalIndex] = SafetyScoreV9ShadowDailySchema.parse({
      ...summaries[finalIndex],
      selectedRun: {
        ...selectedRun,
        coverage: { ...selectedRun.coverage, unresolvedCriticalMovementIds: ["asset:movement"] },
        movement: { ...selectedRun.movement, pendingReviewCount: 1 },
      },
    });

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: replayEvidence(summaries) });

    expect(blockerCodes(report)).toContain("unresolved-critical-movement");
    expect(blockerCodes(report)).toContain("unresolved-review");
    expect(report.decision).toBe("no-go");
  });

  it("requires replay evidence bound to every first, final, and anomaly artifact set", () => {
    const summaries = passingSummaries();
    const evidence = replayEvidence(summaries);
    evidence.replays = evidence.replays.filter((entry) => entry.utcDay !== "2026-06-06");
    evidence.replays.find((entry) => entry.utcDay === "2026-06-14")!.replayedResultDigest = digest("f");

    const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence: evidence });

    expect(blockerCodes(report)).toEqual(expect.arrayContaining(["replay-evidence-missing", "replay-result-mismatch"]));
    expect(report.verifiedReplayDays).toEqual(["2026-06-01"]);
  });

  it("exposes a strict read-only CLI that prints the deterministic report", async () => {
    const summaries = passingSummaries();
    const evidence = replayEvidence(summaries);
    const artifactRow = {
      artifact_key: `base-input:${digest("1")}`,
      artifact_kind: "base-input",
      identity: "fixture-base-input",
      content_sha256: digest("1"),
      encoding: "gzip-base64",
      uncompressed_bytes: 1,
      stored_bytes: 1,
      payload: "x",
      created_at_sec: 1,
      verified_at_sec: 1,
    };
    const inputs: Record<string, unknown> = {
      "summaries.json": [
        {
          results: summaries.map((summary) => ({
            utc_day: summary.utcDay,
            daily_json: stableJsonStringifyV1(summary),
          })),
          success: true,
          meta: {},
        },
      ],
      "artifacts.json": [{ results: [artifactRow], success: true, meta: {} }],
    };
    let stdout = "";
    let verifiedArtifactCount = 0;

    const report = await runSafetyScoreV9ShadowGateCli(
      ["--summaries", "summaries.json", "--artifacts", "artifacts.json"],
      {
        readJson: (path) => inputs[path],
        stdout: { write: (text) => (stdout += text) },
        verifyReplays: async (days, artifacts) => {
          expect(days).toEqual(summaries);
          expect(artifacts).toEqual([
            expect.objectContaining({
              artifactKey: artifactRow.artifact_key,
              kind: artifactRow.artifact_kind,
              contentSha256: artifactRow.content_sha256,
            }),
          ]);
          verifiedArtifactCount = artifacts.length;
          return evidence;
        },
      },
    );

    expect(report?.decision).toBe("gate-passed");
    expect(verifiedArtifactCount).toBe(1);
    expect(JSON.parse(stdout)).toEqual(report);
    await expect(
      runSafetyScoreV9ShadowGateCli(["--summaries", "summaries.json", "--unknown"], {
        readJson: (path) => inputs[path],
        stdout: { write: () => true },
      }),
    ).rejects.toThrow(/Unknown option/);
  });

  it("rejects non-canonical or mismatched D1 daily_json exports", () => {
    const summary = dailySummary(0, ["first"]);
    expect(() =>
      parseSafetyScoreV9ShadowSummaryExport([
        { results: [{ utc_day: "2026-06-02", daily_json: stableJsonStringifyV1(summary) }] },
      ]),
    ).toThrow(/utc_day does not match/);
    expect(() =>
      parseSafetyScoreV9ShadowSummaryExport([{ results: [{ utc_day: summary.utcDay, daily_json: "{}" }] }]),
    ).toThrow();
  });
});
