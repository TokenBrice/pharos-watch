import { describe, expect, it, vi } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
} from "../safety-score-v9/control";
import { evaluateV9SubthresholdUnresolvedBridgeJoins } from "../safety-score-v9/control-bridge-join";
import type {
  V9BridgeControlReview,
  V9EconomicControlAssetFacts,
  V9MintMechanismReview,
  V9OracleControlReview,
} from "../safety-score-v9/control-primitives";
import { loadV9MethodologyPolicy, unknownQuality, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { gradeEconomicControlAuthority } from "../safety-score-v9/control-mint-grade";
import { reviewedScope, SCOPE_CONTROLLER } from "./safety-score-v9-control-scope.test-support";
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as facts,
  makeDeploymentControl as control,
  makeReviewedMintInput,
  makeSupplyPartition,
  noBridgeReview as noBridge,
  noMintReview as noMint,
  requiredKnown,
  stale,
  makeCompiledVotingControl,
} from "./safety-score-v9-fixtures.test-support";

const SEMANTIC_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic;

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

describe("Safety Score v9 economic control", () => {
  it("canonically evaluates shuffled facts and reviews without mutating its input", () => {
    const mintControl = control("mint:z", "mint");
    const bridges = ["z", "a"].map((key) => control(`bridge:${key}`, "bridge", {
      deploymentKey: `ethereum:${key}`, scope: "deployment", economicLossScope: "deployment",
      materialSupplyShare: 0.5,
    }));
    const input = args({
      facts: { ...facts([mintControl, ...bridges]), supply: makeSupplyPartition({
        status: requiredKnown("supply"), selectedRouteSupplyShare: 1, unknownRouteSupplyShare: 0,
        unreviewedRouteSupplyShare: 0, routes: bridges.map((item) => ({
          deploymentRouteKey: item.deploymentKey, supplyUsd: 50, supplyShare: 0.5,
          reviewState: "selected-reviewed", reviewedRouteKind: "controlled",
        })),
      }) },
      mint: boundedMint(mintControl.controlKey),
      oracle: { status: requiredKnown("oracle"), tier: "single-source-or-laggy",
        branches: (["liquidation", "feed"] as const).map((branch) => ({
          branch, status: requiredKnown(`oracle.${branch}`), controlKey: null,
          mechanismKey: "mechanism:core", inheritedFromAssetId: null,
        })) },
      bridge: { status: requiredKnown("bridge"), routes: bridges.map((item) => ({
        controlKey: item.controlKey, tier: "issuer-native-burn-mint",
      })) },
    });
    const before = structuredClone(input);
    const shuffled = { ...input,
      facts: { ...input.facts, controls: [...input.facts.controls].reverse(),
        supply: { ...input.facts.supply, selectedBridgeRoutes: [...input.facts.supply.selectedBridgeRoutes].reverse() } },
      oracle: { ...input.oracle, branches: [...input.oracle.branches].reverse() },
      bridge: { ...input.bridge, routes: [...input.bridge.routes].reverse() },
    };
    const shuffledBefore = structuredClone(shuffled);
    expect(evaluateV9EconomicControl(input)).toEqual(evaluateV9EconomicControl(shuffled));
    expect(input).toEqual(before);
    expect(shuffled).toEqual(shuffledBefore);
    expect(() => evaluateV9EconomicControl({ ...input, policy: {} as never })).toThrow();
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
    warn.mockRestore();
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

    expect(result).toMatchObject({ score: 90, state: "rated", reasons: [] });
    expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
      posture: "none-resolved",
      binding: true,
    });
  });


  it("omits a not-applicable oracle instead of manufacturing a scored control", () => {
    const result = evaluateV9EconomicControl(args());

    expect(result.components.some((component) => component.kind === "oracle")).toBe(false);
    expect(result).toMatchObject({ score: 90, state: "rated", oracleApplicability: "not-applicable" });
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
    // The scoped weak branch remains a diagnostic alongside the measured tier.
    expect(result.structuralFailures.filter((failure) => failure.kind === "weak-oracle-branch")).toEqual([
      expect.objectContaining({
        kind: "weak-oracle-branch",
        severity: "moderate",
        binding: true,
        controlKeys: [],
        failureDomains: [{ kind: "oracle-feed", key: "oracle:crvusd-fixture:sub-material-weak" }],
      }),
    ]);
    expect(result.score).not.toBeNull();
  });

  it("retains a known material weak oracle tier and its high diagnostic", () => {
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

    expect(result).toMatchObject({ score: 50, state: "rated", reasons: [] });
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





  it("bounds a stale material control with a non-critical reason instead of failing closed", () => {
    const staleMintControl = control("mint:stale", "mint", { status: stale("mint-control") });
    const result = evaluateV9EconomicControl(
      args({ facts: facts([staleMintControl]), mint: boundedMint(staleMintControl.controlKey) }),
    );

    expect(result).toMatchObject({ score: 65, state: "rated" });
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

    expect(result).toMatchObject({ score: 60, state: "rated" });
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
      score: unknownQuality("control", "U"),
      state: "rated",
    });
    expect(result.components.map((component) => component.componentKey).sort()).toEqual([
      "bridge:unverified",
      "mint:upgrade",
      "oracle",
    ]);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.every((reason) => !reason.critical)).toBe(true);
  });

  it.each(["bounded-unknown", "stale", "missing"] as const)(
    "retains each authority's unknown or adverse facts when the aggregate review is %s",
    (observationState) => {
      const root = control("mint:healthy-root", "mint");
      const unknown = control("mint:unreviewed", "mint", {
        status: { ...boundedUnknown("mint:unreviewed"), evidenceRefIds: [] },
        authority: null,
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

    expect(peripheral.score).not.toBeNull();
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
    expect(scoped.score).not.toBeNull();
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
    expect(nonAdverse.score).not.toBeNull();
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

    expect(result).toMatchObject({ state: "rated", reasons: [] });
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

    expect(result).toMatchObject({ state: "rated", reasons: [] });
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
    expect(result).toMatchObject({ state: "rated" });
  });

  it("treats a deployment absent from a complete partition as zero share for a null-share control", () => {
    const { result } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.absent);

    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ state: "rated" });
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
    expect(result.components.some((component) => component.kind === "inventory")).toBe(false);
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
      expect.objectContaining({ kind: "bridge", binding: true }),
    );
    expect(result.score).toBe(unknownQuality("control", "U"));
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
    expect(peripheral.score).not.toBeNull();

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
    expect(absent.score).not.toBeNull();

    // Pool at 9.99% without any joined control: the proof tolerates it as an
    // accepted bounded row without surfacing an unresolved producer reason.
    const smooth = resultFor(0.0999, { withPoolControl: false });
    expect(smooth.reasons).toEqual([]);
    expect(smooth.score).not.toBeNull();

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
    expect(floorWithControl.score).not.toBeNull();

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

    expect(result).toMatchObject({ state: "rated" });
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


describe("one economic-authority ladder", () => {
  const unbounded = (overrides: Partial<V9DeploymentControlFactV2> = {}) => control("authority:synthetic", "mint", {
    capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    delaySec: null, authority: { authorityKey: SCOPE_CONTROLLER, model: "eoa", threshold: null }, ...overrides,
  });
  const quality = (row: V9DeploymentControlFactV2, mint = makeReviewedMintInput(row.controlKey)) =>
    gradeEconomicControlAuthority(row, mint, SEMANTIC_POLICY);

  it("orders verified single keys, opaque controllers and verified quorums without invented delays", () => {
    const single = unbounded();
    const opaque = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null } });
    const quorum = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "multisig", threshold: { required: 2, total: 3 } } });
    expect([quality(single), quality(opaque), quality(quorum)]).toEqual([50, 60, 65]);
    expect(quality({ ...quorum, delaySec: 86400 })).toBe(65);
    expect(quality({ ...quorum, authority: { ...quorum.authority!, threshold: null } })).toBe(60);
    expect(quality({ ...quorum, authority: { ...quorum.authority!, threshold: { required: 1, total: 3 } } })).toBe(50);
  });

  it("gives the same two controller graphs the same score independent of asset identity", () => {
    const scope = reviewedScope();
    const row = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null },
      executionScope: scope, executionScopeComplete: true });
    const scores = ["synthetic-vault-alpha", "synthetic-vault-beta"].map((assetId) =>
      evaluateV9EconomicControl(args({ facts: facts([row], { assetId }), mint: makeReviewedMintInput(row.controlKey) })).score);
    expect(scores).toEqual([60, 60]);
  });

  it("changes each bound or assurance fact by at most fifteen and never lets an issuer exceed immutable quality", () => {
    const scope = reviewedScope();
    scope.paths[0]!.claimImpairment = "bounded";
    scope.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } };
    const row = unbounded({ claimImpairment: "bounded", capSemantics: scope.paths[0]!.capSemantics,
      executionScope: scope, executionScopeComplete: true });
    const mint = makeReviewedMintInput(row.controlKey, { reconciliation: "none", supervision: "none" });
    const base = quality(row, mint);
    expect(base).toBe(60);
    expect(base - quality({ ...row, capSemantics: { kind: "unbounded", bound: null } }, mint)).toBe(10);
    expect(quality(row, { ...mint, reconciliation: "continuous" }) - base).toBe(15);
    expect(quality(row, { ...mint, supervision: "prudential" }) - base).toBe(15);
    expect(quality(row, { ...mint, supervision: "attestation-only" }) - base).toBe(10);
    const opaque = { ...row, authority: { authorityKey: SCOPE_CONTROLLER, model: "contract" as const, threshold: null } };
    expect(quality(opaque, { ...mint, reconciliation: "continuous", supervision: "prudential" })).toBe(90);
    expect(quality(opaque, { ...mint, reconciliation: "internal-ledger", supervision: "none" })).toBe(70);
    expect(quality(opaque, { ...mint, reconciliation: "unknown", supervision: "unknown" })).toBe(70);
  });

  it("does not let a bounded deposit leaf conceal a reachable unbounded accountant or upgrade root", () => {
    const scope = reviewedScope();
    const leaf = scope.paths[0]!;
    leaf.claimImpairment = "bounded";
    leaf.capSemantics = { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } };
    const row = unbounded({ claimImpairment: "bounded", capSemantics: leaf.capSemantics,
      executionScope: scope, executionScopeComplete: true });
    expect(quality(row)).toBe(60);
    leaf.upgradeRefs = ["allocator"];
    scope.paths.push({ ...leaf, id: "allocator", upgradeRefs: [], capabilities: ["parameter-change"],
      claimImpairment: "unbounded", capSemantics: { kind: "unbounded", bound: null }, unavoidableDelaySec: 0 });
    expect(quality(row)).toBe(50);
    expect(quality({ ...row, authority: { authorityKey: SCOPE_CONTROLLER, model: "multisig", threshold: { required: 2, total: 3 } },
      delaySec: 86400 })).toBe(65);
  });

  it.each(["upgrade", "custody", "governance"] as const)("makes an independently admitted %s dilution path compete with an immutable mint", (kind) => {
    const row = unbounded({ controlKey: `authority:${kind}`, controlKind: kind,
      capabilities: kind === "upgrade" ? ["upgrade"] : kind === "custody" ? ["custody-transfer"] : ["parameter-change"] });
    const result = evaluateV9EconomicControl(args({ facts: facts([row]), mint: noMint() }));
    expect(result.score).toBe(50);
    expect(result.components).toContainEqual(expect.objectContaining({ kind: "mint", score: 50, controlKeys: [row.controlKey] }));
  });

  it("keeps an active compromise at twenty-five despite missing process and favorable assurance", () => {
    const row = unbounded({ incidentState: "active", status: boundedUnknown("authority:incident") });
    const mint = makeReviewedMintInput(row.controlKey, { status: boundedUnknown("mint:incident"),
      reconciliation: "continuous", supervision: "prudential" });
    expect(evaluateV9EconomicControl(args({ facts: facts([row]), mint })).score).toBe(25);
  });

  it("treats an access-only freeze as disclosure, not economic authority", () => {
    const baseline = evaluateV9EconomicControl(args());
    const freeze = control("access:freeze", "freeze", { incidentState: "active" });
    const result = evaluateV9EconomicControl(args({ facts: facts([freeze]) }));
    expect(result.score).toBe(baseline.score);
    expect(result.structuralFailures).toEqual([]);
    expect(result.components.some((component) => component.controlKeys.includes(freeze.controlKey))).toBe(false);
  });

  it.each([{ cause: "C", expected: 50 }, { cause: "U", expected: 60 }] as const)(
    "prices an unknown controller under $cause once, preserving independent facts", ({ cause, expected }) => {
      const gap = createV9FactGapV3({
        gapId: `controller:${cause}`, reasonCode: "unresolved-control-identity", ownerDomain: "control",
        policyRuleId: "control.controller", observationState: "bounded-unknown", responsibility: "unresearched",
        path: { kind: "local-component", componentKey: "control:authority:synthetic" }, message: "Controller review gap.",
        causeProof: cause === "U" ? { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] } : {
          cause: "C", classificationId: "controller:research", proofOrigin: "typed-review", reviewedAt: "2026-10-01",
          assertion: "researched-nondisclosure", evidenceRefIds: ["controller:source"],
          rationale: "Current primary documentation does not disclose the effective controller.",
          sources: [{ url: "https://example.com/controller", location: "Controller",
            excerpt: "Controller is undisclosed.", assertion: "Effective controller is not disclosed." }],
        },
      });
      const status = { ...boundedUnknown(), gapIds: [gap.gapId] };
      const row = unbounded({ authority: null, status, factorStatuses: { authority: status } });
      const mint = makeReviewedMintInput(row.controlKey, { reconciliation: "none", supervision: "none" });
      const result = evaluateV9EconomicControl(args({ facts: facts([row], { gaps: [gap] }), mint }));
      expect(result.score).toBe(expected);
      expect(evaluateV9EconomicControl(args({ facts: facts([row], { gaps: [gap] }),
        mint: { ...mint, reconciliation: "continuous" } })).score).toBe(expected + 15);
    },
  );

  it("retains the same known authority when only the wider review becomes partial", () => {
    const row = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "multisig", threshold: { required: 2, total: 3 } } });
    const mint = makeReviewedMintInput(row.controlKey);
    const baseline = evaluateV9EconomicControl(args({ facts: facts([row]), mint })).score;
    expect(baseline).toBe(65);
    expect(evaluateV9EconomicControl(args({ facts: facts([row]),
      mint: { ...mint, status: boundedUnknown("mint:partial") } })).score).toBe(baseline);
  });
});

describe("independent authority proofs and incident recovery", () => {
  it("separates verified quorum and unavoidable delay from public governance", () => {
    const scope = reviewedScope();
    scope.paths[0]!.capSemantics = { kind: "unbounded", bound: null };
    scope.paths[0]!.claimImpairment = "unbounded";
    scope.paths[0]!.unavoidableDelaySec = 172800;
    const row = control("authority:delayed", "mint", { executionScope: scope, executionScopeComplete: true,
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", delaySec: 172800 });
    const mint = makeReviewedMintInput(row.controlKey);
    expect(gradeEconomicControlAuthority(row, mint, SEMANTIC_POLICY)).toBe(70);
    expect(gradeEconomicControlAuthority({ ...row, executionScopeComplete: false }, mint, SEMANTIC_POLICY)).toBe(65);
    const governor = { ...row, authority: { authorityKey: SCOPE_CONTROLLER, model: "governance" as const, threshold: null },
      issuanceGovernance: {
        coverage: "complete" as const, incompleteReasons: [], governorAuthorityKey: SCOPE_CONTROLLER,
        decisionRule: "affirmative-vote" as const, minUnavoidableDelaySec: 172800,
        votingPower: "past-block-checkpoint" as const, vetoQuorumBps: null, vetoOverride: null,
        enumerable: true, nonGovernorUnboundedPathKeys: [], votingControl: makeCompiledVotingControl(), diagnostics: [],
      },
    };
    expect(gradeEconomicControlAuthority(governor, mint, SEMANTIC_POLICY)).toBe(75);
    expect(gradeEconomicControlAuthority({ ...governor, issuanceGovernance: {
      ...governor.issuanceGovernance, minUnavoidableDelaySec: 0,
    } }, mint, SEMANTIC_POLICY)).toBe(65);
    expect(gradeEconomicControlAuthority({ ...governor, issuanceGovernance: {
      ...governor.issuanceGovernance, votingControl: makeCompiledVotingControl({ qualified: false }),
    } }, mint, SEMANTIC_POLICY)).toBe(60);
  });

  it("retains bounded recovery of a resolved authority failure without seasoning credits", () => {
    const row = control("authority:history", "mint", { incidentState: "resolved" });
    const mint = makeReviewedMintInput(row.controlKey, { reconciliation: "continuous", supervision: "prudential" });
    const recent = evaluateV9EconomicControl(args({ facts: facts([row]), mint, resolvedIncidentAgeMonths: 0 }));
    const old = evaluateV9EconomicControl(args({ facts: facts([row]), mint, resolvedIncidentAgeMonths: 60 }));
    expect(recent.score).toBe(55);
    expect(old.score).toBe(85);
    expect(evaluateV9EconomicControl(args({ facts: facts([{ ...row, incidentState: "active" }]), mint,
      resolvedIncidentAgeMonths: 60 })).score).toBe(25);
  });
});
