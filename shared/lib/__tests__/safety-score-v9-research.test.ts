import { describe, expect, it } from "vitest";
import {
  HistoricalV9FixtureCorpusSchema,
  HistoricalV9FixtureSchema,
  type CompiledV9AssetInput,
} from "@shared/types/safety-score-v9";
import historicalFixtures from "@shared/data/safety-score-v9/historical-fixtures-v1.json";
import {
  V9_CANDIDATE_POLICY_V1,
  resolveV9StructuralCaps,
  scoreCompiledAsset,
  scoreCompiledAssetSet,
  scoreV9ResearchScenarioInput,
  scoreV9Input,
} from "../safety-score-v9-research";
import { projectV9ScoringInput } from "../safety-score-v9/score";

const AS_OF = "2026-07-01T00:00:00.000Z";

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
  it("validates the versioned historical corpus without look-ahead evidence", () => {
    const corpus = HistoricalV9FixtureCorpusSchema.parse(historicalFixtures);
    expect(corpus.fixtures.filter((fixture) => fixture.outcome.classification === "adverse")).toHaveLength(12);
    expect(
      corpus.fixtures.filter((fixture) => fixture.outcome.classification === "resilient").length,
    ).toBeGreaterThanOrEqual(12);
    expect(new Set(corpus.fixtures.flatMap((fixture) => fixture.outcome.categories))).toEqual(
      new Set(["backing", "exit", "control", "dependency", "peg-incident", "survivor"]),
    );
  });

  it("scores expectation-free input without redistributing a missing pillar", () => {
    const compiledInput = compiled("missing-exit");
    compiledInput.pillars.exit.score = null;
    const input = projectV9ScoringInput(compiledInput, V9_CANDIDATE_POLICY_V1, {
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [],
    });
    expect(input).toStrictEqual({
      assetId: "missing-exit",
      pillars: { backing: 90, exit: null, control: 70 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 72,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [],
    });
    const trace = scoreV9Input(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({ code: "missing-pillar" }));
  });

  it("gives an active depeg precedence over an equal structural cap", () => {
    const trace = scoreV9ResearchScenarioInput(
      {
        assetId: "active-depeg-tie",
        pillars: { backing: 90, exit: 90, control: 90 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: 2_500,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [],
        unresolved: [],
      },
      V9_CANDIDATE_POLICY_V1,
      [{ kind: "structural:f", limit: 39, reason: "Independent structural F cap." }],
    );

    expect(trace.bindingCap).toMatchObject({
      source: "active-depeg",
      kind: "active-depeg:f",
      limit: 39,
    });
  });

  it.each([
    ["material-unknown-reserve-exposure", "issuer-undisclosed", 69],
    ["missing-latest-assurance-report", "issuer-undisclosed", 84],
    ["partial-reserve-review", "issuer-undisclosed", 69],
  ] as const)("executes the %s issuer-evidence ceiling", (code, responsibility, expectedLimit) => {
    const trace = scoreV9Input(
      {
        assetId: `bounded-unknown-${code}`,
        pillars: { backing: 95, exit: 95, control: 95 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [],
        unresolved: [
          {
            code,
            reason: "A bounded fact remains unresolved.",
            critical: false,
            path: "fixture",
            responsibility,
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(expectedLimit);
    expect(trace.bindingCap).toMatchObject({
      source: "evidence",
      kind: `reason:${code}`,
      limit: expectedLimit,
    });
    expect(trace.nrReasons).toEqual([]);
  });

  it("applies the configured ceiling to an integration-owned implementation-date gap", () => {
    const trace = scoreV9Input(
      {
        assetId: "integration-owned-implementation-date",
        pillars: { backing: 95, exit: 95, control: 95 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [],
        unresolved: [{
          code: "missing-implementation-date",
          reason: "Pharos has not integrated the reviewed launch date.",
          critical: false,
          path: "fixture",
          responsibility: "integration-missing",
        }],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(79);
    expect(trace.bindingCap).toMatchObject({
      source: "evidence",
      kind: "reason:missing-implementation-date",
      limit: 79,
    });
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
      {
        assetId: "informational-parent",
        pillars: { backing: 90, exit: 90, control: 90 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: 40,
        structuralSignals: [],
        unresolved: [],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(90);
    expect(trace.caps.some((cap) => cap.source === "parent")).toBe(false);
  });

  it("rejects a parent trace that does not match the compiled parent identity", () => {
    const child = compiled("child", "expected-parent");
    const wrongParent = scoreCompiledAsset(compiled("wrong-parent"), V9_CANDIDATE_POLICY_V1);

    expect(() => scoreCompiledAsset(child, V9_CANDIDATE_POLICY_V1, wrongParent)).toThrow(
      "expects parent expected-parent, not wrong-parent",
    );
  });

  it("rejects a compiled input evaluated under a different policy", () => {
    const input = compiled("policy-mismatch");
    input.compilerPolicy.semanticDigest = "0".repeat(64);
    expect(() => scoreCompiledAsset(input, V9_CANDIDATE_POLICY_V1)).toThrow(/was produced by/);
  });

  it("validates policy provenance even for an empty compiled set", () => {
    const forgedPolicy = { ...V9_CANDIDATE_POLICY_V1 };
    expect(() => scoreCompiledAssetSet([], forgedPolicy)).toThrow(/loadV9MethodologyPolicy/);
  });

  it("turns parent cycles into explicit NR traces", () => {
    const result = scoreCompiledAssetSet([compiled("a", "b"), compiled("b", "a")], V9_CANDIDATE_POLICY_V1);
    const reversed = scoreCompiledAssetSet([compiled("b", "a"), compiled("a", "b")], V9_CANDIDATE_POLICY_V1);
    expect(result.traces.every((trace) => trace.finalGrade === "NR")).toBe(true);
    expect(result.traces.every((trace) => trace.nrReasons.some((reason) => reason.code === "parent-cycle"))).toBe(true);
    expect(result.traces.every((trace) => trace.bindingCap === null)).toBe(true);
    expect(result.evaluatedOrder).toEqual(["a", "b"]);
    expect(reversed).toEqual(result);
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
    expect(parsed.error?.issues[0]?.message).toContain("Look-ahead evidence");
  });
});
