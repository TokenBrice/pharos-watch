import { describe, expect, it } from "vitest";
import {
  HistoricalV9FixtureCorpusSchema,
  HistoricalV9FixtureSchema,
  type CompiledV9AssetInput,
} from "@shared/types/safety-score-v9";
import historicalFixtures from "@shared/data/safety-score-v9/historical-fixtures-v1.json";
import {
  resolveV9StructuralCaps,
  scoreCompiledAsset,
  scoreCompiledAssetSet,
  scoreV9Input,
} from "../safety-score-v9-research";

const AS_OF = "2026-07-01T00:00:00.000Z";

function compiled(assetId: string, parentId?: string): CompiledV9AssetInput {
  const evidence = [{ sourceId: "fixture", observedAt: AS_OF }];
  return {
    schemaVersion: 1,
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
    const trace = scoreV9Input({
      assetId: "missing-exit",
      pillars: { backing: 90, exit: null, control: 80 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "adequate",
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralCaps: [],
      structuralSignals: [],
      unresolved: [],
    });
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({ code: "missing-pillar" }));
  });

  it("gives an active depeg precedence over an equal structural cap", () => {
    const trace = scoreV9Input({
      assetId: "active-depeg-tie",
      pillars: { backing: 90, exit: 90, control: 90 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 48,
      activeDepegBps: 2_500,
      parentRequired: false,
      parentScore: null,
      structuralCaps: [{ kind: "structural:f", limit: 39, reason: "Independent structural F cap." }],
      structuralSignals: [],
      unresolved: [],
    });

    expect(trace.bindingCap).toMatchObject({
      source: "active-depeg",
      kind: "active-depeg:f",
      limit: 39,
    });
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
    expect(resolveV9StructuralCaps(input.structuralSignals)).toEqual([
      expect.objectContaining({ kind: "signal:unsafe-backing:critical", limit: 39 }),
    ]);
    expect(scoreCompiledAsset(input).bindingCap?.kind).toBe("signal:unsafe-backing:critical");
  });

  it("evaluates parents deterministically regardless of input order", () => {
    const parent = compiled("parent");
    parent.pillars.backing.score = 60;
    const child = compiled("child", "parent");

    const forward = scoreCompiledAssetSet([parent, child]);
    const reverse = scoreCompiledAssetSet([child, parent]);
    expect(reverse.traces).toEqual(forward.traces);
    expect(forward.traces.find((trace) => trace.assetId === "child")?.finalScore).toBeLessThanOrEqual(
      forward.traces.find((trace) => trace.assetId === "parent")?.finalScore ?? 0,
    );
  });

  it("turns parent cycles into explicit NR traces", () => {
    const result = scoreCompiledAssetSet([compiled("a", "b"), compiled("b", "a")]);
    expect(result.traces.every((trace) => trace.finalGrade === "NR")).toBe(true);
    expect(result.traces.flatMap((trace) => trace.nrReasons).some((reason) => reason.code === "parent-cycle")).toBe(
      true,
    );
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
