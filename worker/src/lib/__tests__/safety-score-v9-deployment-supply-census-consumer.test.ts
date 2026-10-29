import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import type { SafetyScoreV9DeploymentSupplyCensus } from "@shared/types/safety-score-v9-deployment-supply-census";
import {
  buildSafetyScoreV9SupplyReview,
  deploymentSupplyCensusDiagnostics,
  safetyScoreV9RouteSupplyShare,
  V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW,
} from "../safety-score-v9/extension-supply";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";

const CLOCK_SEC = 1_793_294_244;
const ASSET_ID = "census-fixture";
const AGGREGATE_USD = 100;
const ETH_ROUTE = `ethereum:0x${"a".repeat(40)}`;
const ETH_SECOND_ROUTE = `ethereum:0x${"b".repeat(40)}`;
const BASE_ROUTE = `base:0x${"c".repeat(40)}`;
const BLOCK_HASH = `0x${"d".repeat(64)}`;
const CODE_HASH = "e".repeat(64);
const REGISTRY_FINGERPRINT = "9".repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"8".repeat(64)}`;
const CENSUS_GENERATION_ID = `safety-score-v9-deployment-supply-census:v1:${"7".repeat(64)}`;

function profile(): BridgeRouteRiskProfile {
  return {
    routes: [
      { id: ETH_ROUTE, reviewDisposition: "reviewed", issuanceModel: "bridge-representation" },
      { id: ETH_SECOND_ROUTE, reviewDisposition: "reviewed", issuanceModel: "bridge-representation" },
      { id: BASE_ROUTE, reviewDisposition: "reviewed", issuanceModel: "bridge-representation" },
    ],
  } as unknown as BridgeRouteRiskProfile;
}

function row(routeId: string, shareUpper: number, pinAtSec = CLOCK_SEC - 60) {
  const chainId = routeId.slice(0, routeId.indexOf(":"));
  const tokenAddress = routeId.slice(routeId.indexOf(":") + 1);
  return {
    routeId,
    chainId,
    tokenAddress,
    readKind: "evm-total-supply" as const,
    pin: {
      kind: "evm-header" as const,
      blockNumber: 21_000_000,
      blockHash: BLOCK_HASH,
      blockTimeSec: pinAtSec,
      runtimeCodeSha256: CODE_HASH,
    },
    decimals: 18,
    totalSupplyRaw: "1000000",
    referencePriceUsd: 1,
    referencePriceObservedAtSec: pinAtSec,
    supplyUsdUpper: shareUpper * AGGREGATE_USD,
    shareUpper,
    evidenceKind: "upper-bound" as const,
  };
}

function packet(overrides: Partial<SafetyScoreV9DeploymentSupplyCensus> = {}): SafetyScoreV9DeploymentSupplyCensus {
  return {
    model: "deployment-supply-census-v1",
    observedAtSec: CLOCK_SEC - 60,
    deployments: [row(ETH_ROUTE, 0.005), row(ETH_SECOND_ROUTE, 0.37), row(BASE_ROUTE, 0.001)],
    conservation: {
      aggregateSupplyUsd: AGGREGATE_USD,
      measuredSupplyUsd: 37.6,
      measuredShareSum: 0.376,
      relativeTolerance: 1e-12,
      absoluteToleranceUsd: 0.000001,
      rosterComplete: true,
      conserved: true,
    },
    rejected: [],
    ...overrides,
  } as SafetyScoreV9DeploymentSupplyCensus;
}

function fixedInput(census: SafetyScoreV9DeploymentSupplyCensus | undefined): SafetyScoreV9CompilerInput {
  return {
    clockSec: CLOCK_SEC,
    registryFingerprint: REGISTRY_FINGERPRINT,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    aggregateCirculatingById: {
      [ASSET_ID]: { circulating: { peggedUSD: AGGREGATE_USD }, observedAtSec: CLOCK_SEC - 60 },
    },
    chainCirculatingById: { [ASSET_ID]: { ethereum: { current: 80 }, base: { current: 20 } } },
    safetyScoreV9SupplyAttributionById: {},
    ...(census === undefined ? {} : {
      safetyScoreV9DeploymentSupplyCensusById: { [ASSET_ID]: census },
      safetyScoreV9DeploymentSupplyCensusBinding: {
        generationId: CENSUS_GENERATION_ID,
        registryFingerprint: REGISTRY_FINGERPRINT,
        sourceBaseInputGenerationId: BASE_INPUT_GENERATION_ID,
      },
    }),
  } as unknown as SafetyScoreV9CompilerInput;
}

function review(census: SafetyScoreV9DeploymentSupplyCensus) {
  return buildSafetyScoreV9SupplyReview(fixedInput(census), ASSET_ID, profile());
}

describe("deployment supply census admission", () => {
  it("admits only sub-bar deployments as upper-bound rows and keeps the chain residual", () => {
    const result = review(packet())!;
    const byKey = new Map(result.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
    // 0.005 < 0.01 documents through the partition bound, never through a share.
    expect(byKey.get(ETH_ROUTE)).toMatchObject({ evidenceKind: "upper-bound", supplyShare: 0.005 });
    expect(byKey.get(BASE_ROUTE)).toMatchObject({ evidenceKind: "upper-bound", supplyShare: 0.001 });
    // 0.37 >= 0.01 has no reviewed escrow rule or exact read: no row, datum required.
    expect(byKey.has(ETH_SECOND_ROUTE)).toBe(false);
    // The unmeasured siblings keep one ambiguous residual identical to the
    // pre-census chain row, so no unmeasured deployment is narrowed to zero.
    expect(byKey.get(`ambiguous-chain:${ASSET_ID}:ethereum`)).toMatchObject({
      reviewState: "unmatched",
      supplyShare: 0.8 - 0.005,
    });
    expect(byKey.get(`ambiguous-chain:${ASSET_ID}:base`)).toMatchObject({
      reviewState: "unmatched",
      supplyShare: 0.2 - 0.001,
    });
    // The partition still reconciles to the whole.
    const rowShare = result.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyShare, 0);
    expect(rowShare).toBeCloseTo(1, 9);
    expect(deploymentSupplyCensusDiagnostics(result)).toEqual([
      { deploymentRouteKey: ETH_SECOND_ROUTE, code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW },
    ]);
  });

  it("documents 0.009999 and requires the datum at exactly 0.01", () => {
    const below = review(packet({
      deployments: [row(ETH_ROUTE, 0.009999), row(ETH_SECOND_ROUTE, 0), row(BASE_ROUTE, 0.001)],
      conservation: {
        aggregateSupplyUsd: AGGREGATE_USD,
        measuredSupplyUsd: 0.9999 + 0 + 0.1,
        measuredShareSum: 0.009999 + 0 + 0.001,
        relativeTolerance: 1e-12,
        absoluteToleranceUsd: 0.000001,
        rosterComplete: true,
        conserved: true,
      },
    }))!;
    const belowRows = new Map(below.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
    expect(belowRows.get(ETH_ROUTE)?.supplyShare).toBe(0.009999);
    expect(belowRows.get(ETH_ROUTE)?.supplyShare).toBeLessThan(0.01);

    const atBar = review(packet({
      deployments: [row(ETH_ROUTE, 0.01), row(ETH_SECOND_ROUTE, 0), row(BASE_ROUTE, 0.001)],
      conservation: {
        aggregateSupplyUsd: AGGREGATE_USD,
        measuredSupplyUsd: 1 + 0 + 0.1,
        measuredShareSum: 0.011,
        relativeTolerance: 1e-12,
        absoluteToleranceUsd: 0.000001,
        rosterComplete: true,
        conserved: true,
      },
    }))!;
    const atBarRows = new Map(atBar.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
    expect(atBarRows.has(ETH_ROUTE)).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(atBar)).toContainEqual({
      deploymentRouteKey: ETH_ROUTE,
      code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW,
    });
  });

  it("keeps a bound out of every control share join, deployment or global scope", () => {
    const result = review(packet())!;
    // No control can take a bound as its material supply share; the bound only
    // reaches the scorer through the reconciled partition.
    expect(safetyScoreV9RouteSupplyShare(result, ETH_ROUTE)).toBeNull();
    expect(safetyScoreV9RouteSupplyShare(result, BASE_ROUTE)).toBeNull();
    expect(safetyScoreV9RouteSupplyShare(result, ETH_SECOND_ROUTE)).toBeNull();
  });

  it("serves the one declared per-source census window, not the capture window", () => {
    const observedAtSec = CLOCK_SEC - 5_399;
    const within = buildSafetyScoreV9SupplyReview(fixedInput(packet({
      observedAtSec,
      deployments: [row(ETH_ROUTE, 0.005, observedAtSec - 60)],
    })), ASSET_ID, profile())!;
    expect(within.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(true);
    expect(deploymentSupplyCensusDiagnostics(within)).not.toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });

    const beyond = buildSafetyScoreV9SupplyReview(fixedInput(packet({
      observedAtSec: CLOCK_SEC - 5_401,
      deployments: [row(ETH_ROUTE, 0.005, CLOCK_SEC - 5_401 - 60)],
    })), ASSET_ID, profile())!;
    expect(beyond.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(beyond)).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });
  });

  it("rejects an unbound census map and one built for another generation", () => {
    const bound = fixedInput(packet());
    const unbound = { ...bound, safetyScoreV9DeploymentSupplyCensusBinding: undefined };
    const unboundReview = buildSafetyScoreV9SupplyReview(unbound, ASSET_ID, profile())!;
    expect(unboundReview.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(unboundReview)).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:generation-unbound" },
    ]);

    for (const binding of [
      { ...bound.safetyScoreV9DeploymentSupplyCensusBinding!, registryFingerprint: "0".repeat(64) },
      {
        ...bound.safetyScoreV9DeploymentSupplyCensusBinding!,
        sourceBaseInputGenerationId: `report-cards-input:v1:${"0".repeat(64)}`,
      },
    ]) {
      const mismatched = buildSafetyScoreV9SupplyReview(
        { ...bound, safetyScoreV9DeploymentSupplyCensusBinding: binding },
        ASSET_ID,
        profile(),
      )!;
      expect(mismatched.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
      expect(deploymentSupplyCensusDiagnostics(mismatched)).toEqual([
        { deploymentRouteKey: null, code: "census-rejected:generation-mismatch" },
      ]);
    }
  });

  it("returns an expired bound to required with a named rejection", () => {
    const result = review(packet({
      observedAtSec: CLOCK_SEC - 5_401,
      deployments: [row(ETH_ROUTE, 0.005, CLOCK_SEC - 5_461), row(ETH_SECOND_ROUTE, 0.37, CLOCK_SEC - 5_461),
        row(BASE_ROUTE, 0.001, CLOCK_SEC - 5_461)],
    }))!;
    expect(result.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(result)).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });
    // The ordinary lane still publishes its own rows: nothing is carried forward.
    expect(result.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual([
      `ambiguous-chain:${ASSET_ID}:ethereum`,
      BASE_ROUTE,
    ]);
  });

  it("refuses a packet that cannot claim conservation", () => {
    const result = review(packet({
      conservation: {
        ...packet().conservation,
        rosterComplete: false,
        conserved: false,
      },
    }))!;
    expect(result.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(result)).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:roster-incomplete",
    });
  });

  it("leaves the replay lane byte-identical when no census packet is present", () => {
    const withoutCensus = buildSafetyScoreV9SupplyReview(fixedInput(undefined), ASSET_ID, profile())!;
    expect(withoutCensus.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(withoutCensus)).toEqual([]);
  });

  it("forwards per-deployment packet rejections into the diagnostic band", () => {
    const result = review(packet({
      deployments: [row(BASE_ROUTE, 0.001)],
      conservation: {
        aggregateSupplyUsd: AGGREGATE_USD,
        measuredSupplyUsd: 0.1,
        measuredShareSum: 0.001,
        relativeTolerance: 1e-12,
        absoluteToleranceUsd: 0.000001,
        rosterComplete: true,
        conserved: true,
      },
      rejected: [{ routeId: ETH_ROUTE, code: "census-rejected:observation-stale" }],
    }))!;
    expect(deploymentSupplyCensusDiagnostics(result)).toContainEqual({
      deploymentRouteKey: ETH_ROUTE,
      code: "census-rejected:observation-stale",
    });
  });
});
