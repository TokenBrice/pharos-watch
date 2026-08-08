import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import * as controlModule from "../safety-score-v9/control";
import {
  evaluateV9EconomicControl,
  type EvaluateV9EconomicControlArgs,
  type V9BridgeControlReview,
  type V9EconomicControlAssetFacts,
  type V9MintMechanismReview,
  type V9MintPosture,
  type V9MintReconciliation,
  type V9MintSupervision,
  type V9OracleControlReview,
} from "../safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const UNATTESTED_EOA_PENALTY =
  V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintMergedSignals.unattestedEoaPenalty;

/**
 * STAGE A pin for owner ruling R4 (2026-07-17, provisional pending the V8
 * counterfactual-matrix review): graded control posture replaces the flat 55
 * for concentrated-admin / unbounded-reconciled mints. Ruled bands:
 *
 *   prudential supervision + independent attestation + segregated custody  => 75-85
 *   attestation-only supervision + reconciled supply                       => 65-75
 *   self-reported / concentrated custodian / open legal events             => <=55
 *   any graded fact unknown                                                => current conservative value
 *     (unbounded-reconciled/concentrated-admin 55, unbounded-or-compromised 25,
 *      unknown posture 45)
 *
 * The ACTIVE table pins the conservative values and the "must NOT lift" guards
 * for TUSD-shaped and USDD-shaped fixtures — they must pass before AND after
 * Stage B. The `describe.skip` block pins the ruled grading table; it fails
 * today by construction and is enabled by Stage B.
 *
 * STAGE B SEAM (proposed contract): the current mint review input carries only
 * supervision x reconciliation. Attestation cadence, custody structure, and
 * legal-event posture have no input slot yet — see the Stage A report's
 * schema-gap note. Proposed grading entry point:
 *
 *   export interface V9MintControlPostureFacts {
 *     supervision: V9MintSupervision;
 *     reconciliation: V9MintReconciliation;
 *     attestationCadence: "independent-periodic" | "self-reported" | "unknown";
 *     custodyStructure: "segregated-diversified" | "concentrated-custodian" | "unknown";
 *     openLegalEvents: "none" | "open" | "unknown";
 *   }
 *   export function gradeV9MintControlPosture(
 *     posture: V9MintPosture,
 *     facts: V9MintControlPostureFacts,
 *   ): number
 */

interface MintControlPostureFacts {
  supervision: V9MintSupervision;
  reconciliation: V9MintReconciliation;
  attestationCadence: "independent-periodic" | "self-reported" | "unknown";
  custodyStructure: "segregated-diversified" | "concentrated-custodian" | "unknown";
  openLegalEvents: "none" | "open" | "unknown";
}

const gradeV9MintControlPosture = (controlModule as unknown as Record<string, unknown>).gradeV9MintControlPosture as
  ((posture: V9MintPosture, facts: MintControlPostureFacts) => number) | undefined;

function requiredKnown(rule = "fixture.required"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [],
  };
}

function notApplicable(rule = "fixture.not-applicable"): V9FactStatusV2 {
  return {
    applicability: {
      state: "not-applicable",
      policyRuleId: rule,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known",
    evidenceRefIds: [],
    gapIds: [],
  };
}

function mintControl(overrides: Partial<V9DeploymentControlFactV2> = {}): V9DeploymentControlFactV2 {
  return {
    controlKey: "mint:issuer-eoa",
    deploymentKey: "deployment:mint:issuer-eoa",
    sourceGenerationId: "research:fixture",
    controlKind: "mint",
    scope: "global",
    status: requiredKnown("control.mint:issuer-eoa"),
    capabilities: ["mint"],
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
    delaySec: 86_400,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "none",
    failureDomains: [{ kind: "mint-control", key: "mint:issuer-eoa" }],
    ...overrides,
  };
}

function facts(controls: readonly V9DeploymentControlFactV2[]): V9EconomicControlAssetFacts {
  return {
    assetId: "fixture-asset",
    archetype: "fiat-cash",
    controlStatus: controls.length > 0 ? requiredKnown("controls") : notApplicable("controls"),
    controls,
    supply: {
      status: requiredKnown("supply"),
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 1,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
    },
  };
}

function mintComponentScore(
  control: V9DeploymentControlFactV2,
  supervision: V9MintSupervision,
  reconciliation: V9MintReconciliation,
): { posture: V9MintPosture; score: number } {
  const noOracle: V9OracleControlReview = { status: notApplicable("oracle"), tier: null, branches: [] };
  const noBridge: V9BridgeControlReview = { status: notApplicable("bridge"), routes: [] };
  const mint: V9MintMechanismReview = {
    status: requiredKnown("mint"),
    controlKey: control.controlKey,
    reconciliation,
    supervision,
    upgrade: { state: "immutable", controlKey: null },
  };
  const args: EvaluateV9EconomicControlArgs = {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: facts([control]),
    mint,
    oracle: noOracle,
    bridge: noBridge,
  };
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

  it("keeps unreconciled/self-reported unbounded mints at 25 (USDD-shaped)", () => {
    for (const supervision of ["none", "unknown", "attestation-only"] as const) {
      const result = mintComponentScore(mintControl(), supervision, "unknown");
      expect(result.posture, supervision).toBe("unbounded-or-compromised");
      expect(result.score, supervision).toBe(25);
    }
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

describe("R4 ruled grading table — Stage B", () => {
  it("exposes the Stage B grading seam", () => {
    expect(typeof gradeV9MintControlPosture).toBe("function");
  });

  const POSTURE: V9MintPosture = "unbounded-reconciled";
  const gradedRows: readonly {
    id: string;
    facts: MintControlPostureFacts;
    min: number;
    max: number;
  }[] = [
    {
      id: "prudential + attested + segregated (top band)",
      facts: {
        supervision: "prudential",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 75,
      max: 85,
    },
    {
      id: "prudential + continuous reconciliation (top band)",
      facts: {
        supervision: "prudential",
        reconciliation: "continuous",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 75,
      max: 85,
    },
    {
      id: "attestation-only + reconciled (middle band)",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 65,
      max: 75,
    },
    {
      id: "self-reported attestation stays <=55",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "self-reported",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 0,
      max: 55,
    },
    {
      id: "TUSD-shaped: concentrated custodian must NOT lift",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "concentrated-custodian",
        openLegalEvents: "none",
      },
      min: 0,
      max: 55,
    },
    {
      id: "TUSD-shaped: open legal events must NOT lift",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "open",
      },
      min: 0,
      max: 55,
    },
    {
      id: "unknown attestation falls back to the conservative value",
      facts: {
        supervision: "prudential",
        reconciliation: "periodic",
        attestationCadence: "unknown",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 55,
      max: 55,
    },
    {
      id: "unknown custody falls back to the conservative value",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "unknown",
        openLegalEvents: "none",
      },
      min: 55,
      max: 55,
    },
    {
      id: "unknown legal events fall back to the conservative value",
      facts: {
        supervision: "attestation-only",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "unknown",
      },
      min: 55,
      max: 55,
    },
    {
      id: "unresolved supervision never grades up",
      facts: {
        supervision: "unknown",
        reconciliation: "periodic",
        attestationCadence: "independent-periodic",
        custodyStructure: "segregated-diversified",
        openLegalEvents: "none",
      },
      min: 55,
      max: 55,
    },
  ];

  for (const row of gradedRows) {
    it(`grades ${row.id} into [${row.min}, ${row.max}]`, () => {
      const score = gradeV9MintControlPosture!(POSTURE, row.facts);
      expect(score).toBeGreaterThanOrEqual(row.min);
      expect(score).toBeLessThanOrEqual(row.max);
    });
  }

  it("keeps compromised/self-reported postures at 25 regardless of graded facts (USDD-shaped)", () => {
    const benign: MintControlPostureFacts = {
      supervision: "prudential",
      reconciliation: "periodic",
      attestationCadence: "independent-periodic",
      custodyStructure: "segregated-diversified",
      openLegalEvents: "none",
    };
    expect(gradeV9MintControlPosture!("unbounded-or-compromised", benign)).toBe(25);
  });

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
