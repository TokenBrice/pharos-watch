import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import type { V9Severity } from "../../types/safety-score-v9";
import {
  evaluateV9EconomicControl,
  type V9MintMechanismReview,
  type V9MintSupervision,
} from "../safety-score-v9/control";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  makeDeploymentControl,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts,
  makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";

/**
 * STAGE A pin for owner ruling R3 (2026-07-17, provisional pending the V8
 * counterfactual-matrix review; supersedes owner-decisions-2026-07-15
 * Batch3#1). Ruled centralized-mint ladder for economically unbounded mints:
 *
 *   prudential supervision + reconciled   -> NO centralized-mint cap
 *                                            (risk priced in the control pillar, R4)
 *   attestation-only + reconciled         -> cap 83 (permits USDT A-, not A; R1)
 *   opaque / unreconciled (no incident)   -> high@59 (MINT-SOFTEN 2026-07-21:
 *                                            heavy control-pillar penalty, not a
 *                                            critical composite floor)
 *   active mint compromise                -> critical@39 (unchanged)
 *   supervision none/unknown + reconciled -> high@59 (fail-closed, unchanged)
 *
 * The suites below pin both the retained fail-closed rungs and the shipped
 * policy/engine behavior for the ruled reconciled-mint cases.
 */

/** An economically unbounded issuer mint path (hot-wallet class). */
function unboundedMintControl(controlKey = "mint:issuer-eoa"): V9DeploymentControlFactV2 {
  return makeDeploymentControl(controlKey, "mint", {
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    authority: { authorityKey: `authority:${controlKey}`, model: "eoa", threshold: null },
  });
}

function mintReview(
  controlKey: string,
  supervision: V9MintSupervision,
  reconciliation: V9MintMechanismReview["reconciliation"],
): V9MintMechanismReview {
  return makeReviewedMintInput(controlKey, { reconciliation, supervision });
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

describe("R3 kept rungs — active fail-closed baseline", () => {
  it("drops opaque/unreconciled unbounded mints to the high rung when there is no active incident", () => {
    // RULED 2026-07-21 (MINT-SOFTEN, supersedes the critical rung of the
    // 2026-07-20 R3 baseline for the no-incident case): an unbounded mint with no
    // active compromise incident is a heavy control-pillar penalty (posture still
    // scores 25) but no longer hard-caps the composite at the critical floor; it
    // takes the high rung so the asset lands on its pillar blend. Prudential
    // supervision still clears the cap entirely; only an active incident (below)
    // stays critical.
    for (const reconciliation of ["not-applicable", "unknown"] as const) {
      for (const supervision of ["attestation-only", "none", "unknown"] as const) {
        expect(centralizedMintSeverity(supervision, reconciliation), `${supervision}/${reconciliation}`).toBe("high");
      }
      expect(centralizedMintSeverity("prudential", reconciliation), `prudential/${reconciliation}`).toBeNull();
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

describe("R3 ruled ladder — live policy", () => {
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
    // The cap limits the score; it does not override the policy's 83-point A
    // threshold. The real flagship can remain A- when its pre-cap score is <83.
    expect(trace.finalGrade).toBe("A");
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
