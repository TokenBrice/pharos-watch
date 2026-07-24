import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  reviewedDeploymentAttributionValidationError,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";

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

  it("rejects future, stale, and cross-chain-skewed observations", () => {
    expect(derive(observations(), 1_784_881_327)).toBeNull();
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
