import { describe, expect, it } from "vitest";
import type { CompiledV9AssetInput } from "@shared/types/safety-score-v9";
import {
  HistoricalV9FixtureSchema,
} from "@shared/types/safety-score-v9-historical-fixtures";
import historicalFixtures from "@shared/data/safety-score-v9/historical-fixtures-v1.json";
import {
  V9_CANDIDATE_POLICY_V1,
  resolveV9StructuralCaps,
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

  it("renormalizes a proven pipeline-only exit gap over the two measured pillars", () => {
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
    expect(trace.finalScore).toBe(81);
    expect(trace.partialEvidence).toMatchObject({ excludedPillars: ["exit"], causes: ["A"] });
    expect(trace.effectiveScoringWeights).toEqual({ backing: 0.4 / 0.65, control: 0.25 / 0.65, exit: 0 });
  });

  it("gives an active depeg precedence over an equal structural cap", () => {
    const trace = scoreV9ResearchScenarioInput(
      scoringInput("active-depeg-tie", {
        pillars: { backing: 90, exit: 90, control: 90 },
        activeDepegBps: 2_500,
      }),
      V9_CANDIDATE_POLICY_V1,
      [{ kind: "structural:f", limit: 39, reason: "Independent structural F cap." }],
    );

    expect(trace.bindingCap).toMatchObject({
      source: "active-depeg",
      kind: "active-depeg:f",
      limit: 39,
    });
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

  it("resolves fact-shaped signals to caps outside compiled metadata", () => {
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
    expect(resolveV9StructuralCaps(input.structuralSignals, V9_CANDIDATE_POLICY_V1)).toEqual([
      expect.objectContaining({ kind: "signal:unsafe-backing:critical", limit: 39 }),
    ]);
    expect(scoreCompiledAsset(input, V9_CANDIDATE_POLICY_V1).bindingCap?.kind).toBe("signal:unsafe-backing:critical");
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

  it("keeps structural caps diagnostic when cyclic parent uncertainty prevents a rating", () => {
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
    expect(trace?.caps).toContainEqual(expect.objectContaining({ kind: "signal:unsafe-backing:critical" }));
    expect(trace?.ratingStatus).toBe("not-rated");
    expect(trace?.finalScore).toBeNull();
    expect(trace?.adverseAttribution).toEqual([]);
    expect(trace?.unresolvedFacts).toContainEqual(expect.objectContaining({ code: "parent-cycle", cause: "U" }));
  });

  it("rejects historical look-ahead evidence", () => {
    const parsed = HistoricalV9FixtureSchema.safeParse({
      schemaVersion: 1,
      id: "look-ahead",
      assetId: "test",
      asOf: "2022-05-01T00:00:00.000Z",
      factsVersion: 1,
      facts: {
        archetype: "algorithmic",
        implementationAgeMonths: 12,
        signals: ["reflexive backing"],
        riskSignals: [],
        unresolvedCriticalFacts: [],
      },
      sources: [
        {
          title: "Postmortem",
          url: "https://example.com/postmortem",
          publishedAt: "2022-05-15T00:00:00.000Z",
          supports: ["failure cause"],
          capture: { status: "unarchived", note: "Negative-control source." },
        },
      ],
      factFreeze: {
        role: "facts-curator",
        reviewer: "facts reviewer",
        frozenAt: "2026-07-01T00:00:00.000Z",
        outcomeAccess: "withheld",
        attestation: "Facts were frozen without outcome access.",
      },
      outcome: {
        classification: "adverse",
        categories: ["backing"],
        observedFrom: "2022-05-09T00:00:00.000Z",
        observedThrough: "2022-05-15T00:00:00.000Z",
        summary: "Failed after the fixed observation date.",
      },
      outcomeAnnotation: {
        role: "outcome-annotator",
        reviewer: "outcome reviewer",
        annotatedAt: "2026-07-01T00:00:00.000Z",
        factSetVersion: 1,
        attestation: "Negative-control outcome annotation.",
      },
      blinding: { mode: "independent-reviewers", rationale: "Separate reviewers for negative control." },
    });
    expect(parsed.success).toBe(false);
  });
});
