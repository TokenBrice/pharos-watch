import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2, V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
  evaluateV9EconomicControlAssetFacts,
  projectV9EconomicControlEvaluation,
  type EvaluateV9EconomicControlArgs,
  type V9BridgeControlReview,
  type V9EconomicControlAssetFacts,
  type V9EconomicControlReviewExtension,
  type V9MintMechanismReview,
  type V9MintSupervision,
  type V9OracleControlReview,
} from "../safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

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

function stale(rule = "fixture.stale"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "stale",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [`gap:${rule}`],
  };
}

function failureDomain(kind: V9FailureDomainRef["kind"], key: string): V9FailureDomainRef {
  return { kind, key };
}

function control(
  controlKey: string,
  controlKind: V9DeploymentControlFactV2["controlKind"],
  overrides: Partial<V9DeploymentControlFactV2> = {},
): V9DeploymentControlFactV2 {
  const domainKind = {
    mint: "mint-control",
    upgrade: "upgrade-control",
    custody: "reserve-custodian",
    oracle: "oracle-feed",
    bridge: "bridge-route",
    freeze: "upgrade-control",
    governance: "upgrade-control",
  } as const;
  const capability = {
    mint: "mint",
    upgrade: "upgrade",
    custody: "custody-transfer",
    oracle: "oracle-update",
    bridge: "bridge-mint",
    freeze: "freeze",
    governance: "parameter-change",
  } as const;
  return {
    controlKey,
    deploymentKey: `deployment:${controlKey}`,
    sourceGenerationId: "research:fixture",
    controlKind,
    scope: "global",
    status: requiredKnown(`control.${controlKey}`),
    capabilities: [capability[controlKind]],
    capSemantics:
      controlKind === "freeze"
        ? { kind: "not-applicable", bound: null }
        : { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } },
    claimImpairment: controlKind === "freeze" ? "none" : "bounded",
    economicLossScope: controlKind === "freeze" ? "access-only" : "global-claim",
    authority: {
      authorityKey: `authority:${controlKey}`,
      model: "multisig",
      threshold: { required: 2, total: 3 },
    },
    delaySec: 86_400,
    materialSupplyShare: null,
    incidentState: "none",
    failureDomains: [failureDomain(domainKind[controlKind], controlKey)],
    ...overrides,
  };
}

function facts(controls: readonly V9DeploymentControlFactV2[] = []): V9EconomicControlAssetFacts {
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

function noMint(): V9MintMechanismReview {
  return {
    status: notApplicable("mint"),
    controlKey: null,
    reconciliation: "not-applicable",
    supervision: "unknown",
    upgrade: { state: "not-applicable", controlKey: null },
  };
}

function boundedMint(controlKey = "mint:primary"): V9MintMechanismReview {
  return {
    status: requiredKnown("mint"),
    controlKey,
    reconciliation: "not-applicable",
    supervision: "unknown",
    upgrade: { state: "immutable", controlKey: null },
  };
}

function noOracle(): V9OracleControlReview {
  return { status: notApplicable("oracle"), tier: null, branches: [] };
}

function noBridge(): V9BridgeControlReview {
  return { status: notApplicable("bridge"), routes: [] };
}

function args(overrides: Partial<EvaluateV9EconomicControlArgs> = {}): EvaluateV9EconomicControlArgs {
  return {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: facts(),
    mint: noMint(),
    oracle: noOracle(),
    bridge: noBridge(),
    ...overrides,
  };
}

describe("Safety Score v9 economic control", () => {
  it("canonically projects normalized asset facts with an explicit review extension", () => {
    const mintControl = control("mint:z", "mint");
    const custodyControl = control("custody:a", "custody");
    const asset = facts([mintControl, custodyControl]);
    const review: V9EconomicControlReviewExtension = {
      assetId: asset.assetId,
      mint: boundedMint(mintControl.controlKey),
      oracle: noOracle(),
      bridge: noBridge(),
    };
    const projected = projectV9EconomicControlEvaluation(asset, review, V9_CANDIDATE_POLICY_V1);

    expect(projected.facts.controls.map((item) => item.controlKey)).toEqual([
      custodyControl.controlKey,
      mintControl.controlKey,
    ]);
    expect(projected.mint).toEqual(review.mint);
    expect(evaluateV9EconomicControlAssetFacts(asset, review, V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9EconomicControl(projected),
    );
    expect(() =>
      projectV9EconomicControlEvaluation(asset, { ...review, assetId: "different-asset" }, V9_CANDIDATE_POLICY_V1),
    ).toThrow(/does not match asset/);
  });

  it("distinguishes bounded, raiseable, and unknown mint-cap semantics", () => {
    const mintControl = control("mint:primary", "mint");
    const bounded = evaluateV9EconomicControl(args({ facts: facts([mintControl]), mint: boundedMint() }));
    const raiseable = evaluateV9EconomicControl(
      args({
        facts: facts([{ ...mintControl, capSemantics: { kind: "raiseable", bound: mintControl.capSemantics.bound } }]),
        mint: boundedMint(),
      }),
    );
    const unknown = evaluateV9EconomicControl(
      args({
        facts: facts([{ ...mintControl, capSemantics: { kind: "unknown", bound: null } }]),
        mint: boundedMint(),
      }),
    );

    expect(bounded).toMatchObject({ score: 85, state: "rated" });
    expect(bounded.components.find((component) => component.kind === "mint")?.posture).toBe("bounded-admin");
    expect(raiseable).toMatchObject({ score: 70, state: "rated" });
    expect(raiseable.components.find((component) => component.kind === "mint")?.posture).toBe(
      "partially-bounded-admin",
    );
    expect(unknown).toMatchObject({ score: 45, state: "rated" });
    expect(unknown.components.find((component) => component.kind === "mint")?.posture).toBe("unknown");
    expect(unknown.reasons.map((reason) => reason.code)).toContain("unknown-control-cap-authority");
    expect(unknown.reasons.every((reason) => !reason.critical)).toBe(true);
  });

  it("treats a reviewed non-claiming mint surface as not applicable", () => {
    const burnOnlyControl = control("mint:burn-only", "mint", {
      capabilities: ["burn"],
      capSemantics: { kind: "not-applicable", bound: null },
      claimImpairment: "none",
      economicLossScope: "access-only",
      authority: { authorityKey: "authority:none", model: "none", threshold: null },
    });
    const result = evaluateV9EconomicControl(
      args({ facts: facts([burnOnlyControl]), mint: boundedMint(burnOnlyControl.controlKey) }),
    );

    expect(result).toMatchObject({ score: 95, state: "rated", reasons: [] });
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "none-resolved",
      binding: false,
    });
  });

  it("keeps immutable mint administration not applicable while evaluating all CDP oracle branches", () => {
    const oracleControl = control("oracle:core", "oracle");
    const oracle: V9OracleControlReview = {
      status: requiredKnown("oracle"),
      tier: "redundant-with-failover",
      branches: ["feed", "collateral-parameter", "liquidation", "backstop", "shutdown-bad-debt"].map((branch) => ({
        branch: branch as V9OracleControlReview["branches"][number]["branch"],
        status: requiredKnown(`oracle.${branch}`),
        controlKey: oracleControl.controlKey,
        mechanismKey: "mechanism:cdp-core",
        inheritedFromAssetId: null,
      })),
    };
    const result = evaluateV9EconomicControl(
      args({
        facts: { ...facts([oracleControl]), archetype: "cdp" },
        mint: noMint(),
        oracle,
      }),
    );

    expect(result).toMatchObject({ score: 90, state: "rated", reasons: [] });
    expect(result.components.map((component) => [component.kind, component.posture])).toEqual([
      ["bridge", "single-chain-or-native"],
      ["mint", "none-resolved"],
      ["oracle", "redundant-with-failover"],
    ]);
  });

  it("emits a traceable structural failure for an unbounded or compromised mint path", () => {
    const mintControl = control("mint:hot-wallet", "mint", {
      authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl]),
        mint: boundedMint(mintControl.controlKey),
      }),
    );

    expect(result).toMatchObject({ score: 25, state: "rated", reasons: [] });
    expect(result.structuralFailures).toContainEqual(
      expect.objectContaining({
        kind: "centralized-mint",
        severity: "critical",
        binding: true,
        controlKeys: [mintControl.controlKey],
        failureDomains: [{ kind: "mint-control", key: mintControl.controlKey }],
      }),
    );
  });

  it("graduates a reconciled unbounded mint by prudential-supervision evidence", () => {
    const mintControl = control("mint:hot-wallet", "mint", {
      authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
    });
    const reconciledMint = (supervision: V9MintSupervision): V9MintMechanismReview => ({
      status: requiredKnown("mint"),
      controlKey: mintControl.controlKey,
      reconciliation: "periodic",
      supervision,
      upgrade: { state: "immutable", controlKey: null },
    });
    const resultFor = (supervision: V9MintSupervision) =>
      evaluateV9EconomicControl(args({ facts: facts([mintControl]), mint: reconciledMint(supervision) }));
    const severityFor = (supervision: V9MintSupervision) =>
      resultFor(supervision).structuralFailures.find((failure) => failure.kind === "centralized-mint");

    // The reconciled unbounded mint is its own posture, scored at 55 (not the
    // 25 unbounded-or-compromised rung), so the ruled tier ceilings are reachable.
    const unknownResult = resultFor("unknown");
    expect(unknownResult.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 55,
    });

    // Inertness proof: default/unknown supervision keeps today's "high" rung and reason.
    expect(severityFor("unknown")).toMatchObject({
      severity: "high",
      reason: "Minting is economically unbounded but supply is reconciled against reserves.",
    });
    expect(severityFor("attestation-only")).toMatchObject({ severity: "high" });
    expect(severityFor("none")).toMatchObject({ severity: "high" });

    // A reviewed prudential-supervision fact graduates one further rung to moderate.
    expect(severityFor("prudential")).toMatchObject({
      severity: "moderate",
      reason: "Minting is economically unbounded but reconciled and prudentially supervised.",
    });
  });

  it("keeps a compromised mint critical regardless of prudential supervision", () => {
    const mintControl = control("mint:compromised", "mint", {
      authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      incidentState: "active",
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl]),
        mint: {
          status: requiredKnown("mint"),
          controlKey: mintControl.controlKey,
          reconciliation: "continuous",
          supervision: "prudential",
          upgrade: { state: "immutable", controlKey: null },
        },
      }),
    );

    expect(result.structuralFailures).toContainEqual(
      expect.objectContaining({ kind: "centralized-mint", severity: "critical" }),
    );
    // A compromised mint stays at the unbounded-or-compromised rung (score 25)
    // even though its reconciliation is continuous and supervision prudential.
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-or-compromised",
      score: 25,
    });
  });

  it("bounds a stale material control with a non-critical reason instead of failing closed", () => {
    const staleMintControl = control("mint:stale", "mint", { status: stale("mint-control") });
    const result = evaluateV9EconomicControl(
      args({ facts: facts([staleMintControl]), mint: boundedMint(staleMintControl.controlKey) }),
    );

    expect(result).toMatchObject({ score: 85, state: "rated" });
    const staleReason = result.reasons.find((reason) => reason.code === "unresolved-mint-authority");
    expect(staleReason).toBeDefined();
    expect(staleReason?.critical).toBe(false);
  });

  it("surfaces an unreviewed mint-critical upgrade path structurally", () => {
    const mintControl = control("mint:upgradeable", "mint");
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl]),
        mint: {
          ...boundedMint(mintControl.controlKey),
          upgrade: { state: "unknown", controlKey: null },
        },
      }),
    );

    expect(result).toMatchObject({ score: 85, state: "rated" });
    expect(result.reasons.map((reason) => reason.code)).toContain("unknown-upgrade-authority");
    expect(result.structuralFailures).toContainEqual(
      expect.objectContaining({
        kind: "unreviewed-upgrade",
        severity: "high",
        binding: true,
        controlKeys: [mintControl.controlKey],
      }),
    );
  });

  it("scores a fully-unverified control surface at the bounded-unknown quality", () => {
    const unresolvedStatus: V9FactStatusV2 = {
      applicability: { state: "required", policyRuleId: "fixture.unresolved", rationale: null, gapId: null },
      observationState: "bounded-unknown",
      evidenceRefIds: [],
      gapIds: [],
    };
    const result = evaluateV9EconomicControl(
      args({
        mint: {
          status: unresolvedStatus,
          controlKey: null,
          reconciliation: "unknown",
          supervision: "unknown",
          upgrade: { state: "unknown", controlKey: null },
        },
        oracle: { status: unresolvedStatus, tier: null, branches: [] },
        bridge: { status: unresolvedStatus, routes: [] },
      }),
    );

    expect(result).toMatchObject({
      score: V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality,
      state: "rated",
    });
    expect(result.components.map((component) => component.componentKey).sort()).toEqual([
      "bridge:unverified",
      "mint",
      "oracle",
    ]);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.every((reason) => !reason.critical)).toBe(true);
  });

  it("keeps a weak peripheral bridge scoped but lets a canonical route bind", () => {
    const bridgeControl = control("bridge:edge", "bridge", {
      scope: "deployment",
      materialSupplyShare: 0.05,
      economicLossScope: "deployment",
    });
    const bridgeReview: V9BridgeControlReview = {
      status: requiredKnown("bridge"),
      routes: [{ controlKey: bridgeControl.controlKey, tier: "external-lock-mint" }],
    };
    const peripheral = evaluateV9EconomicControl(args({ facts: facts([bridgeControl]), bridge: bridgeReview }));
    const canonical = evaluateV9EconomicControl(
      args({
        facts: facts([{ ...bridgeControl, economicLossScope: "global-claim" }]),
        bridge: bridgeReview,
      }),
    );

    expect(peripheral.score).toBe(95);
    expect(peripheral.components.find((component) => component.kind === "bridge")).toMatchObject({
      score: 45,
      binding: false,
    });
    expect(peripheral.structuralFailures).toContainEqual(
      expect.objectContaining({ kind: "peripheral-bridge", binding: false }),
    );
    expect(canonical.score).toBe(45);
    expect(canonical.structuralFailures).toContainEqual(
      expect.objectContaining({ kind: "material-bridge", binding: true }),
    );
  });

  it("does not treat individual freeze capability as economic loss by itself", () => {
    const freezeControl = control("freeze:individual", "freeze", {
      incidentState: "active",
      authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
    });
    const baseline = evaluateV9EconomicControl(args());
    const categoricalOnly = evaluateV9EconomicControl(args({ facts: facts([freezeControl]) }));
    const systemic = evaluateV9EconomicControl(
      args({
        facts: facts([
          {
            ...freezeControl,
            capabilities: ["freeze", "custody-transfer"],
            capSemantics: { kind: "unbounded", bound: null },
            claimImpairment: "unbounded",
            economicLossScope: "global-claim",
          },
        ]),
      }),
    );

    expect(categoricalOnly.score).toBe(baseline.score);
    expect(categoricalOnly.reasons).toEqual([]);
    expect(categoricalOnly.structuralFailures).toEqual([]);
    expect(systemic.structuralFailures).toContainEqual(
      expect.objectContaining({ kind: "active-control-incident", binding: true }),
    );
  });

  it("preserves binding custody failure domains for cross-pillar correlation", () => {
    const custodyControl = control("custody:primary", "custody");
    const result = evaluateV9EconomicControl(args({ facts: facts([custodyControl]) }));

    expect(result).toMatchObject({ score: 95, state: "rated" });
    expect(result.failureDomains).toContainEqual({
      kind: "reserve-custodian",
      key: custodyControl.controlKey,
    });
  });

  it("normalizes output order independently of control insertion order", () => {
    const mintControl = control("mint:z", "mint");
    const custodyControl = control("custody:a", "custody");
    const left = evaluateV9EconomicControl(
      args({ facts: facts([mintControl, custodyControl]), mint: boundedMint(mintControl.controlKey) }),
    );
    const right = evaluateV9EconomicControl(
      args({ facts: facts([custodyControl, mintControl]), mint: boundedMint(mintControl.controlKey) }),
    );

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});
