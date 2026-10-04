import { describe, expect, it } from "vitest";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import {
  makeDeploymentControl as control,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts,
  makeReviewedMintInput,
  boundedUnknown,
  makeOperationalIssuanceProcess,
  makeCompiledVotingControl,
} from "./safety-score-v9-fixtures.test-support";

describe("V9 mint inventory selection", () => {
  it("selects the worst material path, not an immaterial linked deployment", () => {
    const base = control("mint:base", "mint", {
      scope: "deployment", economicLossScope: "deployment", materialSupplyShare: 0.0304,
    });
    const ethereum = control("mint:ethereum", "mint", {
      authority: base.authority,
      scope: "deployment", economicLossScope: "deployment", materialSupplyShare: 0.8192,
      capSemantics: { kind: "raiseable", bound: null },
    });
    for (const controls of [[base, ethereum], [ethereum, base]]) {
      const result = evaluateV9EconomicControl(args({
        facts: facts(controls), mint: makeReviewedMintInput(base.controlKey),
      }));
      const standalone = evaluateV9EconomicControl(args({
        facts: facts([ethereum]), mint: makeReviewedMintInput(ethereum.controlKey),
      }));
      expect(result.score).toBe(standalone.score);
      expect(result.components.find((row) => row.kind === "mint")).toMatchObject({
        binding: true, posture: "partially-bounded-admin", controlKeys: [ethereum.controlKey],
      });
    }
  });

  it("retains proportional pricing for proved deployment-local adverse mint", () => {
    const local = control("mint:local", "mint", {
      scope: "deployment", economicLossScope: "deployment", materialSupplyShare: 0.3,
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const root = control("mint:root", "mint");
    const result = evaluateV9EconomicControl(args({
      facts: facts([local, root]), mint: makeReviewedMintInput(local.controlKey),
    }));
    const standalone = evaluateV9EconomicControl(args({
      facts: facts([root]), mint: makeReviewedMintInput(root.controlKey),
    }));
    expect(result.score).toBe(standalone.score);
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({
      kind: "centralized-mint", binding: true, materialSharePct: 30, controlKeys: [local.controlKey],
    }));
  });

  it("does not let an unlinked unresolved material minter disappear", () => {
    const known = control("mint:known", "mint");
    const unknown = control("mint:unknown", "mint", {
      status: boundedUnknown("mint:unknown"), authority: null,
      capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown",
    });
    const result = evaluateV9EconomicControl(args({
      facts: facts([known, unknown]), mint: makeReviewedMintInput(known.controlKey),
    }));
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code: "unresolved-mint-authority", controlKey: unknown.controlKey,
    }));
    expect(result.components.find((row) => row.kind === "mint")).toMatchObject({ posture: "unknown" });
  });

  it("leaves a single deployment's score and authority attribution unchanged", () => {
    const minter = control("mint:only", "mint");
    const bridge = control("bridge:unrelated", "bridge");
    const evaluate = (controls: typeof minter[]) => evaluateV9EconomicControl(args({
      facts: facts(controls), mint: makeReviewedMintInput(minter.controlKey),
    }));
    expect(evaluate([minter, bridge]).components.find((row) => row.kind === "mint"))
      .toEqual(evaluate([minter]).components.find((row) => row.kind === "mint"));
    expect(evaluate([minter, bridge]).score).toBe(evaluate([minter]).score);
  });
});

describe("H mint inventory selection", () => {
  it("does not let a qualified operational-flow row hide a worse native chosen-recipient path", () => {
    const ref = "ethereum:0x1234567890123456789012345678901234567890";
    const operational = control("mint:operational", "mint", {
      authority: { authorityKey: ref, model: "governance", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      issuanceProcess: makeOperationalIssuanceProcess(),
      issuanceGovernance: { coverage: "complete", incompleteReasons: [], governorAuthorityKey: ref,
        decisionRule: "affirmative-vote", minUnavoidableDelaySec: 0, votingPower: "lock-escrowed",
        vetoQuorumBps: null, vetoOverride: null, enumerable: true, nonGovernorUnboundedPathKeys: ["operational#interest"],
        votingControl: makeCompiledVotingControl(), diagnostics: [] },
    });
    const mint = makeReviewedMintInput(operational.controlKey, { reconciliation: "none", supervision: "none" });
    const positive = evaluateV9EconomicControl(args({ facts: facts([operational]), mint }));
    expect(positive.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score: 55 });
    const discretionary = { ...operational, controlKey: "mint:council", issuanceProcess: undefined, issuanceGovernance: undefined };
    for (const controls of [[operational, discretionary], [discretionary, operational]]) {
      const result = evaluateV9EconomicControl(args({ facts: facts(controls), mint }));
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "unbounded-unreconciled", score: 25, controlKeys: [discretionary.controlKey],
      });
      expect(result.structuralFailures).toContainEqual(expect.objectContaining({
        kind: "centralized-mint", severity: "high", controlKeys: [discretionary.controlKey],
      }));
    }
  });
});
