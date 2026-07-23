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
import { loadV9MethodologyPolicy, resolveV9ReasonPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

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

function boundedUnknown(rule = "fixture.bounded-unknown"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "bounded-unknown",
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

  it("surfaces a sub-material weak oracle branch as a non-binding moderate diagnostic without dragging the component", () => {
    const oracleControl = control("oracle:core", "oracle");
    const oracle: V9OracleControlReview = {
      status: requiredKnown("oracle"),
      tier: "standard-external",
      subMaterialWeakBand: "moderate",
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
        facts: { ...facts([oracleControl]), assetId: "crvusd-fixture", archetype: "cdp" },
        mint: noMint(),
        oracle,
      }),
    );

    // The oracle component keeps the material-only standard-external quality (70);
    // it is not dragged by the sub-material weak branches.
    expect(result.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "standard-external",
      score: 70,
    });
    // Exactly one weak-oracle-branch diagnostic, at moderate, with a single
    // synthetic failure domain so the common-mode multi-branch cap never fires.
    expect(result.structuralFailures.filter((failure) => failure.kind === "weak-oracle-branch")).toEqual([
      expect.objectContaining({
        kind: "weak-oracle-branch",
        severity: "moderate",
        binding: true,
        controlKeys: [],
        failureDomains: [{ kind: "oracle-feed", key: "oracle:crvusd-fixture:sub-material-weak" }],
      }),
    ]);
    // The control result itself is the min binding component (70); the moderate
    // ceiling (74) is applied downstream and stays above a healthy composite.
    expect(result.score).toBe(70);
  });

  it("still fails a material weak oracle tier closed at high (cdp-enosys-shape stays capped)", () => {
    const oracleControl = control("oracle:core", "oracle");
    const oracle: V9OracleControlReview = {
      status: requiredKnown("oracle"),
      tier: "single-source-or-laggy",
      branches: ["feed", "collateral-parameter", "liquidation", "backstop", "shutdown-bad-debt"].map((branch) => ({
        branch: branch as V9OracleControlReview["branches"][number]["branch"],
        status: requiredKnown(`oracle.${branch}`),
        controlKey: oracleControl.controlKey,
        mechanismKey: "mechanism:cdp-core",
        inheritedFromAssetId: null,
      })),
    };
    const result = evaluateV9EconomicControl(
      args({ facts: { ...facts([oracleControl]), archetype: "cdp" }, mint: noMint(), oracle }),
    );

    expect(result.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "single-source-or-laggy",
      score: 45,
    });
    expect(result.structuralFailures.filter((failure) => failure.kind === "weak-oracle-branch")).toEqual([
      expect.objectContaining({ kind: "weak-oracle-branch", severity: "high", binding: true }),
    ]);
    expect(result.score).toBe(45);
  });

  it("emits a traceable high structural failure for an unbounded mint path with no active incident", () => {
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

    // MINT-SOFTEN 2026-07-21: an unbounded mint with no active compromise
    // incident stays a heavy control-pillar penalty (posture score 25) but takes
    // the high rung, not the critical composite floor.
    expect(result).toMatchObject({ score: 25, state: "rated", reasons: [] });
    expect(result.structuralFailures).toContainEqual(
      expect.objectContaining({
        kind: "centralized-mint",
        severity: "high",
        binding: true,
        controlKeys: [mintControl.controlKey],
        failureDomains: [{ kind: "mint-control", key: mintControl.controlKey }],
      }),
    );
  });

  it("applies the R3 reconciled-mint ladder by reviewed supervision", () => {
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

    // R3/R4 keep unknown supervision conservative while grading reviewed
    // supervision inside the control pillar.
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
    expect(severityFor("attestation-only")).toMatchObject({ severity: "low" });
    expect(severityFor("none")).toMatchObject({ severity: "high" });

    expect(severityFor("prudential")).toBeUndefined();
    expect(resultFor("prudential").components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 80,
    });
    expect(resultFor("attestation-only").components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 70,
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

  it("treats a prudentially-supervised unbounded mint as reconciled without a reconciliation cadence", () => {
    const mintControl = control("mint:regulated-issuer", "mint", {
      authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
    });
    const reviewFor = (
      supervision: V9MintSupervision,
      controls: readonly V9DeploymentControlFactV2[],
    ): V9MintMechanismReview => ({
      status: requiredKnown("mint"),
      controlKey: controls[0]!.controlKey,
      reconciliation: "not-applicable",
      supervision,
      upgrade: { state: "immutable", controlKey: null },
    });
    const mintComponent = (result: ReturnType<typeof evaluateV9EconomicControl>) =>
      result.components.find((component) => component.kind === "mint");
    const centralizedMint = (result: ReturnType<typeof evaluateV9EconomicControl>) =>
      result.structuralFailures.find((failure) => failure.kind === "centralized-mint");

    // Prudential supervision by a named regulator moves an unbounded mint to
    // unbounded-reconciled and drops the critical cap even when the
    // reserve-reconciliation cadence is not-applicable. Without a cadence the
    // elevated prudential-reconciled grade is not applied, so the mint still
    // scores at the conservative unbounded-reconciled quality (55).
    const prudential = evaluateV9EconomicControl(
      args({ facts: facts([mintControl]), mint: reviewFor("prudential", [mintControl]) }),
    );
    expect(mintComponent(prudential)).toMatchObject({ posture: "unbounded-reconciled", score: 55 });
    expect(centralizedMint(prudential)).toBeUndefined();

    // The same not-applicable-reconciliation unbounded mint without prudential
    // supervision stays unbounded-or-compromised (posture score 25) but, absent
    // an active incident, takes the high rung rather than the critical floor
    // (MINT-SOFTEN 2026-07-21).
    const unsupervised = evaluateV9EconomicControl(
      args({ facts: facts([mintControl]), mint: reviewFor("none", [mintControl]) }),
    );
    expect(mintComponent(unsupervised)).toMatchObject({ posture: "unbounded-or-compromised", score: 25 });
    expect(centralizedMint(unsupervised)).toMatchObject({ severity: "high" });

    // An active mint incident stays critical even with prudential supervision,
    // because the compromise check precedes the reconciled gate.
    const compromised = evaluateV9EconomicControl(
      args({
        facts: facts([{ ...mintControl, incidentState: "active" }]),
        mint: reviewFor("prudential", [mintControl]),
      }),
    );
    expect(mintComponent(compromised)).toMatchObject({ posture: "unbounded-or-compromised", score: 25 });
    expect(centralizedMint(compromised)).toMatchObject({ severity: "critical" });
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

  it("share-bands a binding external-lock-mint material bridge by supply share", () => {
    const evaluateBridge = (materialSupplyShare: number | null, tier = "external-lock-mint") => {
      const bridgeControl = control("bridge:lock-mint", "bridge", {
        scope: "deployment",
        economicLossScope: "deployment",
        materialSupplyShare,
      });
      const result = evaluateV9EconomicControl(
        args({
          facts: facts([bridgeControl]),
          bridge: {
            status: requiredKnown("bridge"),
            routes: [{ controlKey: bridgeControl.controlKey, tier: tier as "external-lock-mint" | "opaque-or-unknown" }],
          },
        }),
      );
      return result.structuralFailures.find((failure) => failure.kind === "material-bridge");
    };

    // Just-material exposure (deployment-material floor up to <25%) is recoverable,
    // so it takes the moderate rung, mirroring the common-mode critical-dependency
    // twin's share banding rather than the former flat high.
    expect(evaluateBridge(0.15)).toMatchObject({ binding: true, severity: "moderate" });
    // Dominant exposure stays high.
    expect(evaluateBridge(0.3)).toMatchObject({ binding: true, severity: "high" });
    // An unattributed share fails closed to high.
    expect(evaluateBridge(null)).toMatchObject({ binding: true, severity: "high" });
    // Opaque topology stays critical regardless of share.
    expect(evaluateBridge(0.15, "opaque-or-unknown")).toMatchObject({ binding: true, severity: "critical" });
  });

  it("keeps unresolved access-only and below-threshold deployment controls nonbinding under a known aggregate", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const unresolvedStatus = boundedUnknown("control.peripheral");
    const accessControl = control("freeze:unresolved", "freeze", { status: unresolvedStatus });
    const peripheralBridge = control("bridge:unresolved-peripheral", "bridge", {
      scope: "deployment",
      status: unresolvedStatus,
      economicLossScope: "deployment",
      materialSupplyShare: threshold - 0.001,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([accessControl, peripheralBridge]),
          controlStatus: requiredKnown("controls"),
        },
        bridge: {
          status: requiredKnown("bridge"),
          routes: [{ controlKey: peripheralBridge.controlKey, tier: "opaque-or-unknown" }],
        },
      }),
    );

    expect(result).toMatchObject({ score: 95, state: "rated", reasons: [] });
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
    expect(result.structuralFailures).toEqual([]);
  });

  it("does not let a known material control make a subthreshold unresolved deployment bind", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const unresolvedStatus = boundedUnknown("control.peripheral-mixed");
    const knownCustody = control("custody:known-material", "custody");
    const peripheralBridge = control("bridge:unresolved-peripheral-mixed", "bridge", {
      scope: "deployment",
      status: unresolvedStatus,
      economicLossScope: "deployment",
      materialSupplyShare: threshold - 0.001,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([knownCustody, peripheralBridge]),
          controlStatus: requiredKnown("controls"),
        },
        bridge: {
          status: requiredKnown("bridge"),
          routes: [{ controlKey: peripheralBridge.controlKey, tier: "opaque-or-unknown" }],
        },
      }),
    );

    expect(result).toMatchObject({ score: 95, state: "rated", reasons: [] });
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
  });

  it("keeps unrepresented aggregate control residue fail-closed without section fallbacks", () => {
    const aggregateStatus = boundedUnknown("control.unrepresented-residue");
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([control("custody:known", "custody")]),
          controlStatus: aggregateStatus,
        },
      }),
    );
    const reasonPolicy = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "unresolved-control-identity");

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }),
    ]);
    expect(result.components.map((component) => component.componentKey)).toEqual(["bridge:native", "mint", "oracle"]);
    expect(reasonPolicy.ceiling).toEqual({ kind: "reason:unresolved-control-identity", limit: 55 });
    expect(Math.min(result.score!, reasonPolicy.ceiling!.limit)).toBe(55);
  });

  it("does not let a subthreshold unresolved row erase aggregate control residue", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const aggregateStatus = boundedUnknown("control.aggregate-residue");
    const peripheralBridge = control("bridge:unresolved-peripheral-residue", "bridge", {
      scope: "deployment",
      status: boundedUnknown("control.peripheral-residue"),
      economicLossScope: "deployment",
      materialSupplyShare: threshold - 0.001,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([control("custody:known-with-residue", "custody"), peripheralBridge]),
          controlStatus: aggregateStatus,
        },
        bridge: {
          status: requiredKnown("bridge"),
          routes: [{ controlKey: peripheralBridge.controlKey, tier: "opaque-or-unknown" }],
        },
      }),
    );
    const reasonPolicy = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "unresolved-control-identity");

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }),
    ]);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
    expect(reasonPolicy.ceiling).toEqual({ kind: "reason:unresolved-control-identity", limit: 55 });
    expect(Math.min(result.score!, reasonPolicy.ceiling!.limit)).toBe(55);
  });

  it("does not let a generic material control reason authorize an unrelated section fallback", () => {
    const unresolvedStatus = boundedUnknown("control.custody-material");
    const unresolvedCustody = control("custody:unresolved-material", "custody", {
      status: unresolvedStatus,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([unresolvedCustody]),
          controlStatus: unresolvedStatus,
        },
        bridge: noBridge(),
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("unresolved-control-identity");
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
    expect(result.score).toBe(95);
  });

  it.each([
    ["exactly threshold", V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100],
    ["above threshold", V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100 + 0.01],
    ["missing share", null],
  ])("keeps an unresolved deployment control fail-closed when its share is %s", (_label, materialSupplyShare) => {
    const unresolvedStatus = boundedUnknown("control.material");
    const materialBridge = control("bridge:unresolved-material", "bridge", {
      scope: "deployment",
      status: unresolvedStatus,
      economicLossScope: "deployment",
      materialSupplyShare,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([materialBridge]),
          controlStatus: unresolvedStatus,
        },
        bridge: {
          status: requiredKnown("bridge"),
          routes: [{ controlKey: materialBridge.controlKey, tier: "opaque-or-unknown" }],
        },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["selected-bridge-route-unresolved", "unresolved-control-identity"]),
    );
    expect(result.components).toContainEqual(
      expect.objectContaining({ componentKey: "bridge:unverified", binding: true }),
    );
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
  });

  it("keeps deployment control materiality independent from common-mode thresholds", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const materialBridge = control("bridge:separate-materiality", "bridge", {
      scope: "deployment",
      status: boundedUnknown("control.separate-materiality"),
      economicLossScope: "deployment",
      materialSupplyShare: threshold,
    });
    const input = {
      facts: { ...facts([materialBridge]), controlStatus: boundedUnknown("control.separate-materiality") },
      bridge: {
        status: requiredKnown("bridge"),
        routes: [{ controlKey: materialBridge.controlKey, tier: "opaque-or-unknown" as const }],
      },
    };
    const changedCommonModePolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    changedCommonModePolicy.semantic.materiality.commonModeHighShareThreshold = 0.2;

    expect(
      evaluateV9EconomicControl(args({ ...input, policy: loadV9MethodologyPolicy(changedCommonModePolicy) })),
    ).toEqual(evaluateV9EconomicControl(args(input)));
  });

  it("ignores below-threshold bridge review residue but fails closed at the exact threshold", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const resultFor = (unreviewedRouteSupplyShare: number, supplyStatus = requiredKnown("supply")) => {
      const unresolvedBridge = control("bridge:unresolved-residue", "bridge", {
        scope: "deployment",
        status: boundedUnknown("control.unresolved-residue"),
        economicLossScope: "deployment",
        materialSupplyShare: unreviewedRouteSupplyShare,
      });
      return evaluateV9EconomicControl(
        args({
          facts: {
            ...facts([unresolvedBridge]),
            supply: {
              ...facts().supply,
              status: supplyStatus,
              selectedBridgeRoutes: [
                {
                  deploymentRouteKey: "ethereum:native",
                  supplyUsd: 100 * (1 - unreviewedRouteSupplyShare),
                  supplyShare: 1 - unreviewedRouteSupplyShare,
                  reviewState: "selected-reviewed",
                  reviewedRouteKind: "native",
                },
                {
                  deploymentRouteKey: unresolvedBridge.deploymentKey,
                  supplyUsd: 100 * unreviewedRouteSupplyShare,
                  supplyShare: unreviewedRouteSupplyShare,
                  reviewState: "selected-unresolved",
                },
              ],
              selectedRouteSupplyShare: 1 - unreviewedRouteSupplyShare,
              unreviewedRouteSupplyShare,
            },
          },
          bridge: { status: requiredKnown("bridge"), routes: [] },
        }),
      );
    };

    const peripheral = resultFor(threshold - 0.001);
    expect(peripheral.reasons).toEqual([]);
    expect(peripheral.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
    expect(peripheral.score).toBe(95);

    const material = resultFor(threshold);
    expect(material.reasons.map((reason) => reason.code)).toContain("missing-bridge-route-rows");
    expect(material.components).toContainEqual(
      expect.objectContaining({ componentKey: "bridge:unverified", binding: true }),
    );

    const staleSupply = resultFor(threshold - 0.001, boundedUnknown("supply.stale"));
    expect(staleSupply.reasons.map((reason) => reason.code)).toContain("missing-bridge-route-rows");
    expect(staleSupply.components).toContainEqual(
      expect.objectContaining({ componentKey: "bridge:unverified", binding: true }),
    );
  });

  it("tolerates an immaterial unrecognized-chain-label pool in the bridge supply proof (RULED D-J)", () => {
    const POOL_KEY = "unmatched-chain-label-pool:fixture-asset";
    const resultFor = (
      poolShare: number | null,
      {
        withPoolControl = true,
        namedUnmatched = [],
      }: { withPoolControl?: boolean; namedUnmatched?: { key: string; share: number; withControl?: boolean }[] } = {},
    ) => {
      const namedShare = namedUnmatched.reduce((sum, row) => sum + row.share, 0);
      const reviewedShare = 1 - (poolShare ?? 0) - namedShare;
      const reviewedControl = control("bridge:reviewed-route", "bridge", {
        deploymentKey: "ethereum:0xreviewed",
        scope: "deployment",
        economicLossScope: "deployment",
        materialSupplyShare: reviewedShare,
        status: requiredKnown("control.reviewed-route"),
      });
      const poolControl = control("bridge-supply:pool", "bridge", {
        deploymentKey: POOL_KEY,
        scope: "deployment",
        economicLossScope: "deployment",
        capabilities: [],
        capSemantics: { kind: "unknown", bound: null },
        claimImpairment: "unknown",
        authority: { authorityKey: `bridge-route:${POOL_KEY}`, model: "unknown", threshold: null },
        materialSupplyShare: poolShare,
        incidentState: "unknown",
        status: boundedUnknown("control.pool"),
      });
      const namedControls = namedUnmatched
        .filter((row) => row.withControl !== false)
        .map((row, index) =>
          control(`bridge-supply:named-${index}`, "bridge", {
            deploymentKey: row.key,
            scope: "deployment",
            economicLossScope: "deployment",
            capabilities: [],
            capSemantics: { kind: "unknown", bound: null },
            claimImpairment: "unknown",
            authority: { authorityKey: `bridge-route:${row.key}`, model: "unknown", threshold: null },
            materialSupplyShare: row.share,
            incidentState: "unknown",
            status: boundedUnknown(`control.named-${index}`),
          }),
        );
      const controls = [
        reviewedControl,
        ...(poolShare !== null && withPoolControl ? [poolControl] : []),
        ...namedControls,
      ];
      return evaluateV9EconomicControl(
        args({
          facts: {
            ...facts(controls),
            supply: {
              status: requiredKnown("supply"),
              selectedBridgeRoutes: [
                {
                  deploymentRouteKey: reviewedControl.deploymentKey,
                  supplyUsd: reviewedShare * 100,
                  supplyShare: reviewedShare,
                  reviewState: "selected-reviewed",
                  reviewedRouteKind: "controlled",
                },
                ...(poolShare !== null
                  ? [
                      {
                        deploymentRouteKey: POOL_KEY,
                        supplyUsd: poolShare * 100,
                        supplyShare: poolShare,
                        reviewState: "unmatched" as const,
                      },
                    ]
                  : []),
                ...namedUnmatched.map((row) => ({
                  deploymentRouteKey: row.key,
                  supplyUsd: row.share * 100,
                  supplyShare: row.share,
                  reviewState: "unmatched" as const,
                })),
              ],
              selectedRouteSupplyShare: reviewedShare,
              unknownRouteSupplyShare: (poolShare ?? 0) + namedShare,
              unreviewedRouteSupplyShare: 0,
            },
          },
          bridge: {
            status: requiredKnown("bridge"),
            routes: [{ controlKey: reviewedControl.controlKey, tier: "issuer-native-burn-mint" as const }],
          },
        }),
      );
    };

    // Pool absent: no pool reason, reviewed route scores at its tier quality.
    const absent = resultFor(null);
    expect(absent.reasons).toEqual([]);
    expect(absent.score).toBe(90);

    // Pool at 9.99% without any joined control: the proof tolerates it as an
    // accepted bounded row and the condition stays visible as a diagnostic.
    const smooth = resultFor(0.0999, { withPoolControl: false });
    expect(smooth.reasons.map((reason) => reason.code)).toEqual(["immaterial-unrecognized-chain-pool"]);
    expect(smooth.reasons[0]).toMatchObject({ critical: false, path: "supply:unrecognized-chain-pool" });
    expect(smooth.score).toBe(90);

    // Pool at exactly 10% without a joined control fails closed exactly as
    // before: the ordinary per-row join is required and the diagnostic is not
    // emitted.
    const floor = resultFor(0.1, { withPoolControl: false });
    expect(floor.reasons.map((reason) => reason.code)).toEqual(["material-bridge-supply-unmatched"]);
    expect(floor.reasons.map((reason) => reason.code)).not.toContain("immaterial-unrecognized-chain-pool");

    // At exactly 10% the pool row is material at the RULED-D-J floor, and
    // — since D1 (2026-07-22) rebanded commonModeShareThreshold to the same
    // 10% as the pre-existing (unrelated) deploymentMaterialSharePct — the
    // joined pool control now also crosses bindingByMateriality's gate, so a
    // merely bounded-unknown control no longer discharges the row on its own;
    // it must be resolved. Below 10% neither gate fires and a joined control
    // still discharges cleanly regardless of resolution state (see `smooth`/
    // `named` above, both sub-floor).
    const floorWithControl = resultFor(0.1, { withPoolControl: true });
    expect(floorWithControl.reasons.map((reason) => reason.code)).toEqual([
      "material-bridge-supply-unmatched",
      "selected-bridge-route-unresolved",
    ]);
    expect(floorWithControl.score).toBe(90);

    // Named unmatched rows are unaffected by the pool tolerance: with their
    // own joined subthreshold controls they pass, and the pool stays
    // diagnostic.
    const named = resultFor(0.0999, {
      withPoolControl: false,
      namedUnmatched: [{ key: "unmatched-chain:fixture-asset:bsc", share: 0.02 }],
    });
    expect(named.reasons.map((reason) => reason.code)).toEqual(["immaterial-unrecognized-chain-pool"]);

    // A named unmatched row without a joined control still fails the proof.
    const namedOpen = resultFor(0.0999, {
      withPoolControl: false,
      namedUnmatched: [{ key: "unmatched-chain:fixture-asset:bsc", share: 0.02, withControl: false }],
    });
    expect(namedOpen.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["material-bridge-supply-unmatched", "immaterial-unrecognized-chain-pool"]),
    );
  });

  it("keeps the pool diagnostic from authorizing the bounded bridge fallback", () => {
    // Shape of the major-issuer cohort: every reviewed deployment is native,
    // so the bridge section contributes no component; the only unresolved
    // supply is an immaterial pool plus joined subthreshold named rows.
    const namedControl = control("bridge-supply:named-0", "bridge", {
      deploymentKey: "unmatched-chain:fixture-asset:bsc",
      scope: "deployment",
      economicLossScope: "deployment",
      capabilities: [],
      capSemantics: { kind: "unknown", bound: null },
      claimImpairment: "unknown",
      authority: { authorityKey: "bridge-route:unmatched-chain:fixture-asset:bsc", model: "unknown", threshold: null },
      materialSupplyShare: 0.02,
      incidentState: "unknown",
      status: boundedUnknown("control.named-0"),
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([namedControl]),
          supply: {
            status: requiredKnown("supply"),
            selectedBridgeRoutes: [
              {
                deploymentRouteKey: "ethereum:native",
                supplyUsd: 94,
                supplyShare: 0.94,
                reviewState: "selected-reviewed",
                reviewedRouteKind: "native",
              },
              {
                deploymentRouteKey: "unmatched-chain-label-pool:fixture-asset",
                supplyUsd: 4,
                supplyShare: 0.04,
                reviewState: "unmatched",
              },
              {
                deploymentRouteKey: "unmatched-chain:fixture-asset:bsc",
                supplyUsd: 2,
                supplyShare: 0.02,
                reviewState: "unmatched",
              },
            ],
            selectedRouteSupplyShare: 0.94,
            unknownRouteSupplyShare: 0.06,
            unreviewedRouteSupplyShare: 0,
          },
        },
        bridge: { status: requiredKnown("bridge"), routes: [] },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toEqual(["immaterial-unrecognized-chain-pool"]);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
  });

  it("rejects a required-known reviewed bridge inventory with no route joins", () => {
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts(),
          supply: {
            ...facts().supply,
            selectedBridgeRoutes: [
              {
                deploymentRouteKey: "ethereum:reviewed",
                supplyUsd: 100,
                supplyShare: 1,
                reviewState: "selected-reviewed",
              },
            ],
          },
        },
        bridge: { status: requiredKnown("bridge"), routes: [] },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("missing-bridge-route-rows");
    expect(result.components).toContainEqual(
      expect.objectContaining({ componentKey: "bridge:unverified", binding: true }),
    );
  });

  it("fails closed when a retained mixed inventory omits the reviewed route kind", () => {
    const unresolvedBridge = control("bridge:retained-unresolved", "bridge", {
      scope: "deployment",
      status: boundedUnknown("control.retained-unresolved"),
      economicLossScope: "deployment",
      materialSupplyShare: 0.09,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([unresolvedBridge]),
          supply: {
            ...facts().supply,
            selectedBridgeRoutes: [
              {
                deploymentRouteKey: "ethereum:retained-reviewed",
                supplyUsd: 91,
                supplyShare: 0.91,
                reviewState: "selected-reviewed",
              },
              {
                deploymentRouteKey: unresolvedBridge.deploymentKey,
                supplyUsd: 9,
                supplyShare: 0.09,
                reviewState: "selected-unresolved",
              },
            ],
            selectedRouteSupplyShare: 0.91,
            unreviewedRouteSupplyShare: 0.09,
          },
        },
        bridge: { status: requiredKnown("bridge"), routes: [] },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("missing-bridge-route-rows");
    expect(result.components).toContainEqual(
      expect.objectContaining({ componentKey: "bridge:unverified", binding: true }),
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

  describe("Lever 5: credits verified static control facts vs the 45 default", () => {
    // A bridge control whose authority identity is fully reviewed but whose
    // exposure share is unknown raises runtime-bridge-materiality-unavailable
    // (control.ts main loop) and, absent a bridge component, authorizes the
    // bounded bridge fallback. Its supply keeps a non-reviewed dust row so the
    // reviewed-inventory guard does not raise missing-bridge-route-rows.
    const materialityGappedBridgeFacts = (
      overrides: Partial<V9DeploymentControlFactV2> = {},
    ): V9EconomicControlAssetFacts => {
      const bridgeControl = control("bridge:materiality-gap", "bridge", {
        scope: "deployment",
        economicLossScope: "deployment",
        materialSupplyShare: null,
        ...overrides,
      });
      return {
        ...facts([bridgeControl]),
        supply: {
          status: requiredKnown("supply"),
          selectedBridgeRoutes: [
            { deploymentRouteKey: "peripheral:dust", supplyUsd: 0, supplyShare: 0, reviewState: "unmatched" },
          ],
          selectedRouteSupplyShare: 1,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
        },
      };
    };
    const knownBridge: V9BridgeControlReview = { status: requiredKnown("bridge"), routes: [] };

    it("grades a verified-authority bridge-materiality gap ABOVE the 45 default", () => {
      // Default authority is a timelocked 2/3 multisig -> partially-bounded-admin (70).
      const result = evaluateV9EconomicControl(
        args({ facts: materialityGappedBridgeFacts(), bridge: knownBridge }),
      );

      expect(result.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
      const bridgeFallback = result.components.find((component) => component.componentKey === "bridge:unverified");
      expect(bridgeFallback).toMatchObject({ binding: true, score: 70 });
      expect(bridgeFallback?.score).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
      expect(bridgeFallback?.controlKeys).toEqual(["bridge:materiality-gap"]);
      // Pillar grades on the real facts (70), not the flat 45 default.
      expect(result.score).toBe(70);
    });

    it("grades a weak verified-authority bridge-materiality gap BELOW the 45 default", () => {
      // A single externally-owned key with no timelock is a weak verified posture.
      const result = evaluateV9EconomicControl(
        args({
          facts: materialityGappedBridgeFacts({
            authority: { authorityKey: "authority:eoa", model: "eoa", threshold: null },
            delaySec: null,
          }),
          bridge: knownBridge,
        }),
      );

      const bridgeFallback = result.components.find((component) => component.componentKey === "bridge:unverified");
      expect(bridgeFallback).toMatchObject({ binding: true, score: 25 });
      expect(bridgeFallback?.score).toBeLessThan(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
      expect(result.score).toBe(25);
    });

    it("keeps the flat 45 default when the gapped control authority is NOT verified", () => {
      // Same bridge-materiality shape, but the control row is bounded-unknown
      // (unverified authority) -> genuinely unknown posture, no lift, no drop.
      const result = evaluateV9EconomicControl(
        args({
          facts: materialityGappedBridgeFacts({ status: boundedUnknown("control.unverified-materiality") }),
          bridge: knownBridge,
        }),
      );

      const bridgeFallback = result.components.find((component) => component.componentKey === "bridge:unverified");
      expect(bridgeFallback).toMatchObject({
        binding: true,
        score: V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality,
        controlKeys: [],
      });
      expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
    });
  });
});
