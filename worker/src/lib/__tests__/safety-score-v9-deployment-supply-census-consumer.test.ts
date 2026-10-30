import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import type { SafetyScoreV9DeploymentSupplyCensus } from "@shared/types/safety-score-v9-deployment-supply-census";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { adaptBridgeReview } from "../safety-score-v9/extension-bridge";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";
import {
  buildSafetyScoreV9SupplyAdmission,
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
    reviewedAt: new Date(CLOCK_SEC * 1000).toISOString().slice(0, 10),
    confidence: "verified",
    sources: [],
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

function review(census: SafetyScoreV9DeploymentSupplyCensus | undefined) {
  return buildSafetyScoreV9SupplyAdmission(fixedInput(census), ASSET_ID, profile());
}

describe("deployment supply census admission", () => {
  it("admits only sub-bar deployments as upper-bound rows and keeps the chain residual", () => {
    const { review: result, censusDiagnostics } = review(packet());
    const byKey = new Map(result!.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
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
    const rowShare = result!.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyShare, 0);
    expect(rowShare).toBeCloseTo(1, 9);
    expect(censusDiagnostics).toEqual([
      { deploymentRouteKey: ETH_SECOND_ROUTE, code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW },
    ]);
  });

  it("documents 0.009999 and requires the datum at exactly 0.01", () => {
    const { review: below } = review(packet({
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
    }));
    const belowRows = new Map(below!.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
    expect(belowRows.get(ETH_ROUTE)?.supplyShare).toBe(0.009999);
    expect(belowRows.get(ETH_ROUTE)?.supplyShare).toBeLessThan(0.01);

    const { review: atBar, censusDiagnostics: atBarDiagnostics } = review(packet({
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
    }));
    const atBarRows = new Map(atBar!.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]));
    expect(atBarRows.has(ETH_ROUTE)).toBe(false);
    expect(atBarDiagnostics).toContainEqual({
      deploymentRouteKey: ETH_ROUTE,
      code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW,
    });
  });

  it("keeps a bound out of every control share join, deployment or global scope", () => {
    const { review: result } = review(packet());
    // No control can take a bound as its material supply share; the bound only
    // reaches the scorer through the reconciled partition.
    expect(safetyScoreV9RouteSupplyShare(result, ETH_ROUTE)).toBeNull();
    expect(safetyScoreV9RouteSupplyShare(result, BASE_ROUTE)).toBeNull();
    expect(safetyScoreV9RouteSupplyShare(result, ETH_SECOND_ROUTE)).toBeNull();
  });

  it("serves the one declared per-source census window, not the capture window", () => {
    const observedAtSec = CLOCK_SEC - 5_399;
    const { review: within, censusDiagnostics: withinDiagnostics } = review(packet({
      observedAtSec,
      deployments: [row(ETH_ROUTE, 0.005, observedAtSec - 60)],
    }));
    expect(within!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(true);
    expect(withinDiagnostics).not.toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });

    const { review: beyond, censusDiagnostics: beyondDiagnostics } = review(packet({
      observedAtSec: CLOCK_SEC - 5_401,
      deployments: [row(ETH_ROUTE, 0.005, CLOCK_SEC - 5_401 - 60)],
    }));
    expect(beyond!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(beyondDiagnostics).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });
  });

  it("admits a census captured under the previous prepare cycle's base input", () => {
    // Production shape: the census run binds the source it measured (10:17's
    // base id); the publication that reads it is prepared one cycle later, so
    // its own base id differs. The carrier generation was admitted by its
    // source clock, so the packet is evidence for this roster, not for the
    // producer's base id.
    const bound = fixedInput(packet());
    const nextCycle = {
      ...bound,
      baseInputGenerationId: `report-cards-input:v1:${"3".repeat(64)}`,
    } as SafetyScoreV9CompilerInput;
    const { review: admitted, censusDiagnostics } = buildSafetyScoreV9SupplyAdmission(
      nextCycle,
      ASSET_ID,
      profile(),
    );
    expect(admitted!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(true);
    expect(censusDiagnostics.some((entry) => entry.code.startsWith("census-rejected:"))).toBe(false);
  });

  it("rejects an unbound census map and one built under another roster", () => {
    const bound = fixedInput(packet());
    const unbound = { ...bound, safetyScoreV9DeploymentSupplyCensusBinding: undefined };
    const { review: unboundReview, censusDiagnostics: unboundDiagnostics } =
      buildSafetyScoreV9SupplyAdmission(unbound, ASSET_ID, profile());
    expect(unboundReview!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(unboundDiagnostics).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:generation-unbound" },
    ]);

    const foreignRoster = {
      ...bound,
      safetyScoreV9DeploymentSupplyCensusBinding: {
        ...bound.safetyScoreV9DeploymentSupplyCensusBinding!,
        registryFingerprint: "0".repeat(64),
      },
    };
    const { review: mismatched, censusDiagnostics: mismatchedDiagnostics } = buildSafetyScoreV9SupplyAdmission(
      foreignRoster,
      ASSET_ID,
      profile(),
    );
    expect(mismatched!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(mismatchedDiagnostics).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:generation-mismatch" },
    ]);
  });

  it("returns an expired bound to required with a named rejection", () => {
    const { review: result, censusDiagnostics } = review(packet({
      observedAtSec: CLOCK_SEC - 5_401,
      deployments: [row(ETH_ROUTE, 0.005, CLOCK_SEC - 5_461), row(ETH_SECOND_ROUTE, 0.37, CLOCK_SEC - 5_461),
        row(BASE_ROUTE, 0.001, CLOCK_SEC - 5_461)],
    }));
    expect(result!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(censusDiagnostics).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:observation-stale",
    });
    // The ordinary lane still publishes its own rows: nothing is carried forward.
    expect(result!.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual([
      `ambiguous-chain:${ASSET_ID}:ethereum`,
      BASE_ROUTE,
    ]);
  });

  it("refuses a packet that cannot claim conservation", () => {
    const { review: result, censusDiagnostics } = review(packet({
      conservation: {
        ...packet().conservation,
        rosterComplete: false,
        conserved: false,
      },
    }));
    expect(result!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(censusDiagnostics).toContainEqual({
      deploymentRouteKey: null,
      code: "census-rejected:roster-incomplete",
    });
  });

  it("leaves the replay lane byte-identical when no census packet is present", () => {
    const { review: withoutCensus, censusDiagnostics } = review(undefined);
    expect(withoutCensus!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(censusDiagnostics).toEqual([]);
  });

  it("forwards per-deployment packet rejections into the diagnostic band", () => {
    const { censusDiagnostics } = review(packet({
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
    }));
    expect(censusDiagnostics).toContainEqual({
      deploymentRouteKey: ETH_ROUTE,
      code: "census-rejected:observation-stale",
    });
  });

  it.each([
    ["missing", undefined],
    ["zero", { circulating: { peggedUSD: 0 }, observedAtSec: CLOCK_SEC - 60 }],
  ] as const)("names an unavailable denominator read, never a breach, when the aggregate is %s", (_label, aggregate) => {
    const base = fixedInput(packet());
    const input = {
      ...base,
      aggregateCirculatingById: aggregate === undefined ? {} : { [ASSET_ID]: aggregate },
    } as SafetyScoreV9CompilerInput;
    const { review: result, censusDiagnostics } = buildSafetyScoreV9SupplyAdmission(input, ASSET_ID, profile());
    expect(result!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(censusDiagnostics).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:read-unavailable" },
    ]);
  });

  it("keeps conservation-breach for a packet bounded against another denominator", () => {
    const { review: result, censusDiagnostics } = review(packet({
      conservation: { ...packet().conservation, aggregateSupplyUsd: AGGREGATE_USD * 2 },
    }));
    expect(result!.selectedBridgeRoutes.some((route) => route.evidenceKind === "upper-bound")).toBe(false);
    expect(censusDiagnostics).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:conservation-breach" },
    ]);
  });

  it("publishes recorded rejections for an asset whose supply review is null", () => {
    const meta = { id: ASSET_ID, bridgeRouteRisk: profile() } as unknown as V9ExtensionRegistryMeta;
    const bound = fixedInput(packet());
    // No per-chain rows, so no supply review exists to carry the diagnostics.
    const input = {
      ...bound,
      chainCirculatingById: {},
      safetyScoreV9DeploymentSupplyCensusBinding: {
        ...bound.safetyScoreV9DeploymentSupplyCensusBinding!,
        registryFingerprint: "0".repeat(64),
      },
    } as SafetyScoreV9CompilerInput;
    const rejected = buildSafetyScoreV9SupplyAdmission(input, ASSET_ID, profile());
    expect(rejected.review).toBeNull();
    const bridge = adaptBridgeReview(
      meta, null, 0, new ReviewEvidenceBuilder(ASSET_ID, CLOCK_SEC), CLOCK_SEC, undefined, rejected.censusDiagnostics,
    );
    expect(bridge.review.diagnostics?.deploymentSupplyCensus).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:generation-mismatch" },
    ]);

    // The next build for the same asset has no packet, so nothing is carried over.
    const cleared = {
      ...fixedInput(undefined),
      chainCirculatingById: {},
      aggregateCirculatingById: {},
    } as SafetyScoreV9CompilerInput;
    const withoutPacket = buildSafetyScoreV9SupplyAdmission(cleared, ASSET_ID, profile());
    expect(withoutPacket.review).toBeNull();
    const noBand = adaptBridgeReview(
      meta, null, 0, new ReviewEvidenceBuilder(ASSET_ID, CLOCK_SEC), CLOCK_SEC, undefined, withoutPacket.censusDiagnostics,
    );
    expect(noBand.review.diagnostics?.deploymentSupplyCensus).toBeUndefined();
  });
});
