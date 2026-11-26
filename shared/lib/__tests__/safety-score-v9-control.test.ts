import { describe, expect, it, vi } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { evaluateV9SubthresholdUnresolvedBridgeJoins } from "../safety-score-v9/control-bridge-join";
import type { V9BridgeControlReview, V9EconomicControlAssetFacts, V9MintMechanismReview, V9OracleControlReview } from "../safety-score-v9/control-primitives";
import { loadV9MethodologyPolicy, unknownQuality, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import {
  isV9BridgeRouteComponentFor,
  isV9DeploymentControlComponentKey,
  v9BridgeMintComponentKey,
  v9BridgeMintControlKey,
  v9BridgeRouteComponentKey,
  v9BridgeRouteDeploymentKey,
  v9ControlChainLabel,
  v9DeploymentMintComponentKey,
} from "../safety-score-v9/control-component-keys";
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
  makeOperationalIssuanceProcess,
} from "./safety-score-v9-fixtures.test-support";

const P = V9_CANDIDATE_POLICY_V1;
const SEMANTIC_POLICY = P.policy.semantic;
const MAT = SEMANTIC_POLICY.materiality;
const DEP_THRESHOLD = MAT.deploymentMaterialSharePct / 100;
const UNRES_THRESHOLD = MAT.unresolvedDeploymentFullCeilingSharePct / 100;

const evaluate = (overrides: Parameters<typeof args>[0] = {}) => evaluateV9EconomicControl(args(overrides));
const boundedMint = (controlKey = "mint:primary"): V9MintMechanismReview => makeReviewedMintInput(controlKey);
const depBridge = (key: string, overrides: Partial<V9DeploymentControlFactV2> = {}) =>
  control(key, "bridge", { scope: "deployment", economicLossScope: "deployment", ...overrides });
const unknownPoolBridge = (controlKey: string, deploymentKey: string, materialSupplyShare: number | null, statusKey: string) =>
  depBridge(controlKey, {
    deploymentKey, capabilities: [], capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown",
    authority: { authorityKey: `bridge-route:${deploymentKey}`, model: "unknown", threshold: null },
    materialSupplyShare, incidentState: "unknown", status: boundedUnknown(statusKey),
  });
const reviewedBridge = (routes: V9BridgeControlReview["routes"]): V9BridgeControlReview => ({ status: requiredKnown("bridge"), routes });
const reasonCodes = (r: ReturnType<typeof evaluate>) => r.reasons.map((x) => x.code);
const comp = (r: ReturnType<typeof evaluate>, kind: string) => r.components.find((c) => c.kind === kind);
const joinCheck = (
  economicFacts: V9EconomicControlAssetFacts,
  controls: readonly V9DeploymentControlFactV2[],
  routes: V9BridgeControlReview["routes"],
) => evaluateV9SubthresholdUnresolvedBridgeJoins(economicFacts, controls, routes, DEP_THRESHOLD, MAT.commonModeShareThreshold, UNRES_THRESHOLD);

const cdpOracleBranches = (controlKey: string): V9OracleControlReview["branches"] =>
  (["feed", "collateral-parameter", "liquidation", "backstop", "shutdown-bad-debt"] as const).map((branch) => ({
    branch, status: requiredKnown(`oracle.${branch}`), controlKey, mechanismKey: "mechanism:cdp-core", inheritedFromAssetId: null,
  }));

type NullShareDeploymentScenario = {
  controlKey: string; deploymentKey: string; status: V9DeploymentControlFactV2["status"];
  gapShare: number | null; includeGapRow: boolean; reviewedBridge: boolean;
};

function nullShareDeploymentScenario(scenario: NullShareDeploymentScenario) {
  const { controlKey, deploymentKey, gapShare, includeGapRow, reviewedBridge: isReviewed, status } = scenario;
  const nullShareBridge = depBridge(controlKey, { deploymentKey, materialSupplyShare: null, status });
  const reviewedShare = gapShare === null ? null : 1 - gapShare;
  const selectedBridgeRoutes = reviewedShare === null ? [] : [
    { deploymentRouteKey: "ethereum:0xcanonical", supplyUsd: reviewedShare * 100, supplyShare: reviewedShare, reviewState: "selected-reviewed" as const, reviewedRouteKind: "native" as const },
    ...(includeGapRow ? [{ deploymentRouteKey: deploymentKey, supplyUsd: (gapShare ?? 0) * 100, supplyShare: gapShare ?? 0, reviewState: "unmatched" as const }] : []),
  ];
  return {
    nullShareBridge,
    result: evaluate({
      facts: {
        ...facts([nullShareBridge]), controlStatus: requiredKnown("controls"),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"), routes: selectedBridgeRoutes,
          selectedRouteSupplyShare: reviewedShare, unknownRouteSupplyShare: gapShare, unreviewedRouteSupplyShare: gapShare === null ? null : 0,
        }),
      },
      ...(isReviewed ? { bridge: reviewedBridge([{ controlKey: nullShareBridge.controlKey, tier: "issuer-native-burn-mint" }]) } : {}),
    }),
  };
}

const NULL_SHARE_DEPLOYMENT_SCENARIOS = {
  subthreshold: { controlKey: "bridge:null-share-subthreshold", deploymentKey: "solana:gapdeployment", status: boundedUnknown("control.null-share-subthreshold"), gapShare: DEP_THRESHOLD - 0.001, includeGapRow: true, reviewedBridge: false },
  absent: { controlKey: "bridge:null-share-absent-row", deploymentKey: "solana:absentdeployment", status: boundedUnknown("control.null-share-absent-row"), gapShare: 0, includeGapRow: false, reviewedBridge: false },
  material: { controlKey: "bridge:null-share-material", deploymentKey: "solana:materialdeployment", status: boundedUnknown("control.null-share-material"), gapShare: DEP_THRESHOLD + 0.05, includeGapRow: true, reviewedBridge: false },
  noPartition: { controlKey: "bridge:null-share-no-partition", deploymentKey: "solana:unpartitioned", status: boundedUnknown("control.null-share-no-partition"), gapShare: null, includeGapRow: false, reviewedBridge: false },
  inventorySubthreshold: { controlKey: "bridge:inventory-null-share", deploymentKey: "solana:inventorygap", status: boundedUnknown("control.inventory-null-share"), gapShare: DEP_THRESHOLD - 0.001, includeGapRow: true, reviewedBridge: true },
  inventoryKnownSubthreshold: { controlKey: "bridge:inventory-known-null-share", deploymentKey: "solana:knowninventorygap", status: requiredKnown("control.inventory-known-null-share"), gapShare: DEP_THRESHOLD - 0.001, includeGapRow: true, reviewedBridge: true },
} satisfies Record<string, NullShareDeploymentScenario>;

type ChainLabelPoolOptions = { withPoolControl?: boolean; namedUnmatched?: { key: string; share: number; withControl?: boolean }[] };

function chainLabelPoolResult(assetId: string, poolShare: number | null, { withPoolControl = true, namedUnmatched = [] }: ChainLabelPoolOptions = {}) {
  const poolKey = `unmatched-chain-label-pool:${assetId}`;
  const namedShare = namedUnmatched.reduce((sum, row) => sum + row.share, 0);
  const reviewedShare = 1 - (poolShare ?? 0) - namedShare;
  const reviewedControl = depBridge("bridge:reviewed-route", { deploymentKey: "ethereum:0xreviewed", materialSupplyShare: reviewedShare, status: requiredKnown("control.reviewed-route") });
  const controls = [
    reviewedControl,
    ...(poolShare !== null && withPoolControl ? [unknownPoolBridge("bridge-supply:pool", poolKey, poolShare, "control.pool")] : []),
    ...namedUnmatched.filter((r) => r.withControl !== false).map((r, i) => unknownPoolBridge(`bridge-supply:named-${i}`, r.key, r.share, `control.named-${i}`)),
  ];
  return evaluate({
    facts: {
      ...facts(controls), assetId,
      supply: makeSupplyPartition({
        status: requiredKnown("supply"),
        routes: [
          { deploymentRouteKey: reviewedControl.deploymentKey, supplyUsd: reviewedShare * 100, supplyShare: reviewedShare, reviewState: "selected-reviewed", reviewedRouteKind: "controlled" },
          ...(poolShare !== null ? [{ deploymentRouteKey: poolKey, supplyUsd: poolShare * 100, supplyShare: poolShare, reviewState: "unmatched" as const }] : []),
          ...namedUnmatched.map((r) => ({ deploymentRouteKey: r.key, supplyUsd: r.share * 100, supplyShare: r.share, reviewState: "unmatched" as const })),
        ],
        selectedRouteSupplyShare: reviewedShare, unknownRouteSupplyShare: (poolShare ?? 0) + namedShare, unreviewedRouteSupplyShare: 0,
      }),
    },
    bridge: reviewedBridge([{ controlKey: reviewedControl.controlKey, tier: "issuer-native-burn-mint" }]),
  });
}

describe("Safety Score v9 economic control", () => {
  it("caps the whole pillar at immutable quality even with only higher-scoring non-authority components", () => {
    const deploymentMint = control("mint:deployment", "mint", { scope: "deployment", economicLossScope: "deployment", materialSupplyShare: 0.01 });
    const result = evaluate({ facts: facts([deploymentMint]), mint: boundedMint(deploymentMint.controlKey) });
    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:native", score: 95, binding: true }));
    expect(result.components.filter((c) => c.binding).every((c) => c.kind !== "mint" && c.score !== null && c.score > 90)).toBe(true);
    expect(result).toMatchObject({ score: 90, state: "rated" });
  });

  it("canonically evaluates shuffled facts and reviews without mutating its input", () => {
    const mintControl = control("mint:z", "mint");
    const bridges = ["z", "a"].map((key) => depBridge(`bridge:${key}`, { deploymentKey: `ethereum:${key}`, materialSupplyShare: 0.5 }));
    const input = args({
      facts: {
        ...facts([mintControl, control("custody:a", "custody"), ...bridges]),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"), selectedRouteSupplyShare: 1, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0,
          routes: bridges.map((item) => ({ deploymentRouteKey: item.deploymentKey, supplyUsd: 50, supplyShare: 0.5, reviewState: "selected-reviewed", reviewedRouteKind: "controlled" })),
        }),
      },
      mint: boundedMint(mintControl.controlKey),
      oracle: {
        status: requiredKnown("oracle"), tier: "single-source-or-laggy",
        branches: (["liquidation", "feed"] as const).map((branch) => ({ branch, status: requiredKnown(`oracle.${branch}`), controlKey: null, mechanismKey: "mechanism:core", inheritedFromAssetId: null })),
      },
      bridge: reviewedBridge(bridges.map((item) => ({ controlKey: item.controlKey, tier: "issuer-native-burn-mint" }))),
    });
    const before = structuredClone(input);
    const shuffled = {
      ...input,
      facts: { ...input.facts, controls: [...input.facts.controls].reverse(), supply: { ...input.facts.supply, selectedBridgeRoutes: [...input.facts.supply.selectedBridgeRoutes].reverse() } },
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
    const rounded = control("mint:rounding", "mint", { incidentState: "active", materialSupplyShare: 1.0000000000000002 });
    const result = evaluate({ facts: facts([rounded]), mint: noMint() });
    expect(result.structuralFailures.find((f) => f.kind === "active-control-incident")?.materialSharePct).toBe(100);
    warn.mockRestore();
  });

  it("treats a reviewed non-claiming mint surface as not applicable", () => {
    const burnOnly = control("mint:burn-only", "mint", {
      capabilities: ["burn"], capSemantics: { kind: "not-applicable", bound: null },
      claimImpairment: "none", economicLossScope: "access-only", authority: { authorityKey: "authority:none", model: "none", threshold: null },
    });
    const result = evaluate({ facts: facts([burnOnly]), mint: boundedMint(burnOnly.controlKey) });
    expect(result).toMatchObject({ score: 90, state: "rated", reasons: [] });
    expect(comp(result, "mint")).toMatchObject({ posture: "none-resolved", binding: true });
  });

  it("omits a not-applicable oracle and scores privileged top-level pricing without requiring liquidation branches", () => {
    const omitted = evaluate();
    expect(comp(omitted, "oracle")).toBeUndefined();
    expect(omitted).toMatchObject({ score: 90, state: "rated", oracleApplicability: "not-applicable" });

    const privileged = evaluate({ oracle: { status: requiredKnown("oracle"), tier: "privileged-internal-pricing", liquidationBranchesApplicable: false, branches: [] } });
    expect(comp(privileged, "oracle")).toMatchObject({ posture: "privileged-internal-pricing", score: 45, binding: true });
    expect(reasonCodes(privileged)).not.toContain("missing-required-oracle-branches");
  });

  it("distinguishes sub-material weak oracle diagnostics from a material weak oracle tier", () => {
    const oracleControl = control("oracle:core", "oracle");
    const subMaterial = evaluate({
      facts: { ...facts([oracleControl]), assetId: "crvusd-fixture", archetype: "cdp" }, mint: noMint(),
      oracle: { status: requiredKnown("oracle"), tier: "standard-external", subMaterialWeakBand: "moderate", branches: cdpOracleBranches(oracleControl.controlKey) },
    });
    expect(comp(subMaterial, "oracle")).toMatchObject({ posture: "standard-external", score: 70 });
    expect(subMaterial.structuralFailures.filter((f) => f.kind === "weak-oracle-branch")).toEqual([
      expect.objectContaining({ kind: "weak-oracle-branch", severity: "moderate", binding: true, controlKeys: [], failureDomains: [{ kind: "oracle-feed", key: "oracle:crvusd-fixture:sub-material-weak" }] }),
    ]);
    expect(subMaterial.score).not.toBeNull();

    const material = evaluate({
      facts: { ...facts([oracleControl]), archetype: "cdp" }, mint: noMint(),
      oracle: { status: requiredKnown("oracle"), tier: "single-source-or-laggy", branches: cdpOracleBranches(oracleControl.controlKey) },
    });
    expect(comp(material, "oracle")).toMatchObject({ posture: "single-source-or-laggy", score: 45 });
    expect(material.structuralFailures.filter((f) => f.kind === "weak-oracle-branch")).toEqual([
      expect.objectContaining({ kind: "weak-oracle-branch", severity: "high", binding: true }),
    ]);
    expect(material.score).toBe(45);
  });

  it("emits traceable structural failures for unbounded mint, local deployment mint, stale controls, and unreviewed upgrades", () => {
    const hotWallet = control("mint:hot-wallet", "mint", { authority: { authorityKey: "authority:issuer", model: "eoa", threshold: null }, capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded" });
    const hotRes = evaluate({ facts: facts([hotWallet]), mint: boundedMint(hotWallet.controlKey) });
    expect(hotRes).toMatchObject({ score: 50, state: "rated", reasons: [] });
    expect(hotRes.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high", binding: true, controlKeys: [hotWallet.controlKey], failureDomains: [{ kind: "mint-control", key: hotWallet.controlKey }] }));

    const localMint = control("mint:local", "mint", { scope: "deployment", economicLossScope: "deployment", materialSupplyShare: 0.1, capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded" });
    const globalUpgrade = control("upgrade:global", "upgrade", { scope: "global", economicLossScope: "global-claim", materialSupplyShare: null });
    const localRes = evaluate({ facts: facts([localMint, globalUpgrade]), mint: { ...boundedMint(localMint.controlKey), upgrade: { state: "reviewed", controlKey: globalUpgrade.controlKey } } });
    const mintFailure = localRes.structuralFailures.find((f) => f.kind === "centralized-mint");
    expect(mintFailure).toMatchObject({ materialSharePct: 10, controlKeys: [localMint.controlKey], failureDomains: [{ kind: "mint-control", key: localMint.controlKey }] });
    expect(mintFailure?.controlKeys).not.toContain(globalUpgrade.controlKey);

    const staleMint = control("mint:stale", "mint", { status: stale("mint-control") });
    const staleRes = evaluate({ facts: facts([staleMint]), mint: boundedMint(staleMint.controlKey) });
    expect(staleRes).toMatchObject({ score: 65, state: "rated" });
    expect(staleRes.reasons.find((r) => r.code === "unresolved-mint-authority")?.critical).toBe(false);

    const upMint = control("mint:upgradeable", "mint");
    const upRes = evaluate({ facts: facts([upMint]), mint: { ...boundedMint(upMint.controlKey), upgrade: { state: "unknown", controlKey: null } } });
    expect(upRes).toMatchObject({ score: 60, state: "rated" });
    expect(reasonCodes(upRes)).toContain("unknown-upgrade-authority");
    expect(upRes.structuralFailures).toContainEqual(expect.objectContaining({ kind: "unreviewed-upgrade", severity: "high", binding: true, controlKeys: [], failureDomains: [] }));
  });

  it("scores a fully-unverified control surface at the bounded-unknown quality", () => {
    const unresolvedStatus: V9FactStatusV2 = {
      applicability: { state: "required", policyRuleId: "fixture.unresolved", rationale: null, gapId: null },
      observationState: "bounded-unknown", evidenceRefIds: [], gapIds: [],
    };
    const result = evaluate({
      mint: { status: unresolvedStatus, controlKey: null, reconciliation: "unknown", supervision: "unknown", upgrade: { state: "unknown", controlKey: null } },
      oracle: { status: unresolvedStatus, tier: null, branches: [] },
      bridge: { status: unresolvedStatus, routes: [] },
    });
    expect(result).toMatchObject({ score: unknownQuality("control", "U"), state: "rated" });
    expect(result.components.map((c) => c.componentKey).sort()).toEqual(["bridge:unverified", "mint:upgrade", "oracle"]);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.every((r) => !r.critical)).toBe(true);
  });

  it.each(["bounded-unknown", "stale", "missing"] as const)("retains each authority's unknown or adverse facts when the aggregate review is %s", (observationState) => {
    const root = control("mint:healthy-root", "mint");
    const unknown = control("mint:unreviewed", "mint", { status: { ...boundedUnknown("mint:unreviewed"), evidenceRefIds: [] }, authority: null, capSemantics: { kind: "unknown", bound: null } });
    const adverse = control("mint:adverse", "mint", { incidentState: "active" });
    const review = { ...boundedMint(root.controlKey), status: { ...boundedUnknown("mint:review"), observationState, evidenceRefIds: [] } };

    const withUnknown = evaluate({ facts: facts([root, unknown]), mint: review });
    const knownReview = evaluate({ facts: facts([root, unknown]), mint: boundedMint(root.controlKey) });
    expect(withUnknown.components).toContainEqual(expect.objectContaining({ kind: "mint", posture: "unknown", controlKeys: [unknown.controlKey] }));
    expect(withUnknown.score).toBeLessThanOrEqual(knownReview.score!);

    const withAdverse = evaluate({ facts: facts([root, adverse]), mint: review });
    expect(withAdverse.components).toContainEqual(expect.objectContaining({ kind: "mint", posture: "compromised", controlKeys: [adverse.controlKey] }));
    expect(withAdverse.score).toBeLessThan(withUnknown.score!);

    const cleared = evaluate({ facts: facts([root, control(unknown.controlKey, "mint"), control(adverse.controlKey, "mint")]), mint: boundedMint(root.controlKey) });
    expect(cleared.score).toBeGreaterThan(withUnknown.score!);
    expect(cleared.structuralFailures.some((f) => f.kind === "active-control-incident")).toBe(false);
  });

  it.each([[2, 0.04, true], [2, 0.05, true], [4, 0.03, true], [3, 0.05, false]] as const)(
    "relaxes %s exact unresolved rows of share %s only below the aggregate full-ceiling boundary",
    (count, share, complete) => {
      const controls = Array.from({ length: count }, (_, i) => depBridge(`bridge:band:${i}`, { materialSupplyShare: share, status: boundedUnknown(`bridge:band:${i}`) }));
      const cohortFacts = facts(controls, {
        supply: makeSupplyPartition({
          routes: [
            { deploymentRouteKey: "ethereum:native", supplyShare: 1 - count * share, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
            ...controls.map((row) => ({ deploymentRouteKey: row.deploymentKey, supplyShare: share, reviewState: "selected-unresolved" as const })),
          ],
          selectedRouteSupplyShare: 1 - count * share, unreviewedRouteSupplyShare: count * share, unknownRouteSupplyShare: 0,
        }),
      });
      const join = joinCheck(cohortFacts, controls, controls.map((row) => ({ controlKey: row.controlKey, tier: "canonical-rollup-bridge" })));
      expect(join.complete).toBe(complete);
      if (!complete) expect(join.cause).toMatchObject({ code: "unresolved-row-control-unproven" });
    },
  );

  it("keeps a weak peripheral bridge scoped, share-bands material bridges, and separates known deployment controls", () => {
    const bridgeControl = depBridge("bridge:edge", { materialSupplyShare: 0.05 });
    const bridgeReview = reviewedBridge([{ controlKey: bridgeControl.controlKey, tier: "external-lock-mint" }]);
    const peripheral = evaluate({ facts: facts([bridgeControl]), bridge: bridgeReview });
    const canonical = evaluate({ facts: facts([{ ...bridgeControl, economicLossScope: "global-claim" }]), bridge: bridgeReview });
    expect(peripheral.score).not.toBeNull();
    expect(comp(peripheral, "bridge")).toMatchObject({ score: 45, binding: false });
    expect(peripheral.structuralFailures).toContainEqual(expect.objectContaining({ kind: "peripheral-bridge", binding: false }));
    expect(canonical.score).toBe(45);
    expect(canonical.structuralFailures).toContainEqual(expect.objectContaining({ kind: "material-bridge", binding: true }));

    const evalLockMint = (materialSupplyShare: number | null, policy = P) => {
      const b = depBridge("bridge:lock-mint", { materialSupplyShare });
      return evaluate({ facts: facts([b]), policy, bridge: reviewedBridge([{ controlKey: b.controlKey, tier: "external-lock-mint" }]) })
        .structuralFailures.find((f) => f.kind === "material-bridge");
    };
    expect(evalLockMint(0.15)).toMatchObject({ binding: true, severity: "moderate" });
    expect(evalLockMint(0.3)).toMatchObject({ binding: true, severity: "high" });
    expect(evalLockMint(null)).toMatchObject({ binding: true, severity: "high" });
    const changed = structuredClone(P.policy);
    changed.semantic.control.materialBridgeHighShareThreshold = 0.15;
    expect(evalLockMint(0.15, loadV9MethodologyPolicy(changed))).toMatchObject({ binding: true, severity: "high" });

    const mintControl = control("mint:global", "mint", { capSemantics: { kind: "raiseable", bound: { amount: 0.1, unit: "supply-fraction" } } });
    const poly = depBridge("bridge:polygon", { materialSupplyShare: 0.15 });
    const evalScoped = (tier: V9BridgeControlReview["routes"][number]["tier"], share: number | null) => evaluate({
      facts: facts([mintControl, { ...poly, materialSupplyShare: share }]), mint: boundedMint(mintControl.controlKey), bridge: reviewedBridge([{ controlKey: poly.controlKey, tier }]),
    });
    const scoped = evalScoped("external-lock-mint", 0.15);
    expect(scoped.score).not.toBeNull();
    expect(comp(scoped, "bridge")).toMatchObject({ score: 45, binding: false });
    expect(scoped.structuralFailures).toContainEqual(expect.objectContaining({ kind: "material-bridge", binding: true, materialSharePct: 15 }));
    const unknownShare = evalScoped("external-lock-mint", null);
    expect(unknownShare.score).toBe(45);
    expect(comp(unknownShare, "bridge")?.binding).toBe(true);
    const nonAdverse = evalScoped("canonical-rollup-bridge", 0.15);
    expect(nonAdverse.score).not.toBeNull();
    expect(comp(nonAdverse, "bridge")?.binding).toBe(true);
  });

  it("keeps subthreshold unresolved rows nonbinding while preserving unrepresented aggregate control residue", () => {
    const sub = DEP_THRESHOLD - 0.001;
    const mkPeripheral = (key: string) => depBridge(key, { status: boundedUnknown(`control.${key}`), materialSupplyShare: sub });
    const p1 = mkPeripheral("bridge:unresolved-peripheral");
    const r1 = evaluate({
      facts: { ...facts([control("freeze:unresolved", "freeze", { status: boundedUnknown("control.peripheral") }), p1]), controlStatus: requiredKnown("controls") },
      bridge: reviewedBridge([{ controlKey: p1.controlKey, tier: "opaque-or-unknown" }]),
    });
    expect(r1).toMatchObject({ state: "rated", reasons: [], structuralFailures: [] });
    expect(r1.components.some((c) => c.componentKey === "bridge:unverified")).toBe(false);

    const p2 = mkPeripheral("bridge:unresolved-peripheral-mixed");
    const r2 = evaluate({
      facts: { ...facts([control("custody:known-material", "custody"), p2]), controlStatus: requiredKnown("controls") },
      bridge: reviewedBridge([{ controlKey: p2.controlKey, tier: "opaque-or-unknown" }]),
    });
    expect(r2).toMatchObject({ state: "rated", reasons: [] });
    expect(r2.components.some((c) => c.componentKey === "bridge:unverified")).toBe(false);

    const r3 = evaluate({ facts: { ...facts([control("custody:known", "custody")]), controlStatus: boundedUnknown("control.unrepresented-residue") } });
    expect(r3.reasons).toEqual([expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null })]);

    const p4 = mkPeripheral("bridge:unresolved-peripheral-residue");
    const r4 = evaluate({
      facts: { ...facts([control("custody:known-with-residue", "custody"), p4]), controlStatus: boundedUnknown("control.aggregate-residue") },
      bridge: reviewedBridge([{ controlKey: p4.controlKey, tier: "opaque-or-unknown" }]),
    });
    expect(r4.reasons).toEqual([expect.objectContaining({ code: "unresolved-control-identity", path: "controls", controlKey: null })]);
    expect(r4.components.some((c) => c.componentKey === "bridge:unverified")).toBe(false);
  });

  it("handles null-share deployment scenarios across subthreshold, absent, material, no-partition, and reviewed inventories", () => {
    for (const key of ["subthreshold", "absent"] as const) {
      const { result } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS[key]);
      expect(result).toMatchObject({ state: "rated", reasons: [] });
    }
    for (const key of ["material", "noPartition"] as const) {
      const { result, nullShareBridge } = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS[key]);
      expect(result.reasons).toEqual([expect.objectContaining({ code: "selected-bridge-route-unresolved", controlKey: nullShareBridge.controlKey })]);
    }
    const invSub = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.inventorySubthreshold).result;
    expect(invSub).toMatchObject({ score: SEMANTIC_POLICY.control.authorityLadder.immutableNoPower, state: "rated", reasons: [] });
    expect(comp(invSub, "bridge")).toMatchObject({ binding: false });

    const invKnown = nullShareDeploymentScenario(NULL_SHARE_DEPLOYMENT_SCENARIOS.inventoryKnownSubthreshold).result;
    expect(invKnown.reasons.filter((r) => r.code === "runtime-bridge-materiality-unavailable")).toEqual([]);
    expect(comp(invKnown, "bridge")).toMatchObject({ binding: false });
  });

  it("does not infer zero deployment exposure from unreconciled aggregates and sums split deployment rows", () => {
    const missing = depBridge("bridge:absent", { deploymentKey: "solana:absent", materialSupplyShare: null, status: boundedUnknown("control.absent") });
    for (const [rowShare, aggregateShare] of [[1, 0.9], [0.9, 0.9]]) {
      const res = evaluate({
        facts: {
          ...facts([missing]), controlStatus: requiredKnown("controls"),
          supply: makeSupplyPartition({
            status: requiredKnown("supply"),
            routes: [{ deploymentRouteKey: "ethereum:native", supplyUsd: rowShare * 100, supplyShare: rowShare, reviewState: "selected-reviewed", reviewedRouteKind: "native" }],
            selectedRouteSupplyShare: aggregateShare, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0,
          }),
        },
      });
      expect(res.reasons).toContainEqual(expect.objectContaining({ code: "selected-bridge-route-unresolved", controlKey: missing.controlKey }));
    }

    const split = depBridge("bridge:split", { deploymentKey: "solana:split", materialSupplyShare: null, status: boundedUnknown("control.split") });
    const splitRes = evaluate({
      facts: {
        ...facts([split]), controlStatus: requiredKnown("controls"),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
            { deploymentRouteKey: "ethereum:native", supplyUsd: 90, supplyShare: 0.9, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
            ...[0.04, 0.06].map((supplyShare) => ({ deploymentRouteKey: split.deploymentKey, supplyUsd: supplyShare * 100, supplyShare, reviewState: "unmatched" as const })),
          ],
          selectedRouteSupplyShare: 0.9, unknownRouteSupplyShare: 0.1, unreviewedRouteSupplyShare: 0,
        }),
      },
    });
    expect(splitRes.reasons).toContainEqual(expect.objectContaining({ code: "selected-bridge-route-unresolved", controlKey: split.controlKey }));
  });

  it("rejects duplicate bridge reviews and ambiguous controls instead of selecting the first join", () => {
    const first = depBridge("bridge:first", { deploymentKey: "ethereum:controlled", materialSupplyShare: 0.95 });
    const second = { ...first, controlKey: "bridge:second" };
    const route = { controlKey: first.controlKey, tier: "external-validated-network" as const };
    const economicFacts: V9EconomicControlAssetFacts = {
      ...facts([first]),
      supply: makeSupplyPartition({
        status: requiredKnown("supply"),
        routes: [
          { deploymentRouteKey: first.deploymentKey, supplyUsd: 95, supplyShare: 0.95, reviewState: "selected-reviewed", reviewedRouteKind: "controlled" },
          { deploymentRouteKey: "unmatched-chain:fixture:arbitrum", supplyUsd: 5, supplyShare: 0.05, reviewState: "unmatched" },
        ],
        selectedRouteSupplyShare: 0.95, unknownRouteSupplyShare: 0.05, unreviewedRouteSupplyShare: 0,
      }),
    };
    expect(joinCheck(economicFacts, [first], [route])).toEqual({ complete: true, cause: null });
    for (const [controls, routes, code, controlKeys] of [
      [[first], [route, route], "duplicate-bridge-route-control", [first.controlKey]],
      [[first, second], [route, { ...route, controlKey: second.controlKey }], "reviewed-row-control-join-not-unique", [first.controlKey, second.controlKey]],
    ] as const) {
      expect(joinCheck(economicFacts, controls, routes)).toMatchObject({ complete: false, cause: { code, controlKeys } });
      const evalArgs = args({ facts: { ...economicFacts, controls }, bridge: reviewedBridge(routes) });
      if (code === "duplicate-bridge-route-control") expect(() => evaluateV9EconomicControl(evalArgs)).toThrow(/Duplicate v9 bridge control/);
      else expect(reasonCodes(evaluateV9EconomicControl(evalArgs))).toContain("nonmaterial-bridge-supply-unmatched");
    }
  });

  it("routes scoped control questions accurately and prevents generic control reasons from authorizing bridge fallback", () => {
    const scopedMint = control("mint:scoped-question", "mint", { status: boundedUnknown("control.scoped-question"), scopedQuestionFresh: true });
    const rSingle = evaluate({ facts: { ...facts([scopedMint]), controlStatus: requiredKnown("controls") } });
    expect(reasonCodes(rSingle)).toContain("scoped-control-question");
    expect(reasonCodes(rSingle)).not.toContain("unresolved-mint-authority");

    const rAll = evaluate({ facts: { ...facts([scopedMint]), controlStatus: boundedUnknown("controls") } });
    expect(reasonCodes(rAll)).toContain("scoped-control-question");
    expect(reasonCodes(rAll)).not.toContain("unresolved-control-identity");

    const unscopedCustody = control("custody:unscoped-mixed", "custody", { status: boundedUnknown("control.unscoped-mixed") });
    expect(reasonCodes(evaluate({ facts: { ...facts([scopedMint, unscopedCustody]), controlStatus: boundedUnknown("controls") } }))).toContain("unresolved-control-identity");

    const unresolvedStatus = boundedUnknown("control.custody-material");
    const generic = evaluate({ facts: { ...facts([control("custody:unresolved-material", "custody", { status: unresolvedStatus })]), controlStatus: unresolvedStatus }, bridge: noBridge() });
    expect(reasonCodes(generic)).toContain("unresolved-control-identity");
    expect(generic.components.some((c) => c.componentKey === "bridge:unverified" || c.kind === "inventory")).toBe(false);
    expect(generic.score).toBe(Math.min(...generic.components.filter((c) => c.binding && c.score !== null).map((c) => c.score!)));
  });

  it.each([["exactly threshold", DEP_THRESHOLD], ["above threshold", DEP_THRESHOLD + 0.01], ["missing share", null]] as const)(
    "keeps an unresolved deployment control fail-closed when its share is %s", (_label, materialSupplyShare) => {
      const status = boundedUnknown("control.material");
      const b = depBridge("bridge:unresolved-material", { status, materialSupplyShare });
      const result = evaluate({ facts: { ...facts([b]), controlStatus: status }, bridge: reviewedBridge([{ controlKey: b.controlKey, tier: "opaque-or-unknown" }]) });
      expect(reasonCodes(result)).toEqual(expect.arrayContaining(["selected-bridge-route-unresolved", "unresolved-control-identity"]));
      expect(result.components).toContainEqual(expect.objectContaining({ kind: "bridge", binding: true }));
      expect(result.score).toBe(unknownQuality("control", "U"));
    },
  );

  it("keeps deployment control materiality independent from common-mode thresholds", () => {
    const b = depBridge("bridge:separate-materiality", { status: boundedUnknown("control.separate-materiality"), materialSupplyShare: DEP_THRESHOLD });
    const input = { facts: { ...facts([b]), controlStatus: boundedUnknown("control.separate-materiality") }, bridge: reviewedBridge([{ controlKey: b.controlKey, tier: "opaque-or-unknown" }]) };
    const changed = structuredClone(P.policy);
    changed.semantic.materiality.commonModeHighShareThreshold = 0.2;
    expect(evaluate({ ...input, policy: loadV9MethodologyPolicy(changed) })).toEqual(evaluate(input));
  });

  it("ignores below-threshold bridge review residue but fails closed at the exact threshold or stale supply", () => {
    const resultFor = (share: number, supplyStatus = requiredKnown("supply")) => {
      const b = depBridge("bridge:unresolved-residue", { status: boundedUnknown("control.unresolved-residue"), materialSupplyShare: share });
      return evaluate({
        facts: {
          ...facts([b]),
          supply: makeSupplyPartition({
            status: supplyStatus,
            routes: [
              { deploymentRouteKey: "ethereum:native", supplyUsd: 100 * (1 - share), supplyShare: 1 - share, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
              { deploymentRouteKey: b.deploymentKey, supplyUsd: 100 * share, supplyShare: share, reviewState: "selected-unresolved" },
            ],
            selectedRouteSupplyShare: 1 - share, unreviewedRouteSupplyShare: share,
          }),
        },
        bridge: reviewedBridge([]),
      });
    };
    const peripheral = resultFor(UNRES_THRESHOLD - 0.001);
    expect(peripheral.reasons).toEqual([]);
    expect(peripheral.components.some((c) => c.componentKey === "bridge:unverified")).toBe(false);
    expect(peripheral.score).not.toBeNull();

    for (const bad of [resultFor(UNRES_THRESHOLD), resultFor(UNRES_THRESHOLD - 0.001, boundedUnknown("supply.stale"))]) {
      expect(reasonCodes(bad)).toContain("missing-bridge-route-rows");
      expect(bad.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified", binding: true }));
    }
  });

  it("clears DAI's immaterial unrecognized-chain-label pool without weakening the RULED D-J floor", () => {
    const ASSET_ID = "dai-makerdao";
    const run = (poolShare: number | null, opts?: ChainLabelPoolOptions) => chainLabelPoolResult(ASSET_ID, poolShare, opts);
    expect(run(null).reasons).toEqual([]);
    expect(run(null).score).not.toBeNull();
    expect(run(0.0999, { withPoolControl: false }).reasons).toEqual([]);
    expect(reasonCodes(run(0.1, { withPoolControl: false }))).toEqual(["material-bridge-supply-unmatched"]);
    const floorWithControl = run(0.1, { withPoolControl: true });
    expect(reasonCodes(floorWithControl)).toEqual(["material-bridge-supply-unmatched", "selected-bridge-route-unresolved"]);
    expect(floorWithControl.score).not.toBeNull();

    expect(run(0.07, { withPoolControl: false, namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02 }] }).reasons).toEqual([]);
    expect(run(0.07, { withPoolControl: false, namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02, withControl: false }] }).reasons).toEqual([]);
    expect(reasonCodes(run(null, { withPoolControl: false, namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.1, withControl: false }] }))).toEqual(["material-bridge-supply-unmatched"]);
    expect(reasonCodes(run(0.0999, { withPoolControl: false, namedUnmatched: [{ key: `unmatched-chain:${ASSET_ID}:bsc`, share: 0.02 }] }))).toEqual(["material-bridge-supply-unmatched"]);
  });

  it("keeps the tolerated pool from authorizing the bounded bridge fallback", () => {
    const namedControl = unknownPoolBridge("bridge-supply:named-0", "unmatched-chain:fixture-asset:bsc", 0.02, "control.named-0");
    const result = evaluate({
      facts: {
        ...facts([namedControl]),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
            { deploymentRouteKey: "ethereum:native", supplyUsd: 94, supplyShare: 0.94, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
            { deploymentRouteKey: "unmatched-chain-label-pool:fixture-asset", supplyUsd: 4, supplyShare: 0.04, reviewState: "unmatched" },
            { deploymentRouteKey: "unmatched-chain:fixture-asset:bsc", supplyUsd: 2, supplyShare: 0.02, reviewState: "unmatched" },
          ],
          selectedRouteSupplyShare: 0.94, unknownRouteSupplyShare: 0.06, unreviewedRouteSupplyShare: 0,
        }),
      },
      bridge: reviewedBridge([]),
    });
    expect(result.reasons).toEqual([]);
    expect(result.components.some((c) => c.componentKey === "bridge:unverified")).toBe(false);
  });

  it("ignores umbrella native controls but fails closed when a reviewed controlled row does not join", () => {
    const residue = DEP_THRESHOLD / 2;
    const check = (controlKey: string, controlDeployment: string, supplyDeployment: string, reviewedRouteKind: "native" | "controlled") => {
      const ctrl = control(controlKey, "bridge", { deploymentKey: controlDeployment });
      const routes = [{ controlKey: ctrl.controlKey, tier: "external-validated-network" as const }];
      const economicFacts: V9EconomicControlAssetFacts = {
        ...facts([ctrl]),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
            { deploymentRouteKey: supplyDeployment, supplyUsd: 100 * (1 - residue), supplyShare: 1 - residue, reviewState: "selected-reviewed", reviewedRouteKind },
            { deploymentRouteKey: "unmatched-chain:fixture-asset:arbitrum", supplyUsd: 100 * residue, supplyShare: residue, reviewState: "unmatched" },
          ],
          selectedRouteSupplyShare: 1 - residue, unknownRouteSupplyShare: residue, unreviewedRouteSupplyShare: 0,
        }),
      };
      return { join: joinCheck(economicFacts, [ctrl], routes), result: evaluate({ facts: economicFacts, bridge: reviewedBridge(routes) }) };
    };
    const nativeRes = check("bridge:native-umbrella", "ethereum:native", "ethereum:native", "native");
    expect(nativeRes.join).toEqual({ complete: true, cause: null });
    expect(reasonCodes(nativeRes.result)).not.toContain("nonmaterial-bridge-supply-unmatched");

    const unmatchedRes = check("bridge:unmatched", "ethereum:other-deployment", "ethereum:bridge-representation", "controlled");
    expect(unmatchedRes.join.complete).toBe(false);
    expect(unmatchedRes.join.cause).toEqual(expect.objectContaining({ code: "reviewed-row-control-join-not-unique", deploymentRouteKey: "ethereum:bridge-representation" }));
    expect(reasonCodes(unmatchedRes.result)).toContain("nonmaterial-bridge-supply-unmatched");
  });

  it("fails closed when reviewed bridge inventory has no route joins or omits reviewedRouteKind", () => {
    const noJoins = evaluate({
      facts: { ...facts(), supply: makeSupplyPartition({ status: requiredKnown("supply"), routes: [{ deploymentRouteKey: "ethereum:reviewed", supplyUsd: 100, supplyShare: 1, reviewState: "selected-reviewed" }] }) },
      bridge: reviewedBridge([]),
    });
    const unresolvedBridge = depBridge("bridge:retained-unresolved", { status: boundedUnknown("control.retained-unresolved"), materialSupplyShare: 0.09 });
    const mixedNoKind = evaluate({
      facts: {
        ...facts([unresolvedBridge]),
        supply: makeSupplyPartition({
          status: requiredKnown("supply"),
          routes: [
            { deploymentRouteKey: "ethereum:retained-reviewed", supplyUsd: 91, supplyShare: 0.91, reviewState: "selected-reviewed" },
            { deploymentRouteKey: unresolvedBridge.deploymentKey, supplyUsd: 9, supplyShare: 0.09, reviewState: "selected-unresolved" },
          ],
          selectedRouteSupplyShare: 0.91, unreviewedRouteSupplyShare: 0.09,
        }),
      },
      bridge: reviewedBridge([]),
    });
    for (const res of [noJoins, mixedNoKind]) {
      expect(reasonCodes(res)).toContain("missing-bridge-route-rows");
      expect(res.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified", binding: true }));
    }
  });

  it("keeps individual freeze categorical while preserving systemic custody failures and custody failure domains", () => {
    const freezeControl = control("freeze:individual", "freeze", { incidentState: "active", authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null } });
    const baseline = evaluate();
    const categoricalOnly = evaluate({ facts: facts([freezeControl]) });
    expect(categoricalOnly).toMatchObject({ score: baseline.score, reasons: [], structuralFailures: [] });

    const systemic = evaluate({
      facts: facts([{ ...freezeControl, capabilities: ["freeze", "custody-transfer"], capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", economicLossScope: "global-claim" }]),
    });
    expect(systemic.structuralFailures).toContainEqual(expect.objectContaining({ kind: "active-control-incident", binding: true }));

    const custodyControl = control("custody:primary", "custody");
    const custodyRes = evaluate({ facts: facts([custodyControl]) });
    expect(custodyRes.state).toBe("rated");
    expect(custodyRes.failureDomains).toContainEqual({ kind: "reserve-custodian", key: custodyControl.controlKey });
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
    const row = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "contract", threshold: null }, executionScope: reviewedScope(), executionScopeComplete: true });
    expect(["synthetic-vault-alpha", "synthetic-vault-beta"].map((assetId) => evaluate({ facts: facts([row], { assetId }), mint: makeReviewedMintInput(row.controlKey) }).score)).toEqual([60, 60]);
  });

  it("changes each bound or assurance fact by at most fifteen and never lets an issuer exceed immutable quality", () => {
    const scope = reviewedScope();
    scope.paths[0]!.claimImpairment = "bounded";
    scope.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } };
    const row = unbounded({ claimImpairment: "bounded", capSemantics: scope.paths[0]!.capSemantics, executionScope: scope, executionScopeComplete: true });
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
    const row = unbounded({ claimImpairment: "bounded", capSemantics: leaf.capSemantics, executionScope: scope, executionScopeComplete: true });
    expect(quality(row)).toBe(60);
    leaf.upgradeRefs = ["allocator"];
    scope.paths.push({ ...leaf, id: "allocator", upgradeRefs: [], capabilities: ["parameter-change"], claimImpairment: "unbounded", capSemantics: { kind: "unbounded", bound: null }, unavoidableDelaySec: 0 });
    expect(quality(row)).toBe(50);
    expect(quality({ ...row, authority: { authorityKey: SCOPE_CONTROLLER, model: "multisig", threshold: { required: 2, total: 3 } }, delaySec: 86400 })).toBe(65);
  });

  it.each(["upgrade", "custody", "governance"] as const)("makes an independently admitted %s dilution path compete with an immutable mint", (kind) => {
    const row = unbounded({ controlKey: `authority:${kind}`, controlKind: kind, capabilities: kind === "upgrade" ? ["upgrade"] : kind === "custody" ? ["custody-transfer"] : ["parameter-change"] });
    const result = evaluate({ facts: facts([row]), mint: noMint() });
    expect(result.score).toBe(50);
    expect(result.components).toContainEqual(expect.objectContaining({ kind: "mint", score: 50, controlKeys: [row.controlKey] }));
  });

  it("keeps active compromise at 25, freeze as disclosure, and known authority stable under partial review", () => {
    const compromised = unbounded({ incidentState: "active", status: boundedUnknown("authority:incident") });
    expect(evaluate({ facts: facts([compromised]), mint: makeReviewedMintInput(compromised.controlKey, { status: boundedUnknown("mint:incident"), reconciliation: "continuous", supervision: "prudential" }) }).score).toBe(25);

    const baseline = evaluate();
    const freeze = control("access:freeze", "freeze", { incidentState: "active" });
    const freezeRes = evaluate({ facts: facts([freeze]) });
    expect(freezeRes).toMatchObject({ score: baseline.score, structuralFailures: [] });
    expect(freezeRes.components.some((c) => c.controlKeys.includes(freeze.controlKey))).toBe(false);

    const quorum = unbounded({ authority: { authorityKey: SCOPE_CONTROLLER, model: "multisig", threshold: { required: 2, total: 3 } } });
    const mint = makeReviewedMintInput(quorum.controlKey);
    expect(evaluate({ facts: facts([quorum]), mint }).score).toBe(65);
    expect(evaluate({ facts: facts([quorum]), mint: { ...mint, status: boundedUnknown("mint:partial") } }).score).toBe(65);
  });

  it.each([{ cause: "C", expected: 50 }, { cause: "U", expected: 60 }] as const)("prices an unknown controller under $cause once, preserving independent facts", ({ cause, expected }) => {
    const gap = createV9FactGapV3({
      gapId: `controller:${cause}`, reasonCode: "unresolved-control-identity", ownerDomain: "control",
      policyRuleId: "control.controller", observationState: "bounded-unknown", responsibility: "unresearched",
      path: { kind: "local-component", componentKey: "control:authority:synthetic" }, message: "Controller review gap.",
      causeProof: cause === "U" ? { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] } : {
        cause: "C", classificationId: "controller:research", proofOrigin: "typed-review", reviewedAt: "2026-10-01",
        assertion: "researched-nondisclosure", evidenceRefIds: ["controller:source"],
        rationale: "Current primary documentation does not disclose the effective controller.",
        sources: [{ url: "https://example.com/controller", location: "Controller", excerpt: "Controller is undisclosed.", assertion: "Effective controller is not disclosed." }],
      },
    });
    const status = { ...boundedUnknown(), gapIds: [gap.gapId] };
    const row = unbounded({ authority: null, status, factorStatuses: { authority: status } });
    const mint = makeReviewedMintInput(row.controlKey, { reconciliation: "none", supervision: "none" });
    expect(evaluate({ facts: facts([row], { gaps: [gap] }), mint }).score).toBe(expected);
    expect(evaluate({ facts: facts([row], { gaps: [gap] }), mint: { ...mint, reconciliation: "continuous" } }).score).toBe(expected + 15);
  });
});

describe("independent authority proofs and incident recovery", () => {
  it("separates verified quorum and unavoidable delay from public governance", () => {
    const scope = reviewedScope();
    Object.assign(scope.paths[0]!, { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", unavoidableDelaySec: 172800 });
    const row = control("authority:delayed", "mint", {
      executionScope: scope, executionScopeComplete: true, capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", delaySec: 172800,
    });
    const mint = makeReviewedMintInput(row.controlKey);
    expect(gradeEconomicControlAuthority(row, mint, SEMANTIC_POLICY)).toBe(70);
    expect(gradeEconomicControlAuthority({ ...row, executionScopeComplete: false }, mint, SEMANTIC_POLICY)).toBe(65);
    const governor = {
      ...row, authority: { authorityKey: SCOPE_CONTROLLER, model: "governance" as const, threshold: null },
      issuanceGovernance: {
        coverage: "complete" as const, incompleteReasons: [], governorAuthorityKey: SCOPE_CONTROLLER,
        decisionRule: "affirmative-vote" as const, minUnavoidableDelaySec: 172800, votingPower: "past-block-checkpoint" as const,
        vetoQuorumBps: null, vetoOverride: null, enumerable: true, nonGovernorUnboundedPathKeys: [],
        votingControl: makeCompiledVotingControl(), diagnostics: [],
      },
    };
    expect(gradeEconomicControlAuthority(governor, mint, SEMANTIC_POLICY)).toBe(75);
    expect(gradeEconomicControlAuthority({ ...governor, issuanceGovernance: { ...governor.issuanceGovernance, minUnavoidableDelaySec: 0 } }, mint, SEMANTIC_POLICY)).toBe(65);
    expect(gradeEconomicControlAuthority({ ...governor, issuanceGovernance: { ...governor.issuanceGovernance, votingControl: makeCompiledVotingControl({ qualified: false }) } }, mint, SEMANTIC_POLICY)).toBe(60);
  });

  it.each([
    [undefined, 55], [0, 55], [365, 55], [365.5, 55 + 45 * 0.5 / 365], [547.5, 77.5], [730, 90], [2555, 90],
  ] as const)("relaxes resolved authority history on the loss clock at day %s", (ageDays, expected) => {
    const row = control("authority:history", "mint", { incidentState: "resolved" });
    const mint = makeReviewedMintInput(row.controlKey, { reconciliation: "continuous", supervision: "prudential" });
    expect(evaluate({ facts: facts([row]), mint, ...(ageDays === undefined ? {} : { resolvedIncidentAgeDays: ageDays }) }).score).toBeCloseTo(expected);
  });

  it("never decays an active compromise or improves an independently weaker authority", () => {
    const row = control("authority:history", "mint", { incidentState: "active" });
    const mint = makeReviewedMintInput(row.controlKey);
    expect(evaluate({ facts: facts([row]), mint, resolvedIncidentAgeDays: 2555 }).score).toBe(25);
    expect(evaluate({ facts: facts([{ ...row, incidentState: "resolved" }]), mint, resolvedIncidentAgeDays: 730 }).score).toBe(65);
  });
});

describe("V9 control component keys", () => {
  const sui = "sui:0xdba3::usdc::USDC";
  const controlKey = "bridge-meta:usdc-circle:52b72ec3cb21ad6fcb03";

  it("joins bridge routes, separates deployment inputs, and names only registered chains", () => {
    const route = v9BridgeRouteComponentKey(sui, controlKey);
    const mint = v9BridgeMintComponentKey(controlKey);
    expect(v9BridgeMintControlKey(mint)).toBe(controlKey);
    expect(isV9BridgeRouteComponentFor(route, controlKey)).toBe(true);
    expect(v9BridgeRouteDeploymentKey(route, controlKey)).toBe(sui);
    expect(isV9BridgeRouteComponentFor(route, "bridge-meta:usdc-circle:other")).toBe(false);
    expect(v9BridgeRouteDeploymentKey(`bridge:${controlKey}`, controlKey)).toBeNull();

    expect(isV9DeploymentControlComponentKey(route)).toBe(true);
    expect(isV9DeploymentControlComponentKey(mint)).toBe(true);
    expect(isV9DeploymentControlComponentKey(v9DeploymentMintComponentKey(["mint-meta:a:1", "mint-meta:a:2"]))).toBe(true);
    for (const key of ["mint", "mint:binding", "mint:upgrade", "oracle", "bridge:native", "bridge:unverified"]) expect(isV9DeploymentControlComponentKey(key)).toBe(false);
    expect(v9BridgeMintControlKey("mint")).toBeNull();

    expect(v9ControlChainLabel("xlayer:0x86a2")).toBe("X Layer");
    expect(v9ControlChainLabel(sui)).toBe("Sui");
    for (const key of ["asset:usdc-circle", "issuer-backend:circle", "representation-group:x", "ambiguous-chain:x", "mint"]) expect(v9ControlChainLabel(key)).toBeNull();
  });
});

describe("owner Control rules", () => {
  it("prices privileged pricing and savings-rate setters on the right ladder", () => {
    const priv = evaluate({ oracle: { status: requiredKnown("oracle"), tier: "privileged-internal-pricing", liquidationBranchesApplicable: false, branches: [] } });
    expect(priv).toMatchObject({ score: 45, state: "rated", reasons: [] });
    expect(comp(priv, "oracle")).toMatchObject({ posture: "privileged-internal-pricing", score: 45, binding: true });

    const ref = "authority:savings-governor";
    const setter = control("mint:savings-rate", "mint", {
      authority: { authorityKey: ref, model: "contract", threshold: null },
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      issuanceGovernance: {
        coverage: "complete", incompleteReasons: [], governorAuthorityKey: ref, decisionRule: "affirmative-vote",
        minUnavoidableDelaySec: 172800, votingPower: "past-block-checkpoint", vetoQuorumBps: null, vetoOverride: null,
        enumerable: true, nonGovernorUnboundedPathKeys: [], votingControl: makeCompiledVotingControl(), diagnostics: [],
      },
    });
    const mint = makeReviewedMintInput(setter.controlKey);
    const oracle = { status: requiredKnown("savings-rate"), tier: "privileged-internal-pricing" as const, pricingKind: "savings-rate" as const, liquidationBranchesApplicable: false, branches: [] };
    const result = evaluate({ facts: facts([setter]), mint, oracle });
    expect(result).toMatchObject({ score: 75, oracleApplicability: "not-applicable" });
    expect(result.components.filter((r) => r.kind === "oracle")).toEqual([]);
    expect(result.components.filter((r) => r.kind === "mint")).toEqual([expect.objectContaining({ score: 75, controlKeys: [setter.controlKey] })]);
    expect(evaluate({ facts: facts([{ ...setter, issuanceGovernance: undefined }]), mint, oracle }).score).toBe(60);
    expect(evaluate({ facts: facts([{ ...setter, issuanceGovernance: { ...setter.issuanceGovernance!, minUnavoidableDelaySec: 0, nonGovernorUnboundedPathKeys: ["bypass"] } }]), mint, oracle }).score).toBe(60);

    const absentSetter = evaluate({ oracle });
    expect(absentSetter).toMatchObject({ score: 60, oracleApplicability: "not-applicable" });
    expect(absentSetter.components).toContainEqual(expect.objectContaining({ componentKey: "mint:savings-rate", kind: "mint", score: 60, cause: "U" }));
    expect(comp(absentSetter, "oracle")).toBeUndefined();

    const unapprovedOracle = evaluate({ oracle: { ...oracle, status: boundedUnknown("savings-rate") } });
    expect(unapprovedOracle.oracleApplicability).toBe("required");
    expect(unapprovedOracle.components).toContainEqual(expect.objectContaining({ kind: "oracle", score: 60, cause: "U" }));
  });

  it.each(["contract", "governance"] as const)("does not infer governance credit from a %s authority label or recorded delay", (model) => {
    const row = control("mint:unproved-governor", "mint", {
      authority: { authorityKey: "authority:unproved", model, threshold: null }, delaySec: 172800,
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
    });
    expect(evaluate({ facts: facts([row]), mint: makeReviewedMintInput(row.controlKey) }).score).toBe(60);
  });

  it.each(["prudential", "none"] as const)("separates a disclosed internal mint ledger from reserve assurance under %s supervision", (supervision) => {
    const mintControl = control("mint:issuer", "mint", {
      capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null }, delaySec: null,
    });
    const before = evaluate({ facts: facts([mintControl]), mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "unknown", supervision }) });
    const after = evaluate({ facts: facts([mintControl]), mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "internal-ledger", supervision }) });
    expect(before.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question", path: "mint:reconciliation" }));
    expect(after.reasons.some((r) => r.code === "mint-control-question")).toBe(false);
    expect(after.score).toBe(before.score);
    expect(comp(after, "mint")).toMatchObject({ posture: supervision === "prudential" ? "unbounded-reconciled" : "unbounded-adverse", score: supervision === "prudential" ? 75 : 60 });

    const compromised = evaluate({ facts: facts([{ ...mintControl, incidentState: "active" }]), mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "internal-ledger", supervision }) });
    expect(comp(compromised, "mint")).toMatchObject({ posture: "compromised", score: 25 });
    expect(compromised.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "critical" }));
  });

  it("applies disclosed issuer ledger processes to native siblings without removing single-key risk", () => {
    const evm = control("mint:evm", "mint", { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", authority: { authorityKey: "authority:evm", model: "multisig", threshold: { required: 3, total: 5 } }, delaySec: null });
    const backend = { ...evm, controlKey: "mint:algorand", authority: { authorityKey: "authority:algorand", model: "issuer-backend" as const, threshold: null } };
    const singleKey = { ...backend, controlKey: "mint:xrpl", authority: { authorityKey: "authority:xrpl", model: "eoa" as const, threshold: null } };
    const controls = facts([evm, backend, singleKey]);
    const before = evaluate({ facts: controls, mint: makeReviewedMintInput(evm.controlKey, { reconciliation: "unknown", supervision: "prudential" }) });
    expect(before.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question", controlKey: backend.controlKey }));
    const after = evaluate({ facts: controls, mint: makeReviewedMintInput(evm.controlKey, { reconciliation: "internal-ledger", supervision: "prudential" }) });
    expect(after.reasons.some((r) => r.code === "mint-control-question")).toBe(false);
    expect(after.score).toBe(65);
    expect(after.score).toBe(before.score);
    expect(after.components.find((r) => r.kind === "mint" && r.controlKeys.includes(singleKey.controlKey))).toMatchObject({ posture: "unbounded-reconciled", score: 65, binding: true });
  });

  it.each(["not-applicable", "unknown", "internal-ledger"] as const)("retains recorded adverse mint facts with unresolved review and %s reconciliation", (reconciliation) => {
    const mintControl = control("mint:adverse", "mint", { status: boundedUnknown("control.mint-adverse"), capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", authority: { authorityKey: "authority:adverse", model: "contract", threshold: null }, delaySec: null });
    const mint = makeReviewedMintInput(mintControl.controlKey, { reconciliation });
    const measured = evaluate({ facts: facts([mintControl]), mint });
    const unresolved = evaluate({ facts: facts([mintControl]), mint: { ...mint, status: boundedUnknown("mint") } });
    expect(unresolved.score).toBe(measured.score);
    expect(comp(unresolved, "mint")).toMatchObject({ posture: "unbounded-adverse", score: 60 });
    expect(unresolved.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));
    expect(unresolved.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "high" }));
  });

  it("retains recorded adverse/quorum/compromised facts and never manufactures adversity from unknown semantics", () => {
    const appControl = control("mint:applicability-gap", "mint", { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", authority: { authorityKey: "authority:adverse", model: "contract", threshold: null }, delaySec: null });
    const status = { ...requiredKnown("mint"), applicability: { state: "unresolved" as const, policyRuleId: "mint", rationale: "Unreviewed.", gapId: "gap:mint-applicability" } };
    const appRes = evaluate({ facts: facts([appControl]), mint: makeReviewedMintInput(appControl.controlKey, { status }) });
    expect(comp(appRes, "mint")).toMatchObject({ posture: "unbounded-adverse", score: 60 });
    expect(appRes.reasons).toContainEqual(expect.objectContaining({ code: "mint-control-question" }));

    const boundedCtrl = control("mint:bounded", "mint", { status: boundedUnknown("control.mint-bounded") });
    const boundedRes = evaluate({ facts: facts([boundedCtrl]), mint: makeReviewedMintInput(boundedCtrl.controlKey, { status: boundedUnknown("mint") }) });
    expect(comp(boundedRes, "mint")).toMatchObject({ score: 65 });
    expect(boundedRes.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));

    const compCtrl = control("mint:compromised", "mint", { status: boundedUnknown("control.mint-compromised"), incidentState: "active" });
    const compRes = evaluate({ facts: facts([compCtrl]), mint: makeReviewedMintInput(compCtrl.controlKey, { status: boundedUnknown("mint") }) });
    expect(comp(compRes, "mint")).toMatchObject({ posture: "compromised", score: 25 });
    expect(compRes.structuralFailures).toContainEqual(expect.objectContaining({ kind: "centralized-mint", severity: "critical" }));
    expect(compRes.reasons).toContainEqual(expect.objectContaining({ code: "unresolved-mint-authority" }));

    const unkCtrl = control("mint:unknown", "mint", { status: boundedUnknown("control.mint-unknown"), capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown" });
    const unkRes = evaluate({ facts: facts([unkCtrl]), mint: makeReviewedMintInput(unkCtrl.controlKey, { status: boundedUnknown("mint") }) });
    expect(comp(unkRes, "mint")).toMatchObject({ posture: "unknown", score: 65 });
    expect(unkRes.structuralFailures.some((f) => f.kind === "centralized-mint")).toBe(false);

    const clearedCtrl = control("mint:cleared", "mint");
    const clearedRes = evaluate({ facts: facts([clearedCtrl]), mint: makeReviewedMintInput(clearedCtrl.controlKey) });
    expect(comp(clearedRes, "mint")).toMatchObject({ posture: "bounded-admin" });
    expect(clearedRes.score).toBeGreaterThan(45);
    expect(clearedRes.structuralFailures.some((f) => f.kind === "centralized-mint")).toBe(false);
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
      issuanceGovernance: {
        coverage: "complete", incompleteReasons: [], governorAuthorityKey: ref, decisionRule: "affirmative-vote",
        minUnavoidableDelaySec: 0, votingPower: "lock-escrowed", vetoQuorumBps: null, vetoOverride: null, enumerable: true,
        nonGovernorUnboundedPathKeys: ["operational#interest"], votingControl: makeCompiledVotingControl({ largestSingleControllerShareBps: 10000 }), diagnostics: [],
      },
    });
    const mint = makeReviewedMintInput(minter.controlKey, { reconciliation: "none", supervision: "none" });
    const positive = evaluate({ facts: facts([minter]), mint });
    expect(comp(positive, "mint")).toMatchObject({ posture: "unbounded-operationally-governed", score: 60 });
    expect(positive.processDiagnostics).toEqual([]);
    expect(positive.controlFacts![0]!.issuanceProcess?.diagnostics[0]?.code).toBe("external-accounting-trust");

    const negative = evaluate({ facts: facts([{ ...minter, issuanceProcess: { ...process, otherClassesQualified: false } }]), mint });
    expect(comp(negative, "mint")).toMatchObject({ posture: "unbounded-adverse", score: 60 });
    expect(negative.processDiagnostics).toContainEqual(expect.objectContaining({ gate: "H4", code: "economic-reach-unclosed" }));
  });
});
