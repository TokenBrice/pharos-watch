import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  reviewedDeploymentAttributionValidationError,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  buildXautRepresentationGroupInventory,
  buildXautTransparencySource,
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT0_ADAPTER_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
  XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
  XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
  XAUT_CANONICAL_RUNTIME_CODE_SHA256,
  XAUT_CANONICAL_TOKEN_ADDRESS,
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
  xautRepresentationGroupAttributionValidationError,
  type XautLockMintObservation,
} from "../safety-score-v9-xaut-supply-attribution-contract";

const AGGREGATE_SUPPLY_USD = 87_020_618.58982982;
const REGISTRY_FINGERPRINT = "a".repeat(64);
const CLOCK_SEC = 1_784_881_340;

const RAW_SUPPLY_BY_ROUTE: Record<string, string> = {
  "ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291": "86712798085682",
  "arbitrum:0x437cc33344a0b27a429f795ff6b469c72698b291": "88459935972",
  "base:0x437cc33344a0b27a429f795ff6b469c72698b291": "70802728527",
  "plume:0x437cc33344a0b27a429f795ff6b469c72698b291": "0",
  "solana:mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp": "247794997129",
};

const BLOCK_TIME_BY_CHAIN: Record<string, number> = {
  ethereum: 1_784_881_319,
  arbitrum: 1_784_881_326,
  base: 1_784_881_327,
  plume: 1_784_881_328,
  solana: 1_784_881_315,
};

function observations(): ReviewedDeploymentSupplyObservation[] {
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  return inventory.routes.map((route, index) => {
    const identity = expectedWmDeploymentIdentity(route.routeId);
    if (!identity) throw new Error(`Missing identity for ${route.routeId}`);
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply: RAW_SUPPLY_BY_ROUTE[route.routeId]!,
      blockNumberOrSlot: (25_000_000 + index).toString(),
      blockTimeSec: BLOCK_TIME_BY_CHAIN[route.chainId]!,
    };
    return identity.runtime === "evm"
      ? {
          ...common,
          blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
          runtimeCodeSha256: identity.runtimeCodeSha256,
          implementationAddress: identity.implementationAddress,
          implementationCodeSha256: identity.implementationCodeSha256,
          underlyingTokenAddress: identity.underlyingTokenAddress,
          controllerAddress: identity.controllerAddress,
        }
      : {
          ...common,
          blockHash: "B".repeat(44),
          programOwner: identity.programOwner,
          mintAuthority: identity.mintAuthority,
          controllerAddress: identity.controllerAddress,
          controllerProgramOwner: identity.controllerProgramOwner,
        };
  });
}

function derive(rows = observations(), clockSec = CLOCK_SEC) {
  return deriveReviewedDeploymentUnitPartition({
    assetId: "wm-m0",
    aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
    registryFingerprint: REGISTRY_FINGERPRINT,
    scoringClockSec: clockSec,
    observations: rows,
  });
}

describe("reviewed deployment supply attribution contract", () => {
  it("allocates the accepted aggregate by exact route units and retains explicit zero", () => {
    const attribution = derive();
    expect(attribution).not.toBeNull();
    expect(attribution!.deployments.map((row) => row.routeId)).toEqual(
      [...attribution!.deployments.map((row) => row.routeId)].sort(),
    );
    expect(attribution!.deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)).toBe(
      AGGREGATE_SUPPLY_USD,
    );
    expect(
      attribution!.deployments.find((row) => row.chainId === "plume"),
    ).toMatchObject({ rawSupply: "0", currentSupplyUsd: 0 });

    const rawUnitTotal = attribution!.deployments.reduce(
      (sum, row) => sum + Number(row.rawSupply) / 10 ** row.decimals,
      0,
    );
    expect(rawUnitTotal).not.toBeCloseTo(AGGREGATE_SUPPLY_USD, 3);
  });

  it("is deterministic across observation order", () => {
    expect(stableJsonStringifyV1(derive(observations().reverse()))).toBe(
      stableJsonStringifyV1(derive()),
    );
  });

  it.each([
    ["omitted route", () => observations().slice(1)],
    ["duplicate route", () => [...observations().slice(0, -1), observations()[0]!]],
    [
      "unexpected route",
      () => observations().map((row, index) => index === 0 ? { ...row, routeId: "arbitrum:unexpected" } : row),
    ],
    [
      "wrong chain",
      () => observations().map((row, index) => index === 0 ? { ...row, chainId: "base" } : row),
    ],
    [
      "wrong address",
      () => observations().map((row, index) => index === 0
        ? { ...row, contractAddress: "0x0000000000000000000000000000000000000001" }
        : row),
    ],
    [
      "wrong decimals",
      () => observations().map((row, index) => index === 0 ? { ...row, decimals: 18 } : row),
    ],
    [
      "malformed raw supply",
      () => observations().map((row, index) => index === 0 ? { ...row, rawSupply: "-1" } : row),
    ],
    ["all-zero raw supply", () => observations().map((row) => ({ ...row, rawSupply: "0" }))],
    [
      "wrong EVM code identity",
      () => observations().map((row, index) => index === 0
        ? { ...row, runtimeCodeSha256: "0".repeat(64) }
        : row),
    ],
    [
      "wrong EVM implementation code identity",
      () => observations().map((row, index) => index === 0
        ? { ...row, implementationCodeSha256: "0".repeat(64) }
        : row),
    ],
    [
      "missing block hash",
      () => observations().map((row, index) => index === 0
        ? { ...row, blockHash: "" }
        : row),
    ],
    [
      "malformed Solana block hash",
      () => observations().map((row) => row.chainId === "solana"
        ? { ...row, blockHash: "0".repeat(44) }
        : row),
    ],
    [
      "wrong Solana controller",
      () => observations().map((row) => row.chainId === "solana"
        ? { ...row, controllerAddress: "11111111111111111111111111111111" }
        : row),
    ],
  ])("fails closed for %s", (_label, mutate) => {
    expect(derive(mutate())).toBeNull();
  });

  it("admits only bounded post-clock Solana finality", () => {
    const boundedSolana = observations().map((row) =>
      row.chainId === "solana" ? { ...row, blockTimeSec: CLOCK_SEC + 5 } : row,
    );
    expect(derive(boundedSolana)).not.toBeNull();

    const futureEvm = observations().map((row) =>
      row.chainId === "base" ? { ...row, blockTimeSec: CLOCK_SEC + 1 } : row,
    );
    expect(derive(futureEvm)).toBeNull();
    expect(
      reviewedDeploymentObservationTimingIssue({
        clockSec: CLOCK_SEC,
        captureStartedAtSec: Math.min(...futureEvm.map((row) => row.blockTimeSec)),
        captureEndedAtSec: Math.max(...futureEvm.map((row) => row.blockTimeSec)),
        observedAtSec: Math.max(...futureEvm.map((row) => row.blockTimeSec)),
        deployments: futureEvm,
      }),
    ).toEqual({
      code: "future-clock",
      failedRouteId: "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
    });

    const allFuture = observations().map((row, index) => ({
      ...row,
      blockTimeSec: CLOCK_SEC + index + 1,
    }));
    expect(derive(allFuture)).toBeNull();
  });

  it("rejects stale and cross-chain-skewed observations", () => {
    expect(derive(observations(), 1_784_883_129)).toBeNull();
    expect(
      derive(
        observations().map((row, index) =>
          index === 0 ? { ...row, blockTimeSec: 1_784_881_000 } : row,
        ),
      ),
    ).toBeNull();
  });

  it("invalidates a packet when registry or route-inventory identity drifts", () => {
    const attribution = derive()!;
    expect(
      reviewedDeploymentAttributionValidationError({
        assetId: "wm-m0",
        attribution: { ...attribution, routeInventoryDigest: "0".repeat(64) },
        aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec: CLOCK_SEC,
      }),
    ).toContain("route inventory mismatch");
    expect(
      reviewedDeploymentAttributionValidationError({
        assetId: "wm-m0",
        attribution,
        aggregateSupplyUsd: AGGREGATE_SUPPLY_USD,
        registryFingerprint: "b".repeat(64),
        clockSec: CLOCK_SEC,
      }),
    ).toContain("registry fingerprint mismatch");
  });
});

const XAUT_AGGREGATE_SUPPLY_USD = 2_480_000_000;

function xautObservation(): XautLockMintObservation {
  return {
    chainId: "ethereum",
    canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterAddress: XAUT0_ADAPTER_ADDRESS,
    decimals: 6,
    canonicalTotalSupplyRaw: "707747089000",
    treasuryAddress: XAUT_TREASURY_ADDRESS,
    treasuryBalanceRaw: "94923429468",
    adapterLockedSupplyRaw: "29720802896",
    blockNumber: 25_601_844,
    blockTimeSec: CLOCK_SEC - 100,
    blockHash: `0x${"ab".repeat(32)}`,
    canonicalRuntimeCodeSha256:
      XAUT_CANONICAL_RUNTIME_CODE_SHA256,
    canonicalImplementationAddress:
      XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
    canonicalImplementationCodeSha256:
      XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
    adapterRuntimeCodeSha256:
      XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
    adapterImplementationAddress:
      XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
    adapterImplementationCodeSha256:
      XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
    adapterTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterEndpointAddress: XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
    disclosure: {
      sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
      sourceConfigDigest: buildXautTransparencySource()!.configDigest,
      sourceTimestampSec: CLOCK_SEC - 200,
      responseSha256: "c".repeat(64),
      totalAuthorizedRaw: "707747089000",
      notIssuedRaw: "94923429468",
      quarantinedRaw: "0",
    },
  };
}

describe("XAUT representation-group supply attribution contract", () => {
  it("binds all reviewed XAUt0 routes to one conserved group", () => {
    const inventory = buildXautRepresentationGroupInventory();
    expect(inventory).toMatchObject({
      assetId: "xaut-tether",
      representationId: "xaut0-omnichain",
      riskTier: "external-lock-mint",
      commonFailureDomainKeys: ["protocol:xaut0-omnichain"],
    });
    expect(inventory!.routes).toHaveLength(14);

    const attribution =
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        observation: xautObservation(),
      });
    expect(attribution).not.toBeNull();
    expect(
      attribution!.canonical.currentSupplyUsd +
        attribution!.representationGroup.currentSupplyUsd,
    ).toBe(XAUT_AGGREGATE_SUPPLY_USD);
    expect(
      attribution!.representationGroup.currentSupplyUsd /
        XAUT_AGGREGATE_SUPPLY_USD,
    ).toBeCloseTo(0.04849813227, 10);
    expect(attribution!.observedAtSec).toBe(CLOCK_SEC - 100);
    expect(attribution!.representationGroup.routeIds).toEqual(
      inventory!.routes.map((route) => route.routeId),
    );
    expect(
      attribution!.representationGroup.failureDomainKeys,
    ).toEqual([
      "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
      "protocol:xaut0-omnichain",
    ]);
  });

  it("rejects inventory, identity, freshness, and conservation drift", () => {
    const attribution =
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        observation: xautObservation(),
      })!;
    expect(
      xautRepresentationGroupAttributionValidationError({
        attribution: {
          ...attribution,
          routeInventoryDigest: "0".repeat(64),
        },
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec: CLOCK_SEC,
      }),
    ).toContain("route inventory mismatch");
    expect(
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        observation: {
          ...xautObservation(),
          adapterEndpointAddress:
            "0x0000000000000000000000000000000000000001",
        },
      }),
    ).toBeNull();
    expect(
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        observation: {
          ...xautObservation(),
          treasuryBalanceRaw: "94923429467",
        },
      }),
    ).toBeNull();
    expect(
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        observation: {
          ...xautObservation(),
          disclosure: {
            ...xautObservation().disclosure,
            quarantinedRaw: "1",
          },
        },
      }),
    ).toBeNull();
    expect(
      xautRepresentationGroupAttributionValidationError({
        attribution,
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec: attribution.observedAtSec + 1_801,
      }),
    ).toContain("observation time");
    expect(
      xautRepresentationGroupAttributionValidationError({
        attribution: {
          ...attribution,
          observation: {
            ...attribution.observation,
            disclosure: {
              ...attribution.observation.disclosure,
              sourceTimestampSec: CLOCK_SEC - 172_801,
            },
          },
        },
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec: CLOCK_SEC,
      }),
    ).toContain("disclosure time");
    expect(
      xautRepresentationGroupAttributionValidationError({
        attribution: {
          ...attribution,
          representationGroup: {
            ...attribution.representationGroup,
            currentSupplyUsd:
              attribution.representationGroup.currentSupplyUsd + 1,
          },
        },
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec: CLOCK_SEC,
      }),
    ).toContain("does not conserve");
  });
});
