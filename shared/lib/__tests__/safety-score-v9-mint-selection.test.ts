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
  it.each(["not-applicable", "none", "unknown", "internal-ledger"] as const)(
    "does not let a qualified 55/60/70 native row hide an adverse path with %s reconciliation", (reconciliation) => {
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
      const governed = { ...operational, issuanceProcess: undefined, issuanceGovernance: {
        ...operational.issuanceGovernance!, minUnavoidableDelaySec: 172800, nonGovernorUnboundedPathKeys: [],
      } };
      const vetoGuarded = { ...governed, issuanceGovernance: { ...governed.issuanceGovernance,
        decisionRule: "minority-veto" as const, minUnavoidableDelaySec: 1209600, vetoQuorumBps: 200, vetoOverride: "none" as const,
      } };
      const discretionary = { ...operational, controlKey: "mint:council", issuanceProcess: undefined, issuanceGovernance: undefined };
      const bridge = control("bridge:external", "bridge", { capabilities: ["mint", "bridge-mint"],
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded" });
      for (const [qualified, posture, score] of [
        [operational, "unbounded-operationally-governed", 55],
        [governed, "unbounded-governed", 60],
        [vetoGuarded, "unbounded-veto-guarded", 70],
      ] as const) {
        const mint = makeReviewedMintInput(qualified.controlKey, { reconciliation, supervision: "none" });
        const positive = evaluateV9EconomicControl(args({ facts: facts([qualified, bridge]), mint }));
        expect(positive.components.find((component) => component.kind === "mint")).toMatchObject({ posture, score });
        for (const controls of [[qualified, discretionary, bridge], [bridge, discretionary, qualified]]) {
          const result = evaluateV9EconomicControl(args({ facts: facts(controls), mint }));
          expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
            posture: "unbounded-adverse", score: 25, controlKeys: [discretionary.controlKey],
          });
          expect(result.structuralFailures).toContainEqual(expect.objectContaining({
            kind: "centralized-mint", severity: "high", controlKeys: [discretionary.controlKey],
          }));
        }
      }
    },
  );

  it("keeps adverse native ties canonical and prefers binding global rows over deployment-local ties", () => {
    const first = control("mint:a", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const second = { ...first, controlKey: "mint:z" };
    const local = { ...first, controlKey: "mint:0-local", scope: "deployment" as const,
      economicLossScope: "deployment" as const, materialSupplyShare: 0.03 };
    for (const controls of [[first, second, local], [local, second, first]]) {
      const result = evaluateV9EconomicControl(args({ facts: facts(controls),
        mint: makeReviewedMintInput(second.controlKey, { reconciliation: "unknown", supervision: "none" }),
      }));
      expect(result.components.find((component) => component.componentKey === "mint")).toMatchObject({
        posture: "unbounded-adverse", score: 25, binding: true, controlKeys: [first.controlKey],
      });
      expect(result.components).toContainEqual(expect.objectContaining({
        componentKey: `mint:deployment:${local.controlKey}`, binding: false, controlKeys: [local.controlKey],
      }));
    }
  });
});
