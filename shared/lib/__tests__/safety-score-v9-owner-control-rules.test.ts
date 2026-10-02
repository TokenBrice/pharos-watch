import { describe, expect, it } from "vitest";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { resolveV9StructuralCaps, scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  boundedUnknown, makeDeploymentControl as control, makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts, makeReviewedMintInput, requiredKnown,
} from "./safety-score-v9-fixtures.test-support";
import { makeV9ScoringInput } from "./safety-score-v9-score.test-support";

const policy = V9_CANDIDATE_POLICY_V1;

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
    const signals = result.structuralFailures.map((failure) => ({
      ...failure, responsibility: "measured-adverse" as const, evidence: [],
      failureDomainKeys: ["oracle:shared-pricing"],
    }));
    expect(resolveV9StructuralCaps(signals, policy)).toEqual([]);
    const weak = {
      kind: "weak-oracle-branch" as const, severity: "high" as const,
      responsibility: "measured-adverse" as const, reason: "A single external feed can impair pricing.",
      evidence: [], failureDomainKeys: ["oracle:shared-pricing"],
    };
    expect(resolveV9StructuralCaps([...signals, weak], policy).some((cap) => cap.kind === "signal:common-mode-oracle")).toBe(false);
    const scored = scoreV9Input(makeV9ScoringInput({
      pillars: { backing: 95, exit: 95, control: result.score }, structuralSignals: signals,
    }), policy);
    expect(scored.finalScore).toBeGreaterThan(59);
    expect(scored.bindingCap).toBeNull();
  });

  it.each(["single-source-or-laggy", "opaque-or-unknown"] as const)(
    "retains local and common-mode ceilings for %s", (tier) => {
      const result = evaluateV9EconomicControl(args({ oracle: {
        status: requiredKnown("oracle"), tier, liquidationBranchesApplicable: false, branches: [],
      } }));
      const signals = result.structuralFailures.map((failure) => ({
        ...failure, responsibility: "measured-adverse" as const, evidence: [],
        failureDomainKeys: ["oracle:shared-feed"],
      }));
      const independentBranchSignals = signals.map((signal) => ({
        ...signal, reason: `${signal.reason} Another reviewed branch shares this feed.`,
      }));
      expect(resolveV9StructuralCaps([...signals, ...independentBranchSignals], policy)).toContainEqual(
        expect.objectContaining({ kind: "signal:common-mode-oracle", limit: policy.policy.semantic.structural.commonModeOracleLimit }),
      );
      expect(resolveV9StructuralCaps(signals, policy)).toContainEqual(
        expect.objectContaining({ kind: `signal:weak-oracle-branch:${tier === "opaque-or-unknown" ? "critical" : "high"}` }),
      );
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
        posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-reconciliation-unknown",
        score: supervision === "prudential" ? 55 : 35,
      });
      const compromised = evaluateV9EconomicControl(args({ facts: facts([{ ...mintControl, incidentState: "active" }]),
        mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "internal-ledger", supervision }),
      }));
      expect(compromised.components.find((row) => row.kind === "mint")).toMatchObject({
        posture: "unbounded-or-compromised", score: 25,
      });
      expect(compromised.structuralFailures).toContainEqual(expect.objectContaining({
        kind: "centralized-mint", severity: "critical",
      }));
    },
  );

  it("applies disclosed issuer ledger processes to native siblings without removing single-key risk", () => {
    const evm = control("mint:evm", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      authority: { authorityKey: "authority:evm", model: "multisig", threshold: 3 },
      signerCount: 5, delaySec: null,
    });
    const backend = { ...evm, controlKey: "mint:algorand",
      authority: { authorityKey: "authority:algorand", model: "issuer-backend" as const, threshold: null },
      signerCount: null,
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
    expect(after.score).toBe(52);
    expect(after.score).toBe(before.score);
    expect(after.components.find((row) => row.kind === "mint" && row.controlKeys.includes(singleKey.controlKey)))
      .toMatchObject({ posture: "unbounded-reconciled", score: 52, binding: true });
  });

  it.each(["not-applicable", "unknown"] as const)(
    "retains recorded adverse mint facts with unresolved review and %s reconciliation", (reconciliation) => {
      const mintControl = control("mint:adverse", "mint", {
        status: boundedUnknown("control.mint-adverse"),
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
        authority: { authorityKey: "authority:adverse", model: "contract", threshold: null },
        delaySec: null,
      });
      const mint = makeReviewedMintInput(mintControl.controlKey, { reconciliation });
      const measured = evaluateV9EconomicControl(args({ facts: facts([mintControl]), mint, trackRecordMonths: 61 }));
      const unresolved = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
        mint: { ...mint, status: boundedUnknown("mint") }, trackRecordMonths: 61,
      }));
      expect(unresolved.score).toBe(measured.score);
      expect(unresolved.components.find((row) => row.kind === "mint")).toMatchObject({
        posture: reconciliation === "unknown" ? "unbounded-reconciliation-unknown" : "unbounded-or-compromised",
        score: reconciliation === "unknown" ? 44 : 35,
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
      state: "unresolved", policyRuleId: "mint", rationale: null, gapId: "gap:mint-applicability",
    };
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status }), trackRecordMonths: 61,
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({
      posture: "unbounded-or-compromised", score: 35,
    });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question" }));
  });

  it("does not award favorable mint posture from an unresolved review", () => {
    const mintControl = control("mint:bounded", "mint", { status: boundedUnknown("control.mint-bounded") });
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status: boundedUnknown("mint") }),
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ posture: "unknown", score: 45 });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));
  });

  it("retains an active mint compromise even when the aggregate review is unresolved", () => {
    const mintControl = control("mint:compromised", "mint", {
      status: boundedUnknown("control.mint-compromised"), incidentState: "active",
    });
    const result = evaluateV9EconomicControl(args({ facts: facts([mintControl]),
      mint: makeReviewedMintInput(mintControl.controlKey, { status: boundedUnknown("mint") }),
      trackRecordMonths: 61,
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({
      posture: "unbounded-or-compromised", score: 25,
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
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ posture: "unknown", score: 45 });
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
