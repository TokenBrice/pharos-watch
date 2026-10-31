import { describe, expect, it } from "vitest";
import type { CompiledV9AssetInput } from "@shared/types/safety-score-v9";
import {
  V9_CANDIDATE_POLICY_V1,
  scoreCompiledAsset,
  scoreCompiledAssetSet,
  scoreV9ResearchScenarioInput,
  scoreV9Input,
} from "../safety-score-v9-research";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { makeV9Pillar, makeV9ProductionScoreInput, makeV9ScoringInput } from "./safety-score-v9-score.test-support";

const AS_OF = "2026-07-01T00:00:00.000Z";

function scoringInput(
  assetId: string,
  overrides: Partial<Parameters<typeof scoreV9Input>[0]> = {},
): Parameters<typeof scoreV9Input>[0] {
  return makeV9ScoringInput({ assetId, ...overrides });
}

function compiled(assetId: string, parentId?: string): CompiledV9AssetInput {
  const evidence = [{ sourceId: "fixture", observedAt: AS_OF }];
  return {
    schemaVersion: 1,
    compilerPolicy: {
      policyId: V9_CANDIDATE_POLICY_V1.policy.policyId,
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    },
    assetId,
    asOf: AS_OF,
    compiledAt: AS_OF,
    archetype: "cdp",
    pillars: {
      backing: { score: 90, evidenceLevel: "strong", evidence, unresolved: [], signals: [] },
      exit: { score: 80, evidenceLevel: "strong", evidence, unresolved: [], signals: [] },
      control: { score: 70, evidenceLevel: "strong", evidence, unresolved: [], signals: [] },
    },
    peg: { applicable: true, score: 100, activeDepegBps: null, evidence, unresolved: [] },
    implementationLaunchDate: "2020-01-01",
    trackRecordMonths: 72,
    parent: parentId ? { assetId: parentId, required: true, relationship: "wrapper" } : null,
    structuralSignals: [],
    unresolved: [],
    sourceTimestamps: { fixture: AS_OF },
  };
}

describe("v9 research handoff contracts", () => {

  it("prices a proven pipeline-only exit gap without presenting it as measured evidence", () => {
    const input = makeV9ProductionScoreInput({
      pillars: {
        backing: makeV9Pillar(90),
        control: makeV9Pillar(70),
        exit: makeV9Pillar(null, {
          aggregationDisposition: "excluded-a-b",
          evidenceLevel: "insufficient",
          causeGapIds: ["exit:producer-gap"],
          supportedComponentKeys: [],
          excludedComponentKeys: ["exit:inventory"],
          excludedCauseGapIds: ["exit:producer-gap"],
          excludedCauses: ["A"],
        }),
      },
    });
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("rated");
    const measuredUnknown = scoreV9EvaluatedAsset({
      ...input, pillars: { ...input.pillars, exit: makeV9Pillar(50) },
    }, V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(measuredUnknown.finalScore);
    expect(trace.diagnosticPillarScores.exit).toBeNull();
    expect(trace.aggregation?.pricedUnknownPillars).toEqual([
      { pillar: "exit", cause: "U", score: 50, causeGapIds: ["exit:producer-gap"] },
    ]);
    expect(trace.partialEvidence).toMatchObject({ excludedPillars: ["exit"], causes: ["A"] });
    expect(trace.effectiveScoringWeights).toEqual({ backing: 0.4, control: 0.25, exit: 0.35 });
  });

  it("prices a missing scenario pillar as unknown and records its diagnostic U cause", () => {
    const trace = scoreV9ResearchScenarioInput(
      scoringInput("scenario-missing-backing", {
        pillars: { backing: null, exit: 90, control: 70 },
      }),
      V9_CANDIDATE_POLICY_V1,
      [],
    );

    expect(trace.includedPillars).toEqual(["backing", "exit", "control"]);
    // Priced at the policy's unknown backing quality for cause U.
    expect(trace.diagnosticPillarScores.backing).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.backing.U);
    expect(trace.limitedEvidenceCauses).toEqual(["U"]);
    expect(trace.limitingPillars).toEqual([]);
    expect(trace.ratingStatus).toBe("rated");
  });

  it("gives an active depeg precedence over an equal structural cap", () => {
    const trace = scoreV9ResearchScenarioInput(
      scoringInput("active-depeg-tie", {
        pillars: { backing: 90, exit: 90, control: 90 },
        activeDepegBps: 2_500,
      }),
      V9_CANDIDATE_POLICY_V1,
      [{ kind: "structural:f", limit: 25, reason: "Independent structural F cap." }],
    );

    expect(trace.bindingCap).toMatchObject({
      source: "active-depeg",
      kind: "active-depeg:f",
      limit: 25,
    });
  });

  it.each([
    { activeDepegBps: 999, limit: null, grade: "A+" },
    { activeDepegBps: 1_000, limit: 49, grade: "D" },
    { activeDepegBps: 2_499, limit: 49, grade: "D" },
    { activeDepegBps: 2_500, limit: 25, grade: "F" },
    { activeDepegBps: 4_999, limit: 25, grade: "F" },
    { activeDepegBps: 5_000, limit: 10, grade: "F" },
    { activeDepegBps: 5_001, limit: 10, grade: "F" },
  ])("selects the depeg severity rung at $activeDepegBps bps", ({ activeDepegBps, limit, grade }) => {
    const trace = scoreV9Input(scoringInput("depeg-boundary", {
      pillars: { backing: 90, exit: 90, control: 90 },
      activeDepegBps,
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalGrade).toBe(grade);
    if (limit === null) {
      expect(trace.caps.some((cap) => cap.source === "active-depeg")).toBe(false);
    } else {
      expect(trace.finalScore).toBe(limit);
      expect(trace.bindingCap).toMatchObject({ source: "active-depeg", limit });
      expect(trace.bindingCap!.reason).toContain(`${grade} range`);
      if (grade === "F") expect(trace.bindingCap!.reason).toContain(`to ${limit},`);
    }
  });

  it("withholds adverse attribution when an issuer-limited required parent is not rated", () => {
    const input = makeV9ProductionScoreInput({
      pillars: { backing: makeV9Pillar(60), exit: makeV9Pillar(55), control: makeV9Pillar(50) },
      trackRecordMonths: 12,
      peg: { applicable: true, score: 100, activeDepegBps: 10_000, reasons: [] },
      parent: {
        required: true, score: null, ratingStatus: "not-rated",
        limitedEvidenceCauses: ["C"], causeGapIds: ["parent:issuer-opacity"],
        propagatedReasons: [{
          code: "insufficient-evidence", message: "Issuer-limited parent evidence.",
          cause: "C", causeGapIds: ["parent:issuer-opacity"], contributingPillars: ["backing", "exit"],
        }],
      },
    });
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("not-rated");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({ code: "insufficient-evidence", cause: "C" }));
    expect(trace.caps).toContainEqual(expect.objectContaining({ source: "active-depeg" }));
    expect(trace.adverseAttribution).toEqual([]);
  });

  it.each([
    "material-unknown-reserve-exposure",
    "missing-latest-assurance-report",
    "partial-reserve-review",
  ] as const)("does not impose a named cap for %s issuer uncertainty", (code) => {
    const trace = scoreV9Input(
      scoringInput(`bounded-unknown-${code}`, {
        unresolved: [
          {
            code,
            reason: "A bounded fact remains unresolved.",
            critical: false,
            path: "fixture",
            responsibility: "issuer-undisclosed",
            cause: "C",
            causeGapIds: [`issuer:${code}`],
          },
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(scoreV9Input(scoringInput("measured-baseline"), V9_CANDIDATE_POLICY_V1).finalScore);
    expect(trace.caps.map((cap) => cap.kind)).not.toContain(`reason:${code}`);
    expect(trace.nrReasons).toEqual([]);
  });

  it("excludes a proven pipeline-owned implementation-date constraint", () => {
    const trace = scoreV9Input(
      scoringInput("integration-owned-implementation-date", {
        unresolved: [{
          code: "missing-implementation-date",
          reason: "Pharos has not integrated the reviewed launch date.",
          critical: false,
          path: "fixture",
          responsibility: "integration-missing",
          cause: "A",
          causeGapIds: ["implementation:producer-gap"],
        }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(scoreV9Input(scoringInput("known-date"), V9_CANDIDATE_POLICY_V1).finalScore);
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("reason:missing-implementation-date");
    expect(trace.nrReasons).toEqual([]);
  });

  it("keeps fact-shaped structural signals diagnostic rather than whole-score caps", () => {
    const input = compiled("unsafe");
    input.structuralSignals = [
      {
        kind: "unsafe-backing",
        severity: "critical",
        reason: "Unsecured backing loss.",
        failureDomainKeys: ["obligor:test"],
        evidence: [],
      },
      {
        kind: "peripheral-bridge",
        severity: "high",
        reason: "One peripheral route.",
        materialSharePct: 0.2,
        failureDomainKeys: ["bridge:test"],
        evidence: [],
      },
    ];
    const baseline = scoreCompiledAsset(compiled("baseline"), V9_CANDIDATE_POLICY_V1);
    const trace = scoreCompiledAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(baseline.finalScore);
    expect(trace.caps).toEqual(baseline.caps);
  });

  it("evaluates parents deterministically regardless of input order", () => {
    const parent = compiled("parent");
    parent.pillars.backing.score = 60;
    const child = compiled("child", "parent");

    const forward = scoreCompiledAssetSet([parent, child], V9_CANDIDATE_POLICY_V1);
    const reverse = scoreCompiledAssetSet([child, parent], V9_CANDIDATE_POLICY_V1);
    expect(reverse.traces).toEqual(forward.traces);
    expect(forward.traces.find((trace) => trace.assetId === "child")?.finalScore).toBeLessThanOrEqual(
      forward.traces.find((trace) => trace.assetId === "parent")?.finalScore ?? 0,
    );
  });

  it("does not apply a parent ceiling when the parent is informational", () => {
    const trace = scoreV9Input(
      scoringInput("informational-parent", {
        pillars: { backing: 90, exit: 90, control: 90 },
        parentScore: 40,
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(90);
    expect(trace.caps.some((cap) => cap.source === "parent")).toBe(false);
  });

  it("rejects a parent trace that does not match the compiled parent identity", () => {
    const child = compiled("child", "expected-parent");
    const wrongParent = scoreCompiledAsset(compiled("wrong-parent"), V9_CANDIDATE_POLICY_V1);

    expect(() => scoreCompiledAsset(child, V9_CANDIDATE_POLICY_V1, wrongParent)).toThrow();
  });

  it("rejects a compiled input evaluated under a different policy", () => {
    const input = compiled("policy-mismatch");
    input.compilerPolicy.semanticDigest = "0".repeat(64);
    expect(() => scoreCompiledAsset(input, V9_CANDIDATE_POLICY_V1)).toThrow();
  });

  it("validates policy provenance even for an empty compiled set", () => {
    const forgedPolicy = { ...V9_CANDIDATE_POLICY_V1 };
    expect(() => scoreCompiledAssetSet([], forgedPolicy)).toThrow();
  });

  it("retains cyclic parent uncertainty without inventing adverse attribution", () => {
    const result = scoreCompiledAssetSet([compiled("a", "b"), compiled("b", "a")], V9_CANDIDATE_POLICY_V1);
    expect(result.traces.every((trace) => trace.finalGrade === "NR")).toBe(true);
    expect(result.traces.every((trace) => trace.unresolvedFacts.some(
      (reason) => reason.code === "parent-cycle" && reason.cause === "U",
    ))).toBe(true);
    expect(result.traces.every((trace) => trace.adverseAttribution.length === 0)).toBe(true);
  });

  it("retains structural diagnostics without a retired whole-score cap during cyclic parent uncertainty", () => {
    const capped = compiled("a", "b");
    capped.structuralSignals = [{
      kind: "unsafe-backing",
      severity: "critical",
      reason: "Unsecured backing loss.",
      failureDomainKeys: ["obligor:test"],
      evidence: [],
    }];

    const result = scoreCompiledAssetSet([capped, compiled("b", "a")], V9_CANDIDATE_POLICY_V1);
    const trace = result.traces.find((candidate) => candidate.assetId === "a");
    expect(trace?.caps).toEqual([]);
    expect(trace?.structuralSignals).toEqual(capped.structuralSignals);
    expect(trace?.ratingStatus).toBe("not-rated");
    expect(trace?.finalScore).toBeNull();
    expect(trace?.adverseAttribution).toEqual([]);
    expect(trace?.unresolvedFacts).toContainEqual(expect.objectContaining({ code: "parent-cycle", cause: "U" }));
  });

});
