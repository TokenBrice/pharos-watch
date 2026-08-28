import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
  type V9MintPosture,
  type V9MintReconciliation,
  type V9MintSupervision,
} from "../safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  makeDeploymentControl,
  makeEconomicControlArgs,
  makeEconomicControlFacts,
  makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";

const UNATTESTED_EOA_PENALTY =
  V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintMergedSignals.unattestedEoaPenalty;

function mintControl(overrides: Partial<V9DeploymentControlFactV2> = {}): V9DeploymentControlFactV2 {
  return makeDeploymentControl("mint:issuer-eoa", "mint", {
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
    failureDomains: [{ kind: "mint-control", key: "mint:issuer-eoa" }],
    ...overrides,
  });
}

function mintComponentScore(
  control: V9DeploymentControlFactV2,
  supervision: V9MintSupervision,
  reconciliation: V9MintReconciliation,
): { posture: V9MintPosture; score: number } {
  const args = makeEconomicControlArgs({
    facts: makeEconomicControlFacts([control]),
    mint: makeReviewedMintInput(control.controlKey, { reconciliation, supervision }),
  });
  const component = evaluateV9EconomicControl(args).components.find((entry) => entry.kind === "mint");
  if (!component) throw new Error("mint component missing");
  return { posture: component.posture as V9MintPosture, score: component.score };
}

describe("R4 conservative fallback — active (TUSD/USDD shapes must NOT lift)", () => {
  it("keeps unknown-posture mint control at the unknown floor (TUSD-shaped unresolved facts)", () => {
    const unknownCap = mintControl({ capSemantics: { kind: "unknown", bound: null } });
    const result = mintComponentScore(unknownCap, "attestation-only", "periodic");
    expect(result.posture).toBe("unknown");
    // 9.1: the fixture's mint key is an unattested EOA, so the merged grader's
    // key-custody penalty applies on top of the unknown floor. The pin's intent
    // is unchanged — an unresolved posture must never lift above the floor.
    expect(result.score).toBe(45 - UNATTESTED_EOA_PENALTY);
  });

  it("splits unreconciled unbounded mints by reconciliation evidence (9.32)", () => {
    // Confirmed absence of reconciliation (none / not-applicable) stays on the
    // floor. Unknown reconciliation is a distinct exposed rung at 35 — above the
    // floor, below unknown-everything (45). Prudential supervision still counts
    // as reconciled even when cadence is unknown.
    for (const reconciliation of ["none", "not-applicable"] as const) {
      for (const supervision of ["none", "unknown", "attestation-only"] as const) {
        const result = mintComponentScore(mintControl(), supervision, reconciliation);
        expect(result.posture, `${supervision}/${reconciliation}`).toBe("unbounded-or-compromised");
        expect(result.score, `${supervision}/${reconciliation}`).toBe(25);
      }
    }
    for (const supervision of ["none", "unknown", "attestation-only"] as const) {
      const result = mintComponentScore(mintControl(), supervision, "unknown");
      expect(result.posture, supervision).toBe("unbounded-reconciliation-unknown");
      // EOA key-custody penalty floors at the adverse rung (25), so 35-3 = 32.
      expect(result.score, supervision).toBe(35 - UNATTESTED_EOA_PENALTY);
    }
    const prudentialUnknown = mintComponentScore(mintControl(), "prudential", "unknown");
    expect(prudentialUnknown.posture).toBe("unbounded-reconciled");
    expect(prudentialUnknown.score).toBe(55 - UNATTESTED_EOA_PENALTY);
  });

  it("keeps unresolved-supervision reconciled mints at the flat conservative 55", () => {
    for (const supervision of ["none", "unknown"] as const) {
      const result = mintComponentScore(mintControl(), supervision, "periodic");
      expect(result.posture, supervision).toBe("unbounded-reconciled");
      expect(result.score, supervision).toBe(55 - UNATTESTED_EOA_PENALTY);
    }
  });

  it("keeps concentrated-admin at the flat conservative 55", () => {
    const concentrated = mintControl({
      capSemantics: { kind: "not-applicable", bound: null },
      claimImpairment: "bounded",
    });
    const result = mintComponentScore(concentrated, "attestation-only", "not-applicable");
    expect(result.posture).toBe("concentrated-admin");
    expect(result.score).toBe(55 - UNATTESTED_EOA_PENALTY);
  });

  it("never ranks a weaker supervision class above a stronger one for the same posture", () => {
    const scoreFor = (supervision: V9MintSupervision) =>
      mintComponentScore(mintControl(), supervision, "periodic").score;
    expect(scoreFor("prudential")).toBeGreaterThanOrEqual(scoreFor("attestation-only"));
    expect(scoreFor("attestation-only")).toBeGreaterThanOrEqual(scoreFor("none"));
    expect(scoreFor("none")).toBe(scoreFor("unknown"));
  });
});

describe("R4 production grading seam", () => {
  it("grades the supervision x reconciliation slice through the existing evaluation seam", () => {
    // The matrix-verified proxy values: prudential+reconciled ~80, attestation-only+reconciled ~70.
    const prudential = mintComponentScore(mintControl(), "prudential", "periodic");
    const attestation = mintComponentScore(mintControl(), "attestation-only", "periodic");
    expect(prudential.score).toBeGreaterThanOrEqual(75);
    expect(prudential.score).toBeLessThanOrEqual(85);
    expect(attestation.score).toBeGreaterThanOrEqual(65);
    expect(attestation.score).toBeLessThanOrEqual(75);
  });
});
