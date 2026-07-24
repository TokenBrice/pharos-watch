import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import wmMetaSource from "@shared/data/stablecoins/coins/wm-m0.json";
import type { BridgeRouteRiskProfile } from "@shared/types/core";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  observeWmReviewedDeploymentUnitPartitionAttempt: vi.fn(),
}));

vi.mock("../evm-rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../evm-rpc")>();
  return {
    ...original,
    fetchEvmMulticall3Aggregate3AtBlock: rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
  };
});

vi.mock("../safety-score-v9-wm-supply-observer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../safety-score-v9-wm-supply-observer")>();
  return {
    ...original,
    observeWmReviewedDeploymentUnitPartitionAttempt:
      rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt,
  };
});

import {
  captureSafetyScoreV9SupplyAttribution,
  captureSafetyScoreV9SupplyAttributionById,
  deriveLockMintSupplyPartition,
} from "../safety-score-v9-supply-attribution";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9-extension-supply";

const XAUT_TOTAL_SUPPLY_RAW = 707_747_089_000n;
const XAUT0_LOCKBOX_BALANCE_RAW = 29_714_544_713n;
const XAUT_AGGREGATE_SUPPLY_USD = 2_480_000_000;
const OBSERVED_AT_SEC = 1_774_000_000;

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function xautFixedInput(
  chainCirculating: Record<string, { current: number }> = {},
): ReportCardsFixedInput {
  return {
    activeAssetIds: ["xaut-tether"],
    clockSec: OBSERVED_AT_SEC,
    chainCirculatingById: { "xaut-tether": chainCirculating },
    aggregateCirculatingById: {
      "xaut-tether": {
        circulating: { peggedGOLD: XAUT_AGGREGATE_SUPPLY_USD },
        observedAtSec: OBSERVED_AT_SEC,
      },
    },
  } as unknown as ReportCardsFixedInput;
}

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([
    [
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://ethereum.example",
        explorerUrl: "https://etherscan.io",
      },
    ],
  ]);
}

describe("Safety Score V9 lock/mint supply attribution", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockReset();
  });

  it("partitions aggregate XAUT without double-counting its XAUt0 lockbox", () => {
    const partition = deriveLockMintSupplyPartition({
      aggregateSupplyUsd: XAUT_AGGREGATE_SUPPLY_USD,
      canonicalTotalSupplyRaw: XAUT_TOTAL_SUPPLY_RAW,
      lockboxBalancesRaw: [XAUT0_LOCKBOX_BALANCE_RAW],
      canonicalChainLabel: "Ethereum",
      pooledRepresentationLabel: "XAUt0 lock-mint pool",
    });

    expect(partition).not.toBeNull();
    expect(partition!.canonicalSupplyUsd + partition!.pooledRepresentationSupplyUsd).toBe(
      XAUT_AGGREGATE_SUPPLY_USD,
    );
    expect(partition!.pooledRepresentationSupplyUsd / XAUT_AGGREGATE_SUPPLY_USD).toBeCloseTo(
      0.04198469365,
      10,
    );
  });

  it("captures a same-block V9-only partition and leaves the public/V8 row unchanged", async () => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue([
      {
        label: "canonical-total-supply",
        success: true,
        returnData: uint256(XAUT_TOTAL_SUPPLY_RAW),
      },
      {
        label: "lockbox-balance:0",
        success: true,
        returnData: uint256(XAUT0_LOCKBOX_BALANCE_RAW),
      },
    ]);
    const fixedInput = xautFixedInput();
    const before = structuredClone(fixedInput);

    const captured = await captureSafetyScoreV9SupplyAttributionById(
      fixedInput,
      chainRpcs(),
    );

    expect(fixedInput).toEqual(before);
    expect(captured["xaut-tether"]).toMatchObject({
      model: "canonical-lock-mint-partition-v1",
      observedAtSec: OBSERVED_AT_SEC,
    });
    const attribution = captured["xaut-tether"]!;
    if (attribution.model !== "canonical-lock-mint-partition-v1") {
      throw new Error("Expected canonical lock/mint attribution");
    }
    const rows = attribution.currentSupplyUsdByChain;
    expect(Object.keys(rows)).toEqual(["Ethereum", "XAUt0 lock-mint pool"]);
    expect(Object.values(rows).reduce((sum, value) => sum + value, 0)).toBe(XAUT_AGGREGATE_SUPPLY_USD);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(1);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledWith(
      "ethereum",
      [
        expect.objectContaining({
          label: "canonical-total-supply",
          target: "0x68749665ff8d2d112fa859aa293f07a622782f38",
          callData: "0x18160ddd",
        }),
        expect.objectContaining({
          label: "lockbox-balance:0",
          target: "0x68749665ff8d2d112fa859aa293f07a622782f38",
        }),
      ],
      "latest",
      expect.objectContaining({ chainRpcs: expect.any(Map) }),
    );
  });

  it("preserves a real upstream chain map and fails closed on unavailable evidence", async () => {
    const existing = { Ethereum: { current: XAUT_AGGREGATE_SUPPLY_USD } };

    await expect(
      captureSafetyScoreV9SupplyAttributionById(
        xautFixedInput(existing),
        chainRpcs(),
      ),
    ).resolves.toEqual({});
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();

    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue(null);
    await expect(
      captureSafetyScoreV9SupplyAttributionById(
        xautFixedInput(),
        chainRpcs(),
      ),
    ).resolves.toEqual({});
  });

  it("restores aggregate-only bridge materiality when the atomic wM capture fails", async () => {
    rpcMocks.observeWmReviewedDeploymentUnitPartitionAttempt.mockResolvedValue({
      status: "rejected",
      rejectionCode: "deployment-identity-mismatch",
      failedRouteId:
        "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
    });
    const fixedInput = {
      activeAssetIds: ["wm-m0"],
      clockSec: OBSERVED_AT_SEC,
      sourceGeneration: "report-cards:v8:fixture",
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      registryFingerprint: "a".repeat(64),
      chainCirculatingById: { "wm-m0": {} },
      aggregateCirculatingById: {
        "wm-m0": {
          circulating: { peggedUSD: 87_020_618.58982982 },
          observedAtSec: OBSERVED_AT_SEC,
        },
      },
    } as unknown as ReportCardsFixedInput;

    const capture = await captureSafetyScoreV9SupplyAttribution(
      fixedInput,
      chainRpcs(),
    );

    expect(capture.attributionById).not.toHaveProperty("wm-m0");
    expect(capture.journalRecords).toHaveLength(1);
    expect(capture.journalRecords[0]).toMatchObject({
      assetId: "wm-m0",
      admissionCode: "supply-attribution.admission.rejected-identity-drift",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      failedRouteId:
        "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
      contentSha256: null,
    });
    expect(
      buildSafetyScoreV9SupplyReview(
        {
          ...fixedInput,
          safetyScoreV9SupplyAttributionById: capture.attributionById,
        },
        "wm-m0",
        wmMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile,
      ),
    ).toBeNull();
  });
});
