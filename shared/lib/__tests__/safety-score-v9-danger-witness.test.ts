import { describe, expect, it } from "vitest";
import type { V9StructuralSignal } from "../../types/safety-score-v9";
import { deriveV9ReserveLossSignal, scoreV9Input } from "../safety-score-v9/formula";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 as policy } from "../safety-score-v9/policy";
import { propagateV9SerialParentAdverseAttribution, scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import {
  makeV9Pillar as pillar,
  makeV9ProductionScoreInput as productionInput,
  makeV9ScoringInput as scoringInput,
} from "./safety-score-v9-score.test-support";
import { compileNativeV3FactSet, coreFixture, evaluateV9FactSet } from "./safety-score-v9-facts.fixture-support";
import type { V9AssetFactsV2 } from "./safety-score-v9-facts.fixture-support";

const primaryEvidence = {
  sourceId: "evidence:reviewed-mint-authority",
  observedAt: "1970-01-01T00:15:00.000Z",
  publishedAt: "1970-01-01T00:15:10.000Z",
  url: "https://explorer.example/address/issuer#code",
};

function mintSignal(evidence: V9StructuralSignal["evidence"] = []): V9StructuralSignal {
  return {
    kind: "centralized-mint", severity: "high",
    reason: "Reviewed authority has unbounded claim-impairing issuance.",
    responsibility: "measured-adverse", economicLossScope: "global-claim",
    pricedInPillar: "control", failureDomainKeys: ["mint:issuer"], evidence,
  };
}

const lowPillars = { backing: 35, exit: 35, control: 25 };

describe("source-bound F danger witnesses", () => {
  it.each(["high", "critical"] as const)("retains an unreferenced %s mint fact but withholds its F", (severity) => {
    const input = scoringInput({ pillars: lowPillars, structuralSignals: [{ ...mintSignal(), severity }] });
    const trace = scoreV9Input(input, policy);
    const oldPolicy = structuredClone(policy.policy);
    oldPolicy.semantic.formula.danger.requireSourceBoundDangerWitness = false;
    const previous = scoreV9Input(input, loadV9MethodologyPolicy(oldPolicy));

    expect(previous.finalGrade).toBe("F");
    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.weightedQuality).toBe(previous.weightedQuality);
    expect(trace.preCapScore).toBe(previous.preCapScore);
    expect(trace.adverseAttribution).toEqual(previous.adverseAttribution);
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({ code: "f-without-measured-adverse" }));
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
    expect(loadV9MethodologyPolicy(oldPolicy).semanticDigest).not.toBe(policy.semanticDigest);
  });

  it("keeps source-bound high mint danger despite C/U sibling limitations", () => {
    const trace = scoreV9EvaluatedAsset(productionInput({ pillars: {
      backing: pillar(35, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(35, { evidenceLevel: "limited", limitedEvidenceCauses: ["U"], causeGapIds: ["gap:exit"] }),
      control: pillar(25, { structuralSignals: [mintSignal([primaryEvidence])] }),
    } }), policy);

    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      path: "structural:centralized-mint:high", evidenceRefIds: [primaryEvidence.sourceId],
    }));
  });

  it("does not change the existing D gate for a measured weakness without an F witness", () => {
    const trace = scoreV9Input(scoringInput({
      pillars: { backing: 45, exit: 45, control: 45 }, structuralSignals: [mintSignal()],
    }), policy);
    expect(trace.finalGrade).toBe("D");
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({ path: "structural:centralized-mint:high" }));
  });

  it("does not let an unreferenced duplicate erase an independently sourced witness", () => {
    const trace = scoreV9Input(scoringInput({
      pillars: lowPillars, structuralSignals: [mintSignal([primaryEvidence]), mintSignal()],
    }), policy);
    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution).toHaveLength(1);
    expect(trace.adverseAttribution[0]!.evidenceRefIds).toEqual([primaryEvidence.sourceId]);
  });

  it.each([
    { activeDepegBps: 3_000, pegScore: 100, source: "active-depeg", pillars: { backing: 80, exit: 80, control: 80 } },
    { activeDepegBps: null, pegScore: 50, source: "peg-performance", pillars: lowPillars },
  ])("retains the admitted numeric $source witness", ({ source, ...peg }) => {
    const trace = scoreV9Input(scoringInput(peg), policy);
    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({ source }));
  });

  it.each([{ evidenceRefIds: [] }, { evidenceRefIds: ["evidence:exact-complete-exit-measurement"] }])("requires the measured Exit attribution's own references ($evidenceRefIds)", ({ evidenceRefIds }) => {
    const trace = scoreV9EvaluatedAsset(productionInput({ pillars: {
      backing: pillar(80), control: pillar(80), exit: pillar(0, { adverseAttribution: [{
        source: "pillar-score", path: "pillar:exit:route:exact:capacity",
        message: "Exact-complete same-notional measured capacity is exhausted.",
        responsibility: "measured-adverse", evidenceRefIds,
      }] }),
    } }), policy);
    expect(trace.finalGrade).toBe(evidenceRefIds.length ? "F" : "NR");
    expect(trace.adverseAttribution).toHaveLength(1);
  });

  it("preserves source-bound parent danger through multiple serial layers", () => {
    const root = scoreV9Input(scoringInput({
      pillars: lowPillars, structuralSignals: [mintSignal([primaryEvidence])],
    }), policy);
    const inherited = propagateV9SerialParentAdverseAttribution("middle",
      propagateV9SerialParentAdverseAttribution("root", root.adverseAttribution));
    const trace = scoreV9EvaluatedAsset(productionInput({ parent: {
      required: true, score: root.finalScore, propagatedReasons: [], propagatedAdverseAttribution: inherited,
    } }), policy);
    expect(trace.bindingCap?.source).toBe("parent");
    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution[0]!.evidenceRefIds).toEqual([primaryEvidence.sourceId]);
  });

  it("preserves a measured peg witness through serial-parent attribution", () => {
    const root = scoreV9Input(scoringInput({ pillars: lowPillars, pegScore: 50 }), policy);
    const trace = scoreV9EvaluatedAsset(productionInput({ parent: {
      required: true, score: root.finalScore, propagatedReasons: [],
      propagatedAdverseAttribution: propagateV9SerialParentAdverseAttribution("root", root.adverseAttribution),
    } }), policy);
    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution[0]!.measuredPegWitness).toBe(true);
  });

  it.each([false, true])("preserves reserve-loss source evidence without manufacturing it (sourced=%s)", (sourced) => {
    const evidence = sourced ? [primaryEvidence] : [];
    const signal = deriveV9ReserveLossSignal({
      exposurePct: 100, lossAbsorptionPct: 0, failureDomainKey: "reserve:measured-loss", evidence,
    }, policy);
    expect(signal.evidence).toBe(evidence);
    const trace = scoreV9Input(scoringInput({ structuralSignals: [signal] }), policy);
    expect(trace.finalGrade).toBe(sourced ? "F" : "NR");
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      path: "structural:unsafe-backing:critical",
    }));
  });

  it("projects underlying control source identities and original clocks without borrowing U process proof", () => {
    const input = coreFixture();
    const asset = input.assets.find((row) => row.assetId === "alpha")! as unknown as V9AssetFactsV2;
    asset.economicControlReview.mint.reconciliation = "unknown";
    asset.economicControlReview.mint.supervision = "unknown";
    const minter = asset.controls.find((control) => control.controlKey === "control:minter")!;
    minter.capSemantics = { kind: "unbounded", bound: null };
    minter.claimImpairment = "unbounded";
    const compiled = compileNativeV3FactSet(input);
    const evaluated = evaluateV9FactSet(compiled, policy).assets.find((row) => row.assetId === "alpha")!;
    const signal = evaluated.scoreInput.pillars.control.structuralSignals.find((row) => row.kind === "centralized-mint")!;
    expect(signal.evidence).toContainEqual(expect.objectContaining({
      sourceId: "evidence:base", observedAt: primaryEvidence.observedAt, publishedAt: primaryEvidence.publishedAt,
    }));
    expect(compiled.assets.find((row) => row.assetId === "alpha")!.economicControlReview.mint).toMatchObject({
      reconciliation: "unknown", supervision: "unknown",
      factorStatuses: { reconciliation: { observationState: "missing" }, supervision: { observationState: "missing" } },
    });
    expect(scoreV9Input(scoringInput({ pillars: lowPillars, structuralSignals: [signal] }), policy).finalGrade).toBe("F");
  });
});
