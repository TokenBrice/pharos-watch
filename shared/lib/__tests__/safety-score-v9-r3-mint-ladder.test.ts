import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import type { V9Severity } from "../../types/safety-score-v9";
import {
  evaluateV9EconomicControl,
  type EvaluateV9EconomicControlArgs,
  type V9BridgeControlReview,
  type V9EconomicControlAssetFacts,
  type V9MintMechanismReview,
  type V9MintSupervision,
  type V9OracleControlReview,
} from "../safety-score-v9/control";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

/**
 * STAGE A pin for owner ruling R3 (2026-07-17, provisional pending the V8
 * counterfactual-matrix review; supersedes owner-decisions-2026-07-15
 * Batch3#1). Ruled centralized-mint ladder for economically unbounded mints:
 *
 *   prudential supervision + reconciled   -> NO centralized-mint cap
 *                                            (risk priced in the control pillar, R4)
 *   attestation-only + reconciled         -> cap 83 (permits USDT A-, not A; R1)
 *   opaque / unreconciled / compromised   -> critical@39 (unchanged)
 *   supervision none/unknown + reconciled -> high@59 (fail-closed, unchanged)
 *
 * ACTIVE describes pin the rungs R3 keeps (they must pass before AND after the
 * Stage B engine/policy batch). The `describe.skip` block pins the ruled new
 * rungs against the LIVE candidate policy and engine entry points; it fails
 * today by construction and is enabled by Stage B (remove the `.skip`). Stage B
 * must also update the superseded pin in
 * `safety-score-v9-control.test.ts` ("graduates a reconciled unbounded mint by
 * prudential-supervision evidence", which still expects attestation-only =>
 * high and prudential => moderate).
 */

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

/** An economically unbounded issuer mint path (hot-wallet class). */
function unboundedMintControl(controlKey = "mint:issuer-eoa"): V9DeploymentControlFactV2 {
  return {
    controlKey,
    deploymentKey: `deployment:${controlKey}`,
    sourceGenerationId: "research:fixture",
    controlKind: "mint",
    scope: "global",
    status: requiredKnown(`control.${controlKey}`),
    capabilities: ["mint"],
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: `authority:${controlKey}`, model: "eoa", threshold: null },
    delaySec: 86_400,
    materialSupplyShare: null,
    incidentState: "none",
    failureDomains: [{ kind: "mint-control", key: controlKey }],
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

function mintReview(
  controlKey: string,
  supervision: V9MintSupervision,
  reconciliation: V9MintMechanismReview["reconciliation"],
): V9MintMechanismReview {
  return {
    status: requiredKnown("mint"),
    controlKey,
    reconciliation,
    supervision,
    upgrade: { state: "immutable", controlKey: null },
  };
}

function args(overrides: Partial<EvaluateV9EconomicControlArgs> = {}): EvaluateV9EconomicControlArgs {
  const noOracle: V9OracleControlReview = { status: notApplicable("oracle"), tier: null, branches: [] };
  const noBridge: V9BridgeControlReview = { status: notApplicable("bridge"), routes: [] };
  return {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: facts([]),
    mint: {
      status: notApplicable("mint"),
      controlKey: null,
      reconciliation: "not-applicable",
      supervision: "unknown",
      upgrade: { state: "not-applicable", controlKey: null },
    },
    oracle: noOracle,
    bridge: noBridge,
    ...overrides,
  };
}

function centralizedMintSeverity(
  supervision: V9MintSupervision,
  reconciliation: V9MintMechanismReview["reconciliation"],
  incidentState: V9DeploymentControlFactV2["incidentState"] = "none",
): V9Severity | null {
  const mintControl = { ...unboundedMintControl(), incidentState };
  const result = evaluateV9EconomicControl(
    args({
      facts: facts([mintControl]),
      mint: mintReview(mintControl.controlKey, supervision, reconciliation),
    }),
  );
  return result.structuralFailures.find((failure) => failure.kind === "centralized-mint")?.severity ?? null;
}

const SUPERVISIONS: readonly V9MintSupervision[] = ["prudential", "attestation-only", "none", "unknown"];

describe("R3 kept rungs — active fail-closed baseline (must hold pre- and post-Stage-B)", () => {
  it("keeps opaque/unreconciled unbounded mints critical for every supervision class", () => {
    for (const reconciliation of ["not-applicable", "unknown"] as const) {
      for (const supervision of SUPERVISIONS) {
        expect(centralizedMintSeverity(supervision, reconciliation), `${supervision}/${reconciliation}`).toBe(
          "critical",
        );
      }
    }
  });

  it("keeps a compromised mint critical regardless of supervision or reconciliation", () => {
    for (const supervision of SUPERVISIONS) {
      expect(centralizedMintSeverity(supervision, "periodic", "active"), supervision).toBe("critical");
    }
  });

  it("keeps supervision none/unknown + reconciled at the high rung (fail-closed)", () => {
    expect(centralizedMintSeverity("none", "periodic")).toBe("high");
    expect(centralizedMintSeverity("unknown", "continuous")).toBe("high");
  });

  it("keeps the policy rungs R3 does not move (moderate@74, high@59, critical@39)", () => {
    const ladder = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["centralized-mint"];
    expect(ladder.moderate).toBe(74);
    expect(ladder.high).toBe(59);
    expect(ladder.critical).toBe(39);
  });
});

// STAGE B: un-skip once the R3 policy/engine batch lands (policy
// signalLimits["centralized-mint"].low = 83; control.ts emits no failure for
// prudential+reconciled and the low rung for attestation-only+reconciled).
describe.skip("R3 ruled ladder — pending Stage B implementation", () => {
  it("emits NO centralized-mint structural failure for prudential + reconciled mints", () => {
    for (const reconciliation of ["continuous", "periodic"] as const) {
      expect(centralizedMintSeverity("prudential", reconciliation), reconciliation).toBeNull();
    }
  });

  it("drops attestation-only + reconciled mints to the low rung", () => {
    for (const reconciliation of ["continuous", "periodic"] as const) {
      expect(centralizedMintSeverity("attestation-only", reconciliation), reconciliation).toBe("low");
    }
  });

  it("sets the ruled attestation rung: policy centralized-mint low limit is 83", () => {
    expect(V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["centralized-mint"].low).toBe(83);
  });

  it("caps an attestation-only + reconciled flagship at 83 at the score level", () => {
    const trace = scoreV9Input(
      {
        assetId: "r3-attestation-flagship",
        pillars: { backing: 95, exit: 95, control: 95 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [
          {
            kind: "centralized-mint",
            severity: "low",
            reason: "Minting is economically unbounded but supply is reconciled against reserves.",
            failureDomainKeys: ["mint-control:fixture"],
            evidence: [],
          },
        ],
        unresolved: [],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.bindingCap).toMatchObject({ kind: "signal:centralized-mint:low", limit: 83 });
    expect(trace.finalScore).toBe(83);
    expect(trace.finalGrade).toBe("A-");
  });

  it("keeps the full ruled ladder ordered: uncapped > 83 > 59 > 39", () => {
    const ladder = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["centralized-mint"];
    expect(ladder.low).toBe(83);
    expect(ladder.high).toBe(59);
    expect(ladder.critical).toBe(39);
    expect(ladder.low!).toBeGreaterThan(ladder.high!);
    expect(ladder.high!).toBeGreaterThan(ladder.critical!);
  });
});
