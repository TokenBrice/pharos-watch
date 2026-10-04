import { describe, expect, it, vi } from "vitest";
import { V9DeploymentControlFactBaseSchema, type V9DeploymentControlFactV2, type V9FactStatusV2, type V1005CompiledVotingControl, type V1005IssuanceProcess } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
  evaluateV9EconomicControlAssetFacts,
  projectV9EconomicControlEvaluation,
} from "../safety-score-v9/control";
import { evaluateV9SubthresholdUnresolvedBridgeJoins } from "../safety-score-v9/control-bridge-join";
import type {
  EvaluateV9EconomicControlArgs,
  V9BridgeControlReview,
  V9EconomicControlAssetFacts,
  V9EconomicControlReviewExtension,
  V9MintMechanismReview,
  V9MintReconciliation,
  V9MintSupervision,
  V9OracleControlReview,
} from "../safety-score-v9/control-primitives";
import { deriveV9MintPosture, isV9GovernedIssuanceQualified, isV9VetoGuardedIssuanceQualified, isV9OperationallyGovernedIssuanceQualified } from "../safety-score-v9/control-primitives";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9Input } from "../safety-score-v9/formula";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { applyMergedMintSignals, gradeVerifiedControlAuthority } from "../safety-score-v9/control-mint-grade";
import { V9CauseContributionSchema } from "../../types/safety-score-v9-causes";
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts,
  makeDeploymentControl as control,
  makeReviewedMintInput,
  makeSupplyPartition,
  noBridgeReview as noBridge,
  noMintReview as noMint,
  noOracleReview as noOracle,
  requiredKnown,
  stale,
  makeCompiledVotingControl,
  makeOperationalIssuanceProcess,
} from "./safety-score-v9-fixtures.test-support";

const CONTROL_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.control;
const SEMANTIC_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic;
const QUALIFIED_VOTING_CONTROL = makeCompiledVotingControl();
const MERGED_MINT_SIGNALS = CONTROL_POLICY.mintMergedSignals;
const UNATTESTED_EOA_PENALTY = MERGED_MINT_SIGNALS.unattestedEoaPenalty;
const RECONCILIATION_AVAILABILITY = ["not-applicable", "none", "unknown", "internal-ledger"] as const;
const RECONCILIATIONS = ["continuous", "periodic", ...RECONCILIATION_AVAILABILITY] as const;
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
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: selectedBridgeRoutes,
            selectedRouteSupplyShare: reviewedShare,
            unknownRouteSupplyShare: gapShare,
            unreviewedRouteSupplyShare: gapShare === null ? null : 0,
          }),
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
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
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
        }),
      },
      bridge: {
        status: requiredKnown("bridge"),
        routes: [{ controlKey: reviewedControl.controlKey, tier: "issuer-native-burn-mint" as const }],
      },
    }),
  );
}

// Synthetic shares test materiality independently of the asset identity.
const REPRESENTATIVE_CHAIN_LABEL_POOLS = [
  { assetId: "synthetic-a", poolShare: 1e-9 },
  { assetId: "synthetic-b", poolShare: 0.02 },
  { assetId: "synthetic-b", poolShare: 0.0999 },
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

  it("bounds a control signal rounding tail without changing in-range or defective shares", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rounded = control("mint:rounding", "mint", {
      incidentState: "active",
      materialSupplyShare: 1.0000000000000002,
    });
    const result = evaluateV9EconomicControl(
      args({ facts: facts([rounded]), mint: noMint() }),
    );

    expect(
      result.structuralFailures.find(
        (failure) => failure.kind === "active-control-incident",
      )?.materialSharePct,
    ).toBe(100);
    expect(warn).toHaveBeenCalledWith(
      "safety_score_v9_structural_signal_percentage_clamped",
      expect.objectContaining({
        assetId: "fixture-asset",
        fieldPath: "structuralSignals[*].materialSharePct",
        rawValue: rounded.materialSupplyShare! * 100,
      }),
    );
    warn.mockRestore();
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
    expect(unknown).toMatchObject({ score: 50, state: "rated" });
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
    const results = {
      unknown: resultFor("unknown"),
      "attestation-only": resultFor("attestation-only"),
      none: resultFor("none"),
      prudential: resultFor("prudential"),
    };
    const severityFor = (supervision: V9MintSupervision) =>
      results[supervision].structuralFailures.find((failure) => failure.kind === "centralized-mint");

    // R3/R4 keep unknown supervision conservative while grading reviewed
    // supervision inside the control pillar.
    // 9.1: the fixture's mint key is an unattested EOA, so every rung below
    // carries the merged grader's key-custody penalty. The R3 ordering the pin
    // guards (prudential > attestation-only > unknown/none) is unchanged.
    const unknownResult = results.unknown;
    expect(unknownResult.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 55 - UNATTESTED_EOA_PENALTY,
    });

    expect(severityFor("unknown")).toMatchObject({
      severity: "high",
    });
    expect(severityFor("attestation-only")).toMatchObject({ severity: "low" });
    expect(severityFor("none")).toMatchObject({ severity: "high" });

    expect(severityFor("prudential")).toBeUndefined();
    expect(results.prudential.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-reconciled",
      score: 80 - UNATTESTED_EOA_PENALTY,
    });
    expect(results["attestation-only"].components.find((component) => component.kind === "mint")).toMatchObject({
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
      if (!component || component.score === null) throw new Error("scored mint component missing");
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
      expect(quorum(1, 31)).toBeGreaterThanOrEqual(CONTROL_POLICY.mintPostureQuality["unbounded-adverse"]);
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
    // A compromised mint stays at the compromised rung (score 25)
    // even though its reconciliation is continuous and supervision prudential.
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "compromised",
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
    // supervision stays unbounded-adverse (posture score 25) but, absent
    // an active incident, takes the high rung rather than the critical floor
    // (MINT-SOFTEN 2026-07-21).
    const unsupervised = evaluateV9EconomicControl(
      args({ facts: facts([mintControl]), mint: reviewFor("none", [mintControl]) }),
    );
    expect(mintComponent(unsupervised)).toMatchObject({ posture: "unbounded-adverse", score: 25 });
    expect(centralizedMint(unsupervised)).toMatchObject({ severity: "high" });

    // An active mint incident stays critical even with prudential supervision,
    // because the compromise check precedes the reconciled gate.
    const compromised = evaluateV9EconomicControl(
      args({
        facts: facts([{ ...mintControl, incidentState: "active" }]),
        mint: reviewFor("prudential", [mintControl]),
      }),
    );
    expect(mintComponent(compromised)).toMatchObject({ posture: "compromised", score: 25 });
    expect(centralizedMint(compromised)).toMatchObject({ severity: "critical" });
  });

  it("prices known adverse minting independently of unknown reconciliation", () => {
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
      posture: "unbounded-adverse",
      score: 25,
    });
    expect(result.structuralFailures.find((failure) => failure.kind === "centralized-mint")).toMatchObject({
      severity: "high",
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

  it.each(RECONCILIATION_AVAILABILITY)("seasons adverse minting at 60 implementation months with %s reconciliation", (reconciliation) => {
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

    expect(mintScore(unboundedControl, reconciliation, 59)).toMatchObject({
      posture: "unbounded-adverse", score: 25,
    });
    expect(mintScore(unboundedControl, reconciliation, 60)).toMatchObject({
      posture: "unbounded-adverse", score: 35,
    });
    expect(mintScore(unboundedControl, reconciliation, 120)).toMatchObject({
      posture: "unbounded-adverse", score: 35,
    });
    const singleKey = { ...unboundedControl, authority: { authorityKey: "issuer-key", model: "eoa" as const, threshold: null } };
    expect(mintScore(singleKey, reconciliation, 59)).toMatchObject({ posture: "unbounded-adverse", score: 25 });
    expect(mintScore(singleKey, reconciliation, 60)).toMatchObject({
      posture: "unbounded-adverse", score: 35 - UNATTESTED_EOA_PENALTY,
    });
    const strongerPenalty = { ...CONTROL_POLICY, mintMergedSignals: { ...MERGED_MINT_SIGNALS, unattestedEoaPenalty: 20 } };
    expect(applyMergedMintSignals(35, singleKey, undefined, strongerPenalty)).toBe(25);
    // Compromise stays ineligible; reconciliation cannot soften its critical signal.
    expect(mintScore({ ...unboundedControl, incidentState: "active" }, reconciliation, 60)).toMatchObject({
      posture: "compromised", score: 25,
    });
  });

  // Owner rulings R3 (centralized-mint ladder) and R4 (conservative mint
  // posture fallback), merged here from their per-ruling suites: the engine
  // under test is the same one the rest of this file owns.
  describe("R3/R4 unbounded-mint rulings", () => {
    const SUPERVISIONS = ["prudential", "attestation-only", "none", "unknown"] as const;

    const unboundedMint = (overrides: Partial<V9DeploymentControlFactV2> = {}) =>
      control("mint:issuer-eoa", "mint", {
        capSemantics: { kind: "unbounded", bound: null },
        claimImpairment: "unbounded",
        economicLossScope: "global-claim",
        authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null },
        failureDomains: [{ kind: "mint-control", key: "mint:issuer-eoa" }],
        ...overrides,
      });

    const evaluateMint = (
      mintControl: V9DeploymentControlFactV2,
      supervision: V9MintSupervision,
      reconciliation: V9MintReconciliation,
    ) =>
      evaluateV9EconomicControl(
        args({
          facts: facts([mintControl]),
          mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation, supervision }),
        }),
      );

    const severityOf = (
      mintControl: V9DeploymentControlFactV2,
      supervision: V9MintSupervision,
      reconciliation: V9MintReconciliation,
    ) =>
      evaluateMint(mintControl, supervision, reconciliation)
        .structuralFailures.find((failure) => failure.kind === "centralized-mint")?.severity ?? null;

    const mintComponentOf = (
      mintControl: V9DeploymentControlFactV2,
      supervision: V9MintSupervision,
      reconciliation: V9MintReconciliation,
    ) => {
      const component = evaluateMint(mintControl, supervision, reconciliation)
        .components.find((entry) => entry.kind === "mint");
      if (!component) throw new Error("mint component missing");
      return component;
    };

    // MINT-SOFTEN 2026-07-21: an unbounded mint with no active compromise is a
    // heavy control-pillar penalty on the high rung, not a critical composite
    // floor. Prudential supervision clears the cap entirely.
    it.each(["not-applicable", "unknown"] as const)(
      "keeps opaque %s-reconciliation unbounded mints on the high rung with no active incident",
      (reconciliation) => {
        for (const supervision of ["attestation-only", "none", "unknown"] as const) {
          expect(severityOf(unboundedMint(), supervision, reconciliation), supervision).toBe("high");
        }
        expect(severityOf(unboundedMint(), "prudential", reconciliation)).toBeNull();
      },
    );

    it.each(SUPERVISIONS)("keeps a compromised mint critical under %s supervision", (supervision) => {
      expect(severityOf(unboundedMint({ incidentState: "active" }), supervision, "periodic")).toBe("critical");
    });

    it("keeps supervision none/unknown + reconciled at the high rung (fail-closed)", () => {
      expect(severityOf(unboundedMint(), "none", "periodic")).toBe("high");
      expect(severityOf(unboundedMint(), "unknown", "continuous")).toBe("high");
    });

    it.each([
      [null, 95, "A+"],
      ["low", 83, "A"],
      ["moderate", 74, "B"],
      ["high", 59, "C"],
      ["critical", 39, "F"],
    ] as const)("scores the %s mint rung independently", (severity, expectedScore, expectedGrade) => {
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
          structuralSignals: severity === null ? [] : [
            {
              kind: "centralized-mint",
              severity,
              responsibility: "measured-adverse",
              reason: "Minting is economically unbounded but supply is reconciled against reserves.",
              failureDomainKeys: ["mint-control:fixture"],
              evidence: [],
            },
          ],
          unresolved: [],
        },
        V9_CANDIDATE_POLICY_V1,
      );
      expect(trace.bindingCap).toEqual(severity === null ? null : expect.objectContaining({
        source: "structural",
        kind: `signal:centralized-mint:${severity}`,
        limit: expectedScore,
      }));
      expect(trace.finalScore).toBe(expectedScore);
      expect(trace.finalGrade).toBe(expectedGrade);
    });

    const availabilityMatrix = [
      ["continuous", [80, 70, 55, 55]],
      ["periodic", [80, 70, 55, 55]],
      ["internal-ledger", [55, 25, 25, 25]],
      ["unknown", [55, 25, 25, 25]],
      ["none", [55, 25, 25, 25]],
      ["not-applicable", [55, 25, 25, 25]],
    ] as const;
    it.each(availabilityMatrix.flatMap(([reconciliation, qualities]) =>
      SUPERVISIONS.map((supervision, index) => ({ reconciliation, supervision, base: qualities[index]! })),
    ))("grades $reconciliation/$supervision from positive assurance, not availability", ({ reconciliation, supervision, base }) => {
      const clean = unboundedMint({
        authority: { authorityKey: "issuer", model: "issuer-backend", threshold: null },
        delaySec: null,
      });
      const posture = base === 25 ? "unbounded-adverse" : "unbounded-reconciled";
      const severity = supervision === "prudential" ? null :
        base === 70 ? "low" : "high";
      expect(mintComponentOf(clean, supervision, reconciliation)).toMatchObject({ posture, score: base });
      expect(mintComponentOf(unboundedMint(), supervision, reconciliation)).toMatchObject({
        posture, score: Math.max(25, base - UNATTESTED_EOA_PENALTY),
      });
      expect(severityOf(clean, supervision, reconciliation)).toBe(severity);
      expect(severityOf(unboundedMint(), supervision, reconciliation)).toBe(severity);
    });

    it("keeps concentrated administration at its conservative rung with independent single-key risk", () => {
      const mintControl = unboundedMint({
        capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "bounded",
      });
      expect(mintComponentOf(mintControl, "attestation-only", "not-applicable")).toMatchObject({
        posture: "concentrated-admin", score: 55 - UNATTESTED_EOA_PENALTY,
      });
    });

    it("never ranks a weaker supervision class above a stronger one for the same posture", () => {
      const scoreFor = (supervision: V9MintSupervision) =>
        mintComponentOf(unboundedMint(), supervision, "periodic").score!;
      expect(scoreFor("prudential")).toBeGreaterThanOrEqual(scoreFor("attestation-only"));
      expect(scoreFor("attestation-only")).toBeGreaterThanOrEqual(scoreFor("none"));
      expect(scoreFor("none")).toBe(scoreFor("unknown"));
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

  it.each(["bounded-unknown", "stale", "missing"] as const)(
    "retains each mint-capable authority's unknown or adverse facts when the aggregate review is %s and has no evidence",
    (observationState) => {
      const root = control("mint:healthy-root", "mint");
      const unknown = control("mint:unreviewed", "mint", {
        status: { ...boundedUnknown("mint:unreviewed"), evidenceRefIds: [] },
        capSemantics: { kind: "unknown", bound: null },
      });
      const adverse = control("mint:adverse", "mint", { incidentState: "active" });
      const review = {
        ...boundedMint(root.controlKey),
        status: { ...boundedUnknown("mint:review"), observationState, evidenceRefIds: [] },
      };
      const withUnknown = evaluateV9EconomicControl(args({
        facts: facts([root, unknown]), mint: review,
      }));
      const knownReview = evaluateV9EconomicControl(args({
        facts: facts([root, unknown]), mint: boundedMint(root.controlKey),
      }));
      expect(withUnknown.components).toContainEqual(expect.objectContaining({
        kind: "mint", posture: "unknown", controlKeys: [unknown.controlKey],
      }));
      expect(withUnknown.score).toBeLessThanOrEqual(knownReview.score!);
      const withAdverse = evaluateV9EconomicControl(args({
        facts: facts([root, adverse]), mint: review,
      }));
      expect(withAdverse.components).toContainEqual(expect.objectContaining({
        kind: "mint", posture: "compromised", controlKeys: [adverse.controlKey],
      }));
      expect(withAdverse.score).toBeLessThan(withUnknown.score!);
      const cleared = evaluateV9EconomicControl(args({
        facts: facts([root, control(unknown.controlKey, "mint"), control(adverse.controlKey, "mint")]),
        mint: boundedMint(root.controlKey),
      }));
      expect(cleared.score).toBeGreaterThan(withUnknown.score!);
      expect(cleared.structuralFailures.some((failure) => failure.kind === "active-control-incident")).toBe(false);
    },
  );

  it.each([[2, 0.04, true], [2, 0.05, true], [4, 0.03, true], [3, 0.05, false]] as const)(
    "relaxes %s exact unresolved rows of share %s only below the aggregate full-ceiling boundary",
    (count, share, complete) => {
      const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
      const controls = Array.from({ length: count }, (_, index) => control(`bridge:band:${index}`, "bridge", {
        scope: "deployment", economicLossScope: "deployment", materialSupplyShare: share,
        status: boundedUnknown(`bridge:band:${index}`),
      }));
      const cohortFacts = facts(controls, {
        supply: makeSupplyPartition({
          routes: [
            { deploymentRouteKey: "ethereum:native", supplyShare: 1 - count * share,
              reviewState: "selected-reviewed", reviewedRouteKind: "native" },
            ...controls.map((row) => ({
              deploymentRouteKey: row.deploymentKey, supplyShare: share, reviewState: "selected-unresolved" as const,
            })),
          ],
          selectedRouteSupplyShare: 1 - count * share,
          unreviewedRouteSupplyShare: count * share,
          unknownRouteSupplyShare: 0,
        }),
      });
      const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
        cohortFacts, controls,
        controls.map((row) => ({ controlKey: row.controlKey, tier: "canonical-rollup-bridge" })),
        materiality.deploymentMaterialSharePct / 100, materiality.commonModeShareThreshold,
        materiality.unresolvedDeploymentFullCeilingSharePct / 100,
      );
      expect(join.complete).toBe(complete);
      if (!complete) expect(join.cause).toMatchObject({ code: "unresolved-row-control-unproven" });
    },
  );

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

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }),
    ]);
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

    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null }),
    ]);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
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

  it("does not infer zero deployment exposure from unreconciled aggregates or totals", () => {
    const missing = control("bridge:absent", "bridge", {
      deploymentKey: "solana:absent", scope: "deployment", economicLossScope: "deployment",
      materialSupplyShare: null, status: boundedUnknown("control.absent"),
    });
    for (const [rowShare, aggregateShare] of [[1, 0.9], [0.9, 0.9]]) {
      const result = evaluateV9EconomicControl(args({
        facts: {
          ...facts([missing]), controlStatus: requiredKnown("controls"),
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: [{
              deploymentRouteKey: "ethereum:native",
              supplyUsd: rowShare * 100,
              supplyShare: rowShare,
              reviewState: "selected-reviewed",
              reviewedRouteKind: "native",
            }],
            selectedRouteSupplyShare: aggregateShare,
            unknownRouteSupplyShare: 0,
            unreviewedRouteSupplyShare: 0,
          }),
        },
      }));
      expect(result.reasons).toContainEqual(expect.objectContaining({
        code: "selected-bridge-route-unresolved", controlKey: missing.controlKey,
      }));
    }
  });

  it("sums split deployment rows before granting null-share relief", () => {
    const missing = control("bridge:split", "bridge", {
      deploymentKey: "solana:split", scope: "deployment", economicLossScope: "deployment",
      materialSupplyShare: null, status: boundedUnknown("control.split"),
    });
    const result = evaluateV9EconomicControl(args({
      facts: {
        ...facts([missing]), controlStatus: requiredKnown("controls"),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
            {
              deploymentRouteKey: "ethereum:native",
              supplyUsd: 90,
              supplyShare: 0.9,
              reviewState: "selected-reviewed",
              reviewedRouteKind: "native",
            },
            ...[0.04, 0.06].map((supplyShare) => ({
              deploymentRouteKey: missing.deploymentKey,
              supplyUsd: supplyShare * 100,
              supplyShare,
              reviewState: "unmatched" as const,
            })),
          ],
          selectedRouteSupplyShare: 0.9,
          unknownRouteSupplyShare: 0.1,
          unreviewedRouteSupplyShare: 0,
        }),
      },
    }));
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code: "selected-bridge-route-unresolved", controlKey: missing.controlKey,
    }));
  });

  it("rejects duplicate bridge reviews and ambiguous controls instead of selecting the first join", () => {
    const first = control("bridge:first", "bridge", {
      deploymentKey: "ethereum:controlled", scope: "deployment",
      economicLossScope: "deployment", materialSupplyShare: 0.95,
    });
    const second = { ...first, controlKey: "bridge:second" };
    const route = { controlKey: first.controlKey, tier: "external-validated-network" as const };
    const economicFacts: V9EconomicControlAssetFacts = {
      ...facts([first]),
      supply: makeSupplyPartition({
        status: requiredKnown("supply"),
        routes: [
          {
            deploymentRouteKey: first.deploymentKey,
            supplyUsd: 95,
            supplyShare: 0.95,
            reviewState: "selected-reviewed",
            reviewedRouteKind: "controlled",
          },
          {
            deploymentRouteKey: "unmatched-chain:fixture:arbitrum",
            supplyUsd: 5,
            supplyShare: 0.05,
            reviewState: "unmatched",
          },
        ],
        selectedRouteSupplyShare: 0.95,
        unknownRouteSupplyShare: 0.05,
        unreviewedRouteSupplyShare: 0,
      }),
    };
    expect(evaluateV9SubthresholdUnresolvedBridgeJoins(
      economicFacts, [first], [route], 0.1, 0.1,
      V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.unresolvedDeploymentFullCeilingSharePct / 100,
    )).toEqual({ complete: true, cause: null });
    for (const [controls, routes, code, controlKeys] of [
      [[first], [route, route], "duplicate-bridge-route-control", [first.controlKey]],
      [[first, second], [route, { ...route, controlKey: second.controlKey }],
        "reviewed-row-control-join-not-unique", [first.controlKey, second.controlKey]],
    ] as const) {
      expect(evaluateV9SubthresholdUnresolvedBridgeJoins(
        economicFacts, controls, routes, 0.1, 0.1,
        V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.unresolvedDeploymentFullCeilingSharePct / 100,
      )).toMatchObject({ complete: false, cause: { code, controlKeys } });
      const evaluationArgs = args({
        facts: { ...economicFacts, controls },
        bridge: { status: requiredKnown("bridge"), routes },
      });
      if (code === "duplicate-bridge-route-control") {
        expect(() => evaluateV9EconomicControl(evaluationArgs)).toThrow(/Duplicate v9 bridge control/);
      } else {
        const result = evaluateV9EconomicControl(evaluationArgs);
        expect(result.reasons.map((reason) => reason.code)).toContain("nonmaterial-bridge-supply-unmatched");
      }
    }
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

    expect(result.reasons.map((reason) => reason.code)).toContain("scoped-control-question");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("unresolved-mint-authority");
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
    expect(result.score).toBe(Math.min(...result.components
      .filter((component) => component.binding && component.score !== null)
      .map((component) => component.score!)));
    expect(result.components.find((component) => component.componentKey === "control:inventory")).toMatchObject({
      cause: "U", effectiveScoringWeight: 0, binding: false,
    });
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
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.unresolvedDeploymentFullCeilingSharePct / 100;
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
            supply: makeSupplyPartition({
              status: supplyStatus,
              routes: [
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
            }),
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

  it.each(REPRESENTATIVE_CHAIN_LABEL_POOLS)(
    "clears the synthetic chain-label pool for $assetId at $poolShare",
    ({ assetId, poolShare }) => {
      const measured = chainLabelPoolResult(assetId, poolShare, { withPoolControl: false });
      expect(measured.reasons).toEqual([]);
      expect(measured.score).toBe(90);

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
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: [
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
          }),
        },
        bridge: { status: requiredKnown("bridge"), routes: [] },
      }),
    );

    expect(result.reasons).toEqual([]);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
  });


  it("proves a clean sub-threshold bridge join and names no failing row", () => {
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
      {
        ...facts(),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
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
        }),
      },
      [],
      [],
      materiality.deploymentMaterialSharePct / 100,
      materiality.commonModeShareThreshold,
      materiality.unresolvedDeploymentFullCeilingSharePct / 100,
    );
    expect(join).toEqual({ complete: true, cause: null });
  });
  it("ignores a matching umbrella control for a reviewed native supply row", () => {
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    const materialShareThreshold = materiality.deploymentMaterialSharePct / 100;
    const residueShare = materialShareThreshold / 2;
    const nativeControl = control("bridge:native-umbrella", "bridge", {
      deploymentKey: "ethereum:native",
    });
    const bridgeRoutes = [
      { controlKey: nativeControl.controlKey, tier: "external-validated-network" as const },
    ] as const;
    const economicFacts: V9EconomicControlAssetFacts = {
      ...facts([nativeControl]),
      supply: makeSupplyPartition({
        status: requiredKnown("supply"),
        routes: [
          {
            deploymentRouteKey: nativeControl.deploymentKey,
            supplyUsd: 100 * (1 - residueShare),
            supplyShare: 1 - residueShare,
            reviewState: "selected-reviewed",
            reviewedRouteKind: "native",
          },
          {
            deploymentRouteKey: "unmatched-chain:fixture-asset:arbitrum",
            supplyUsd: 100 * residueShare,
            supplyShare: residueShare,
            reviewState: "unmatched",
          },
        ],
        selectedRouteSupplyShare: 1 - residueShare,
        unknownRouteSupplyShare: residueShare,
        unreviewedRouteSupplyShare: 0,
      }),
    };
    const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
      economicFacts,
      [nativeControl],
      bridgeRoutes,
      materialShareThreshold,
      materiality.commonModeShareThreshold,
      materiality.unresolvedDeploymentFullCeilingSharePct / 100,
    );

    // Before the fix, this native control joined the row and made the proof
    // incomplete, which emitted the nonmaterial residue reason below.
    expect(join).toEqual({ complete: true, cause: null });
    const result = evaluateV9EconomicControl(
      args({
        facts: economicFacts,
        bridge: { status: requiredKnown("bridge"), routes: bridgeRoutes },
      }),
    );
    expect(result.reasons.map((reason) => reason.code)).not.toContain("nonmaterial-bridge-supply-unmatched");
  });

  it("keeps an unresolved reviewed bridge row incomplete when its control does not join", () => {
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    const materialShareThreshold = materiality.deploymentMaterialSharePct / 100;
    const residueShare = materialShareThreshold / 2;
    const unmatchedControl = control("bridge:unmatched", "bridge", {
      deploymentKey: "ethereum:other-deployment",
    });
    const bridgeRoutes = [
      { controlKey: unmatchedControl.controlKey, tier: "external-validated-network" as const },
    ] as const;
    const economicFacts: V9EconomicControlAssetFacts = {
      ...facts([unmatchedControl]),
      supply: makeSupplyPartition({
        status: requiredKnown("supply"),
        routes: [
          {
            deploymentRouteKey: "ethereum:bridge-representation",
            supplyUsd: 100 * (1 - residueShare),
            supplyShare: 1 - residueShare,
            reviewState: "selected-reviewed",
            reviewedRouteKind: "controlled",
          },
          {
            deploymentRouteKey: "unmatched-chain:fixture-asset:arbitrum",
            supplyUsd: 100 * residueShare,
            supplyShare: residueShare,
            reviewState: "unmatched",
          },
        ],
        selectedRouteSupplyShare: 1 - residueShare,
        unknownRouteSupplyShare: residueShare,
        unreviewedRouteSupplyShare: 0,
      }),
    };
    const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
      economicFacts,
      [unmatchedControl],
      bridgeRoutes,
      materialShareThreshold,
      materiality.commonModeShareThreshold,
      materiality.unresolvedDeploymentFullCeilingSharePct / 100,
    );

    expect(join.complete).toBe(false);
    expect(join.cause).toEqual(
      expect.objectContaining({
        code: "reviewed-row-control-join-not-unique",
        deploymentRouteKey: "ethereum:bridge-representation",
      }),
    );
    const result = evaluateV9EconomicControl(
      args({
        facts: economicFacts,
        bridge: { status: requiredKnown("bridge"), routes: bridgeRoutes },
      }),
    );
    expect(result.reasons.map((reason) => reason.code)).toContain("nonmaterial-bridge-supply-unmatched");
  });

  it("rejects a required-known reviewed bridge inventory with no route joins", () => {
    const result = evaluateV9EconomicControl(
      args({
        facts: {
          ...facts(),
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: [{
              deploymentRouteKey: "ethereum:reviewed",
              supplyUsd: 100,
              supplyShare: 1,
              reviewState: "selected-reviewed",
            }],
          }),
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
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: [
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
          }),
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
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [{
            deploymentRouteKey: "peripheral:dust",
            supplyUsd: 0,
            supplyShare: 0,
            reviewState: "unmatched",
          }],
          selectedRouteSupplyShare: 1,
          unknownRouteSupplyShare: 0,
          unreviewedRouteSupplyShare: 0,
        }),
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

    it("HARD RULE: grades a validator quorum at or below issuer-backend, never above a named multisig", () => {
      // AUTHORITY-LADDER 9.46. The rung is KNOWN (it no longer holds the flat
      // default because the authority is unresolved) but it earns no lift: an
      // anonymous rotating quorum is not stronger than a 3-of-5 Safe.
      const gradeFor = (authority: NonNullable<V9DeploymentControlFactV2["authority"]>) => {
        const result = evaluateV9EconomicControl(
          args({
            facts: materialityGappedBridgeFacts({ authority, delaySec: null }),
            bridge: knownBridge,
          }),
        );
        return result.components.find((component) => component.componentKey === "bridge:unverified")!.score!;
      };
      const quorum = gradeFor({
        authorityKey: "bridge-route:protocol:layerzero-dvns",
        model: "validator-quorum",
        threshold: null,
      });
      const issuerBackend = gradeFor({
        authorityKey: "authority:issuer",
        model: "issuer-backend",
        threshold: null,
      });
      const namedMultisig = gradeFor({
        authorityKey: "safe:base:0xbbbb",
        model: "multisig",
        threshold: { required: 3, total: 5 },
      });

      expect(quorum).toBeLessThanOrEqual(issuerBackend);
      expect(quorum).toBeLessThan(namedMultisig);
      expect(quorum).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
      // The multisig branch starts from the concentrated rung, which is strictly
      // above this one, so naming a validation domain can never lift a control
      // into the multisig class.
      expect(quorum).toBeLessThan(CONTROL_POLICY.mintPostureQuality["concentrated-admin"]);
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

describe("cause-aware Control minima", () => {
  function missing(cause: "A" | "B" | "C" | "U", id: string, factorKey?: string) {
    const gap = createV9FactGapV3({
      gapId: id, reasonCode: "unresolved-control-identity", ownerDomain: "control", policyRuleId: "control-proof",
      responsibility: "unresearched", observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: id }, message: "Scoped control datum.",
      ...(factorKey === undefined ? {} : { causeScope: {
        pillar: "control" as const, componentKey: "economic-control:mint", factorKey,
        routeKey: null, exposureId: null, requiredDatum: factorKey,
      } }),
      causeProof: cause === "A" ? { cause, producerState: "producer-failed", sourceId: "control-reader",
        sourceGenerationId: "capture", observedAtSec: 1, rejectionCode: "reader-failed", evidenceRefIds: ["attempt"] }
        : cause === "U" ? { cause, reason: "not-yet-researched", evidenceRefIds: [] }
          : cause === "B" ? { cause, proofOrigin: "typed-review", classificationId: id, reviewedAt: "2026-10-01",
            sources: [{ url: "https://issuer.example/control", assertion: "The scoped authority datum is public." }],
            evidenceRefIds: ["review"], assertion: "required-data-public" }
            : { cause, proofOrigin: "typed-review", classificationId: id, reviewedAt: "2026-10-01",
              sources: [{ url: "https://issuer.example/control", assertion: "The scoped datum was researched." }],
              evidenceRefIds: ["review"], assertion: "researched-nondisclosure", rationale: "Current datum not disclosed." },
    });
    const status: V9FactStatusV2 = { applicability: { state: "required", policyRuleId: "control-proof", rationale: null, gapId: null },
      observationState: "bounded-unknown", evidenceRefIds: [], gapIds: [gap.gapId] };
    return { status, gap };
  }

  it("prices C/U unknown multisig topology at -6 while proof-backed A/B is neutral", () => {
    for (const cause of ["A", "B", "C", "U"] as const) {
      const gap = missing(cause, `topology:${cause}`);
      const row = control("mint:topology", "mint", {
        authority: { authorityKey: "unknown-safe", model: "multisig", threshold: null }, delaySec: null,
        factorStatuses: { topology: gap.status },
      });
      expect(applyMergedMintSignals(85, row, undefined, CONTROL_POLICY, [gap.gap])).toBe(
        cause === "A" || cause === "B" ? 85 : 79,
      );
    }
  });

  it("keeps ordinary known-only mint ladders independent of the generic unknown rung", () => {
    const known = control("mint:known-ladder", "mint", {
      authority: { authorityKey: "contract", model: "contract", threshold: null }, delaySec: null,
      modulesOrGuards: "none-detected",
    });
    const changed = { ...CONTROL_POLICY, mintPostureQuality: { ...CONTROL_POLICY.mintPostureQuality, unknown: 56 } };
    expect(applyMergedMintSignals(55, known, undefined, changed)).toBe(applyMergedMintSignals(55, known, undefined, CONTROL_POLICY));
  });

  it.each(["A", "B", "C", "U"] as const)(
    "reconciles a gap-backed %s inventory component without inventing a mint control", (cause) => {
      const root = missing(cause, `inventory:${cause}`);
      const bridgeReader = missing("A", "bridge-reader");
      const inventoryFacts = { ...facts([control("custody:known", "custody")]), controlStatus: root.status,
        gaps: [root.gap, bridgeReader.gap] };
      const excludedBridge = { ...noBridge(), status: bridgeReader.status };
      const known = evaluateV9EconomicControl(args({ facts: inventoryFacts, bridge: excludedBridge }));
      expect(known.score).toBe(100);
      expect(known.causeGapIds).toContain(root.gap.gapId);
      expect(known.limitedEvidenceCauses).toEqual([]);
      expect(known.components.find((component) => component.kind === "inventory")).toMatchObject({
        componentKey: "control:inventory", score: cause === "A" || cause === "B" ? null : 45,
        binding: false, effectiveScoringWeight: 0, cause, causeGapIds: [root.gap.gapId],
      });
      expect(known.score).toBe(Math.min(...known.components
        .filter((component) => component.binding && component.score !== null).map((component) => component.score!)));
      const typedUnknown = evaluateV9EconomicControl(args({
        facts: inventoryFacts, mint: { ...noMint(), status: root.status },
        bridge: excludedBridge,
      }));
      expect(typedUnknown.score).toBe(cause === "A" || cause === "B" ? null : 50);
      const lowerKnown = evaluateV9EconomicControl(args({
        facts: inventoryFacts,
        bridge: excludedBridge,
        mint: { ...noMint(), status: root.status },
        oracle: { ...noOracle(), status: requiredKnown("oracle"), tier: "single-source-or-laggy", liquidationBranchesApplicable: false },
      }));
      expect(lowerKnown.score).toBe(45);
      expect(lowerKnown.limitedEvidenceCauses).toEqual([]);
    },
  );

  it.each(["C", "U"] as const)("keeps %s inventory diagnostic at the unchanged BASE control minimum", (cause) => {
    const root = missing(cause, `inventory:${cause}`);
    for (const [capKind, claimImpairment, authority, reconciliation, expected] of [
      ["raiseable", "bounded", "contract", "not-applicable", 70],
      ["unbounded", "unbounded", "eoa", "continuous", 52],
    ] as const) {
      const row = control("mint:known", "mint", { capSemantics: { kind: capKind, bound: null }, claimImpairment,
        authority: { authorityKey: "known-authority", model: authority, threshold: null }, delaySec: null });
      const review = { ...boundedMint(row.controlKey), reconciliation, supervision: "none" as const,
        upgrade: { state: "not-applicable" as const, controlKey: null } };
      const baseline = evaluateV9EconomicControl(args({ facts: facts([row]), mint: review }));
      const candidate = evaluateV9EconomicControl(args({
        facts: { ...facts([row]), controlStatus: root.status, gaps: [root.gap] }, mint: review,
      }));
      expect(baseline.score).toBe(expected);
      expect(candidate.score).toBe(baseline.score);
      expect(candidate.components.find((component) => component.kind === "inventory")).toMatchObject({
        binding: false, effectiveScoringWeight: 0, causeGapIds: [root.gap.gapId],
      });
      expect(candidate.limitedEvidenceCauses).toEqual([]);
      expect(candidate.supportedComponentKeys).not.toContain("control:inventory");
    }
  });

  it("retains measured adverse mint powers in the inventory despite an unrelated unknown inventory gap", () => {
    const root = missing("U", "inventory");
    const adverse = control("mint:adverse", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      authority: { authorityKey: "issuer", model: "issuer-backend", threshold: null }, delaySec: null,
    });
    const result = evaluateV9EconomicControl(args({
      facts: { ...facts([adverse]), controlStatus: root.status, gaps: [root.gap] },
      mint: { ...boundedMint(adverse.controlKey), reconciliation: "none", supervision: "none",
        upgrade: { state: "not-applicable", controlKey: null } },
    }));
    expect(result.score).toBe(25);
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ score: 25, binding: true });
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({
      kind: "centralized-mint", severity: "high", binding: true,
    }));
  });

  it.each(["A", "B", "C", "U"] as const)(
    "retains actual %s row and tier gaps when a known bridge inventory needs a fallback", (cause) => {
      const rowGap = missing(cause, `bridge-row:${cause}`);
      const tierGap = missing(cause, `bridge-tier:${cause}`);
      const bridgeControl = control("bridge:unresolved", "bridge", {
        status: rowGap.status, economicLossScope: "deployment", scope: "deployment", materialSupplyShare: 1,
      });
      const result = evaluateV9EconomicControl(args({
        facts: { ...facts([bridgeControl]), controlStatus: requiredKnown("controls"), gaps: [rowGap.gap, tierGap.gap] },
        bridge: { status: requiredKnown("bridge"), routes: [{
          controlKey: bridgeControl.controlKey, tier: "opaque-or-unknown", factorStatuses: { tier: tierGap.status },
        }] },
      }));
      expect(result.components.find((component) => component.componentKey === "bridge:unverified")).toMatchObject({
        cause, causeGapIds: [rowGap.gap.gapId, tierGap.gap.gapId].sort(),
        score: cause === "A" || cause === "B" ? null : 45, binding: cause !== "A" && cause !== "B",
      });
      expect(result.score).toBe(cause === "A" || cause === "B" ? 100 : 45);
    },
  );

  it.each(["A", "B"] as const)("excludes a proven %s mint gap without clearing a known weak oracle", (cause) => {
    const gap = missing(cause, "mint-gap");
    const result = evaluateV9EconomicControl(args({
      facts: { ...facts([]), gaps: [gap.gap] },
      mint: { ...noMint(), status: gap.status },
      oracle: { ...noOracle(), status: requiredKnown("oracle"), tier: "single-source-or-laggy", liquidationBranchesApplicable: false },
    }));
    expect(result.score).toBe(45);
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      score: null, cause, effectiveScoringWeight: 0,
    });
    expect(result.components.find((component) => component.kind === "oracle")!.score).toBe(45);
    expect(result.structuralFailures.some((failure) => failure.kind === "weak-oracle-branch")).toBe(true);
    expect(result.limitedEvidenceCauses).not.toContain(cause);
  });

  it.each(["C", "U"] as const)("uses typed no-lower-than-today %s mint50/oracle45/bridge45 rungs", (cause) => {
    const gap = missing(cause, "gap");
    const result = evaluateV9EconomicControl(args({
      facts: { ...facts([]), gaps: [gap.gap] },
      mint: { ...noMint(), status: gap.status },
      oracle: { ...noOracle(), status: gap.status },
      bridge: { ...noBridge(), status: gap.status },
    }));
    expect(result.components.find((component) => component.kind === "mint")!.score).toBe(50);
    expect(result.components.find((component) => component.kind === "oracle")!.score).toBe(45);
    expect(result.components.find((component) => component.kind === "bridge")!.score).toBe(45);
    expect(result.reasons.every((reason) => !reason.critical)).toBe(true);
  });

  it("retains a real reconciliation cause while pricing independently known adverse power", () => {
    const gap = missing("C", "reconciliation", "reconciliation");
    const mintControl = control("mint:issuer", "mint", {
      authority: { authorityKey: "issuer", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const evaluate = (reconciliation: V9MintReconciliation) => evaluateV9EconomicControl(args({
      facts: { ...facts([mintControl]), gaps: [gap.gap] },
      mint: { ...boundedMint(mintControl.controlKey), reconciliation, supervision: "none",
        factorStatuses: reconciliation === "unknown" ? { reconciliation: gap.status } : {} },
    }));
    const unknown = evaluate("unknown");
    const disclosed = evaluate("periodic");
    expect(unknown.components.find((component) => component.kind === "mint")!).toMatchObject({
      posture: "unbounded-adverse", score: 25, cause: "C", causeGapIds: [gap.gap.gapId],
    });
    expect(disclosed.score).toBeGreaterThanOrEqual(unknown.score!);
    expect(unknown.components.find((component) => component.kind === "mint")!.cause).toBe("C");
  });

  it.each(["C", "U"] as const)("retains scoped %s reconciliation and topology gaps together", (cause) => {
    const reconciliation = missing(cause, "z:reconciliation", "reconciliation");
    const topology = missing("U", "a:topology", "topology");
    const unrelated = missing("C", "other:inventory");
    const mintControl = control("mint:scoped", "mint", {
      authority: { authorityKey: "unknown-safe", model: "multisig", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", delaySec: null,
      factorStatuses: { topology: { ...topology.status, gapIds: [topology.gap.gapId, topology.gap.gapId] } },
    });
    for (const cadence of ["unknown", "internal-ledger"] as const) {
      const result = evaluateV9EconomicControl(args({
        facts: facts([mintControl], { gaps: [reconciliation.gap, topology.gap, unrelated.gap] }),
        mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: cadence, supervision: "none",
          factorStatuses: { reconciliation: reconciliation.status } }),
      }));
      const component = result.components.find((entry) => entry.kind === "mint")!;
      expect(component).toMatchObject({ posture: "unbounded-adverse", score: 25, cause,
        causeGapIds: [topology.gap.gapId, reconciliation.gap.gapId], scoringDisposition: "bounded-uncertainty" });
      expect(reconciliation.gap.causeScope).toMatchObject({
        pillar: "control", componentKey: "economic-control:mint", factorKey: "reconciliation", requiredDatum: "reconciliation",
      });
      expect(V9CauseContributionSchema.safeParse({ cause: component.cause, causeGapIds: component.causeGapIds,
        score: component.score, scoringDisposition: component.scoringDisposition,
        effectiveScoringWeight: component.effectiveScoringWeight }).success).toBe(true);
      expect(result.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high" }));
    }
  });

  it.each(["none", "not-applicable"] as const)("does not turn reviewed %s reconciliation into an unresearched cause", (reconciliation) => {
    const unrelated = missing("U", "unrelated-inventory");
    const row = control("mint:reviewed", "mint", {
      authority: { authorityKey: "contract", model: "contract", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const result = evaluateV9EconomicControl(args({
      facts: facts([row], { gaps: [unrelated.gap] }),
      mint: makeReviewedMintInput(row.controlKey, { reconciliation }),
    }));
    expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
      posture: "unbounded-adverse", score: 25, cause: null, causeGapIds: [], scoringDisposition: "included",
    });
  });

  it("cannot satisfy a missing factor cause by borrowing unrelated diagnostic gaps", () => {
    const unrelated = missing("U", "unrelated-inventory");
    const row = control("mint:missing-factor", "mint", {
      authority: { authorityKey: "issuer", model: "issuer-backend", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    const status = { ...boundedUnknown("mint.reconciliation"), gapIds: [] };
    const result = evaluateV9EconomicControl(args({
      facts: facts([row], { gaps: [unrelated.gap] }),
      mint: makeReviewedMintInput(row.controlKey, { reconciliation: "unknown", factorStatuses: { reconciliation: status } }),
    }));
    const component = result.components.find((entry) => entry.kind === "mint")!;
    expect(component).toMatchObject({ posture: "unbounded-adverse", score: 25, cause: "U", causeGapIds: [] });
    expect(V9CauseContributionSchema.safeParse({ cause: component.cause, causeGapIds: component.causeGapIds,
      score: component.score, scoringDisposition: component.scoringDisposition,
      effectiveScoringWeight: component.effectiveScoringWeight }).success).toBe(false);
  });

  it("drops an A/B-only Control pillar with null scores, not a favorable neutral100", () => {
    const gap = missing("A", "all-controls");
    const result = evaluateV9EconomicControl(args({
      facts: { ...facts([]), controlStatus: gap.status, gaps: [gap.gap] },
      mint: { ...noMint(), status: gap.status }, oracle: { ...noOracle(), status: gap.status },
      bridge: { ...noBridge(), status: gap.status },
    }));
    expect(result.score).toBeNull();
    expect(result.aggregationDisposition).toBe("excluded-a-b");
    expect(result.supportedComponentKeys).toEqual([]);
    expect(result.limitedEvidenceCauses).toEqual([]);
  });
});

describe("D29 governed unbounded issuance", () => {
  const governance: NonNullable<V9DeploymentControlFactV2["issuanceGovernance"]> = {
    coverage: "complete",
    incompleteReasons: [],
    governorAuthorityKey: "ethereum:0x1234567890123456789012345678901234567890",
    decisionRule: "affirmative-vote",
    minUnavoidableDelaySec: 172_800,
    votingPower: "lock-escrowed",
    vetoQuorumBps: null,
    vetoOverride: null,
    enumerable: true,
    nonGovernorUnboundedPathKeys: [],
    votingControl: QUALIFIED_VOTING_CONTROL, diagnostics: [],
  };
  const governor = control("mint:governor", "mint", {
    authority: { authorityKey: governance.governorAuthorityKey, model: "governance", threshold: null },
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    delaySec: 172_800,
    issuanceGovernance: governance,
  });

  it.each([
    ["active incident beats qualified governance", "periodic", "prudential", "active", true, "compromised", 25],
    ["prudential graded reconciliation beats governance", "continuous", "prudential", "none", true, "unbounded-reconciled", 80],
    ["attestation graded reconciliation beats governance", "periodic", "attestation-only", "none", true, "unbounded-reconciled", 70],
    ["governance beats continuous base reconciliation", "continuous", "none", "none", true, "unbounded-governed", 60],
    ["governance beats periodic base reconciliation", "periodic", "unknown", "none", true, "unbounded-governed", 60],
    ["governance beats supervision-only base reconciliation", "unknown", "prudential", "none", true, "unbounded-governed", 60],
    ["governance beats unknown reconciliation", "unknown", "none", "none", true, "unbounded-governed", 60],
    ["governance beats internal-ledger reconciliation", "internal-ledger", "none", "none", true, "unbounded-governed", 60],
    ["governance beats absent reconciliation", "none", "none", "none", true, "unbounded-governed", 60],
    ["governance beats inapplicable reconciliation", "not-applicable", "none", "none", true, "unbounded-governed", 60],
    ["base reconciliation survives unqualified governance", "continuous", "none", "none", false, "unbounded-reconciled", 55],
    ["prudential supervision survives unqualified governance", "not-applicable", "prudential", "none", false, "unbounded-reconciled", 55],
    ["unknown reconciliation does not lift failed governance", "unknown", "none", "none", false, "unbounded-adverse", 25],
    ["internal-ledger does not lift failed governance", "internal-ledger", "none", "none", false, "unbounded-adverse", 25],
    ["absent reconciliation does not lift failed governance", "none", "none", "none", false, "unbounded-adverse", 25],
  ] as const)("%s", (_name, reconciliation, supervision, incidentState, qualified, posture, score) => {
    const candidate = {
      ...governor,
      incidentState,
      issuanceGovernance: qualified ? governance : undefined,
    };
    const mint = makeReviewedMintInput(candidate.controlKey, { reconciliation, supervision });
    expect(deriveV9MintPosture(candidate, mint, false, SEMANTIC_POLICY)).toBe(posture);
    const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture, score });
  });

  it.each([
    ["incomplete coverage", { coverage: "incomplete" }],
    ["a retained incomplete reason", { incompleteReasons: ["review-incomplete"] }],
    ["a non-governor unbounded path", { nonGovernorUnboundedPathKeys: ["council:mint"] }],
    ["unknown unavoidable delay", { minUnavoidableDelaySec: null }],
    ["delay below two days", { minUnavoidableDelaySec: 172_799 }],
    ["live-balance voting", { votingPower: "live-balance" }],
    ["unknown voting", { votingPower: "unknown" }],
    ["non-enumerable issuance", { enumerable: false }],
  ] satisfies [string, Partial<NonNullable<V9DeploymentControlFactV2["issuanceGovernance"]>>][])(
    "fails closed for %s", (_name, overrides) => {
      const candidate = { ...governor, issuanceGovernance: { ...governance, ...overrides } };
      const mint = makeReviewedMintInput(candidate.controlKey, { supervision: "none" });
      expect(isV9GovernedIssuanceQualified(candidate, CONTROL_POLICY.governedIssuance)).toBe(false);
      expect(deriveV9MintPosture(candidate, mint, false, SEMANTIC_POLICY)).toBe("unbounded-adverse");
      expect(gradeVerifiedControlAuthority(candidate, SEMANTIC_POLICY)).toBe(25);
      for (const reconciliation of RECONCILIATION_AVAILABILITY) {
        for (const supervision of ["prudential", "attestation-only", "none", "unknown"] as const) {
          const review = makeReviewedMintInput(candidate.controlKey, { reconciliation, supervision });
          const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint: review }));
          expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
            posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-adverse",
            score: supervision === "prudential" ? 55 : 25,
          });
          expect(result.structuralFailures.find((failure) => failure.kind === "centralized-mint")?.severity ?? null)
            .toBe(supervision === "prudential" ? null : "high");
        }
      }
    },
  );

  it("does not infer qualification from the authority model and controller delay without a compiled stamp", () => {
    const candidate = { ...governor, issuanceGovernance: undefined };
    expect(isV9GovernedIssuanceQualified(candidate, CONTROL_POLICY.governedIssuance)).toBe(false);
    expect(gradeVerifiedControlAuthority(candidate, SEMANTIC_POLICY)).toBe(25);
  });

  it.each(["lock-escrowed", "past-block-checkpoint"] as const)(
    "admits %s voting at the unavoidable-delay boundary and grades verified authority at 60", (votingPower) => {
      const candidate = { ...governor, issuanceGovernance: { ...governance, votingPower } };
      expect(isV9GovernedIssuanceQualified(candidate, CONTROL_POLICY.governedIssuance)).toBe(true);
      expect(gradeVerifiedControlAuthority(candidate, SEMANTIC_POLICY)).toBe(60);
      expect(gradeVerifiedControlAuthority({ ...candidate, incidentState: "active" }, SEMANTIC_POLICY)).toBe(25);
    },
  );

  it("uses policy delay and voting admissibility rather than an authority-specific exception", () => {
    expect(isV9GovernedIssuanceQualified(governor, {
      ...CONTROL_POLICY.governedIssuance, minUnavoidableDelaySec: 172_801,
    })).toBe(false);
    expect(isV9GovernedIssuanceQualified(governor, {
      ...CONTROL_POLICY.governedIssuance, admissibleVotingPower: ["past-block-checkpoint"],
    })).toBe(false);
  });

  it("prices governed issuance at 60 with only a low centralized-mint diagnostic", () => {
    const result = evaluateV9EconomicControl(args({
      facts: facts([governor]),
      mint: makeReviewedMintInput(governor.controlKey, { supervision: "none" }),
    }));
    expect(result).toMatchObject({ score: 60, state: "rated" });
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "unbounded-governed", score: 60,
    });
    expect(result.structuralFailures.filter((failure) => failure.kind === "centralized-mint")).toEqual([
      expect.objectContaining({
        severity: "low", binding: true, controlKeys: [governor.controlKey],
        reason: "Minting is economically unbounded but held only by delayed on-chain governance.",
      }),
    ]);
    expect(result.structuralFailures.some((failure) => failure.severity === "high" || failure.severity === "critical")).toBe(false);
  });

  it.each([[59, 60], [60, 69], [120, 69]] as const)(
    "seasons a %i-month governed mint to %i without requiring reconciliation", (trackRecordMonths, score) => {
      const result = evaluateV9EconomicControl(args({
        facts: facts([governor]), trackRecordMonths,
        mint: makeReviewedMintInput(governor.controlKey, { reconciliation: "none", supervision: "none" }),
      }));
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "unbounded-governed", score,
      });
    },
  );

  it.each([
    ["active", "compromised", "critical", "Minting authority is under an active incident."],
    ["none", "unbounded-adverse", "high", "Economically effective minting is unbounded without a qualified governance, reconciliation, or supervisory process."],
  ] as const)("preserves the %s-incident adverse mint signal", (incidentState, posture, severity, reason) => {
    const candidate = { ...governor, incidentState, issuanceGovernance: undefined };
    const result = evaluateV9EconomicControl(args({
      facts: facts([candidate]),
      mint: makeReviewedMintInput(candidate.controlKey, { reconciliation: "none", supervision: "none" }),
    }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture, score: 25 });
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity, reason }));
  });
});

describe("D30 minority-veto unbounded issuance", () => {
  type Governance = NonNullable<V9DeploymentControlFactV2["issuanceGovernance"]>;
  const governance: Governance = {
    coverage: "complete", incompleteReasons: [],
    governorAuthorityKey: "ethereum:0x1234567890123456789012345678901234567890",
    decisionRule: "minority-veto", minUnavoidableDelaySec: 1_209_600,
    votingPower: "holding-period-weighted", vetoQuorumBps: 200,
    vetoOverride: "symmetric-vote-destruction", enumerable: true, nonGovernorUnboundedPathKeys: [],
    votingControl: QUALIFIED_VOTING_CONTROL, diagnostics: [],
  };
  const governor = control("mint:veto-governor", "mint", {
    authority: { authorityKey: governance.governorAuthorityKey, model: "governance", threshold: null },
    capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    issuanceGovernance: governance,
  });
  const mint = makeReviewedMintInput(governor.controlKey, { reconciliation: "none", supervision: "none" });

  it.each([
    ["window one second short", { minUnavoidableDelaySec: 1_209_599 }, false],
    ["window at fourteen days", { minUnavoidableDelaySec: 1_209_600 }, true],
    ["two-percent quorum", { vetoQuorumBps: 200 }, true],
    ["quorum one basis point too high", { vetoQuorumBps: 201 }, false],
    ["holding-duration votes", { votingPower: "holding-period-weighted" }, true],
    ["escrowed votes", { votingPower: "lock-escrowed" }, true],
    ["past-block votes", { votingPower: "past-block-checkpoint" }, true],
    ["transaction-live votes", { votingPower: "live-balance" }, false],
    ["unknown votes", { votingPower: "unknown" }, false],
    ["no override", { vetoOverride: "none" }, true],
    ["unreachable certified restructure", { vetoOverride: "insolvency-gated-restructure" }, true],
    ["equal-cost vote destruction", { vetoOverride: "symmetric-vote-destruction" }, true],
    ["unknown override", { vetoOverride: "unknown" }, false],
    ["unknown window", { minUnavoidableDelaySec: null }, false],
    ["unknown quorum", { vetoQuorumBps: null }, false],
    ["missing override", { vetoOverride: null }, false],
    ["incomplete coverage", { coverage: "incomplete" }, false],
    ["unclosed review", { incompleteReasons: ["review-incomplete"] }, false],
    ["independent unbounded minter", { nonGovernorUnboundedPathKeys: ["council:mint"] }, false],
    ["unobservable admissions", { enumerable: false }, false],
  ] satisfies [string, Partial<Governance>, boolean][])(
    "qualifies %s: %s", (_name, overrides, qualified) => {
      const candidate = { ...governor, issuanceGovernance: { ...governance, ...overrides } };
      expect(isV9VetoGuardedIssuanceQualified(candidate, CONTROL_POLICY.governedIssuance)).toBe(qualified);
      expect(isV9GovernedIssuanceQualified(candidate, CONTROL_POLICY.governedIssuance)).toBe(false);
      expect(deriveV9MintPosture(candidate, mint, false, SEMANTIC_POLICY))
        .toBe(qualified ? "unbounded-veto-guarded" : "unbounded-adverse");
      expect(gradeVerifiedControlAuthority(candidate, SEMANTIC_POLICY)).toBe(qualified ? 70 : 25);
      if (!qualified) {
        for (const reconciliation of RECONCILIATION_AVAILABILITY) {
          for (const supervision of ["prudential", "attestation-only", "none", "unknown"] as const) {
            const review = makeReviewedMintInput(candidate.controlKey, { reconciliation, supervision });
            const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint: review }));
            expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
              posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-adverse",
              score: supervision === "prudential" ? 55 : 25,
            });
          }
        }
      }
    },
  );

  it("uses policy-owned minority-veto gates without granting an authority exception", () => {
    for (const change of [
      { minVetoWindowSec: 1_209_601 }, { maxVetoQuorumBps: 199 },
      { admissibleVotingPower: ["lock-escrowed"] }, { admissibleOverride: ["none"] },
    ] satisfies Partial<typeof CONTROL_POLICY.governedIssuance.minorityVeto>[]) {
      expect(isV9VetoGuardedIssuanceQualified(governor, {
        ...CONTROL_POLICY.governedIssuance,
        minorityVeto: { ...CONTROL_POLICY.governedIssuance.minorityVeto, ...change },
      })).toBe(false);
    }
  });

  it("ranks minority veto above affirmative governance and never falls back to it", () => {
    const candidate = { ...governor, issuanceGovernance: { ...governance, votingPower: "lock-escrowed" as const } };
    expect(deriveV9MintPosture(candidate, mint, false, SEMANTIC_POLICY)).toBe("unbounded-veto-guarded");
    const affirmative = { ...candidate, issuanceGovernance: {
      ...candidate.issuanceGovernance, decisionRule: "affirmative-vote" as const, vetoQuorumBps: null, vetoOverride: null,
    } };
    expect(deriveV9MintPosture(affirmative, mint, false, SEMANTIC_POLICY)).toBe("unbounded-governed");
    const failedVeto = { ...candidate, issuanceGovernance: { ...candidate.issuanceGovernance, vetoQuorumBps: 201 } };
    expect(deriveV9MintPosture(failedVeto, mint, false, SEMANTIC_POLICY)).toBe("unbounded-adverse");
  });

  it.each([
    ["continuous", "prudential", "none", "unbounded-reconciled", 80],
    ["periodic", "attestation-only", "none", "unbounded-reconciled", 70],
    ["continuous", "none", "none", "unbounded-veto-guarded", 70],
    ["none", "none", "active", "compromised", 25],
  ] as const)("preserves %s/%s/%s precedence", (reconciliation, supervision, incidentState, posture, score) => {
    const candidate = { ...governor, incidentState };
    const review = makeReviewedMintInput(candidate.controlKey, { reconciliation, supervision });
    const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint: review }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture, score });
  });

  it.each([[59, 70], [60, 79], [120, 79]] as const)(
    "seasons %i months to %i under the unchanged merged-ladder ceiling", (trackRecordMonths, score) => {
      const result = evaluateV9EconomicControl(args({ facts: facts([governor]), mint, trackRecordMonths }));
      expect(result.components.find((component) => component.kind === "mint"))
        .toMatchObject({ posture: "unbounded-veto-guarded", score });
    },
  );

  it("emits the low minority-veto signal without treating issuance as bounded", () => {
    const result = evaluateV9EconomicControl(args({ facts: facts([governor]), mint }));
    expect(result.structuralFailures).toContainEqual(expect.objectContaining({
      kind: "centralized-mint", severity: "low", binding: true, controlKeys: [governor.controlKey],
      reason: "Minting is economically unbounded but every new issuer faces a public minority-veto window.",
    }));
  });

  it.each([
    ["affirmative-vote", 200, null, "vetoQuorumBps"],
    ["affirmative-vote", null, "none", "vetoOverride"],
    ["minority-veto", null, "none", "vetoQuorumBps"],
    ["minority-veto", 200, null, "vetoOverride"],
  ] as const)("rejects inconsistent compiled %s veto facts", (decisionRule, vetoQuorumBps, vetoOverride, field) => {
    const parsed = V9DeploymentControlFactBaseSchema.shape.issuanceGovernance.safeParse({
      ...governance, decisionRule, vetoQuorumBps, vetoOverride,
    });
    expect(parsed.error?.issues).toContainEqual(expect.objectContaining({ path: [field] }));
  });
});

describe("H operational governance admission", () => {
  const process = makeOperationalIssuanceProcess();
  const governance: NonNullable<V9DeploymentControlFactV2["issuanceGovernance"]> = {
    decisionRule: "affirmative-vote", governorAuthorityKey: "ethereum:0x1234567890123456789012345678901234567890",
    coverage: "complete", incompleteReasons: [], minUnavoidableDelaySec: 0, votingPower: "lock-escrowed",
    vetoQuorumBps: null, vetoOverride: null, enumerable: true,
    nonGovernorUnboundedPathKeys: ["formula-interest", "keeper-compensation"],
    votingControl: QUALIFIED_VOTING_CONTROL, diagnostics: [],
  };
  const candidate = control("mint:operational-governor", "mint", {
    authority: { authorityKey: governance.governorAuthorityKey, model: "governance", threshold: null },
    capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    delaySec: 0, issuanceGovernance: governance, issuanceProcess: process,
  });
  const mint = makeReviewedMintInput(candidate.controlKey, { reconciliation: "none", supervision: "none" });
  const admission = (changes: Partial<V1005IssuanceProcess> = {}) =>
    isV9OperationallyGovernedIssuanceQualified({ ...candidate, issuanceProcess: { ...process, ...changes } }, SEMANTIC_POLICY);

  const processRows = [
    { row: candidate, posture: "unbounded-operationally-governed", score: 55, severity: "moderate" },
    { row: { ...candidate, issuanceProcess: undefined, issuanceGovernance: {
      ...governance, minUnavoidableDelaySec: 172800, nonGovernorUnboundedPathKeys: [],
    } }, posture: "unbounded-governed", score: 60, severity: "low" },
    { row: { ...candidate, issuanceProcess: undefined, issuanceGovernance: {
      ...governance, decisionRule: "minority-veto" as const, minUnavoidableDelaySec: 1209600,
      vetoQuorumBps: 200, vetoOverride: "none" as const, nonGovernorUnboundedPathKeys: [],
    } }, posture: "unbounded-veto-guarded", score: 70, severity: "low" },
  ];
  it.each(processRows.flatMap((processRow) => RECONCILIATIONS.flatMap((reconciliation) =>
    (["prudential", "attestation-only", "none", "unknown"] as const).map((supervision) =>
      ({ ...processRow, reconciliation, supervision })),
  )))("preserves $posture under $reconciliation/$supervision", ({ row, posture, score, severity, reconciliation, supervision }) => {
    const review = makeReviewedMintInput(row.controlKey, { reconciliation, supervision });
    const result = evaluateV9EconomicControl(args({ facts: facts([row]), mint: review }));
    const gradedReconciliation = (reconciliation === "continuous" || reconciliation === "periodic") &&
      (supervision === "prudential" || supervision === "attestation-only");
    expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
      posture: gradedReconciliation ? "unbounded-reconciled" : posture,
      score: gradedReconciliation ? supervision === "prudential" ? 80 : 70 : score,
    });
    expect(result.structuralFailures.find((failure) => failure.kind === "centralized-mint")?.severity ?? null)
      .toBe(gradedReconciliation ? supervision === "prudential" ? null : "low" : severity);
  });

  it.each([
    { maxAnnualInterestGrowthPpm: 500001 }, { maxAnnualInterestGrowthPpm: null },
    { maxKeeperProportionalRewardPpm: 1001 }, { maxKeeperProportionalRewardPpm: null },
    { keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxFixedRewardRaw: "11" } },
    { maxKeeperFixedRewardSupplyPpm: null },
    { minKeeperRecurringIntervalSec: 3599 }, { minKeeperRecurringIntervalSec: null },
    { maxKeeperRepeatRewardSupplyPpmPer86400Sec: 25000,
      keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "25000" } },
    { maxKeeperRepeatRewardSupplyPpmPer86400Sec: null },
    { minDiscretionaryPublicDelaySec: 172799 }, { minDiscretionaryPublicDelaySec: null },
    { minEnvelopeRaisePublicDelaySec: 172799 }, { minEnvelopeRaisePublicDelaySec: null },
    { minOperationalExerciseDelaySec: null },
  ] satisfies Partial<V1005IssuanceProcess>[])("falls from failed H screens to the availability-invariant matrix: %j", (change) => {
    const row = { ...candidate, issuanceProcess: { ...process, ...change } };
    expect(admission(change).qualified).toBe(false);
    for (const reconciliation of RECONCILIATION_AVAILABILITY) {
      for (const supervision of ["prudential", "attestation-only", "none", "unknown"] as const) {
        const review = makeReviewedMintInput(row.controlKey, { reconciliation, supervision });
        const result = evaluateV9EconomicControl(args({ facts: facts([row]), mint: review }));
        expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
          posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-adverse",
          score: supervision === "prudential" ? 55 : 25,
        });
      }
    }
  });

  it.each(["C", "U"] as const)("discloses real %s unknown-reconciliation factors on favorable process controls", (cause) => {
    const gap = createV9FactGapV3({
      gapId: `gap:mint-reconciliation:${cause}`, reasonCode: "unresolved-control-identity",
      ownerDomain: "control", policyRuleId: "v9.control.reconciliation", responsibility: "unresearched",
      observationState: "bounded-unknown", path: { kind: "local-component", componentKey: "economic-control:mint" },
      message: "Whole-supply reconciliation has not been established.",
      causeScope: { pillar: "control", componentKey: "economic-control:mint", factorKey: "reconciliation",
        requiredDatum: "reconciliation", routeKey: null, exposureId: null },
      causeProof: cause === "U" ? { cause, reason: "not-yet-researched", evidenceRefIds: [] } :
        { cause, proofOrigin: "typed-review", classificationId: "reconciliation-review", reviewedAt: "2026-10-01",
          sources: [{ url: "https://issuer.example/reconciliation", assertion: "Whole-supply reconciliation was researched." }],
          evidenceRefIds: ["reconciliation-review"], assertion: "researched-nondisclosure", rationale: "Whole-supply cadence is not disclosed." },
    });
    const status = { ...boundedUnknown("mint.reconciliation"), gapIds: [gap.gapId] };
    for (const { row, posture, score } of [
      ...processRows,
      { row: { ...candidate, issuanceProcess: undefined, issuanceGovernance: undefined },
        posture: "unbounded-reconciled", score: 55 },
    ]) {
      const review = makeReviewedMintInput(row.controlKey, { reconciliation: "unknown",
        supervision: posture === "unbounded-reconciled" ? "prudential" : "none",
        factorStatuses: { reconciliation: status } });
      const result = evaluateV9EconomicControl(args({ facts: facts([row], { gaps: [gap] }), mint: review }));
      expect(result.components.find((entry) => entry.kind === "mint")).toMatchObject({
        posture, score, cause, causeGapIds: [gap.gapId], scoringDisposition: "bounded-uncertainty",
      });
    }
  });

  it("derives 55 with a moderate74 cap while retaining actual immediate exercise", () => {
    expect(admission()).toEqual({ qualified: true, diagnostics: [] });
    expect(deriveV9MintPosture(candidate, mint, false, SEMANTIC_POLICY)).toBe("unbounded-operationally-governed");
    expect(gradeVerifiedControlAuthority(candidate, SEMANTIC_POLICY)).toBe(55);
    const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score: 55 });
    const signal = result.structuralFailures.find((failure) => failure.kind === "centralized-mint")!;
    expect(signal).toMatchObject({ severity: "moderate", binding: true,
      reason: "Discretionary expansion and operational-envelope changes require public token governance; formula interest and activity-bound compensation can execute immediately within reviewed envelopes. Economically unbounded." });
    const trace = scoreV9Input({
      assetId: "operational-flow-fixture", pillars: { backing: 95, exit: 95, control: 95 },
      pegScore: 100, pegApplicable: true, evidenceLevel: "strong", trackRecordMonths: 60,
      activeDepegBps: null, parentRequired: false, parentScore: null, unresolved: [],
      structuralSignals: [{ kind: "centralized-mint", severity: signal.severity, reason: signal.reason,
        responsibility: "measured-adverse", failureDomainKeys: [], evidence: [] }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(trace.bindingCap).toMatchObject({ kind: "signal:centralized-mint:moderate", limit: 74 });
    expect(candidate.issuanceProcess?.minOperationalExerciseDelaySec).toBe(0);
  });

  it.each([[59, 55], [60, 59], [120, 59]] as const)("seasons %i months to %i through the shared ladder", (trackRecordMonths, score) => {
    const result = evaluateV9EconomicControl(args({ facts: facts([candidate]), mint, trackRecordMonths }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score });
  });

  it("keeps positive merged custody credit below60 and preserves negative/incident effects", () => {
    const changed = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    changed.semantic.control.mintMergedSignals.modulesOrGuardsAdjustment.noneDetectedCredit = 10;
    const policy = loadV9MethodologyPolicy(changed);
    const knownModules = { ...candidate, modulesOrGuards: "none-detected" as const };
    expect(applyMergedMintSignals(55, knownModules, undefined, policy.policy.semantic.control)).toBe(59);
    expect(applyMergedMintSignals(59, knownModules, undefined, policy.policy.semantic.control)).toBe(59);
    expect(applyMergedMintSignals(55, { ...candidate, authority: { ...candidate.authority!, model: "eoa" } }, undefined, CONTROL_POLICY)).toBe(52);
    expect(deriveV9MintPosture({ ...candidate, incidentState: "active" }, mint, false, SEMANTIC_POLICY)).toBe("compromised");
    expect(gradeVerifiedControlAuthority({ ...candidate, incidentState: "active" }, SEMANTIC_POLICY)).toBe(25);
  });

  it.each([
    ["maxAnnualInterestGrowthPpm", 500000, 500001],
    ["maxKeeperProportionalRewardPpm", 1000, 1001],
    ["minKeeperRecurringIntervalSec", 3600, 3599],
  ] as const)("admits equality, rejects the nearest adverse unit and unknown %s", (field, equality, adverse) => {
    expect(admission({ [field]: equality }).qualified).toBe(true);
    for (const [measurement, code] of [[adverse, "operational-screen-failed"], [null, "operational-cap-unproved"]] as const) {
      const result = admission({ [field]: measurement });
      expect(result.qualified).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ gate: "H2", code, field }));
    }
  });

  it("compares fixed awards in exact raw units, not rounded display ppm", () => {
    const exactBoundary = { ...process.keeperSupplyScreenBasis!, nativeSupplyRaw: "2000000",
      maxFixedRewardRaw: "20", maxRepeatRewardRawPer86400Sec: "13792" };
    expect(admission({ keeperSupplyScreenBasis: exactBoundary }).qualified).toBe(true);
    for (const displayedPpm of [10.5, 10]) {
      expect(admission({ keeperSupplyScreenBasis: { ...exactBoundary, maxFixedRewardRaw: "21" },
        maxKeeperFixedRewardSupplyPpm: displayedPpm }).diagnostics)
        .toContainEqual(expect.objectContaining({ code: "operational-screen-failed", field: "maxKeeperFixedRewardSupplyPpm" }));
    }
    expect(admission({ keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxFixedRewardRaw: null } }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "operational-cap-unproved", field: "maxKeeperFixedRewardSupplyPpm" }));
    expect(admission({ maxKeeperFixedRewardSupplyPpm: null }).qualified).toBe(false);
  });

  it("requires interval proof only for funded recurring keeper paths", () => {
    const unfunded: Partial<V1005IssuanceProcess> = { fundedKeeperRecurringPathCount: 0,
      minKeeperRecurringIntervalSec: null, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0,
      keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "0" } };
    expect(admission(unfunded).qualified).toBe(true);
    expect(admission({ ...unfunded, fundedKeeperRecurringPathCount: 1 }).diagnostics)
      .toContainEqual(expect.objectContaining({ gate: "H2", code: "operational-cap-unproved", field: "minKeeperRecurringIntervalSec" }));
    expect(admission({ ...unfunded, fundedKeeperRecurringPathCount: 2 }).diagnostics)
      .toContainEqual(expect.objectContaining({ gate: "H0", code: "process-certificate-unavailable" }));
    expect(admission({ ...unfunded, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 1,
      keeperSupplyScreenBasis: { ...unfunded.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "1" } }).diagnostics)
      .toContainEqual(expect.objectContaining({ gate: "H0", code: "process-certificate-unavailable", field: "fundedKeeperRecurringPathCount" }));
  });

  it("uses separately upward-rounded interest/repeat terms at the reused 48h exposure boundary", () => {
    const boundary: Partial<V1005IssuanceProcess> = {
      maxAnnualInterestGrowthPpm: 365, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 24999,
      keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "24999" },
    };
    expect(admission(boundary).qualified).toBe(true); // 2 + 49998 = 50000
    expect(admission({ ...boundary, maxAnnualInterestGrowthPpm: 366 }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "operational-screen-failed", gate: "H3", field: "operationalExposurePpm" }));
    expect(admission({ ...boundary, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 25000,
      keeperSupplyScreenBasis: { ...boundary.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "25000" } }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "operational-screen-failed", gate: "H3" }));
    expect(admission({ ...boundary, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 25000,
      keeperSupplyScreenBasis: { ...boundary.keeperSupplyScreenBasis!, nativeSupplyRaw: "2000000",
        maxFixedRewardRaw: "20", maxRepeatRewardRawPer86400Sec: "49999" } }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "operational-screen-failed", gate: "H3" }));
    for (const changes of [
      { maxKeeperRepeatRewardSupplyPpmPer86400Sec: null },
      { keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: null } },
      { maxAnnualInterestGrowthPpm: null },
    ]) expect(admission(changes).diagnostics).toContainEqual(expect.objectContaining({ code: "aggregate-flow-unproved", gate: "H3" }));
    const stricter = structuredClone(SEMANTIC_POLICY);
    stricter.backing.structural.severityShares.moderate = 0.049999;
    expect(isV9OperationallyGovernedIssuanceQualified({ ...candidate, issuanceProcess: { ...process, ...boundary } }, stricter).qualified).toBe(false);
    stricter.backing.structural.severityShares.moderate = 0.05;
    stricter.control.governedIssuance.minUnavoidableDelaySec++;
    expect(isV9OperationallyGovernedIssuanceQualified({ ...candidate, issuanceProcess: { ...process, ...boundary,
      minDiscretionaryPublicDelaySec: 172801, minEnvelopeRaisePublicDelaySec: 172801 } }, stricter).qualified).toBe(false);
  });

  it("admits the certified annual-window equality and denies only an anchor one second beyond it", () => {
    const policy = structuredClone(SEMANTIC_POLICY);
    const annualWindow = policy.control.governedIssuance.operationalFlow.annualWindowSec;
    policy.control.governedIssuance.minUnavoidableDelaySec = annualWindow;
    const annual = { ...candidate, issuanceProcess: { ...process,
      minDiscretionaryPublicDelaySec: annualWindow + 1, minEnvelopeRaisePublicDelaySec: annualWindow + 1,
      maxAnnualInterestGrowthPpm: 10000, fundedKeeperRecurringPathCount: 0, minKeeperRecurringIntervalSec: null,
      maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0,
      keeperSupplyScreenBasis: { ...process.keeperSupplyScreenBasis!, maxRepeatRewardRawPer86400Sec: "0" } } };
    expect(isV9OperationallyGovernedIssuanceQualified(annual, policy).qualified).toBe(true);
    policy.control.governedIssuance.minUnavoidableDelaySec++;
    expect(isV9OperationallyGovernedIssuanceQualified(annual, policy).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "aggregate-flow-unproved", gate: "H3", field: "operationalExposurePpm" }));
    expect(deriveV9MintPosture(annual, mint, false, policy)).toBe("unbounded-adverse");
    expect(gradeVerifiedControlAuthority(annual, policy)).toBe(25);
  });

  it.each(["minDiscretionaryPublicDelaySec", "minEnvelopeRaisePublicDelaySec"] as const)("requires public172800 and rejects unknown %s", (field) => {
    expect(admission({ [field]: 172800 }).qualified).toBe(true);
    expect(admission({ [field]: 172799 }).diagnostics).toContainEqual(expect.objectContaining({ gate: "H1", code: "delay-too-short", field }));
    expect(admission({ [field]: null }).diagnostics).toContainEqual(expect.objectContaining({ gate: "H1", code: "delay-unproved", field }));
  });

  it("requires an envelope delay only when proved envelope-transition paths exist", () => {
    expect(admission({ envelopeTransitionPathCount: 0, minEnvelopeRaisePublicDelaySec: null }).qualified).toBe(true);
    expect(admission({ envelopeTransitionPathCount: 1, minEnvelopeRaisePublicDelaySec: null }).diagnostics)
      .toContainEqual(expect.objectContaining({ gate: "H1", code: "delay-unproved", field: "minEnvelopeRaisePublicDelaySec" }));
  });

  it.each([
    { inventoryComplete: false }, { authorityCoverage: "incomplete" }, { executionCoverage: "incomplete" },
    { unknownMemberCount: 1, matchedMemberCount: 2 }, { nonGovernorDiscretionaryPathKeys: ["council#mint"] },
    { formulaQualified: false }, { keeperQualified: false }, { otherClassesQualified: false },
    { unknownRecipientPathKeys: ["callback#withdraw"] },
  ] satisfies Partial<V1005IssuanceProcess>[])("does not grant a partial H rung for structural gate %j", (change) => {
    const altered = { ...candidate, issuanceProcess: { ...process, ...change } };
    expect(admission(change).qualified).toBe(false);
    expect(deriveV9MintPosture(altered, mint, false, SEMANTIC_POLICY)).toBe("unbounded-adverse");
    expect(gradeVerifiedControlAuthority(altered, SEMANTIC_POLICY)).toBe(25);
    expect(altered.capSemantics).toEqual(candidate.capSemantics);
    for (const reconciliation of RECONCILIATION_AVAILABILITY) {
      const review = { ...mint, reconciliation };
      const result = evaluateV9EconomicControl(args({ facts: facts([altered]), mint: review }));
      expect(result.components.find((entry) => entry.kind === "mint"))
        .toMatchObject({ posture: "unbounded-adverse", score: 25 });
    }
  });

  it("preserves graded reconciliation and D30/D29 precedence above adverse fallback", () => {
    const d29 = { ...candidate, issuanceGovernance: { ...governance, minUnavoidableDelaySec: 172800, nonGovernorUnboundedPathKeys: [] } };
    const d30 = { ...d29, issuanceGovernance: { ...d29.issuanceGovernance, decisionRule: "minority-veto" as const,
      minUnavoidableDelaySec: 1209600, vetoQuorumBps: 200, vetoOverride: "none" as const } };
    expect(deriveV9MintPosture(d29, mint, false, SEMANTIC_POLICY)).toBe("unbounded-governed");
    expect(deriveV9MintPosture(d30, mint, false, SEMANTIC_POLICY)).toBe("unbounded-veto-guarded");
    expect(deriveV9MintPosture(candidate, { ...mint, reconciliation: "periodic", supervision: "prudential" }, false, SEMANTIC_POLICY)).toBe("unbounded-reconciled");
    const missing = { ...candidate, issuanceProcess: undefined };
    expect(deriveV9MintPosture(missing, { ...mint, reconciliation: "periodic" }, false, SEMANTIC_POLICY)).toBe("unbounded-reconciled");
    expect(deriveV9MintPosture(missing, { ...mint, reconciliation: "unknown" }, false, SEMANTIC_POLICY)).toBe("unbounded-adverse");
    const vetoAdmission = isV9OperationallyGovernedIssuanceQualified(d30, SEMANTIC_POLICY);
    expect(vetoAdmission.diagnostics).toContainEqual(expect.objectContaining({ code: "operational-decision-rule-inadmissible", gate: "H0" }));
    expect(isV9VetoGuardedIssuanceQualified(d30, CONTROL_POLICY.governedIssuance)).toBe(true);
    expect(gradeVerifiedControlAuthority(d30, SEMANTIC_POLICY)).toBe(70);
  });

  it.each([
    { affiliatedUnilateralRouteIds: ["own-lock-route"] },
    { otherHolderVoteOperatorControllerIds: ["other-holder-key"] },
    { unknownAboveThresholdVoteOwnershipControllerIds: ["unknown-owner"] },
    { privilegedVoteCreation: "independent" }, { forcedDelegation: "unknown" },
    { censusReconciliations: [{ ...QUALIFIED_VOTING_CONTROL.censusReconciliations[0]!, accountedPowerRaw: "99" }] },
  ] satisfies Partial<V1005CompiledVotingControl>[])("requires uniformD32 even if an authored qualification flag remains true: %j", (failure) => {
    const voting = { ...QUALIFIED_VOTING_CONTROL, ...failure };
    const d29 = { ...candidate, issuanceGovernance: { ...governance, minUnavoidableDelaySec: 172800,
      nonGovernorUnboundedPathKeys: [], votingControl: voting } };
    const d30 = { ...d29, issuanceGovernance: { ...d29.issuanceGovernance, decisionRule: "minority-veto" as const,
      minUnavoidableDelaySec: 1209600, vetoQuorumBps: 200, vetoOverride: "none" as const } };
    expect(isV9GovernedIssuanceQualified(d29, CONTROL_POLICY.governedIssuance)).toBe(false);
    expect(isV9VetoGuardedIssuanceQualified(d30, CONTROL_POLICY.governedIssuance)).toBe(false);
    const result = isV9OperationallyGovernedIssuanceQualified(d29, SEMANTIC_POLICY);
    expect(result.qualified).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ gate: "D32" }));
    if ("unknownAboveThresholdVoteOwnershipControllerIds" in failure) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ gate: "D32", code: "voting-provenance-unknown" }));
    }
    for (const row of [d29, d30, { ...candidate, issuanceGovernance: { ...governance, votingControl: voting },
      issuanceProcess: { ...process, votingControl: voting } }]) {
      for (const reconciliation of RECONCILIATION_AVAILABILITY) {
        const review = { ...mint, reconciliation };
        expect(evaluateV9EconomicControl(args({ facts: facts([row]), mint: review }))
          .components.find((entry) => entry.kind === "mint")).toMatchObject({ posture: "unbounded-adverse", score: 25 });
      }
    }
  });

  it("keeps D32 denial diagnostics and credit identical for shared versus independently decoded voting objects", () => {
    const voting = { ...QUALIFIED_VOTING_CONTROL, qualified: false, otherHolderVoteOperatorControllerIds: ["operator-key"] };
    const shared = { ...candidate, issuanceGovernance: { ...governance, votingControl: voting },
      issuanceProcess: { ...process, votingControl: voting } };
    const decoded = structuredClone(shared);
    decoded.issuanceProcess.votingControl = structuredClone(decoded.issuanceGovernance.votingControl);
    const result = isV9OperationallyGovernedIssuanceQualified(shared, SEMANTIC_POLICY);
    expect(result.qualified).toBe(false);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "voting-other-holder-operator")).toHaveLength(1);
    expect(isV9OperationallyGovernedIssuanceQualified(decoded, SEMANTIC_POLICY)).toEqual(result);
    expect(evaluateV9EconomicControl(args({ facts: facts([shared]), mint })).components.find((component) => component.kind === "mint"))
      .toMatchObject({ posture: "unbounded-adverse", score: 25 });
    expect(evaluateV9EconomicControl(args({ facts: facts([decoded]), mint })).processDiagnostics)
      .toEqual(evaluateV9EconomicControl(args({ facts: facts([shared]), mint })).processDiagnostics);
  });

  it("retains typed D32 denial provenance instead of relabeling it as missing evidence", () => {
    const diagnostic = { gate: "D32", code: "voting-other-holder-operator", controlRef: null,
      pathId: "operator-vote-path", classId: null, memberRef: null,
      field: "controller:other-holder-key", evidenceRefIds: ["ev:operator-control"] } as const;
    const voting = { ...QUALIFIED_VOTING_CONTROL, qualified: false, diagnostics: [{ ...diagnostic, evidenceRefIds: [...diagnostic.evidenceRefIds] }] };
    const denied = { ...candidate, issuanceGovernance: { ...governance, votingControl: voting },
      issuanceProcess: { ...process, votingControl: voting } };
    expect(isV9OperationallyGovernedIssuanceQualified(denied, SEMANTIC_POLICY).diagnostics).toContainEqual(diagnostic);
  });

  it("anchors measured policy denial to the normalized control identity", () => {
    const controlRef = `ethereum:0x${"a".repeat(40)}`;
    const denied = { ...candidate, authority: { ...candidate.authority!, authorityKey: `Ethereum:0x${"A".repeat(40)}` },
      issuanceProcess: { ...process, minKeeperRecurringIntervalSec: 3599 } };
    expect(isV9OperationallyGovernedIssuanceQualified(denied, SEMANTIC_POLICY).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "operational-screen-failed", gate: "H2", controlRef,
        field: "minKeeperRecurringIntervalSec" }));
  });

  it("publishes evaluator screen failure without mutating complete compiler evidence", () => {
    const failed = { ...candidate, issuanceProcess: { ...process, maxAnnualInterestGrowthPpm: 500001 } };
    const before = structuredClone(failed);
    const result = evaluateV9EconomicControl(args({ facts: facts([failed]), mint }));
    expect(result.processDiagnostics).toContainEqual(expect.objectContaining({ code: "operational-screen-failed", field: "maxAnnualInterestGrowthPpm" }));
    expect(result.components.find((component) => component.kind === "mint")?.score).toBe(25);
    expect(failed).toEqual(before);
    expect(failed.issuanceProcess.coverage).toBe("complete");
  });

  it("binds asset-wide issuance evidence exactly without copying it onto referenced rows", () => {
    const issuanceFacts = { ref: "modeled-book:H", governance, process, diagnostics: [] };
    const referenced = { ...candidate, issuanceFactsRef: issuanceFacts.ref,
      issuanceGovernance: undefined, issuanceProcess: undefined, processDiagnostics: undefined };
    expect(isV9OperationallyGovernedIssuanceQualified(referenced, SEMANTIC_POLICY, issuanceFacts).qualified).toBe(true);
    expect(deriveV9MintPosture(referenced, mint, false, SEMANTIC_POLICY, issuanceFacts)).toBe("unbounded-operationally-governed");
    expect(gradeVerifiedControlAuthority(referenced, SEMANTIC_POLICY, undefined, issuanceFacts)).toBe(55);
    const result = evaluateV9EconomicControl(args({ facts: { ...facts([referenced]), issuanceFacts }, mint }));
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score: 55 });
    expect(result.issuanceFacts).toBe(issuanceFacts);
    expect(result.controlFacts![0]!.issuanceFactsRef).toBe(issuanceFacts.ref);
    expect(result.controlFacts![0]!.issuanceProcess).toBeUndefined();
    for (const shared of [undefined, { ...issuanceFacts, ref: "different-book" }]) {
      expect(isV9OperationallyGovernedIssuanceQualified(referenced, SEMANTIC_POLICY, shared).qualified).toBe(false);
      expect(gradeVerifiedControlAuthority(referenced, SEMANTIC_POLICY, undefined, shared)).toBe(25);
    }
    expect(isV9OperationallyGovernedIssuanceQualified({ ...referenced, issuanceProcess: process },
      SEMANTIC_POLICY, issuanceFacts).qualified).toBe(false);
    const failed = isV9OperationallyGovernedIssuanceQualified(referenced, SEMANTIC_POLICY,
      { ...issuanceFacts, process: { ...process, maxAnnualInterestGrowthPpm: 500001 } });
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ code: "operational-screen-failed",
      field: "maxAnnualInterestGrowthPpm", issuanceFactsRef: issuanceFacts.ref, evidenceRefIds: [] }));
  });

  it.each([
    { decisionRule: "affirmative-vote" as const, delay: 172800, vetoQuorumBps: null, vetoOverride: null,
      posture: "unbounded-governed", score: 60 },
    { decisionRule: "minority-veto" as const, delay: 1209600, vetoQuorumBps: 200, vetoOverride: "none" as const,
      posture: "unbounded-veto-guarded", score: 70 },
  ])("retains $posture credit on exact shared governance and denies a mismatched bundle", (scenario) => {
    const issuanceFacts = {
      ref: "modeled-book:governance-only", diagnostics: [],
      governance: { ...governance, decisionRule: scenario.decisionRule,
        minUnavoidableDelaySec: scenario.delay, nonGovernorUnboundedPathKeys: [],
        vetoQuorumBps: scenario.vetoQuorumBps, vetoOverride: scenario.vetoOverride },
    };
    const referenced = { ...candidate, issuanceFactsRef: issuanceFacts.ref,
      issuanceGovernance: undefined, issuanceProcess: undefined, processDiagnostics: undefined };
    const evaluate = (shared = issuanceFacts) => evaluateV9EconomicControl(
      args({ facts: { ...facts([referenced]), issuanceFacts: shared }, mint }));
    expect(evaluate().components.find((component) => component.kind === "mint"))
      .toMatchObject({ posture: scenario.posture, score: scenario.score });
    expect(evaluate({ ...issuanceFacts, ref: "different-book" }).components
      .find((component) => component.kind === "mint"))
      .toMatchObject({ posture: "unbounded-adverse", score: 25 });
  });
});
