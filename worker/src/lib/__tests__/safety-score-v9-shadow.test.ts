import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ReplayArtifactSchema,
  SafetyScoreV9ShadowDailySchema,
  SafetyScoreV9ShadowEnvelopeSchema,
  assessSafetyScoreV9ShadowQualification,
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailyFailure,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  safetyScoreV9ShadowLastSuccessfulAttemptAtSec,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9CoverageFloor,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowEnvelope,
} from "../safety-score-v9-shadow";
import { scoreToGrade } from "@shared/lib/report-cards";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9Response,
} from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);
const BASE_GENERATION = `report-cards-input:v1:${digest("a")}`;
const POLICY_DIGEST = digest("b");
const FACT_DIGEST = digest("c");
const BUILD_DIGEST = digest("d");
const RESULT_DIGEST = digest("e");
const COMPILER_SCHEMA_DIGEST = digest("f");
const PRODUCER_CAPABILITY_DIGEST = digest("1");

function v9Card(
  id: string,
  score: number | null,
  options: {
    bindingCap?: { kind: string; limit: number; source: "structural" } | null;
    reasonCodes?: SafetyScoreV9Response["cards"][number]["reasonCodes"];
  } = {},
): SafetyScoreV9Response["cards"][number] {
  const pillar = (pillarScore: number | null) => ({
    score: pillarScore,
    evidenceLevel: pillarScore === null ? ("insufficient" as const) : ("adequate" as const),
    freshness: "current" as const,
    components: [],
    reasons: [],
  });
  const bindingCap = options.bindingCap
    ? { ...options.bindingCap, reason: "Candidate structural ceiling", binding: true }
    : null;
  const reasonCodes = options.reasonCodes ?? (score === null ? ["insufficient-evidence"] : []);
  const backingScore = score === null ? null : score + 1 > 100 ? 100 : score + 1;
  const exitScore = score;
  const controlScore = score === null ? null : score + 0.5;
  const trace = {
    schemaVersion: 3 as const,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean" as const,
      pegAdjustedScore: "post-deployment-pre-cap-score" as const,
      score: "post-cap-public-score" as const,
    },
    aggregation: score === null
      ? null
      : {
          method: "smooth-bounded-headroom" as const,
          score,
          weightedPillarMean: score,
          weakestPillar: "exit" as const,
          weakestScore: score,
          headroom: 45,
        },
    stages: {
      weightedPillarMean: score,
      aggregatedQualityScore: score,
      pegMultiplier: score === null ? null : 1,
      baseAssetScore: score,
      deploymentAdjustedScore: score,
      deploymentAdjustmentPoints: score === null ? null : 0,
      preCapScore: score,
      publishedScore: score,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2" as const,
      totalAdjustmentPoints: score === null ? null : 0,
      adjustments: [],
      unresolvedExposures: [],
    },
    adverseAttribution: {
      semantics: "causal-measured-adverse-v1" as const,
      items: [],
    },
    boundedUncertaintyAttribution: {
      semantics: "causal-bounded-uncertainty-v1" as const,
      items: [],
    },
    evidenceResponsibility: {
      semantics: "limiting-fact-owner-v1" as const,
      totalFactCount: 0,
      summaries: [
        { responsibility: "integration-missing" as const, factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "issuer-undisclosed" as const, factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "measured-adverse" as const, factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "method-unsupported" as const, factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "producer-failed" as const, factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      ],
    },
    scoreAdjustments: [],
    wrapperParentLimit: null,
  };
  const breakdowns: SafetyScoreV9CurrentCard["breakdowns"] = score === null
    ? null
    : {
        backing: {
          evaluatedScore: backingScore!,
          publishedScore: backingScore!,
          aggregationWeight: 0.4,
          groups: [{ key: "reserves" as const, label: "Reserves", score: backingScore!, effectiveWeight: 1 }],
          components: [{
            key: "reserve:fixture",
            label: "Fixture reserves",
            source: "reserve-exposure" as const,
            score: backingScore!,
            effectiveWeight: 1,
            weightedContribution: backingScore!,
            observationState: "known" as const,
          }],
          adjustments: [],
        },
        exit: {
          evaluatedScore: exitScore!,
          publishedScore: exitScore!,
          aggregationWeight: 0.35,
          stressRequest: null,
          primaryRoute: {
            key: "redemption:fixture",
            label: "Fixture redemption",
            routeFamily: "protocol-redemption" as const,
            score: exitScore!,
            components: ([
              ["access", "Access", 0.2],
              ["settlement", "Settlement", 0.15],
              ["executionCertainty", "Execution certainty", 0.15],
              ["capacity", "Capacity", 0.25],
              ["outputAssetQuality", "Output asset quality", 0.15],
              ["cost", "Cost", 0.1],
            ] as const).map(([key, label, weight]) => ({
              key,
              label,
              score: exitScore!,
              weight,
              weightedContribution: exitScore! * weight,
            })),
            confidenceFactor: 1,
            eligibilityMultiplier: 1,
            capsApplied: [],
          },
          diversification: null,
          alternatives: [],
          adjustments: [],
        },
        control: {
          evaluatedScore: controlScore!,
          publishedScore: controlScore!,
          aggregationWeight: 0.25,
          method: "minimum-binding-component" as const,
          components: [{
            key: "control:fixture",
            label: "Fixture control",
            kind: "mint" as const,
            score: controlScore!,
            binding: true,
            posture: "distributed",
          }],
          adjustments: [],
        },
      };
  return {
    id,
    score,
    grade: scoreToGrade(score),
    qualityScore: score,
    pegMultiplier: score === null ? null : 1,
    pegAdjustedScore: score,
    pillars:
      score === null
        ? { backing: pillar(null), exit: pillar(null), control: pillar(null) }
        : {
            backing: pillar(backingScore),
            exit: pillar(exitScore),
            control: pillar(controlScore),
          },
    weakestPillar: score === null ? null : { pillar: "exit", score },
    caps: bindingCap ? [bindingCap] : [],
    bindingCap,
    nrReasons:
      score === null
        ? [{ code: "insufficient-evidence", message: "Critical evidence is unavailable", field: null, origin: "asset" }]
        : [],
    reasonCodes,
    evidence: { level: score === null ? "insufficient" : "adequate", freshness: "current", reasons: [] },
    accessPosture: {
      transfer: "permissionless",
      freezeExposure: "none-known",
      primaryExit: "permissionless",
      governance: "distributed",
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: digest("7"),
    scoreTrace: trace,
    breakdowns,
  };
}

function candidate(
  cards: SafetyScoreV9Response["cards"],
  overrides: Partial<SafetyScoreV9Response> = {},
): SafetyScoreV9Response {
  const notRatedIds = cards
    .filter((card) => card.grade === "NR")
    .map((card) => card.id)
    .sort();
  return {
    model: "v9-critical-path",
    schemaVersion: 5,
    lifecycle: "active",
    candidateId: "safety-score-v9:v1:shadow-test",
    policyVersion: "9.0",
    publicationGenerationId: "report-cards:v9:v1:shadow-test",
    baseInputGenerationId: BASE_GENERATION,
    factSetDigest: FACT_DIGEST,
    resultDigest: RESULT_DIGEST,
    policy: { id: "safety-score-v9", semanticDigest: POLICY_DIGEST },
    evaluationBuildDigest: BUILD_DIGEST,
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
    asOfSec: 1_700_000_000,
    publishedAtSec: 1_700_000_060,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    cards,
    ...overrides,
  };
}

function replayArtifact(
  kind: SafetyScoreV9ReplayArtifactKind,
  candidateInput: SafetyScoreV9Response,
  status: "pending" | "verified" | "checksum-mismatch" | "unreadable" = "verified",
): SafetyScoreV9ReplayArtifact {
  const identityByKind: Record<SafetyScoreV9ReplayArtifactKind, string> = {
    "base-input": candidateInput.baseInputGenerationId,
    "fact-set": candidateInput.factSetDigest,
    policy: candidateInput.policy.semanticDigest,
    "evaluation-build": candidateInput.evaluationBuildDigest,
    result: candidateInput.resultDigest,
  };
  const contentSha256 = digest(
    kind === "base-input"
      ? "2"
      : kind === "fact-set"
        ? "3"
        : kind === "policy"
          ? "4"
          : kind === "evaluation-build"
            ? "5"
            : "6",
  );
  return SafetyScoreV9ReplayArtifactSchema.parse({
    kind,
    identity: identityByKind[kind],
    artifactRef: `content://${kind}/${contentSha256}`,
    contentSha256,
    byteLength: 1_024,
    compression: "gzip",
    verification: {
      status,
      observedContentSha256:
        status === "verified" ? contentSha256 : status === "checksum-mismatch" ? digest("7") : null,
      verifiedAtSec: status === "verified" || status === "checksum-mismatch" ? 1_700_000_120 : null,
    },
  });
}

function replayArtifacts(candidateInput: SafetyScoreV9Response) {
  return (["base-input", "fact-set", "policy", "evaluation-build", "result"] as const).map((kind) =>
    replayArtifact(kind, candidateInput),
  );
}

const PASSING_FLOOR: SafetyScoreV9CoverageFloor = {
  id: "active-asset-coverage",
  status: "pass",
  observed: 1,
  required: ">= 0.95",
  detail: "Observed active-asset coverage meets the candidate floor",
};

function envelope(
  cards: SafetyScoreV9Response["cards"] = [v9Card("alpha", 90)],
  options: {
    expectedActiveIds?: string[];
    replayArtifacts?: SafetyScoreV9ReplayArtifact[];
    coverageFloors?: SafetyScoreV9CoverageFloor[];
    duplicateIds?: string[];
    compilerExceptions?: string[];
    futureDatedEvidenceIds?: string[];
    publicationRegression?: boolean;
    historicalUnresolvedReleaseBlockers?: string[];
    unresolvedCriticalMovementIds?: string[];
    candidateOverrides?: Partial<SafetyScoreV9Response>;
  } = {},
): SafetyScoreV9ShadowEnvelope {
  const candidateInput = candidate(cards, options.candidateOverrides);
  const current = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidateInput,
    expectedActiveIds: options.expectedActiveIds ?? cards.map((card) => card.id),
    compilerFactSchemaDigest: COMPILER_SCHEMA_DIGEST,
    producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    duplicateIds: options.duplicateIds,
    compilerExceptions: options.compilerExceptions,
    futureDatedEvidenceIds: options.futureDatedEvidenceIds,
    coverageFloors: options.coverageFloors ?? [PASSING_FLOOR],
    publicationRegression: options.publicationRegression,
    unresolvedCriticalMovementIds: options.unresolvedCriticalMovementIds,
  });
  if (options.replayArtifacts === undefined && options.historicalUnresolvedReleaseBlockers === undefined) return current;
  return SafetyScoreV9ShadowEnvelopeSchema.parse({
    ...current,
    coverage: {
      ...current.coverage,
      unresolvedReleaseBlockers: [...(options.historicalUnresolvedReleaseBlockers ?? [])].sort(),
    },
    replayArtifacts: [...(options.replayArtifacts ?? [])].sort((left, right) =>
      left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
    ),
  });
}

describe("Safety Score V9 shadow envelope", () => {
  it("binds exact V9 identities and compact current observations", () => {
    const result = envelope([
      v9Card("zeta", null, { reasonCodes: ["insufficient-evidence"] }),
      v9Card("alpha", 90),
    ]);

    expect(result.candidate.cards.map((card) => card.id)).toEqual(["alpha", "zeta"]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      candidate: {
        lifecycle: "active",
        baseInputGenerationId: BASE_GENERATION,
        factSetDigest: FACT_DIGEST,
        resultDigest: RESULT_DIGEST,
        policy: { semanticDigest: POLICY_DIGEST },
        evaluationBuildDigest: BUILD_DIGEST,
      },
      compilerFactSchemaDigest: COMPILER_SCHEMA_DIGEST,
      producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
      coverage: {
        expectedActiveCount: 2,
        observedResultCount: 2,
        ratedResultCount: 1,
        notRatedResultCount: 1,
      },
    });
    expect(result.replayArtifacts).toEqual([]);
  });

  it("refuses legacy candidate lifecycle and replay artifacts bound to another identity", () => {
    expect(() =>
      envelope(undefined, {
        candidateOverrides: { lifecycle: "candidate" as never },
      }),
    ).toThrow(/expected.*active/);

    const candidateInput = candidate([v9Card("alpha", 90)]);
    const artifacts = replayArtifacts(candidateInput);
    artifacts[0] = { ...artifacts[0]!, identity: `report-cards-input:v1:${digest("9")}` };
    expect(() => envelope(undefined, { replayArtifacts: artifacts })).toThrow("Replay artifact identity");
  });

  it("qualifies an exact covered generation without retained artifacts", () => {
    expect(assessSafetyScoreV9ShadowQualification(envelope())).toEqual({
      qualifies: true,
      blockers: [],
    });
  });

  it("reports every machine qualification blocker without inventing a pass", () => {
    const candidateInput = candidate([v9Card("alpha", 90)]);
    const result = envelope(candidateInput.cards, {
      expectedActiveIds: ["alpha", "missing"],
      coverageFloors: [{ ...PASSING_FLOOR, status: "fail", detail: "Coverage is below the floor" }],
      duplicateIds: ["alpha"],
      compilerExceptions: ["compiler-exception:alpha"],
      futureDatedEvidenceIds: ["alpha"],
      publicationRegression: true,
      historicalUnresolvedReleaseBlockers: ["release-owner-review"],
      unresolvedCriticalMovementIds: ["alpha"],
    });

    expect(assessSafetyScoreV9ShadowQualification(result)).toEqual({
      qualifies: false,
      blockers: [
        "active-id-bijection-failed",
        "compiler-exception",
        "coverage-floor-failed",
        "future-dated-evidence",
        "publication-regression",
        "unresolved-release-blocker",
      ],
    });
  });

  it("keeps replay verification separate from runtime qualification", () => {
    const candidateInput = candidate([v9Card("alpha", 90)]);
    const artifacts = replayArtifacts(candidateInput);
    artifacts[2] = replayArtifact("policy", candidateInput, "checksum-mismatch");
    const result = envelope(candidateInput.cards, { replayArtifacts: artifacts });

    expect(assessSafetyScoreV9ShadowQualification(result)).toEqual({
      qualifies: true,
      blockers: [],
    });
  });

  it("produces the same envelope digest across input permutations", () => {
    const cards = [v9Card("zeta", 80), v9Card("alpha", 90)];
    const firstCandidate = candidate(cards);
    const first = envelope(cards, {
      expectedActiveIds: ["zeta", "alpha"],
      replayArtifacts: replayArtifacts(firstCandidate).reverse(),
      coverageFloors: [
        PASSING_FLOOR,
        { ...PASSING_FLOOR, id: "route-coverage", detail: "Route coverage passes" },
      ].reverse(),
    });
    const second = envelope([...cards].reverse(), {
      expectedActiveIds: ["alpha", "zeta"],
      replayArtifacts: replayArtifacts(candidate([...cards].reverse())),
      coverageFloors: [PASSING_FLOOR, { ...PASSING_FLOOR, id: "route-coverage", detail: "Route coverage passes" }],
    });

    expect(computeSafetyScoreV9ShadowEnvelopeDigest(first)).toBe(computeSafetyScoreV9ShadowEnvelopeDigest(second));
    expect(computeSafetyScoreV9ShadowEnvelopeDigest(first)).toBe(
      computeSafetyScoreV9ShadowEnvelopeDigest(
        envelope(cards, {
          replayArtifacts: [],
          coverageFloors: [PASSING_FLOOR, { ...PASSING_FLOOR, id: "route-coverage", detail: "Route coverage passes" }],
        }),
      ),
    );
  });

  it("uses canonical UTC day boundaries", () => {
    expect(safetyScoreV9UtcDay(Date.parse("2026-07-13T23:59:59Z") / 1_000)).toBe("2026-07-13");
    expect(safetyScoreV9UtcDay(Date.parse("2026-07-14T00:00:00Z") / 1_000)).toBe("2026-07-14");
    expect(() => safetyScoreV9UtcDay(-1)).toThrow("Invalid Safety Score v9 shadow timestamp");
  });
});

const SCHEDULED_FOR = Date.parse("2026-07-13T04:00:00Z") / 1_000;

function dailyDiff(shadow: SafetyScoreV9ShadowEnvelope) {
  return buildSafetyScoreV9DiffReport({
    generatedAtSec: SCHEDULED_FOR + 15,
    expectedActiveIds: ["alpha"],
    v8: v8Snapshot([{ id: "alpha", score: 90, grade: "A+", bindingCap: null, reasonCodes: [] }]),
    v9: shadow,
    topCutoffIds: new Set(),
    downstreamThresholds: [],
    supplyUsdById: { alpha: 1_000 },
  });
}

function successfulDaily(previous: SafetyScoreV9ShadowDaily | null = null) {
  const shadow = envelope();
  return buildSafetyScoreV9ShadowDailySuccess({
    utcDay: "2026-07-13",
    selectedAtSec: SCHEDULED_FOR + 15,
    updatedAtSec: SCHEDULED_FOR + 20,
    previous,
    envelope: shadow,
    diff: dailyDiff(shadow),
  });
}

describe("Safety Score V9 compact daily history", () => {
  it("records one selected identity and compact qualification summaries", () => {
    const daily = successfulDaily();
    expect(daily).toMatchObject({
      utcDay: "2026-07-13",
      attemptCounts: { successful: 1, failed: 0 },
      selectedRun: {
        identity: {
          publicationGenerationId: "report-cards:v9:v1:shadow-test",
          baseInputGenerationId: BASE_GENERATION,
          factSetDigest: FACT_DIGEST,
          policyDigest: POLICY_DIGEST,
          evaluationBuildDigest: BUILD_DIGEST,
          resultDigest: RESULT_DIGEST,
          compilerFactSchemaDigest: COMPILER_SCHEMA_DIGEST,
          producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
        },
        coverage: { expectedActiveCount: 1, ratedResultCount: 1, notRatedResultCount: 0 },
        movement: { expectedCount: 1, pendingReviewCount: 0 },
        qualification: { qualifies: true, blockers: [] },
        archiveSelectionReasons: [],
        artifactKeys: [],
      },
      latestError: null,
    });
  });

  it("keeps failures retryable and preserves the bounded latest error after success", () => {
    const failed = buildSafetyScoreV9ShadowDailyFailure({
      utcDay: "2026-07-13",
      updatedAtSec: SCHEDULED_FOR + 11,
      failure: {
        atSec: SCHEDULED_FOR + 11,
        stage: "compile",
        code: "compile-failed",
        message: "Fact compilation failed",
      },
    });
    const recovered = successfulDaily(failed);
    expect(recovered.attemptCounts).toEqual({ successful: 1, failed: 1 });
    expect(recovered.selectedRun?.qualification.qualifies).toBe(true);
    expect(recovered.latestError).toMatchObject({ stage: "compile", code: "compile-failed" });
  });

  it("re-selects the same UTC day with a later success and rejects backwards selection", () => {
    const daily = successfulDaily();
    // Intra-day refresh: a later success re-selects the day and increments
    // the successful attempt count; the daily summary stays one row.
    const refreshed = successfulDaily(daily);
    expect(refreshed.attemptCounts.successful).toBe(2);
    expect(refreshed.selectedRun).not.toBeNull();
    expect(SafetyScoreV9ShadowDailySchema.parse(refreshed)).toEqual(refreshed);
    // A re-selection older than the current selected run fails closed.
    const backwards = {
      ...daily,
      selectedRun: { ...daily.selectedRun!, selectedAtSec: daily.selectedRun!.selectedAtSec + 1 },
    };
    expect(() => successfulDaily(SafetyScoreV9ShadowDailySchema.parse(backwards))).toThrow(
      "cannot move the selected run backwards",
    );
  });
});

const RETIRED_START_FLOOR: SafetyScoreV9CoverageFloor = {
  id: "scheduled-start-latency",
  status: "pass",
  observed: 1,
  required: "retired",
  detail: "Retired start-window prerequisite retained only for shadow-history compatibility",
};

const OBSERVATION_DAY = "2026-07-13";
const OBSERVATION_DAY_START_SEC = Date.parse(`${OBSERVATION_DAY}T00:00:00.000Z`) / 1_000;
const FIRST_OBSERVATION_SEC = OBSERVATION_DAY_START_SEC + 1_800 + 120;
const LATER_OBSERVATION_SEC = OBSERVATION_DAY_START_SEC + 4 * 3_600;
const LATEST_OBSERVATION_SEC = OBSERVATION_DAY_START_SEC + 8 * 3_600;

function latencyDaily(
  previous: SafetyScoreV9ShadowDaily | null,
  selectedAtSec: number,
): SafetyScoreV9ShadowDaily {
  const shadow = envelope(undefined, {
    coverageFloors: [RETIRED_START_FLOOR],
  });
  return buildSafetyScoreV9ShadowDailySuccess({
    utcDay: OBSERVATION_DAY,
    selectedAtSec,
    updatedAtSec: selectedAtSec + 5,
    previous: previous ?? undefined,
    envelope: shadow,
    diff: dailyDiff(shadow),
  });
}

describe("Safety Score V9 current daily observation", () => {
  it("replaces an earlier observation on every successful refresh", () => {
    const first = latencyDaily(null, FIRST_OBSERVATION_SEC);
    expect(first.selectedRun?.selectedAtSec).toBe(FIRST_OBSERVATION_SEC);

    const refreshed = latencyDaily(first, LATER_OBSERVATION_SEC);
    expect(refreshed.attemptCounts).toEqual({ successful: 2, failed: 0 });
    expect(refreshed.updatedAtSec).toBe(LATER_OBSERVATION_SEC + 5);
    expect(refreshed.selectedRun?.selectedAtSec).toBe(LATER_OBSERVATION_SEC);
    expect(refreshed.selectedRun?.qualification).toEqual({
      qualifies: true,
      blockers: [],
    });
    expect(SafetyScoreV9ShadowDailySchema.parse(refreshed)).toEqual(refreshed);

    const lateAgain = latencyDaily(refreshed, LATEST_OBSERVATION_SEC);
    expect(lateAgain.selectedRun?.selectedAtSec).toBe(LATEST_OBSERVATION_SEC);
    expect(lateAgain.attemptCounts.successful).toBe(3);
  });

  it("keeps the backwards re-selection guard", () => {
    const first = latencyDaily(null, FIRST_OBSERVATION_SEC);
    const shadow = envelope(undefined, { coverageFloors: [RETIRED_START_FLOOR] });
    expect(() =>
      buildSafetyScoreV9ShadowDailySuccess({
        utcDay: OBSERVATION_DAY,
        selectedAtSec: FIRST_OBSERVATION_SEC - 1,
        updatedAtSec: FIRST_OBSERVATION_SEC + 10,
        previous: first,
        envelope: shadow,
        diff: dailyDiff(shadow),
      }),
    ).toThrow("cannot move the selected run backwards");
  });

  it("derives the latest success time for refresh throttling across failures", () => {
    const first = latencyDaily(null, FIRST_OBSERVATION_SEC);
    expect(safetyScoreV9ShadowLastSuccessfulAttemptAtSec(first)).toBe(FIRST_OBSERVATION_SEC + 5);

    const refreshed = latencyDaily(first, LATER_OBSERVATION_SEC);
    expect(safetyScoreV9ShadowLastSuccessfulAttemptAtSec(refreshed)).toBe(LATER_OBSERVATION_SEC + 5);

    const failed = buildSafetyScoreV9ShadowDailyFailure({
      utcDay: OBSERVATION_DAY,
      updatedAtSec: LATEST_OBSERVATION_SEC,
      previous: refreshed,
      failure: {
        atSec: LATEST_OBSERVATION_SEC,
        stage: "compile",
        code: "compile-failed",
        message: "Fact compilation failed",
      },
    });
    expect(safetyScoreV9ShadowLastSuccessfulAttemptAtSec(failed)).toBe(LATER_OBSERVATION_SEC);

    expect(
      safetyScoreV9ShadowLastSuccessfulAttemptAtSec(
        buildSafetyScoreV9ShadowDailyFailure({
          utcDay: OBSERVATION_DAY,
          updatedAtSec: FIRST_OBSERVATION_SEC,
          failure: { atSec: FIRST_OBSERVATION_SEC, stage: "compile", code: "compile-failed", message: "Compile failed" },
        }),
      ),
    ).toBeNull();
  });
});

function v8Snapshot(cards: SafetyScoreV8ComparableSnapshot["cards"]): SafetyScoreV8ComparableSnapshot {
  return {
    model: "v8",
    publicationGenerationId: "v8-generation-1",
    baseInputGenerationId: BASE_GENERATION,
    methodologyVersion: "8.17",
    evaluationBuildDigest: digest("8"),
    cards,
  };
}

describe("Safety Score V8/V9 shadow diff", () => {
  const v9Cards = [
    v9Card("cap", 80, {
      bindingCap: { kind: "unsafe-backing", limit: 80, source: "structural" },
    }),
    v9Card("large", 84, { reasonCodes: ["partial-reserve-review"] }),
    v9Card("nr", null, { reasonCodes: ["insufficient-evidence"] }),
    v9Card("stable", 89, { reasonCodes: ["partial-reserve-review"] }),
    v9Card("threshold", 69),
    v9Card("top", 87),
  ];
  const expectedIds = ["cap", "large", "missing", "nr", "stable", "threshold", "top"];
  const shadow = envelope(v9Cards, { expectedActiveIds: expectedIds });
  const v8 = v8Snapshot([
    { id: "cap", score: 80, grade: "A-", bindingCap: null, reasonCodes: [] },
    { id: "large", score: 90, grade: "A+", bindingCap: null, reasonCodes: ["legacy-quality"] },
    { id: "missing", score: 75, grade: "B+", bindingCap: null, reasonCodes: [] },
    { id: "nr", score: 80, grade: "A-", bindingCap: null, reasonCodes: [] },
    { id: "stable", score: 90, grade: "A+", bindingCap: null, reasonCodes: ["legacy-quality"] },
    { id: "threshold", score: 71, grade: "B", bindingCap: null, reasonCodes: [] },
    { id: "top", score: 89, grade: "A+", bindingCap: null, reasonCodes: [] },
  ]);

  it("flags every preregistered review threshold and records dispositions", () => {
    const input = {
      generatedAtSec: 1_700_000_180,
      expectedActiveIds: expectedIds,
      v8,
      v9: shadow,
      topCutoffIds: new Set(["top"]),
      downstreamThresholds: [
        { id: "selector-min-70", label: "Selector minimum score", score: 70, comparison: "at-least" },
      ],
      supplyUsdById: {
        cap: 10,
        large: 1_000,
        missing: 500,
        nr: 100,
        stable: 2_000,
        threshold: 200,
        top: 3_000,
      },
    } as const;
    const pendingReport = buildSafetyScoreV9DiffReport(input);
    const reviewKeyById = Object.fromEntries(
      pendingReport.cards.flatMap((card) => (card.review.key === null ? [] : [[card.id, card.review.key] as const])),
    );
    const report = buildSafetyScoreV9DiffReport({
      ...input,
      reviewDispositionsByKey: {
        [reviewKeyById.large!]: "intended-methodology-change",
        [reviewKeyById.missing!]: "producer-data-gap",
      },
    });

    expect(report.v8Identity.baseInputGenerationId).toBe(report.v9Identity.baseInputGenerationId);
    expect(report.cards.find((card) => card.id === "large")).toMatchObject({
      scoreDelta: -6,
      absoluteScoreDelta: 6,
      newReasonCodes: ["partial-reserve-review"],
      removedReasonCodes: ["legacy-quality"],
      flags: {
        gradeOrNrTransition: true,
        absoluteScoreDeltaAtLeast5: true,
        requiresReview: true,
      },
      review: { status: "classified", disposition: "intended-methodology-change" },
    });
    expect(report.cards.find((card) => card.id === "top")?.flags).toMatchObject({
      absoluteScoreDeltaAtLeast5: false,
      topCutoffScoreDeltaAtLeast2: true,
      requiresReview: true,
    });
    expect(report.cards.find((card) => card.id === "nr")).toMatchObject({
      transition: "v8-rated-v9-nr",
      flags: { gradeOrNrTransition: true, requiresReview: true },
    });
    expect(report.cards.find((card) => card.id === "cap")?.flags).toMatchObject({
      bindingCapChanged: true,
      requiresReview: true,
    });
    expect(report.cards.find((card) => card.id === "threshold")?.flags).toMatchObject({
      downstreamThresholdCrossingIds: ["selector-min-70"],
      requiresReview: true,
    });
    expect(report.cards.find((card) => card.id === "missing")).toMatchObject({
      transition: "missing-v9",
      flags: { inputMissing: true, requiresReview: true },
      review: { status: "classified", disposition: "producer-data-gap" },
    });
    expect(report.cards.find((card) => card.id === "stable")).toMatchObject({
      absoluteScoreDelta: 1,
      flags: { requiresReview: false },
      review: { status: "not-required", disposition: null },
    });
    expect(report.summary).toMatchObject({
      expectedCount: 7,
      comparedCount: 6,
      missingInputCount: 1,
      bindingCapChangeCount: 1,
      largeScoreMovementCount: 1,
      topCutoffMovementCount: 1,
      downstreamCrossingCount: 2,
      requiresReviewCount: 6,
      pendingReviewCount: 4,
    });
    expect(report.topSupplyWeightedMovements[0]).toMatchObject({
      id: "large",
      absoluteScoreDelta: 6,
      supplyUsd: 1_000,
      supplyWeightedImpact: 6_000,
    });
    expect(SafetyScoreV9DiffReportSchema.safeParse(report).success).toBe(true);
  });

  it("triggers score review thresholds at their exact inclusive boundaries", () => {
    const boundaryShadow = envelope([v9Card("large-boundary", 75), v9Card("top-boundary", 88)]);
    const report = buildSafetyScoreV9DiffReport({
      generatedAtSec: 1_700_000_180,
      expectedActiveIds: ["large-boundary", "top-boundary"],
      v8: v8Snapshot([
        { id: "large-boundary", score: 80, grade: "A-", bindingCap: null, reasonCodes: [] },
        { id: "top-boundary", score: 90, grade: "A+", bindingCap: null, reasonCodes: [] },
      ]),
      v9: boundaryShadow,
      topCutoffIds: new Set(["top-boundary"]),
      downstreamThresholds: [],
      supplyUsdById: {},
    });
    expect(report.cards.find((card) => card.id === "large-boundary")?.flags.absoluteScoreDeltaAtLeast5).toBe(true);
    expect(report.cards.find((card) => card.id === "top-boundary")?.flags.topCutoffScoreDeltaAtLeast2).toBe(true);
  });

  it("keeps semantic review keys across publications and invalidates them when movement or policy changes", () => {
    const v8Input = v8Snapshot([{ id: "asset", score: 90, grade: "A+", bindingCap: null, reasonCodes: [] }]);
    const build = (
      v9: SafetyScoreV9ShadowEnvelope,
      generatedAtSec: number,
      supplyUsd = 1_000,
      topCutoffIds: ReadonlySet<string> = new Set(),
    ) =>
      buildSafetyScoreV9DiffReport({
        generatedAtSec,
        expectedActiveIds: ["asset"],
        v8: v8Input,
        v9,
        topCutoffIds,
        downstreamThresholds: [],
        supplyUsdById: { asset: supplyUsd },
      }).cards[0]!.review.key;

    const first = envelope([v9Card("asset", 84)]);
    const nextPublication = envelope([v9Card("asset", 84)], {
      candidateOverrides: {
        publicationGenerationId: "report-cards:v9:v1:shadow-test-2",
        factSetDigest: digest("8"),
        resultDigest: digest("9"),
      },
    });
    expect(build(nextPublication, 1_700_000_240)).toBe(build(first, 1_700_000_180));
    expect(build(first, 1_700_000_240, 2_000)).toBe(build(first, 1_700_000_180, 1_000));

    const changedMovement = envelope([v9Card("asset", 83)]);
    expect(build(changedMovement, 1_700_000_300)).not.toBe(build(first, 1_700_000_180));

    expect(build(first, 1_700_000_300, 1_000, new Set(["asset"]))).not.toBe(build(first, 1_700_000_180));

    const changedPolicy = envelope([v9Card("asset", 84)], {
      candidateOverrides: { policy: { id: "safety-score-v9-test", semanticDigest: digest("8") } },
    });
    expect(build(changedPolicy, 1_700_000_360)).not.toBe(build(first, 1_700_000_180));
  });

  it("rejects mixed base generations and digest tampering", () => {
    expect(() =>
      buildSafetyScoreV9DiffReport({
        generatedAtSec: 1_700_000_180,
        expectedActiveIds: expectedIds,
        v8: { ...v8, baseInputGenerationId: `report-cards-input:v1:${digest("9")}` },
        v9: shadow,
        topCutoffIds: new Set(),
        downstreamThresholds: [],
        supplyUsdById: {},
      }),
    ).toThrow("one exact base input generation");

    const report = buildSafetyScoreV9DiffReport({
      generatedAtSec: 1_700_000_180,
      expectedActiveIds: expectedIds,
      v8,
      v9: shadow,
      topCutoffIds: new Set(),
      downstreamThresholds: [],
      supplyUsdById: {},
    });
    expect(SafetyScoreV9DiffReportSchema.safeParse({ ...report, reportDigest: digest("0") }).success).toBe(false);
  });
});

describe("Safety Score V8/V9 movement disposition carry", () => {
  const expectedIds = ["carry"];
  const downstreamThresholds = [
    { id: "selector-min-70", label: "Selector minimum score", score: 70, comparison: "at-least" as const },
  ];

  /** Builds one reviewable movement: a V8 A+ at 90 against a V9 B+ at the supplied score. */
  function scenario(options: {
    v9Score: number;
    v8Score?: number;
    v9ReasonCodes?: SafetyScoreV9Response["cards"][number]["reasonCodes"];
    v9BindingCap?: { kind: string; limit: number; source: "structural" } | null;
  }) {
    return {
      generatedAtSec: 1_700_000_180,
      expectedActiveIds: expectedIds,
      v8: v8Snapshot([
        {
          id: "carry",
          score: options.v8Score ?? 90,
          grade: scoreToGrade(options.v8Score ?? 90),
          bindingCap: null,
          reasonCodes: ["legacy-quality"],
        },
      ]),
      v9: envelope(
        [
          v9Card("carry", options.v9Score, {
            reasonCodes: options.v9ReasonCodes ?? ["partial-reserve-review"],
            bindingCap: options.v9BindingCap ?? null,
          }),
        ],
        { expectedActiveIds: expectedIds },
      ),
      topCutoffIds: new Set<string>(),
      downstreamThresholds,
      supplyUsdById: { carry: 1_000 },
    };
  }

  /** The recorded review a reviewer produced against the reviewed movement. */
  function recordedCarry(reviewedInput: ReturnType<typeof scenario>, disposition: "intended-methodology-change" | "defect") {
    const reviewed = buildSafetyScoreV9DiffReport(reviewedInput).cards[0]!;
    return {
      classKey: reviewed.review.classKey!,
      carry: {
        reviewKey: reviewed.review.key!,
        disposition,
        reviewedV8Score: reviewed.v8?.score ?? null,
        reviewedV9Score: reviewed.v9?.score ?? null,
      },
    };
  }

  it("carries a recorded disposition across a sub-threshold score wobble", () => {
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75 }), "intended-methodology-change");

    // Two points of drift: a new exact key, an unchanged class, inside the D=3 anchor.
    const wobbled = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 77 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(wobbled.review.key).not.toBe(carry.reviewKey);
    expect(wobbled.review.classKey).toBe(classKey);
    expect(wobbled.review).toMatchObject({
      status: "classified",
      disposition: "intended-methodology-change",
      carriedFrom: { reviewKey: carry.reviewKey, reviewedV9Score: 75 },
    });
  });

  it("carries across a drifting continuous weakest-pillar score", () => {
    // v9Card derives weakestPillar.score from the card score, so an unquantised pillar move is
    // exactly the zero-deadband case the class key drops in favour of the anchor.
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75 }), "intended-methodology-change");
    const drifted = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 76.5 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(drifted.review.status).toBe("classified");
    expect(drifted.review.carriedFrom).not.toBeNull();
  });

  it("expires the carry when drift exceeds the anchor and re-pends the movement", () => {
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75 }), "intended-methodology-change");

    const inside = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 78 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;
    expect(inside.review.status).toBe("classified");

    // 75 -> 78.1 is 3.1 points, past the ratified cap.
    const beyond = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 78.1 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;
    expect(beyond.review).toMatchObject({ status: "pending", disposition: null, carriedFrom: null });
  });

  it("expires the carry when the V8 anchor drifts past the cap", () => {
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75, v8Score: 90 }), "intended-methodology-change");

    const drifted = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 75, v8Score: 94 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(drifted.review).toMatchObject({ status: "pending", carriedFrom: null });
  });

  const classChanges: Array<[string, Parameters<typeof scenario>[0]]> = [
    ["a grade change", { v9Score: 80 }],
    ["a reason-code change", { v9Score: 75, v9ReasonCodes: ["critical-unresolved"] }],
    [
      "a binding-cap change",
      { v9Score: 75, v9BindingCap: { kind: "unsafe-backing", limit: 75, source: "structural" } },
    ],
  ];
  it.each(classChanges)("expires the carry on %s", (_label, changed) => {
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75 }), "intended-methodology-change");

    const report = buildSafetyScoreV9DiffReport({
      ...scenario(changed),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(report.review.classKey).not.toBe(classKey);
    expect(report.review).toMatchObject({ status: "pending", disposition: null, carriedFrom: null });
  });

  it("never lets a defect-class movement inherit a benign disposition", () => {
    // A benign movement is adjudicated, then the asset swaps its cause for a defect-class reason
    // code at an identical score. Cause is part of the class, so the benign ruling cannot follow.
    const { classKey, carry } = recordedCarry(
      scenario({ v9Score: 75, v9ReasonCodes: ["partial-reserve-review"] }),
      "intended-methodology-change",
    );

    const substituted = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 75, v9ReasonCodes: ["critical-unresolved"] }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(substituted.review.disposition).toBeNull();
    expect(substituted.review.status).toBe("pending");
  });

  it("carries a defect disposition without laundering it into a clean review", () => {
    const { classKey, carry } = recordedCarry(scenario({ v9Score: 75 }), "defect");

    const carried = buildSafetyScoreV9DiffReport({
      ...scenario({ v9Score: 77 }),
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(carried.review).toMatchObject({ status: "classified", disposition: "defect" });
  });

  it("prefers an exact-key disposition over any offered carry", () => {
    const input = scenario({ v9Score: 75 });
    const exact = buildSafetyScoreV9DiffReport(input).cards[0]!;
    const { classKey, carry } = recordedCarry(input, "defect");

    const report = buildSafetyScoreV9DiffReport({
      ...input,
      reviewDispositionsByKey: { [exact.review.key!]: "evidence-correction" },
      reviewCarriesByClassKey: { [classKey]: carry },
    }).cards[0]!;

    expect(report.review).toMatchObject({
      status: "classified",
      disposition: "evidence-correction",
      carriedFrom: null,
    });
  });
});

describe("Safety Score V9 daily advisory checks", () => {
  it("does not block a day on unresolved movement adjudication alone", () => {
    const result = envelope([v9Card("alpha", 90)], {
      unresolvedCriticalMovementIds: ["alpha"],
    });

    expect(assessSafetyScoreV9ShadowQualification(result)).toEqual({ qualifies: true, blockers: [] });
    // The movement remains visible to the owner without changing the advisory check.
    expect(result.coverage.unresolvedCriticalMovementIds).toEqual(["alpha"]);
  });

  it.each([
    [
      "a failing coverage floor",
      {
        coverageFloors: [
          { id: "active-result-count", status: "fail" as const, observed: 0, required: "1", detail: "No results" },
        ],
      },
      "coverage-floor-failed",
    ],
    [
      "a compiler exception",
      { compilerExceptions: ["alpha:compile"] },
      "compiler-exception",
    ],
    [
      "an active-ID bijection break",
      { expectedActiveIds: ["alpha", "beta"] },
      "active-id-bijection-failed",
    ],
    [
      "a publication regression",
      { publicationRegression: true },
      "publication-regression",
    ],
    [
      "future-dated evidence",
      { futureDatedEvidenceIds: ["alpha:future"] },
      "future-dated-evidence",
    ],
  ])("still fails the day on %s", (_label, options, expected) => {
    const result = envelope([v9Card("alpha", 90)], {
      ...options,
      unresolvedCriticalMovementIds: ["alpha"],
    });

    const qualification = assessSafetyScoreV9ShadowQualification(result);
    expect(qualification.qualifies).toBe(false);
    expect(qualification.blockers).toContain(expected);
  });
});
