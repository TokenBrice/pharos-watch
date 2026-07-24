import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS, PAIRWISE_CONSTRAINTS } from "@shared/data/safety-score-v9/golden-scenarios-v1";
import type {
  CompiledV9AssetInput,
  V9ScoringInput,
  V9StructuralSignal,
  V9UnresolvedFact,
} from "@shared/types/safety-score-v9";
import {
  buildV9DependencyEvaluationPlan,
  type V9DependencyPlanningAsset,
  type V9DependencyPlanningEdge,
} from "../safety-score-v9/dependencies";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "../safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1, resolveV9ReasonPolicy } from "../safety-score-v9/policy";
import { scoreV9GoldenScenario } from "../safety-score-v9/scenario-evaluator";
import { scoreCompiledAssetSet } from "../safety-score-v9-research";

/**
 * STAGE A invariant + adverse-anchor re-pins for the 2026-07-17 anchor-
 * coherence rulings (R2/R3/R4/D1/D2/D3; provisional pending the V8
 * counterfactual-matrix review). Every test here is ACTIVE: it passes on the
 * current engine and must keep passing unchanged after the Stage B batch —
 * the ruled semantics were verified adverse-green in the counterfactual
 * matrix (results/counterfactual-matrix-2026-07-17/MATRIX.md, adverse guard
 * GREEN in all six executed variants), so any same-input lift of the adverse
 * set or invariant break is a stop-and-report, not a fix-forward.
 *
 * Adverse fixture provenance: capture-9 pinned input
 * (results/real-a-2026-07-16/capture-9/, captured 2026-07-16T18:19:02Z,
 * source generation report-cards:8.17:1784225728) as replayed by matrix V0;
 * pillar scores, peg scores, evidence levels, and binding caps below are the
 * V0 replay values for the six named adverse anchors.
 */

function scoringInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "invariant-fixture",
    pillars: { backing: 90, exit: 90, control: 90 },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralSignals: [],
    unresolved: [],
    ...overrides,
  };
}

function boundedCeilingFact(code: string): V9UnresolvedFact {
  const resolved = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, code as V9UnresolvedFact["code"]);
  const reasonCode = code as V9UnresolvedFact["code"];
  return {
    code: reasonCode,
    reason: `fixture ${code}`,
    critical: resolved.critical,
    responsibility: V9_LEGACY_RESPONSIBILITY_BY_REASON[reasonCode],
  };
}

function signal(kind: V9StructuralSignal["kind"], severity: V9StructuralSignal["severity"]): V9StructuralSignal {
  const pricedInPillar =
    kind === "unsafe-backing" ||
    kind === "speculative-credit" ||
    kind === "algorithmic-reflexivity"
      ? "backing" as const
      : kind === "centralized-mint" ||
          kind === "unreviewed-upgrade" ||
          kind === "weak-oracle-branch" ||
          kind === "active-control-incident"
        ? "control" as const
        : undefined;
  return {
    kind,
    severity,
    reason: `fixture ${kind}:${severity}`,
    responsibility: "measured-adverse",
    ...(pricedInPillar === undefined ? {} : { pricedInPillar }),
    failureDomainKeys: [`fixture:${kind}`],
    evidence: [],
  };
}

function score(overrides: Partial<V9ScoringInput> = {}) {
  return scoreV9Input(scoringInput(overrides), V9_CANDIDATE_POLICY_V1);
}

const AS_OF_SEC = 1_780_000_000;
const AS_OF = new Date(AS_OF_SEC * 1_000).toISOString();

function compiledInput(
  assetId: string,
  pillarScore: number,
  parent: CompiledV9AssetInput["parent"] = null,
): CompiledV9AssetInput {
  const pillar = {
    score: pillarScore,
    evidenceLevel: "strong" as const,
    evidence: [{ sourceId: `fixture:${assetId}`, observedAt: AS_OF }],
    unresolved: [],
    signals: [],
  };
  return {
    schemaVersion: 1,
    compilerPolicy: {
      policyId: V9_CANDIDATE_POLICY_V1.policy.policyId,
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    },
    assetId,
    asOf: AS_OF,
    compiledAt: AS_OF,
    archetype: "fiat-cash",
    pillars: { backing: pillar, exit: pillar, control: pillar },
    peg: { applicable: false, score: null, activeDepegBps: null, evidence: [], unresolved: [] },
    implementationLaunchDate: "2022-01-01",
    trackRecordMonths: 48,
    parent,
    structuralSignals: [],
    unresolved: [],
    sourceTimestamps: { fixture: AS_OF },
  };
}

describe("anchor-coherence invariants — active", () => {
  it("keeps the 32 golden orderings passing unmodified", () => {
    expect(GOLDEN_SCENARIOS).toHaveLength(34);
    expect(PAIRWISE_CONSTRAINTS).toHaveLength(31);
    const traces = new Map(
      GOLDEN_SCENARIOS.map((scenario) => [scenario.id, scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1)]),
    );
    for (const constraint of PAIRWISE_CONSTRAINTS) {
      const higher = traces.get(constraint.higherId)!;
      const lower = traces.get(constraint.lowerId)!;
      expect(higher.finalScore, constraint.higherId).not.toBeNull();
      expect(lower.finalScore, constraint.lowerId).not.toBeNull();
      expect(higher.finalScore! - lower.finalScore!, constraint.rationale).toBeGreaterThanOrEqual(
        constraint.minGap,
      );
    }
  });

  it("more-unknown-never-raises: bounded unknowns and structural signals never lift any score", () => {
    for (const pillars of [
      { backing: 95, exit: 95, control: 95 },
      { backing: 70, exit: 65, control: 50 },
      { backing: 45, exit: 40, control: 35 },
    ]) {
      const baseTrace = score({ pillars });
      const variants = [
        { unresolved: [boundedCeilingFact("missing-reserve-composition")] },
        { structuralSignals: [signal("critical-dependency", "high")] },
        {
          unresolved: [boundedCeilingFact("missing-reserve-composition")],
          structuralSignals: [signal("critical-dependency", "high")],
        },
        { unresolved: [boundedCeilingFact("missing-same-notional-route")] },
      ];
      for (const variant of variants) {
        const candidate = score({ pillars, ...variant });
        const addsOnlyUncertainty = !("structuralSignals" in variant);
        if (baseTrace.finalScore === null && addsOnlyUncertainty) {
          expect(candidate.finalScore, JSON.stringify(variant)).toBeNull();
          expect(candidate.finalGrade, JSON.stringify(variant)).toBe("NR");
          continue;
        }
        if (candidate.finalScore === null) {
          expect(candidate.finalGrade, JSON.stringify(variant)).toBe("NR");
        } else {
          const baselineComparable =
            baseTrace.finalScore ??
            (baseTrace.preCapScore === null ? null : Math.round(baseTrace.preCapScore));
          expect(baselineComparable).not.toBeNull();
          expect(candidate.finalScore, JSON.stringify(variant)).toBeLessThanOrEqual(
            baselineComparable!,
          );
        }
      }
    }
  });

  it("hiding-favorable-never-raises: withholding favorable evidence never lifts the score", () => {
    const full = score({ pillars: { backing: 95, exit: 95, control: 95 } });
    const redactedEvidence = score({ pillars: { backing: 95, exit: 95, control: 95 }, evidenceLevel: "limited" });
    expect(redactedEvidence.finalScore!).toBeLessThanOrEqual(full.finalScore!);

    const withDiagnostic = score({ structuralSignals: [signal("critical-dependency", "low")] });
    const hiddenDiagnostic = score({});
    expect(withDiagnostic.finalScore).toBe(hiddenDiagnostic.finalScore);
  });

  it("serial non-dilution: a serial claim suppresses duplicate basket roles to the same upstream", () => {
    const edges: V9DependencyPlanningEdge[] = [
      {
        edgeKey: "serial:parent:child",
        upstreamAssetId: "parent",
        dependencyType: "wrapper",
        economicRole: "serial-claim",
        weight: 1,
        failureDomains: [],
      },
      {
        edgeKey: "basket:parent:child",
        upstreamAssetId: "parent",
        dependencyType: "collateral",
        economicRole: "basket-exposure",
        weight: 0.4,
        failureDomains: [],
      },
    ];
    const planningAsset = (assetId: string, assetEdges: readonly V9DependencyPlanningEdge[]) =>
      ({
        assetId,
        dependencies: { edges: assetEdges },
        reserveExposures: [],
        exitRoutes: [],
        controls: [],
        peg: { failureDomains: [] },
        supply: { failureDomains: [] },
      }) satisfies V9DependencyPlanningAsset;
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [planningAsset("child", edges), planningAsset("parent", [])],
    });
    expect(plan.serialPaths).toHaveLength(1);
    expect(plan.basketPaths).toHaveLength(0);
    expect(plan.suppressedRoles).toEqual([
      {
        assetId: "child",
        upstreamAssetId: "parent",
        selectedEdgeKey: "serial:parent:child",
        suppressedEdgeKey: "basket:parent:child",
        selectedRole: "serial-claim",
        suppressedRole: "basket-exposure",
        reason: "serial-role-dominates",
      },
    ]);
  });

  it("serial non-dilution: sibling basket exposure never dilutes a required parent cap", () => {
    const parent = compiledInput("parent", 50);
    const child = compiledInput("child", 90, { assetId: "parent", required: true, relationship: "wrapper" });
    const alone = scoreCompiledAssetSet([child, parent], V9_CANDIDATE_POLICY_V1).traces.find(
      (trace) => trace.assetId === "child",
    )!;
    expect(alone.finalScore).toBe(50);
    expect(alone.bindingCap).toMatchObject({ source: "parent", limit: 50 });

    const sibling = compiledInput("sibling", 95, { assetId: "parent", required: true, relationship: "wrapper" });
    const withSibling = scoreCompiledAssetSet([child, parent, sibling], V9_CANDIDATE_POLICY_V1).traces.find(
      (trace) => trace.assetId === "child",
    )!;
    expect(withSibling.finalScore).toBe(alone.finalScore);
    expect(withSibling.bindingCap).toEqual(alone.bindingCap);
  });

  it("no double-charged uncertainty: dual-channel expression costs exactly the stronger single channel", () => {
    const viaReason = score({ unresolved: [boundedCeilingFact("missing-reserve-composition")] });
    const viaSignal = score({ structuralSignals: [signal("critical-dependency", "high")] });
    const dual = score({
      unresolved: [boundedCeilingFact("missing-reserve-composition")],
      structuralSignals: [signal("critical-dependency", "high")],
    });
    expect(viaReason.finalScore).toBe(60);
    expect(viaSignal.finalScore).toBe(64);
    expect(dual.finalScore).toBe(Math.min(viaReason.finalScore!, viaSignal.finalScore!));
    expect(dual.caps.map((cap) => cap.kind)).toEqual(
      expect.arrayContaining(["reason:missing-reserve-composition", "signal:critical-dependency:high"]),
    );
  });
});

describe("adverse anchor re-pins — active same-input fixtures (capture-9 V0 replay features)", () => {
  const CASES: readonly {
    assetId: string;
    pillars: { backing: number; exit: number; control: number };
    pegScore: number;
    evidenceLevel: V9ScoringInput["evidenceLevel"];
    activeDepegBps: number | null;
    structuralSignals: V9StructuralSignal[];
    maxScore: number;
    exactScore?: number;
    bindingCapKind?: string;
  }[] = [
    {
      // USDD 39/F: quality 47.3066 x peg 0.962978 = 45.56, bound by mint:critical@39.
      assetId: "usdd-tron-dao-reserve",
      pillars: { backing: 39.151483999999996, exit: 72.56, control: 25 },
      pegScore: 91,
      evidenceLevel: "adequate",
      activeDepegBps: null,
      structuralSignals: [
        signal("centralized-mint", "critical"),
        signal("unsafe-backing", "high"),
        signal("critical-dependency", "high"),
      ],
      maxScore: 39,
      bindingCapKind: "signal:centralized-mint:critical",
    },
    {
      // U 32/F: raw quality 32.0753; critical caps present but non-binding.
      assetId: "u-united-stables",
      pillars: { backing: 33.93812500000001, exit: 35, control: 25 },
      pegScore: 100,
      evidenceLevel: "limited",
      activeDepegBps: null,
      structuralSignals: [signal("centralized-mint", "critical"), signal("unsafe-backing", "critical")],
      maxScore: 32,
    },
    {
      // USDai 39/F: quality 41.584, bound by mint:critical@39.
      assetId: "usdai-usd-ai",
      pillars: { backing: 41.75, exit: 53.24, control: 25 },
      pegScore: 100,
      evidenceLevel: "limited",
      activeDepegBps: null,
      structuralSignals: [signal("centralized-mint", "critical")],
      maxScore: 39,
    },
    {
      // TUSD 53/C-: quality 54.2755 x peg 0.983804 = 53.40; caps at 55+ never bind.
      assetId: "tusd-trueusd",
      pillars: { backing: 66.989875, exit: 46.37, control: 45 },
      pegScore: 96,
      evidenceLevel: "limited",
      activeDepegBps: null,
      structuralSignals: [signal("centralized-mint", "high"), signal("critical-dependency", "high")],
      maxScore: 53,
    },
    {
      // EURS 20/F: quality 34 x peg 0.583431 = 19.84 (real current 0.59 peg).
      assetId: "eurs-stasis",
      pillars: { backing: 38.75, exit: 35, control: 25 },
      pegScore: 26,
      evidenceLevel: "limited",
      activeDepegBps: null,
      structuralSignals: [signal("centralized-mint", "critical")],
      maxScore: 20,
    },
    {
      // MIM 0/F: pegScore 0 zeroes the multiplier regardless of quality.
      assetId: "mim-abracadabra",
      pillars: { backing: 49.893164, exit: 35, control: 45 },
      pegScore: 0,
      evidenceLevel: "limited",
      activeDepegBps: 2500,
      structuralSignals: [],
      maxScore: 0,
      exactScore: 0,
    },
  ];

  for (const fixture of CASES) {
    it(`keeps ${fixture.assetId} at <= ${fixture.maxScore}`, () => {
      const trace = scoreV9Input(
        scoringInput({
          assetId: fixture.assetId,
          pillars: fixture.pillars,
          pegScore: fixture.pegScore,
          evidenceLevel: fixture.evidenceLevel,
          activeDepegBps: fixture.activeDepegBps,
          structuralSignals: fixture.structuralSignals,
        }),
        V9_CANDIDATE_POLICY_V1,
      );
      expect(trace.finalScore).not.toBeNull();
      expect(trace.finalScore!).toBeLessThanOrEqual(fixture.maxScore);
      if (fixture.exactScore !== undefined) expect(trace.finalScore).toBe(fixture.exactScore);
      if (fixture.bindingCapKind) expect(trace.bindingCap?.kind).toBe(fixture.bindingCapKind);
      if (fixture.maxScore < 40) expect(trace.finalGrade).toBe("F");
    });
  }
});
