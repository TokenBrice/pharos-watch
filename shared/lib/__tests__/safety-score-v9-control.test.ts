import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
  evaluateV9EconomicControlAssetFacts,
  evaluateV9SubthresholdUnresolvedBridgeJoins,
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
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts,
  makeDeploymentControl as control,
  makeReviewedMintInput,
  noBridgeReview as noBridge,
  noMintReview as noMint,
  noOracleReview as noOracle,
  requiredKnown,
  stale,
} from "./safety-score-v9-fixtures.test-support";

const CONTROL_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.control;
const MERGED_MINT_SIGNALS = CONTROL_POLICY.mintMergedSignals;
const UNATTESTED_EOA_PENALTY = MERGED_MINT_SIGNALS.unattestedEoaPenalty;
/** Fine-ladder grade for the fixtures' default timelocked 2-of-3 multisig. */
const TIMELOCKED_TWO_OF_THREE_QUALITY =
  CONTROL_POLICY.mintPostureQuality["concentrated-admin"] +
  MERGED_MINT_SIGNALS.multisigQuorumAdjustment.twoSigner +
  MERGED_MINT_SIGNALS.multisigQuorumAdjustment.majorityThresholdCredit +
  MERGED_MINT_SIGNALS.multisigQuorumAdjustment.timelockCredit;

function boundedMint(controlKey = "mint:primary"): V9MintMechanismReview {
  return makeReviewedMintInput(controlKey);
}

type NullShareDeploymentScenario = {
  controlKey: string;
  deploymentKey: string;
  status: V9DeploymentControlFactV2["status"];
  gapShare: number | null;
  includeGapRow: boolean;
  reviewedBridge: boolean;
};

function nullShareDeploymentScenario(scenario: NullShareDeploymentScenario) {
  const { controlKey, deploymentKey, gapShare, includeGapRow, reviewedBridge, status } = scenario;
  const nullShareBridge = control(controlKey, "bridge", {
    deploymentKey,
    scope: "deployment",
    economicLossScope: "deployment",
    materialSupplyShare: null,
    status,
  });
  const reviewedShare = gapShare === null ? null : 1 - gapShare;
  const gapShareValue = gapShare ?? 0;
  const selectedBridgeRoutes =
    reviewedShare === null
      ? []
      : [
          {
            deploymentRouteKey: "ethereum:0xcanonical",
            supplyUsd: reviewedShare * 100,
            supplyShare: reviewedShare,
            reviewState: "selected-reviewed" as const,
            reviewedRouteKind: "native" as const,
          },
          ...(includeGapRow
            ? [
                {
                  deploymentRouteKey: deploymentKey,
                  supplyUsd: gapShareValue * 100,
                  supplyShare: gapShareValue,
                  reviewState: "unmatched" as const,
                },
              ]
            : []),
        ];
  return {
    nullShareBridge,
    result: evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([nullShareBridge]),
          controlStatus: requiredKnown("controls"),
          supply: {
            status: requiredKnown("supply"),
            selectedBridgeRoutes,
            selectedRouteSupplyShare: reviewedShare,
            unknownRouteSupplyShare: gapShare,
            unreviewedRouteSupplyShare: gapShare === null ? null : 0,
          },
        },
        ...(reviewedBridge
          ? {
              bridge: {
                status: requiredKnown("bridge"),
                routes: [{ controlKey: nullShareBridge.controlKey, tier: "issuer-native-burn-mint" as const }],
              },
            }
          : {}),
      }),
    ),
  };
}

const NULL_SHARE_DEPLOYMENT_SCENARIOS = {
  subthreshold: {
    controlKey: "bridge:null-share-subthreshold",
    deploymentKey: "solana:gapdeployment",
    status: boundedUnknown("control.null-share-subthreshold"),
    gapShare: V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100 - 0.001,
    includeGapRow: true,
    reviewedBridge: false,
  },
  absent: {
    controlKey: "bridge:null-share-absent-row",
    deploymentKey: "solana:absentdeployment",
    status: boundedUnknown("control.null-share-absent-row"),
    gapShare: 0,
    includeGapRow: false,
    reviewedBridge: false,
  },
  material: {
    controlKey: "bridge:null-share-material",
    deploymentKey: "solana:materialdeployment",
    status: boundedUnknown("control.null-share-material"),
    gapShare: V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100 + 0.05,
    includeGapRow: true,
    reviewedBridge: false,
  },
  noPartition: {
    controlKey: "bridge:null-share-no-partition",
    deploymentKey: "solana:unpartitioned",
    status: boundedUnknown("control.null-share-no-partition"),
    gapShare: null,
    includeGapRow: false,
    reviewedBridge: false,
  },
  inventorySubthreshold: {
    controlKey: "bridge:inventory-null-share",
    deploymentKey: "solana:inventorygap",
    status: boundedUnknown("control.inventory-null-share"),
    gapShare: V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100 - 0.001,
    includeGapRow: true,
    reviewedBridge: true,
  },
  inventoryKnownSubthreshold: {
    controlKey: "bridge:inventory-known-null-share",
    deploymentKey: "solana:knowninventorygap",
    status: requiredKnown("control.inventory-known-null-share"),
    gapShare: V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100 - 0.001,
    includeGapRow: true,
    reviewedBridge: true,
  },
} satisfies Record<string, NullShareDeploymentScenario>;

type ChainLabelPoolOptions = {
  withPoolControl?: boolean;
  namedUnmatched?: { key: string; share: number; withControl?: boolean }[];
};

// Shape of an asset whose provider supply carries one pooled row of
// unrecognized chain labels (RULED D-J): a single reviewed native/controlled
// route plus the pool, optionally joined by a bounded control and by named
// unmatched chain rows.
function chainLabelPoolResult(
  assetId: string,
  poolShare: number | null,
  { withPoolControl = true, namedUnmatched = [] }: ChainLabelPoolOptions = {},
) {
  const poolKey = `unmatched-chain-label-pool:${assetId}`;
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
    deploymentKey: poolKey,
    scope: "deployment",
    economicLossScope: "deployment",
    capabilities: [],
    capSemantics: { kind: "unknown", bound: null },
    claimImpairment: "unknown",
    authority: { authorityKey: `bridge-route:${poolKey}`, model: "unknown", threshold: null },
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
  const controls = [reviewedControl, ...(poolShare !== null && withPoolControl ? [poolControl] : []), ...namedControls];
  return evaluateV9EconomicControl(
    args({
      facts: {
        ...facts(controls),
        assetId,
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
                    deploymentRouteKey: poolKey,
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
}

// Every tracked asset that carried a producer-failed
// immaterial-unrecognized-chain-pool fact in the 2026-07-29 baseline, with the
// pool share measured for it in the publication-exact replay that cleared the
// group under Safety Score v9.03.
const MEASURED_CHAIN_LABEL_POOLS = [
  { assetId: "eurc-circle", poolShare: 1.127575627983762e-7 },
  { assetId: "eurs-stasis", poolShare: 0.00023167490433921285 },
  { assetId: "frax-frax", poolShare: 0.00000247225321587023 },
  { assetId: "fusd-finchain", poolShare: 2.9977780980856436e-7 },
  { assetId: "pyusd-paypal", poolShare: 7.125766668483089e-10 },
  { assetId: "sbc-brale", poolShare: 0.004350370441887976 },
  { assetId: "tusd-trueusd", poolShare: 0.0000040954852087551855 },
  { assetId: "usbd-bima", poolShare: 0.00007350583479734122 },
  { assetId: "usdc-circle", poolShare: 0.0004388981967687535 },
  { assetId: "usdglo-glo", poolShare: 0.00871673920808645 },
  { assetId: "usdp-parallel", poolShare: 2.9347931689789586e-7 },
  { assetId: "usdt-tether", poolShare: 0.0007689831247690548 },
  { assetId: "usdy-ondo-finance", poolShare: 2.2530125252785815e-7 },
  { assetId: "xsgd-straitsx", poolShare: 0.07916180659603161 },
] as const;

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

  it("omits a not-applicable oracle instead of manufacturing a scored control", () => {
    const result = evaluateV9EconomicControl(args());

    expect(result.components.some((component) => component.kind === "oracle")).toBe(false);
    expect(result).toMatchObject({ score: 95, state: "rated", oracleApplicability: "not-applicable" });
  });

  it("scores privileged top-level pricing without requiring liquidation branches", () => {
    const result = evaluateV9EconomicControl(
      args({
        oracle: {
          status: requiredKnown("oracle"),
          tier: "privileged-internal-pricing",
          liquidationBranchesApplicable: false,
          branches: [],
        },
      }),
    );

    expect(result.components.find((component) => component.kind === "oracle")).toMatchObject({
      posture: "privileged-internal-pricing",
      score: 45,
      binding: true,
    });
    expect(result.reasons.map((reason) => reason.code)).not.toContain("missing-required-oracle-branches");
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

  it("keeps a deployment-local mint's exact share and domain separate from upgrade control", () => {
    const mintControl = control("mint:local", "mint", {
      scope: "deployment",
      economicLossScope: "deployment",
      materialSupplyShare: 0.1,
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
    });
    const upgradeControl = control("upgrade:global", "upgrade", {
      scope: "global",
      economicLossScope: "global-claim",
      materialSupplyShare: null,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl, upgradeControl]),
        mint: {
          ...boundedMint(mintControl.controlKey),
          upgrade: { state: "reviewed", controlKey: upgradeControl.controlKey },
        },
      }),
    );
    const mintFailure = result.structuralFailures.find(
      (failure) => failure.kind === "centralized-mint",
    );

    expect(mintFailure).toMatchObject({
      materialSharePct: 10,
      controlKeys: [mintControl.controlKey],
      failureDomains: [{ kind: "mint-control", key: mintControl.controlKey }],
    });
    expect(mintFailure?.controlKeys).not.toContain(upgradeControl.controlKey);
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
    // 9.1: the fixture's mint key is an unattested EOA, so every rung below
    // carries the merged grader's key-custody penalty. The R3 ordering the pin
    // guards (prudential > attestation-only > unknown/none) is unchanged.
    const unknownResult = resultFor("unknown");
    expect(unknownResult.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 55 - UNATTESTED_EOA_PENALTY,
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
      score: 80 - UNATTESTED_EOA_PENALTY,
    });
    expect(resultFor("attestation-only").components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 70 - UNATTESTED_EOA_PENALTY,
    });
  });

  describe("9.1 merged mint grader", () => {
    const boundedAdminMint = (overrides: Partial<V9DeploymentControlFactV2> = {}) =>
      control("mint:safe", "mint", {
        authority: { authorityKey: "authority:safe", model: "multisig", threshold: { required: 3, total: 5 } },
        capSemantics: { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } },
        claimImpairment: "bounded",
        delaySec: null,
        ...overrides,
      });
    const scoreOf = (mintControl: V9DeploymentControlFactV2, extra: Partial<EvaluateV9EconomicControlArgs> = {}) => {
      const result = evaluateV9EconomicControl(
        args({
          facts: facts([mintControl]),
          mint: { ...boundedMint(mintControl.controlKey), reconciliation: "not-applicable" },
          ...extra,
        }),
      );
      const component = result.components.find((entry) => entry.kind === "mint");
      if (!component) throw new Error("mint component missing");
      return component.score;
    };

    it("decays a resolved mint incident by age instead of ignoring it", () => {
      const resolved = boundedAdminMint({ incidentState: "resolved" });
      const caps = MERGED_MINT_SIGNALS.resolvedIncidentQualityCaps;
      const tiers = MERGED_MINT_SIGNALS.resolvedIncidentDecayMinMonths;
      const clean = scoreOf(boundedAdminMint());

      expect(scoreOf(resolved, { resolvedIncidentAgeMonths: 0 })).toBe(Math.min(clean, caps.recent));
      expect(scoreOf(resolved, { resolvedIncidentAgeMonths: tiers.aging })).toBe(Math.min(clean, caps.aging));
      expect(scoreOf(resolved, { resolvedIncidentAgeMonths: tiers.dated })).toBe(Math.min(clean, caps.dated));
      // An unmeasured age fails conservative onto the strictest rung.
      expect(scoreOf(resolved)).toBe(Math.min(clean, caps.recent));
      // The cap never reaches the clean-record ladder.
      expect(caps.dated).toBeLessThan(CONTROL_POLICY.mintPostureQuality["none-resolved"]);
    });

    it("leaves a clean-record mint component untouched by the incident ladder", () => {
      expect(scoreOf(boundedAdminMint({ incidentState: "none" }), { resolvedIncidentAgeMonths: 0 })).toBe(
        scoreOf(boundedAdminMint()),
      );
    });

    it("applies resolved supply-integrity history without inventing a live mint authority", () => {
      const result = evaluateV9EconomicControl(
        args({
          mint: noMint(),
          resolvedIncidentAgeMonths: 11,
        }),
      );
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "none-resolved",
        score: MERGED_MINT_SIGNALS.resolvedIncidentQualityCaps.recent,
      });
      expect(result.structuralFailures).toEqual([]);
    });

    it("waives the externally-owned-key penalty for reviewed MPC or HSM custody", () => {
      const eoaMint = (keyCustody: V9DeploymentControlFactV2["keyCustody"]) =>
        boundedAdminMint({
          authority: { authorityKey: "authority:eoa", model: "eoa", threshold: null },
          keyCustody,
        });
      const attested = scoreOf(eoaMint("mpc"));
      expect(scoreOf(eoaMint("hsm"))).toBe(attested);
      expect(scoreOf(eoaMint("unknown"))).toBe(attested - UNATTESTED_EOA_PENALTY);
    });

    it("grades multisig quorum granularity instead of a binary strong-quorum test", () => {
      const quorum = (required: number, total: number, delaySec: number | null = null) =>
        scoreOf(
          boundedAdminMint({
            authority: { authorityKey: "authority:safe", model: "multisig", threshold: { required, total } },
            delaySec,
          }),
        );
      // A single-signer Safe is strictly weaker than a two-signer one, which is
      // strictly weaker than a healthy three-of-five.
      expect(quorum(1, 3)).toBeLessThan(quorum(2, 5));
      expect(quorum(2, 5)).toBeLessThan(quorum(3, 5));
      // Unreviewed topology fails conservative, below the reviewed healthy set.
      expect(scoreOf(boundedAdminMint({ authority: { authorityKey: "a", model: "multisig", threshold: null } })))
        .toBeLessThan(quorum(3, 5));
      // Relief may cancel a penalty but never lifts a published component.
      expect(quorum(2, 3, 86_400)).toBeLessThanOrEqual(quorum(3, 5));
      expect(quorum(3, 5, 86_400)).toBe(quorum(3, 5));
      // The ladder never invents a posture worse than the adverse rung.
      expect(quorum(1, 31)).toBeGreaterThanOrEqual(CONTROL_POLICY.mintPostureQuality["unbounded-or-compromised"]);
    });

    it("applies the Safe module surface as a small modifier", () => {
      const neutral = scoreOf(boundedAdminMint({ modulesOrGuards: "unknown" }));
      expect(scoreOf(boundedAdminMint({ modulesOrGuards: "not-applicable" }))).toBe(neutral);
      expect(scoreOf(boundedAdminMint({ modulesOrGuards: "none-detected" }))).toBe(
        neutral + MERGED_MINT_SIGNALS.modulesOrGuardsAdjustment.noneDetectedCredit,
      );
      expect(scoreOf(boundedAdminMint({ modulesOrGuards: "present" }))).toBe(
        neutral - MERGED_MINT_SIGNALS.modulesOrGuardsAdjustment.presentPenalty,
      );
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

  it("derives unbounded-reconciliation-unknown for unknown cadence without prudential supervision (9.32)", () => {
    const mintControl = control("mint:unknown-recon", "mint", {
      authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl]),
        mint: {
          status: requiredKnown("mint"),
          controlKey: mintControl.controlKey,
          reconciliation: "unknown",
          supervision: "none",
          upgrade: { state: "immutable", controlKey: null },
        },
      }),
    );
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciliation-unknown",
      score: 35,
    });
    expect(result.structuralFailures.find((failure) => failure.kind === "centralized-mint")).toMatchObject({
      severity: "high",
      reason: "Minting is economically unbounded and its reconciliation is unverified.",
    });
  });

  it("derives collateral-gated posture from verified collateral-gated cap semantics (9.32)", () => {
    const mintControl = control("mint:collateral-gated", "mint", {
      authority: { authorityKey: "authority:admin", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "collateral-gated", bound: null },
      claimImpairment: "bounded",
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: facts([mintControl]),
        mint: {
          status: requiredKnown("mint"),
          controlKey: mintControl.controlKey,
          reconciliation: "not-applicable",
          supervision: "none",
          upgrade: { state: "immutable", controlKey: null },
        },
      }),
    );
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "collateral-gated",
      score: 50,
    });
    expect(result.structuralFailures.find((failure) => failure.kind === "centralized-mint")).toMatchObject({
      severity: "moderate",
      reason: "Minting is collateral-gated behind a privileged administrator surface.",
    });
  });

  it("applies adverse-rung seasoning under the 9.32 ceiling rules", () => {
    const unboundedControl = control("mint:adverse-seasoned", "mint", {
      authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      incidentState: "none",
    });
    const mintReview = (
      reconciliation: V9MintMechanismReview["reconciliation"],
      controlKey: string,
    ): V9MintMechanismReview => ({
      status: requiredKnown("mint"),
      controlKey,
      reconciliation,
      supervision: "none",
      upgrade: { state: "immutable", controlKey: null },
    });
    const mintScore = (
      controlFact: V9DeploymentControlFactV2,
      reconciliation: V9MintMechanismReview["reconciliation"],
      trackRecordMonths: number,
    ) => {
      const result = evaluateV9EconomicControl(
        args({
          facts: facts([controlFact]),
          mint: mintReview(reconciliation, controlFact.controlKey),
          trackRecordMonths,
        }),
      );
      const component = result.components.find((entry) => entry.kind === "mint");
      if (!component) throw new Error("mint component missing");
      return { posture: component.posture, score: component.score };
    };

    // Floor rung: 25+10 under the dedicated adverse ceiling 39 → 35.
    expect(mintScore(unboundedControl, "not-applicable", 61)).toMatchObject({
      posture: "unbounded-or-compromised",
      score: 35,
    });
    // Below the min-months gate: no credit.
    expect(mintScore(unboundedControl, "not-applicable", 59)).toMatchObject({
      posture: "unbounded-or-compromised",
      score: 25,
    });
    // Active compromise stays ineligible even with a long track record.
    expect(
      mintScore({ ...unboundedControl, incidentState: "active" }, "not-applicable", 61),
    ).toMatchObject({
      posture: "unbounded-or-compromised",
      score: 25,
    });
    // Unknown-reconciliation rung uses the generic next-rung-minus-one ceiling
    // (35+10 capped one under unknown 45 → 44).
    expect(mintScore(unboundedControl, "unknown", 61)).toMatchObject({
      posture: "unbounded-reconciliation-unknown",
      score: 44,
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
        controlKeys: [],
        failureDomains: [],
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

    expect(peripheral.score).toBe(100);
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
    const evaluateBridge = (
      materialSupplyShare: number | null,
      tier = "external-lock-mint",
      policy = V9_CANDIDATE_POLICY_V1,
    ) => {
      const bridgeControl = control("bridge:lock-mint", "bridge", {
        scope: "deployment",
        economicLossScope: "deployment",
        materialSupplyShare,
      });
      const result = evaluateV9EconomicControl(
        args({
          facts: facts([bridgeControl]),
          policy,
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
    const changedPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    changedPolicy.semantic.control.materialBridgeHighShareThreshold = 0.15;
    expect(
      evaluateBridge(
        0.15,
        "external-lock-mint",
        loadV9MethodologyPolicy(changedPolicy),
      ),
    ).toMatchObject({ binding: true, severity: "high" });
  });

  it("moves known adverse deployment control out of the whole-asset pillar while preserving fail-closed cases", () => {
    const mintControl = control("mint:global", "mint", {
      capSemantics: { kind: "raiseable", bound: { amount: 0.1, unit: "supply-fraction" } },
    });
    const bridgeControl = control("bridge:polygon", "bridge", {
      scope: "deployment",
      economicLossScope: "deployment",
      materialSupplyShare: 0.15,
    });
    const evaluateBridge = (tier: V9BridgeControlReview["routes"][number]["tier"], share: number | null) =>
      evaluateV9EconomicControl(
        args({
          facts: facts([mintControl, { ...bridgeControl, materialSupplyShare: share }]),
          mint: boundedMint(mintControl.controlKey),
          bridge: {
            status: requiredKnown("bridge"),
            routes: [{ controlKey: bridgeControl.controlKey, tier }],
          },
        }),
      );

    const scoped = evaluateBridge("external-lock-mint", 0.15);
    expect(scoped.score).toBe(70);
    expect(scoped.components.find((component) => component.kind === "bridge")).toMatchObject({
      score: 45,
      binding: false,
    });
    expect(scoped.structuralFailures).toContainEqual(
      expect.objectContaining({ kind: "material-bridge", binding: true, materialSharePct: 15 }),
    );

    const unknownShare = evaluateBridge("external-lock-mint", null);
    expect(unknownShare.score).toBe(45);
    expect(unknownShare.components.find((component) => component.kind === "bridge")?.binding).toBe(true);

    const nonAdverse = evaluateBridge("canonical-rollup-bridge", 0.15);
    expect(nonAdverse.score).toBe(70);
    expect(nonAdverse.components.find((component) => component.kind === "bridge")?.binding).toBe(true);
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

    expect(result).toMatchObject({ score: 100, state: "rated", reasons: [] });
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

    expect(result).toMatchObject({ score: 100, state: "rated", reasons: [] });
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
    expect(result.components.map((component) => component.componentKey)).toEqual(["bridge:native", "mint"]);
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

  it("releases a null-share deployment control whose complete partition proves its deployment subthreshold", () => {
    const { result } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.subthreshold);

    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ score: 95, state: "rated" });
  });

  it("treats a deployment absent from a complete partition as zero share for a null-share control", () => {
    const { result } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.absent);

    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ score: 95, state: "rated" });
  });

  it("keeps a null-share deployment control binding when its partition row is material", () => {
    const { result, nullShareBridge } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.material);

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "selected-bridge-route-unresolved", controlKey: nullShareBridge.controlKey }),
    ]);
  });

  it("keeps a null-share deployment control binding when no supply partition exists", () => {
    const { result, nullShareBridge } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.noPartition);

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "selected-bridge-route-unresolved", controlKey: nullShareBridge.controlKey }),
    ]);
  });

  it("releases an unresolved reviewed bridge route whose null-share deployment is proven subthreshold", () => {
    const { result } = nullShareDeploymentScenario(
      NULL_SHARE_DEPLOYMENT_SCENARIOS.inventorySubthreshold,
    );

    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ score: 100, state: "rated" });
  });

  it("releases the known null-share bridge route materiality reason when the partition proves it subthreshold", () => {
    const { result } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.inventoryKnownSubthreshold);

    expect(
      result.reasons.filter((reason) => reason.code === "runtime-bridge-materiality-unavailable"),
    ).toEqual([]);
    expect(result.components.find((component) => component.kind === "bridge")).toMatchObject({ binding: false });
  });

  it("routes an unresolved control with a fresh scoped question to the scoped-control-question ceiling", () => {
    const scopedMint = control("mint:scoped-question", "mint", {
      status: boundedUnknown("control.scoped-question"),
      scopedQuestionFresh: true,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([scopedMint]),
          controlStatus: requiredKnown("controls"),
        },
      }),
    );
    const reasonPolicy = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, "scoped-control-question");

    expect(result.reasons.map((reason) => reason.code)).toContain("scoped-control-question");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("unresolved-mint-authority");
    expect(reasonPolicy.ceiling).toEqual({ kind: "reason:scoped-control-question", limit: 69 });
  });

  it("softens the aggregate inventory reason when every unresolved control carries a fresh scoped question", () => {
    const scopedMint = control("mint:scoped-aggregate", "mint", {
      status: boundedUnknown("control.scoped-aggregate"),
      scopedQuestionFresh: true,
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([scopedMint]),
          controlStatus: boundedUnknown("controls"),
        },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("scoped-control-question");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("unresolved-control-identity");
  });

  it("keeps the hard aggregate reason when any unresolved control lacks a scoped question", () => {
    const scopedMint = control("mint:scoped-mixed", "mint", {
      status: boundedUnknown("control.scoped-mixed"),
      scopedQuestionFresh: true,
    });
    const unscopedCustody = control("custody:unscoped-mixed", "custody", {
      status: boundedUnknown("control.unscoped-mixed"),
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([scopedMint, unscopedCustody]),
          controlStatus: boundedUnknown("controls"),
        },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("unresolved-control-identity");
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
    expect(peripheral.score).toBe(100);

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

  it("clears DAI's immaterial unrecognized-chain-label pool without weakening the RULED D-J floor", () => {
    const ASSET_ID = "dai-makerdao";
    const resultFor = (poolShare: number | null, options?: ChainLabelPoolOptions) =>
      chainLabelPoolResult(ASSET_ID, poolShare, options);

    // Pool absent: no pool reason, reviewed route scores at its tier quality.
    const absent = resultFor(null);
    expect(absent.reasons).toEqual([]);
    expect(absent.score).toBe(90);

    // Pool at 9.99% without any joined control: the proof tolerates it as an
    // accepted bounded row without surfacing an unresolved producer reason.
    const smooth = resultFor(0.0999, { withPoolControl: false });
    expect(smooth.reasons).toEqual([]);
    expect(smooth.score).toBe(90);

    // Pool at exactly 10% without a joined control fails closed exactly as
    // before: the ordinary per-row join is required.
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
    // own joined subthreshold controls they pass. Shares are chosen so the
    // AGGREGATE residue also stays under the floor — 9.26 grades the sum as
    // well as each row, so a per-row assertion has to hold the sum sub-material
    // to be measuring per-row tolerance at all.
    const named = resultFor(0.07, {
      withPoolControl: false,
      namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02 }],
    });
    expect(named.reasons).toEqual([]);

    // 9.192: a named unmatched row independently below the 10% deployment
    // floor is accepted without a joined identity control, same as the
    // unrecognized-label pool. At or above the floor it still fails closed.
    const namedOpen = resultFor(0.07, {
      withPoolControl: false,
      namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02, withControl: false }],
    });
    expect(namedOpen.reasons).toEqual([]);
    const namedOpenAtFloor = resultFor(null, {
      withPoolControl: false,
      namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.1, withControl: false }],
    });
    expect(namedOpenAtFloor.reasons.map((reason) => reason.code)).toEqual(["material-bridge-supply-unmatched"]);

    // 9.26: rows that each clear the per-row tolerance still fail closed once
    // their SUM reaches the floor. The completeness proof grades every row
    // individually, so before 9.26 read the aggregate this shape proved
    // "complete" while 11.99% of supply was mapped to no reviewed route — an
    // escape that only stayed shut because the trigger was any residue at all.
    const aggregateAtFloor = resultFor(0.0999, {
      withPoolControl: false,
      namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02 }],
    });
    expect(aggregateAtFloor.reasons.map((reason) => reason.code)).toEqual(["material-bridge-supply-unmatched"]);
  });

  it.each(MEASURED_CHAIN_LABEL_POOLS)(
    "clears the measured chain-label pool for $assetId while holding the RULED D-J floor",
    ({ assetId, poolShare }) => {
      // The tolerance only applies below the common-mode floor, so every
      // measured share this group cleared with must stay strictly under it.
      // XSGD is the binding case at ~7.9%.
      expect(poolShare).toBeLessThan(V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.commonModeShareThreshold);

      // At its measured share the pool is tolerated silently: no reason, and
      // the reviewed route still scores at its tier quality.
      const measured = chainLabelPoolResult(assetId, poolShare, { withPoolControl: false });
      expect(measured.reasons).toEqual([]);
      expect(measured.score).toBe(90);

      // The same asset identity at the floor still fails closed, so the
      // clearance is bounded by materiality rather than by asset.
      const atFloor = chainLabelPoolResult(assetId, 0.1, { withPoolControl: false });
      expect(atFloor.reasons.map((reason) => reason.code)).toEqual(["material-bridge-supply-unmatched"]);
    },
  );

  it("keeps the tolerated pool from authorizing the bounded bridge fallback", () => {
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

    expect(result.reasons).toEqual([]);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
  });

  it("publishes a trace bridge residue as a diagnostic rather than the material ceiling", () => {
    // EURC's 2026-08-18 shape. Every material deployment is reviewed and the
    // only unattributed supply is $257 of a $470M inventory. The completeness
    // proof cannot clear it — the reviewed Tempo route's control is
    // bounded-unknown rather than known, which fails the per-row join — so
    // before 9.26 that trace took the material reason's 55 control-unverified
    // ceiling, and, because a ceiling-treatment reason also classifies its
    // pillar as limited evidence, the 69 evidence ceiling underneath it. The
    // residue is still published; it just scores nothing.
    const tempoControl = control("bridge:tempo", "bridge", {
      deploymentKey: "tempo:0xtempo",
      scope: "deployment",
      economicLossScope: "deployment",
      materialSupplyShare: 0.00002,
      status: boundedUnknown("control.tempo"),
    });
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts([tempoControl]),
          supply: {
            status: requiredKnown("supply"),
            selectedBridgeRoutes: [
              {
                deploymentRouteKey: "ethereum:native",
                supplyUsd: 99_997,
                supplyShare: 0.99997,
                reviewState: "selected-reviewed",
                reviewedRouteKind: "native",
              },
              {
                deploymentRouteKey: tempoControl.deploymentKey,
                supplyUsd: 2,
                supplyShare: 0.00002,
                reviewState: "selected-reviewed",
                reviewedRouteKind: "controlled",
              },
              {
                deploymentRouteKey: "unmatched-chain:fixture-asset:icp",
                supplyUsd: 1,
                supplyShare: 0.00001,
                reviewState: "unmatched",
              },
            ],
            selectedRouteSupplyShare: 0.99999,
            unknownRouteSupplyShare: 0.00001,
            unreviewedRouteSupplyShare: 0,
          },
        },
        bridge: {
          status: requiredKnown("bridge"),
          routes: [{ controlKey: tempoControl.controlKey, tier: "external-validated-network" as const }],
        },
      }),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain("nonmaterial-bridge-supply-unmatched");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("material-bridge-supply-unmatched");

    // ODR-D5a: the same proof, asked directly, must name the row that failed
    // rather than returning a bare boolean.
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
      {
        ...facts([tempoControl]),
        supply: {
          status: requiredKnown("supply"),
          selectedBridgeRoutes: [
            {
              deploymentRouteKey: "ethereum:native",
              supplyUsd: 99_997,
              supplyShare: 0.99997,
              reviewState: "selected-reviewed",
              reviewedRouteKind: "native",
            },
            {
              deploymentRouteKey: tempoControl.deploymentKey,
              supplyUsd: 2,
              supplyShare: 0.00002,
              reviewState: "selected-reviewed",
              reviewedRouteKind: "controlled",
            },
            {
              deploymentRouteKey: "unmatched-chain:fixture-asset:icp",
              supplyUsd: 1,
              supplyShare: 0.00001,
              reviewState: "unmatched",
            },
          ],
          selectedRouteSupplyShare: 0.99999,
          unknownRouteSupplyShare: 0.00001,
          unreviewedRouteSupplyShare: 0,
        },
      },
      [tempoControl],
      [{ controlKey: tempoControl.controlKey, tier: "external-validated-network" as const }],
      materiality.deploymentMaterialSharePct / 100,
      materiality.commonModeShareThreshold,
    );
    expect(join.complete).toBe(false);
    expect(join.cause).toEqual({
      code: "reviewed-row-control-unproven",
      deploymentRouteKey: "tempo:0xtempo",
      reviewState: "selected-reviewed",
      reviewedRouteKind: "controlled",
      supplyShare: 0.00002,
      controlKeys: [tempoControl.controlKey],
    });
  });

  it("proves a clean sub-threshold bridge join and names no failing row", () => {
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
      {
        ...facts(),
        supply: {
          status: requiredKnown("supply"),
          selectedBridgeRoutes: [
            {
              deploymentRouteKey: "ethereum:native",
              supplyUsd: 100_000,
              supplyShare: 1,
              reviewState: "selected-reviewed",
              reviewedRouteKind: "native",
            },
          ],
          selectedRouteSupplyShare: 1,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
        },
      },
      [],
      [],
      materiality.deploymentMaterialSharePct / 100,
      materiality.commonModeShareThreshold,
    );
    expect(join).toEqual({ complete: true, cause: null });
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
      // Default authority is a timelocked 2/3 multisig. 9.1 grades it on the fine
      // quorum ladder (concentrated rung + two-signer penalty + majority and
      // timelock relief) instead of jumping a whole rung on a binary test.
      const result = evaluateV9EconomicControl(
        args({ facts: materialityGappedBridgeFacts(), bridge: knownBridge }),
      );

      expect(result.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
      const bridgeFallback = result.components.find((component) => component.componentKey === "bridge:unverified");
      expect(bridgeFallback).toMatchObject({ binding: true, score: TIMELOCKED_TWO_OF_THREE_QUALITY });
      expect(bridgeFallback?.score).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
      expect(bridgeFallback?.controlKeys).toEqual(["bridge:materiality-gap"]);
      // Pillar grades on the real facts, not the flat 45 default.
      expect(result.score).toBe(TIMELOCKED_TWO_OF_THREE_QUALITY);
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
