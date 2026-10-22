import { describe, expect, it } from "vitest";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import {
  boundedUnknown, makeDeploymentControl as control, makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts, makeReviewedMintInput, requiredKnown,
  makeOperationalIssuanceProcess, makeCompiledVotingControl,
} from "./safety-score-v9-fixtures.test-support";


describe("owner Control rules", () => {
  it("prices privileged pricing in Control without a local or shared-oracle ceiling", () => {
    const result = evaluateV9EconomicControl(args({ oracle: {
      status: requiredKnown("oracle"), tier: "privileged-internal-pricing",
      liquidationBranchesApplicable: false, branches: [],
    } }));
    expect(result).toMatchObject({ score: 45, state: "rated", reasons: [] });
    expect(result.components.find((row) => row.kind === "oracle")).toMatchObject({
      posture: "privileged-internal-pricing", score: 45, binding: true,
    });
  });

  it("prices a reviewed savings-rate setter once on the authority ladder, not at oracle 45", () => {
    const ref = "authority:savings-governor";
    const setter = control("mint:savings-rate", "mint", {
      authority: { authorityKey: ref, model: "contract", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      issuanceGovernance: {
        coverage: "complete", incompleteReasons: [], governorAuthorityKey: ref,
        decisionRule: "affirmative-vote", minUnavoidableDelaySec: 172800,
        votingPower: "past-block-checkpoint", vetoQuorumBps: null, vetoOverride: null,
        enumerable: true, nonGovernorUnboundedPathKeys: [],
        votingControl: makeCompiledVotingControl(), diagnostics: [],
      },
    });
    const mint = makeReviewedMintInput(setter.controlKey);
    const oracle = {
      status: requiredKnown("savings-rate"), tier: "privileged-internal-pricing" as const,
      pricingKind: "savings-rate" as const, liquidationBranchesApplicable: false, branches: [],
    };
    const result = evaluateV9EconomicControl(args({ facts: facts([setter]), mint, oracle }));
    expect(result).toMatchObject({ score: 75, oracleApplicability: "not-applicable" });
    expect(result.components.filter((row) => row.kind === "oracle")).toEqual([]);
    expect(result.components.filter((row) => row.kind === "mint")).toEqual([
      expect.objectContaining({ score: 75, controlKeys: [setter.controlKey] }),
    ]);
    expect(evaluateV9EconomicControl(args({ facts: facts([{ ...setter, issuanceGovernance: undefined }]),
      mint, oracle })).score).toBe(60);
    expect(evaluateV9EconomicControl(args({ facts: facts([{ ...setter, issuanceGovernance: {
      ...setter.issuanceGovernance!, minUnavoidableDelaySec: 0, nonGovernorUnboundedPathKeys: ["bypass"],
    } }]), mint, oracle })).score).toBe(60);
  });

  it("does not infer immutable savings-rate authority from an absent setter review", () => {
    const result = evaluateV9EconomicControl(args({ oracle: {
      status: requiredKnown("savings-rate"), tier: "privileged-internal-pricing",
      pricingKind: "savings-rate", liquidationBranchesApplicable: false, branches: [],
    } }));
    expect(result).toMatchObject({ score: 60, oracleApplicability: "not-applicable" });
    expect(result.components).toContainEqual(expect.objectContaining({
      componentKey: "mint:savings-rate", kind: "mint", score: 60, cause: "U",
    }));
    expect(result.components.some((row) => row.kind === "oracle")).toBe(false);
  });

  it("retains the oracle gap when a savings-rate classification is not currently admitted", () => {
    const result = evaluateV9EconomicControl(args({ oracle: {
      status: boundedUnknown("savings-rate"), tier: "privileged-internal-pricing",
      pricingKind: "savings-rate", liquidationBranchesApplicable: false, branches: [],
    } }));
    expect(result.oracleApplicability).toBe("required");
    expect(result.components).toContainEqual(expect.objectContaining({ kind: "oracle", score: 60, cause: "U" }));
  });

  it.each(["contract", "governance"] as const)(
    "does not infer governance credit from a %s authority label or recorded delay", (model) => {
      const row = control("mint:unproved-governor", "mint", {
        authority: { authorityKey: "authority:unproved", model, threshold: null },
        delaySec: 172800,
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      });
      expect(evaluateV9EconomicControl(args({ facts: facts([row]),
        mint: makeReviewedMintInput(row.controlKey) })).score).toBe(60);
    },
  );


  it.each(["prudential", "none"] as const)(
    "separates a disclosed internal mint ledger from reserve assurance under %s supervision", (supervision) => {
      const mintControl = control("mint:issuer", "mint", {
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
        authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
        delaySec: null,
      });
      const before = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
        mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "unknown", supervision }),
      }));
      const after = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
        mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "internal-ledger", supervision }),
      }));
      expect(before.reasons).toContainEqual(expect.objectContaining({
        code: "mint-control-question", path: "mint:reconciliation",
      }));
      expect(after.reasons.some((row) => row.code === "mint-control-question")).toBe(false);
      expect(after.score).toBe(before.score);
      expect(after.components.find((row) => row.kind === "mint")).toMatchObject({
        posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-adverse",
        score: supervision === "prudential" ? 75 : 60,
      });
      const compromised = evaluateV9EconomicControl(args({ facts: facts([{ ...mintControl, incidentState: "active" }]),
        mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "internal-ledger", supervision }),
      }));
      expect(compromised.components.find((row) => row.kind === "mint")).toMatchObject({
        posture: "compromised", score: 25,
      });
      expect(compromised.structuralFailures).toContainEqual(expect.objectContaining({
        kind: "centralized-mint", severity: "critical",
      }));
    },
  );

  it("applies disclosed issuer ledger processes to native siblings without removing single-key risk", () => {
    const evm = control("mint:evm", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      authority: { authorityKey: "authority:evm", model: "multisig", threshold: { required: 3, total: 5 } },
      delaySec: null,
    });
    const backend = { ...evm, controlKey: "mint:algorand",
      authority: { authorityKey: "authority:algorand", model: "issuer-backend" as const, threshold: null },
    };
    const singleKey = { ...backend, controlKey: "mint:xrpl",
      authority: { authorityKey: "authority:xrpl", model: "eoa" as const, threshold: null },
    };
    const controls = facts([evm, backend, singleKey]);
    const before = evaluateV9EconomicControl(args({ facts: controls,
      mint: makeReviewedMintInput(evm.controlKey, { reconciliation: "unknown", supervision: "prudential" }),
    }));
    expect(before.reasons).toContainEqual(expect.objectContaining({
      code: "mint-control-question", controlKey: backend.controlKey,
    }));
    const after = evaluateV9EconomicControl(args({ facts: controls,
      mint: makeReviewedMintInput(evm.controlKey, { reconciliation: "internal-ledger", supervision: "prudential" }),
    }));
    expect(after.reasons.some((row) => row.code === "mint-control-question")).toBe(false);
    expect(after.score).toBe(65);
    expect(after.score).toBe(before.score);
    expect(after.components.find((row) => row.kind === "mint" && row.controlKeys.includes(singleKey.controlKey)))
      .toMatchObject({ posture: "unbounded-reconciled", score: 65, binding: true });
  });

  it.each(["not-applicable", "none", "unknown", "internal-ledger"] as const)(
    "retains recorded adverse mint facts with unresolved review and %s reconciliation", (reconciliation) => {
      const mintControl = control("mint:adverse", "mint", {
        status: boundedUnknown("control.mint-adverse"),
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
        authority: { authorityKey: "authority:adverse", model: "contract", threshold: null },
        delaySec: null,
      });
      const mint = makeReviewedMintInput(mintControl.controlKey, { reconciliation });
      const measured = evaluateV9EconomicControl(args({ facts: facts([mintControl]), mint }));
      const unresolved = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
        mint: { ...mint, status: boundedUnknown("mint") },
      }));
      expect(unresolved.score).toBe(measured.score);
      expect(unresolved.components.find((row) => row.kind === "mint")).toMatchObject({
        posture: "unbounded-adverse",
        score: 60,
      });
      expect(unresolved.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));
      expect(unresolved.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high" }));
    },
  );

  it("retains recorded adverse minting while applicability remains unresolved", () => {
    const mintControl = control("mint:applicability-gap", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      authority: { authorityKey: "authority:adverse", model: "contract", threshold: null }, delaySec: null,
    });
    const status = requiredKnown("mint");
    status.applicability = {
      state: "unresolved", policyRuleId: "mint", rationale: "Mint applicability has not been reviewed.", gapId: "gap:mint-applicability",
    };
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status }),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({
      posture: "unbounded-adverse", score: 60,
    });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question" }));
  });

  it("retains verified quorum facts when the wider mint review is unresolved", () => {
    const mintControl = control("mint:bounded", "mint", { status: boundedUnknown("control.mint-bounded") });
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status: boundedUnknown("mint") }),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ score: 65 });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));
  });

  it("retains an active mint compromise even when the aggregate review is unresolved", () => {
    const mintControl = control("mint:compromised", "mint", {
      status: boundedUnknown("control.mint-compromised"), incidentState: "active",
    });
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status: boundedUnknown("mint") }),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({
      posture: "compromised", score: 25,
    });
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({
      kind: "centralized-mint", severity: "critical",
    }));
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));
  });

  it("does not manufacture an adverse posture from unknown control semantics", () => {
    const mintControl = control("mint:unknown", "mint", {
      status: boundedUnknown("control.mint-unknown"),
      capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown",
    });
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status: boundedUnknown("mint") }),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ posture: "unknown", score: 65 });
    expect(result.structuralFailures.some((failure) => failure.kind === "centralized-mint")).toBe(false);
  });

  it("requires positive reviewed control changes to clear the adverse posture", () => {
    const mintControl = control("mint:cleared", "mint");
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ posture: "bounded-admin" });
    expect(result.score).toBeGreaterThan(45);
    expect(result.structuralFailures.some((failure) => failure.kind === "centralized-mint")).toBe(false);
  });
});

describe("owner H bounded-stock closure", () => {
  it("keeps downstream accounting trust as a disclosed note, not an extra H Mint gate", () => {
    const ref = "ethereum:0x1234567890123456789012345678901234567890";
    const process = makeOperationalIssuanceProcess({ diagnostics: [{
      code: "external-accounting-trust", gate: "H4", controlRef: ref, pathId: "finite-stock",
      classId: null, memberRef: ref, field: "external-accounting", evidenceRefIds: ["stock-proof"],
    }] });
    const minter = control("mint:bounded-delegation", "mint", {
      authority: { authorityKey: ref, model: "governance", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", issuanceProcess: process,
      issuanceGovernance: { coverage: "complete", incompleteReasons: [], governorAuthorityKey: ref,
        decisionRule: "affirmative-vote", minUnavoidableDelaySec: 0, votingPower: "lock-escrowed",
        vetoQuorumBps: null, vetoOverride: null, enumerable: true, nonGovernorUnboundedPathKeys: ["operational#interest"],
        votingControl: makeCompiledVotingControl({ largestSingleControllerShareBps: 10000 }), diagnostics: [] },
    });
    const mint = makeReviewedMintInput(minter.controlKey, { reconciliation: "none", supervision: "none" });
    const positive = evaluateV9EconomicControl(args({ facts: facts([minter]), mint }));
    expect(positive.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score: 60 });
    expect(positive.processDiagnostics).toEqual([]);
    expect(positive.controlFacts![0]!.issuanceProcess?.diagnostics[0]?.code).toBe("external-accounting-trust");
    const failed = { ...minter, issuanceProcess: { ...process, otherClassesQualified: false } };
    const negative = evaluateV9EconomicControl(args({ facts: facts([failed]), mint }));
    expect(negative.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-adverse", score: 60 });
    expect(negative.processDiagnostics).toContainEqual(expect.objectContaining({ gate: "H4", code: "economic-reach-unclosed" }));
  });
});
