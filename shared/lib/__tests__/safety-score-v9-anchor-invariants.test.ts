import { describe, expect, it } from "vitest";

import type {
  CompiledV9AssetInput,
  V9ScoringInput,
  V9StructuralSignal,
  V9UnresolvedFact,
} from "@shared/types/safety-score-v9";
import { scoreV9Input, deriveV9WindowedPegScore } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1, resolveV9ReasonTreatment } from "../safety-score-v9/policy";

import { scoreCompiledAssetSet } from "../safety-score-v9-research";
import {
  makeCompiledV9AssetInput,
  makeV9ScoringInput,
} from "./safety-score-v9-score.test-support";
import { compileNativeV3FactSet, coreFixture, evaluateV9FactSet } from "./safety-score-v9-facts.fixture-support";


function scoringInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return makeV9ScoringInput({
    assetId: "invariant-fixture",
    pillars: { backing: 90, exit: 90, control: 90 },
    ...overrides,
  });
}

function boundedFact(code: string): V9UnresolvedFact {
  const resolved = resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, code as V9UnresolvedFact["code"], "U");
  const reasonCode = code as V9UnresolvedFact["code"];
  return {
    code: reasonCode,
    reason: `fixture ${code}`,
    critical: resolved.critical,
    responsibility: "unresearched",
    cause: "U",
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

const compiledInput = (assetId: string, pillarScore: number, parent: CompiledV9AssetInput["parent"] = null) =>
  makeCompiledV9AssetInput({ assetId, pillarScore, parent, sourceKey: "fixture" });

describe("anchor-coherence invariants — active", () => {
  it("more-unknown-never-raises: bounded unknowns and structural signals never lift any score", () => {
    for (const pillars of [
      { backing: 95, exit: 95, control: 95 },
      { backing: 70, exit: 65, control: 50 },
      { backing: 45, exit: 40, control: 35 },
    ]) {
      const baseTrace = score({ pillars });
      const variants = [
        { unresolved: [boundedFact("missing-reserve-composition")] },
        { structuralSignals: [signal("critical-dependency", "high")] },
        {
          unresolved: [boundedFact("missing-reserve-composition")],
          structuralSignals: [signal("critical-dependency", "high")],
        },
        { unresolved: [boundedFact("missing-same-notional-route")] },
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

  it("serial-sibling independence: another serial child never changes a required parent cap", () => {
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

  it("serial non-dilution: an actual basket exposure cannot average away the serial parent cap", () => {
    const input = coreFixture();
    const parent = input.assets.find((asset) => asset.assetId === "gamma")!;
    parent.peg.pegScore = 10;
    const result = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    const child = result.assets.find((asset) => asset.assetId === "alpha")!;
    const evaluatedParent = result.assets.find((asset) => asset.assetId === "gamma")!;
    expect(child.dependencyInputs.basket).toEqual([
      expect.objectContaining({ upstreamAssetId: "beta", weight: 0.4 }),
    ]);
    expect(child.dependencyInputs.serial).toEqual([
      expect.objectContaining({ upstreamAssetId: "gamma", blocked: false }),
    ]);
    expect(evaluatedParent.trace.finalScore).not.toBeNull();
    expect(child.trace.bindingCap).toMatchObject({ source: "parent", limit: evaluatedParent.trace.finalScore });
    expect(child.trace.finalScore).toBe(evaluatedParent.trace.finalScore);

    const withoutBasket = structuredClone(input);
    const standalone = withoutBasket.assets.find((asset) => asset.assetId === "alpha")!;
    standalone.dependencies.edges = standalone.dependencies.edges.filter((edge) => edge.economicRole !== "basket-exposure");
    standalone.reserveExposures = standalone.reserveExposures.filter((entry) => entry.trackedAssetId === null)
      .map((entry) => ({ ...entry, weight: 1 }));
    standalone.dependencies.mappedLiveReserveWeight = 0;
    const control = evaluateV9FactSet(compileNativeV3FactSet(withoutBasket), V9_CANDIDATE_POLICY_V1)
      .assets.find((asset) => asset.assetId === "alpha")!;
    expect(control.trace.bindingCap).toEqual(child.trace.bindingCap);
    expect(control.trace.finalScore).toBe(child.trace.finalScore);
  });

  it("does not double-charge a measured structural signal through an unrelated missing-data global cap", () => {
    const viaSignal = score({ structuralSignals: [signal("critical-dependency", "high")] });
    const dual = score({
      unresolved: [boundedFact("missing-reserve-composition")],
      structuralSignals: [signal("critical-dependency", "high")],
    });
    expect(dual.finalScore).toBe(viaSignal.finalScore);
    expect(dual.caps.some((cap) => cap.kind === "reason:missing-reserve-composition")).toBe(false);
    expect(dual.bindingCap).toEqual(viaSignal.bindingCap);
  });
});

const CLOCK_SEC = 1_800_000_000;
const { pegHistoryWindowSec, pegQuietHistoryFloor } = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;

function derive(overrides: Partial<Parameters<typeof deriveV9WindowedPegScore>[0]> = {}) {
  return deriveV9WindowedPegScore({
    pegScore: 84,
    activeDepeg: false,
    lastEventAt: null,
    clockSec: CLOCK_SEC,
    windowSec: pegHistoryWindowSec,
    quietHistoryFloor: pegQuietHistoryFloor,
    ...overrides,
  });
}

describe("R5 V9-only 36-month peg-window proxy", () => {
  it("pins the matrix-verified policy bound", () => {
    expect(pegHistoryWindowSec).toBe(Math.ceil(3 * 365.25 * 86_400));
    expect(pegQuietHistoryFloor).toBe(97);
  });

  it("floors inactive legacy penalties after a null or older-than-window event", () => {
    expect(derive({ pegScore: 93, lastEventAt: null })).toBe(97);
    expect(derive({ lastEventAt: undefined })).toBe(97);
    expect(derive({ pegScore: 84, lastEventAt: CLOCK_SEC - pegHistoryWindowSec - 1 })).toBe(97);
  });

  it("uses a strict window boundary", () => {
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec })).toBe(84);
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec + 1 })).toBe(84);
  });

  it("does not manufacture evidence or disturb current adverse histories", () => {
    expect(derive({ pegScore: null })).toBeNull();
    expect(derive({ pegScore: 99 })).toBe(99);
    expect(derive({ pegScore: 0, activeDepeg: true, lastEventAt: null })).toBe(0);
    expect(derive({ pegScore: 37, activeDepeg: null, lastEventAt: null })).toBe(37);
  });

  it("rejects fractional and non-finite clocks independently of other valid inputs", () => {
    for (const clockSec of [CLOCK_SEC + 0.5, NaN, Infinity]) {
      expect(() => derive({ clockSec })).toThrow(/clockSec/);
    }
  });

  it("rejects non-positive and fractional windows", () => {
    for (const windowSec of [0, -1, 0.5, Infinity]) {
      expect(() => derive({ windowSec })).toThrow(/windowSec/);
    }
  });

  it("rejects invalid quiet floors while accepting both endpoints", () => {
    for (const quietHistoryFloor of [NaN, Infinity, -1, 101]) {
      expect(() => derive({ quietHistoryFloor })).toThrow(/quietHistoryFloor/);
    }
    expect(derive({ pegScore: 0, quietHistoryFloor: 0 })).toBe(0);
    expect(derive({ pegScore: 0, quietHistoryFloor: 100 })).toBe(100);
  });
});
