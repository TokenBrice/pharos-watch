import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  corruptWmDeploymentObservation,
  corruptXautObservation,
  makeWmDeploymentObservations,
  makeXautObservation,
} from "../../test-helpers/v9-fixed-input";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedCentrifugeDeploymentIdentity,
  expectedWmDeploymentIdentity,
  reviewedDeploymentAttributionValidationError,
  reviewedDeploymentObservationTimingIssue,
  reviewedDeploymentIdentityValidationError,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  buildXautRepresentationGroupInventory,
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
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
  return makeWmDeploymentObservations({
    clockSec: CLOCK_SEC,
    rawSupplyByRoute: RAW_SUPPLY_BY_ROUTE,
    blockTimeByChain: BLOCK_TIME_BY_CHAIN,
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
  it("checks only the pinned deployment identity when an expected deployment is supplied", () => {
    const row = observations()[0]!;
    expect(
      reviewedDeploymentIdentityValidationError(row, "wm-m0", {
        chainId: row.chainId,
        contractAddress: row.contractAddress.toUpperCase(),
      }),
    ).toBeNull();
    expect(
      reviewedDeploymentIdentityValidationError(row, "wm-m0", {
        chainId: row.chainId,
        contractAddress: "0x000000000000000000000000000000000000dead",
      }),
    ).toBe(`reviewed deployment identity mismatch for ${row.routeId}`);
    expect(
      reviewedDeploymentIdentityValidationError(row, "wm-m0", {
        chainId: "base",
        contractAddress: row.contractAddress,
      }),
    ).toBe(`reviewed deployment identity mismatch for ${row.routeId}`);
  });

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
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "routeId", "arbitrum:unexpected"),
    ],
    [
      "wrong chain",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "chainId", "base"),
    ],
    [
      "wrong address",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "contractAddress", "0x0000000000000000000000000000000000000001"),
    ],
    [
      "wrong decimals",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "decimals", 18),
    ],
    [
      "malformed raw supply",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "rawSupply", "-1"),
    ],
    ["all-zero raw supply", () => observations().map((row) => ({ ...row, rawSupply: "0" }))],
    [
      "wrong EVM code identity",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "runtimeCodeSha256", "0".repeat(64)),
    ],
    [
      "wrong EVM implementation code identity",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "implementationCodeSha256", "0".repeat(64)),
    ],
    [
      "missing block hash",
      () => corruptWmDeploymentObservation(observations(), (_row, index) => index === 0, "blockHash", ""),
    ],
    [
      "malformed Solana block hash",
      () => corruptWmDeploymentObservation(observations(), (row) => row.chainId === "solana", "blockHash", "0".repeat(44)),
    ],
    [
      "wrong Solana controller",
      () => corruptWmDeploymentObservation(observations(), (row) => row.chainId === "solana", "controllerAddress", "11111111111111111111111111111111"),
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

const CENTRIFUGE_AGGREGATE_SUPPLY_USD = 51_033_069.79770032;

function centrifugeObservations(
  assetId = "acrdx-anemoy-apollo",
): ReviewedDeploymentSupplyObservation[] {
  const inventory = buildReviewedDeploymentRouteInventory(assetId);
  if (!inventory) throw new Error(`Missing ${assetId} route inventory`);
  return inventory.routes.map((route, index) => {
    const identity = expectedCentrifugeDeploymentIdentity(
      assetId,
      route.routeId,
    );
    if (!identity) throw new Error(`Missing identity for ${route.routeId}`);
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply:
        route.chainId === "base" || route.chainId === "solana"
          ? "0"
          : (10n ** BigInt(route.decimals) * BigInt(index + 1)).toString(),
      blockNumberOrSlot: (43_000_000 + index).toString(),
      blockTimeSec: CLOCK_SEC - 30 + index,
    };
    return identity.runtime === "evm"
      ? {
          ...common,
          blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
          runtimeCodeSha256: identity.runtimeCodeSha256,
          controllerAddress: identity.controllerAddress,
        }
      : {
          ...common,
          blockHash: "C".repeat(44),
          programOwner: identity.programOwner,
          mintAuthority: identity.mintAuthority,
          controllerAddress: identity.controllerAddress,
          controllerProgramOwner: identity.controllerProgramOwner,
        };
  });
}

function deriveCentrifuge(
  rows = centrifugeObservations(),
): ReturnType<typeof deriveReviewedDeploymentUnitPartition> {
  return deriveReviewedDeploymentUnitPartition({
    assetId: "acrdx-anemoy-apollo",
    aggregateSupplyUsd: CENTRIFUGE_AGGREGATE_SUPPLY_USD,
    registryFingerprint: REGISTRY_FINGERPRINT,
    scoringClockSec: CLOCK_SEC,
    observations: rows,
  });
}

describe("Centrifuge burn/mint deployment supply attribution contract", () => {
  it("binds each supported asset to its complete official inventory", () => {
    expect(
      buildReviewedDeploymentRouteInventory("jtrsy-anemoy")!.routes,
    ).toHaveLength(8);
    expect(
      buildReviewedDeploymentRouteInventory("acrdx-anemoy-apollo")!.routes,
    ).toHaveLength(6);

    const attribution = deriveCentrifuge();
    expect(attribution).not.toBeNull();
    expect(
      attribution!.deployments.reduce(
        (sum, row) => sum + row.currentSupplyUsd,
        0,
      ),
    ).toBe(CENTRIFUGE_AGGREGATE_SUPPLY_USD);
    expect(
      attribution!.deployments.filter((row) => row.rawSupply === "0"),
    ).toEqual([
      expect.objectContaining({ chainId: "base", currentSupplyUsd: 0 }),
      expect.objectContaining({ chainId: "solana", currentSupplyUsd: 0 }),
    ]);
    expect(
      stableJsonStringifyV1(
        deriveCentrifuge(centrifugeObservations().reverse()),
      ),
    ).toBe(stableJsonStringifyV1(attribution));
  });

  it.each([
    [
      "an omitted Solana route",
      () =>
        centrifugeObservations().filter((row) => row.chainId !== "solana"),
    ],
    [
      "EVM runtime-code drift",
      () =>
        centrifugeObservations().map((row) =>
          row.chainId === "ethereum"
            ? { ...row, runtimeCodeSha256: "0".repeat(64) }
            : row,
        ),
    ],
    [
      "an unexpected proxy identity",
      () =>
        centrifugeObservations().map((row) =>
          row.chainId === "base"
            ? {
                ...row,
                implementationAddress:
                  "0x0000000000000000000000000000000000000001",
              }
            : row,
        ),
    ],
    [
      "Solana authority drift",
      () =>
        centrifugeObservations().map((row) =>
          row.chainId === "solana"
            ? {
                ...row,
                mintAuthority:
                  "11111111111111111111111111111111",
              }
            : row,
        ),
    ],
    [
      "a post-clock Solana observation",
      () =>
        centrifugeObservations().map((row) =>
          row.chainId === "solana"
            ? { ...row, blockTimeSec: CLOCK_SEC + 1 }
            : row,
        ),
    ],
  ])("fails closed for %s", (_label, mutate) => {
    expect(deriveCentrifuge(mutate())).toBeNull();
  });
});

const XAUT_AGGREGATE_SUPPLY_USD = 2_480_000_000;

function xautObservation(): XautLockMintObservation {
  return makeXautObservation({ clockSec: CLOCK_SEC });
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
      xautRepresentationGroupAttributionValidationError({
        attribution,
        aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
        registryFingerprint: REGISTRY_FINGERPRINT,
        clockSec:
          attribution.observedAtSec +
          XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC +
          1,
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

  it.each([
    ["adapter endpoint", "adapterEndpointAddress", "0x0000000000000000000000000000000000000001"],
    ["treasury balance", "treasuryBalanceRaw", "94923429467"],
    ["quarantined disclosure supply", "disclosure.quarantinedRaw", "1"],
  ] as const)("rejects invalid %s", (_label, field, value) => {
    expect(deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
      registryFingerprint: REGISTRY_FINGERPRINT,
      scoringClockSec: CLOCK_SEC,
      observation: corruptXautObservation(xautObservation(), field, value),
    })).toBeNull();
  });
});
