import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ReplayArtifactSchema,
  SafetyScoreV9ShadowDailySchema,
  assessSafetyScoreV9ShadowQualification,
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailyFailure,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9CoverageFloor,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowEnvelope,
} from "../safety-score-v9-shadow";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";

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
  grade: SafetyScoreV9Response["cards"][number]["grade"],
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
  return {
    id,
    score,
    grade,
    qualityScore: score,
    pegMultiplier: score === null ? null : 1,
    pegAdjustedScore: score,
    pillars:
      score === null
        ? { backing: pillar(null), exit: pillar(null), control: pillar(null) }
        : {
            backing: pillar(score + 1 > 100 ? 100 : score + 1),
            exit: pillar(score),
            control: pillar(score + 0.5),
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
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v1",
    policyVersion: "candidate-v1",
    publicationGenerationId: "v9-shadow-generation-1",
    baseInputGenerationId: BASE_GENERATION,
    factSetDigest: FACT_DIGEST,
    resultDigest: RESULT_DIGEST,
    policy: { id: "candidate-v1", semanticDigest: POLICY_DIGEST },
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
  cards: SafetyScoreV9Response["cards"] = [v9Card("alpha", 90, "A")],
  options: {
    expectedActiveIds?: string[];
    replayArtifacts?: SafetyScoreV9ReplayArtifact[];
    coverageFloors?: SafetyScoreV9CoverageFloor[];
    duplicateIds?: string[];
    compilerExceptions?: string[];
    futureDatedEvidenceIds?: string[];
    publicationRegression?: boolean;
    unresolvedReleaseBlockers?: string[];
    unresolvedCriticalMovementIds?: string[];
    candidateOverrides?: Partial<SafetyScoreV9Response>;
  } = {},
): SafetyScoreV9ShadowEnvelope {
  const candidateInput = candidate(cards, options.candidateOverrides);
  return buildSafetyScoreV9ShadowEnvelope({
    candidate: candidateInput,
    expectedActiveIds: options.expectedActiveIds ?? cards.map((card) => card.id),
    compilerFactSchemaDigest: COMPILER_SCHEMA_DIGEST,
    producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    duplicateIds: options.duplicateIds,
    compilerExceptions: options.compilerExceptions,
    futureDatedEvidenceIds: options.futureDatedEvidenceIds,
    coverageFloors: options.coverageFloors ?? [PASSING_FLOOR],
    publicationRegression: options.publicationRegression,
    unresolvedReleaseBlockers: options.unresolvedReleaseBlockers,
    unresolvedCriticalMovementIds: options.unresolvedCriticalMovementIds,
    replayArtifacts: options.replayArtifacts ?? replayArtifacts(candidateInput),
  });
}

describe("Safety Score V9 shadow envelope", () => {
  it("binds exact candidate identities, coverage, compact results, and replay artifacts", () => {
    const result = envelope([
      v9Card("zeta", null, "NR", { reasonCodes: ["insufficient-evidence"] }),
      v9Card("alpha", 90, "A"),
    ]);

    expect(result.candidate.cards.map((card) => card.id)).toEqual(["alpha", "zeta"]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      candidate: {
        lifecycle: "candidate",
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
    expect(result.replayArtifacts.map((artifact) => artifact.kind)).toEqual([
      "base-input",
      "evaluation-build",
      "fact-set",
      "policy",
      "result",
    ]);
  });

  it("refuses active lifecycle and replay artifacts bound to another identity", () => {
    expect(() =>
      envelope(undefined, {
        candidateOverrides: { lifecycle: "active" as never },
      }),
    ).toThrow(/candidate/);

    const candidateInput = candidate([v9Card("alpha", 90, "A")]);
    const artifacts = replayArtifacts(candidateInput);
    artifacts[0] = { ...artifacts[0]!, identity: `report-cards-input:v1:${digest("9")}` };
    expect(() => envelope(undefined, { replayArtifacts: artifacts })).toThrow("Replay artifact identity");
  });

  it("qualifies an exact covered generation without requiring retained artifacts", () => {
    expect(assessSafetyScoreV9ShadowQualification(envelope(undefined, { replayArtifacts: [] }))).toEqual({
      qualifies: true,
      blockers: [],
    });
  });

  it("reports every machine qualification blocker without inventing a pass", () => {
    const candidateInput = candidate([v9Card("alpha", 90, "A")]);
    const result = envelope(candidateInput.cards, {
      expectedActiveIds: ["alpha", "missing"],
      replayArtifacts: [replayArtifact("base-input", candidateInput, "pending")],
      coverageFloors: [{ ...PASSING_FLOOR, status: "fail", detail: "Coverage is below the floor" }],
      duplicateIds: ["alpha"],
      compilerExceptions: ["compiler-exception:alpha"],
      futureDatedEvidenceIds: ["alpha"],
      publicationRegression: true,
      unresolvedReleaseBlockers: ["release-owner-review"],
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
        "unresolved-critical-movement",
        "unresolved-release-blocker",
      ],
    });
  });

  it("keeps replay verification separate from runtime qualification", () => {
    const candidateInput = candidate([v9Card("alpha", 90, "A")]);
    const artifacts = replayArtifacts(candidateInput);
    artifacts[2] = replayArtifact("policy", candidateInput, "checksum-mismatch");
    const result = envelope(candidateInput.cards, { replayArtifacts: artifacts });

    expect(assessSafetyScoreV9ShadowQualification(result)).toEqual({
      qualifies: true,
      blockers: [],
    });
  });

  it("produces the same envelope digest across input permutations", () => {
    const cards = [v9Card("zeta", 80, "B"), v9Card("alpha", 90, "A")];
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
    v8: v8Snapshot([{ id: "alpha", score: 90, grade: "A", bindingCap: null, reasonCodes: [] }]),
    v9: shadow,
    topCutoffIds: new Set(),
    downstreamThresholds: [],
    supplyUsdById: { alpha: 1_000 },
  });
}

function successfulDaily(previous: SafetyScoreV9ShadowDaily | null = null) {
  const shadow = envelope(undefined, { replayArtifacts: [] });
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
          publicationGenerationId: "v9-shadow-generation-1",
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

  it("requires all five artifact keys only when a run is selected for archive", () => {
    const shadow = envelope(undefined, { replayArtifacts: [] });
    const diff = dailyDiff(shadow);
    expect(() =>
      buildSafetyScoreV9ShadowDailySuccess({
        utcDay: "2026-07-13",
        selectedAtSec: SCHEDULED_FOR + 15,
        updatedAtSec: SCHEDULED_FOR + 20,
        envelope: shadow,
        diff,
        archiveSelectionReasons: ["anomaly"],
      }),
    ).toThrow("one replay artifact of every kind");

    const artifactKeys = (["base-input", "evaluation-build", "fact-set", "policy", "result"] as const).map(
      (kind, index) => `${kind}:${digest(String(index + 2))}`,
    );
    const archived = buildSafetyScoreV9ShadowDailySuccess({
      utcDay: "2026-07-13",
      selectedAtSec: SCHEDULED_FOR + 15,
      updatedAtSec: SCHEDULED_FOR + 20,
      envelope: shadow,
      diff,
      archiveSelectionReasons: ["anomaly"],
      artifactKeys,
    });
    expect(archived.selectedRun).toMatchObject({ archiveSelectionReasons: ["anomaly"], artifactKeys });
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
    v9Card("cap", 80, "B", {
      bindingCap: { kind: "unsafe-backing", limit: 80, source: "structural" },
    }),
    v9Card("large", 84, "B+", { reasonCodes: ["partial-reserve-review"] }),
    v9Card("nr", null, "NR", { reasonCodes: ["insufficient-evidence"] }),
    v9Card("stable", 89, "A", { reasonCodes: ["partial-reserve-review"] }),
    v9Card("threshold", 69, "C+"),
    v9Card("top", 87, "A"),
  ];
  const expectedIds = ["cap", "large", "missing", "nr", "stable", "threshold", "top"];
  const shadow = envelope(v9Cards, { expectedActiveIds: expectedIds });
  const v8 = v8Snapshot([
    { id: "cap", score: 80, grade: "B", bindingCap: null, reasonCodes: [] },
    { id: "large", score: 90, grade: "A", bindingCap: null, reasonCodes: ["legacy-quality"] },
    { id: "missing", score: 75, grade: "B-", bindingCap: null, reasonCodes: [] },
    { id: "nr", score: 80, grade: "B", bindingCap: null, reasonCodes: [] },
    { id: "stable", score: 90, grade: "A", bindingCap: null, reasonCodes: ["legacy-quality"] },
    { id: "threshold", score: 71, grade: "C+", bindingCap: null, reasonCodes: [] },
    { id: "top", score: 89, grade: "A", bindingCap: null, reasonCodes: [] },
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
    const boundaryShadow = envelope([v9Card("large-boundary", 75, "B-"), v9Card("top-boundary", 88, "A")]);
    const report = buildSafetyScoreV9DiffReport({
      generatedAtSec: 1_700_000_180,
      expectedActiveIds: ["large-boundary", "top-boundary"],
      v8: v8Snapshot([
        { id: "large-boundary", score: 80, grade: "B", bindingCap: null, reasonCodes: [] },
        { id: "top-boundary", score: 90, grade: "A", bindingCap: null, reasonCodes: [] },
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
    const v8Input = v8Snapshot([{ id: "asset", score: 90, grade: "A", bindingCap: null, reasonCodes: [] }]);
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

    const first = envelope([v9Card("asset", 84, "B+")]);
    const nextPublication = envelope([v9Card("asset", 84, "B+")], {
      candidateOverrides: {
        publicationGenerationId: "v9-shadow-generation-2",
        factSetDigest: digest("8"),
        resultDigest: digest("9"),
      },
    });
    expect(build(nextPublication, 1_700_000_240)).toBe(build(first, 1_700_000_180));
    expect(build(first, 1_700_000_240, 2_000)).toBe(build(first, 1_700_000_180, 1_000));

    const changedMovement = envelope([v9Card("asset", 83, "B+")]);
    expect(build(changedMovement, 1_700_000_300)).not.toBe(build(first, 1_700_000_180));

    expect(build(first, 1_700_000_300, 1_000, new Set(["asset"]))).not.toBe(build(first, 1_700_000_180));

    const changedPolicy = envelope([v9Card("asset", 84, "B+")], {
      candidateOverrides: { policy: { id: "candidate-v1", semanticDigest: digest("8") } },
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
