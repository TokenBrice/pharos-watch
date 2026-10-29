import { describe, expect, it } from "vitest";
import {
  SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL,
  SafetyScoreV9DeploymentSupplyCensusByIdSchema,
  SafetyScoreV9DeploymentSupplyCensusSchema,
  V9DeploymentSupplyCensusRejectionCodeSchema,
  deploymentSupplyCensusRejectionCode,
  type SafetyScoreV9DeploymentSupplyCensus,
  type V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const CLOCK_SEC = 1_793_294_244;
const SUPPLY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
const CENSUS = SUPPLY.deploymentSupplyCensus;

function evmRow(overrides: Partial<V9DeploymentSupplyCensusRow> = {}): V9DeploymentSupplyCensusRow {
  return {
    deploymentRouteKey: "ethereum:0x0000000000000000000000000000000000000001",
    chainId: "ethereum",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    readKind: "evm-total-supply",
    pin: {
      kind: "evm-header",
      blockNumber: 26_000_000,
      blockHash: `0x${"a".repeat(64)}`,
      blockTimeSec: CLOCK_SEC - 60,
      runtimeCodeSha256: "b".repeat(64),
    },
    decimals: 18,
    totalSupplyRaw: "1000000000000000000000",
    referencePriceUsd: 1,
    referencePriceObservedAtSec: CLOCK_SEC - 30,
    supplyUsdUpper: 1_000,
    shareUpper: 0.001,
    evidenceKind: "upper-bound",
    ...overrides,
  };
}

function packet(overrides: Partial<SafetyScoreV9DeploymentSupplyCensus> = {}): SafetyScoreV9DeploymentSupplyCensus {
  return {
    model: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL,
    observedAtSec: CLOCK_SEC,
    deployments: [evmRow()],
    conservation: {
      aggregateSupplyUsd: 1_000_000,
      measuredSupplyUsd: 1_000,
      measuredShareSum: 0.001,
      relativeTolerance: SUPPLY.conservationRelativeTolerance,
      absoluteToleranceUsd: SUPPLY.conservationAbsoluteToleranceUsd,
      rosterComplete: true,
      conserved: true,
    },
    rejected: [],
    ...overrides,
  };
}

function accept(value: unknown): SafetyScoreV9DeploymentSupplyCensus {
  return SafetyScoreV9DeploymentSupplyCensusSchema.parse(value);
}

function reject(value: unknown): void {
  expect(SafetyScoreV9DeploymentSupplyCensusSchema.safeParse(value).success).toBe(false);
}

describe("deployment supply census packet", () => {
  it("admits one pinned upper-bound row and keeps the model vocabulary", () => {
    const parsed = accept(packet());
    expect(parsed.deployments[0]!.evidenceKind).toBe("upper-bound");
    expect(parsed.model).toBe("deployment-supply-census-v1");
  });

  it("rejects the 65th deployment but accepts the configured maximum", () => {
    const deployments = Array.from({ length: CENSUS.maxDeploymentsPerAsset }, (_, index) =>
      evmRow({
        deploymentRouteKey: `ethereum:0x${(index + 1).toString(16).padStart(40, "0")}`,
        tokenAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      }),
    );
    expect(accept(packet({ deployments })).deployments).toHaveLength(CENSUS.maxDeploymentsPerAsset);
    reject(packet({
      deployments: [...deployments, evmRow({ deploymentRouteKey: "ethereum:0xdead", tokenAddress: "0xdead" })],
    }));
  });

  it("represents a conservation breach but refuses a conserved packet above the ceiling", () => {
    const breach = packet({
      conservation: {
        aggregateSupplyUsd: 100,
        measuredSupplyUsd: 100.4,
        measuredShareSum: 1.004,
        relativeTolerance: SUPPLY.conservationRelativeTolerance,
        absoluteToleranceUsd: SUPPLY.conservationAbsoluteToleranceUsd,
        rosterComplete: true,
        conserved: false,
      },
      rejected: [{ deploymentRouteKey: null, code: "census-rejected:conservation-breach" }],
    });
    expect(accept(breach).conservation.conserved).toBe(false);
    reject({ ...breach, rejected: [], conservation: { ...breach.conservation, conserved: true } });
  });

  it("rejects an incomplete roster that claims conservation", () => {
    const value = packet();
    reject({ ...value, conservation: { ...value.conservation, rosterComplete: false } });
  });

  it("bounds pin age and cross-chain skew at the policy boundary", () => {
    const atMaxAge = packet({
      deployments: [evmRow({
        pin: { ...evmRow().pin, blockTimeSec: CLOCK_SEC - CENSUS.observationMaxAgeSec },
      } as Partial<V9DeploymentSupplyCensusRow>)],
    });
    accept(atMaxAge);
    reject({
      ...atMaxAge,
      deployments: [evmRow({
        pin: { ...evmRow().pin, blockTimeSec: CLOCK_SEC - CENSUS.observationMaxAgeSec - 1 },
      } as Partial<V9DeploymentSupplyCensusRow>)],
    });

    const secondChain = evmRow({
      deploymentRouteKey: "base:0x0000000000000000000000000000000000000002",
      chainId: "base",
      tokenAddress: "0x0000000000000000000000000000000000000002",
      pin: {
        kind: "evm-header",
        blockNumber: 1,
        blockHash: `0x${"c".repeat(64)}`,
        blockTimeSec: CLOCK_SEC - 60 - CENSUS.observationMaxSkewSec,
        runtimeCodeSha256: "d".repeat(64),
      },
    });
    accept(packet({ deployments: [evmRow(), secondChain] }));
    reject(packet({
      deployments: [evmRow(), { ...secondChain, pin: { ...secondChain.pin, blockTimeSec: CLOCK_SEC - 60 - CENSUS.observationMaxSkewSec - 1 } }],
    }));
  });

  it("fails closed on missing pins, missing code hashes, future dates and mixed headers", () => {
    const row = evmRow();
    const withoutCodeHash = { ...row, pin: { ...row.pin, runtimeCodeSha256: undefined } };
    reject(packet({ deployments: [withoutCodeHash as unknown as V9DeploymentSupplyCensusRow] }));

    const withoutBlock = { ...row, pin: { ...row.pin, blockNumber: undefined } };
    reject(packet({ deployments: [withoutBlock as unknown as V9DeploymentSupplyCensusRow] }));

    reject(packet({ deployments: [{ ...row, pin: { ...row.pin, blockTimeSec: CLOCK_SEC + 1 } }] }));

    const reminted = evmRow({
      deploymentRouteKey: "ethereum:0x0000000000000000000000000000000000000003",
      tokenAddress: "0x0000000000000000000000000000000000000003",
      pin: { ...row.pin, blockHash: `0x${"e".repeat(64)}` },
    });
    reject(packet({ deployments: [row, reminted] }));
  });

  it("shares one header across same-chain deployments with distinct code hashes", () => {
    const first = evmRow();
    const second = evmRow({
      deploymentRouteKey: "ethereum:0x0000000000000000000000000000000000000002",
      tokenAddress: "0x0000000000000000000000000000000000000002",
      pin: {
        kind: "evm-header",
        blockNumber: 26_000_000,
        blockHash: `0x${"a".repeat(64)}`,
        blockTimeSec: CLOCK_SEC - 60,
        runtimeCodeSha256: "f".repeat(64),
      },
    });
    expect(accept(packet({ deployments: [first, second] })).deployments).toHaveLength(2);
    reject(packet({
      deployments: [
        first,
        { ...second, pin: { ...second.pin, blockNumber: 26_000_001 } },
      ],
    }));
  });

  it("rejects a stale reference price and a read kind that disagrees with its pin", () => {
    reject(packet({
      deployments: [evmRow({
        referencePriceObservedAtSec: CLOCK_SEC - CENSUS.observationMaxAgeSec - 1,
      })],
    }));
    reject(packet({
      deployments: [evmRow({
        readKind: "solana-mint",
      })],
    }));
  });

  it("requires the policy conservation tolerance instead of a packet-local claim", () => {
    const value = packet();
    reject({ ...value, conservation: { ...value.conservation, relativeTolerance: 0.01 } });
  });

  it("keeps rejection codes machine-readable and never admits a rejected deployment", () => {
    expect(deploymentSupplyCensusRejectionCode("conservation-breach")).toBe("census-rejected:conservation-breach");
    expect(V9DeploymentSupplyCensusRejectionCodeSchema.safeParse("census-rejected:conservation-breach").success).toBe(true);
    expect(V9DeploymentSupplyCensusRejectionCodeSchema.safeParse("conservation-breach").success).toBe(false);
    reject(packet({ rejected: [{ deploymentRouteKey: null, code: "conservation-breach" }] }));
    reject(packet({
      rejected: [{ deploymentRouteKey: evmRow().deploymentRouteKey, code: "census-rejected:missing-code-hash" }],
    }));
  });

  it("indexes packets by asset id and rejects an open packet shape", () => {
    const byId = SafetyScoreV9DeploymentSupplyCensusByIdSchema.parse({ "fixture-usd": packet() });
    expect(Object.keys(byId)).toEqual(["fixture-usd"]);
    expect(SafetyScoreV9DeploymentSupplyCensusByIdSchema.safeParse({
      "fixture-usd": { ...packet(), extra: true },
    }).success).toBe(false);
  });
});
