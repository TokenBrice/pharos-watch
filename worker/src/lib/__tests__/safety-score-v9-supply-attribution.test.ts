import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../chain-registry";
import type { StablecoinData } from "@shared/types/market";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../evm-rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../evm-rpc")>();
  return {
    ...original,
    fetchEvmMulticall3Aggregate3AtBlock: rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
  };
});

import {
  captureSafetyScoreV9SupplyAttributionById,
  deriveLockMintSupplyPartition,
} from "../safety-score-v9-supply-attribution";

const XAUT_TOTAL_SUPPLY_RAW = 707_747_089_000n;
const XAUT0_LOCKBOX_BALANCE_RAW = 29_714_544_713n;
const XAUT_AGGREGATE_SUPPLY_USD = 2_480_000_000;
const OBSERVED_AT_SEC = 1_774_000_000;

function uint256(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function xautAsset(chainCirculating: StablecoinData["chainCirculating"] = {}): StablecoinData {
  return {
    id: "xaut-tether",
    name: "Tether Gold",
    symbol: "XAUT",
    circulating: { peggedGOLD: XAUT_AGGREGATE_SUPPLY_USD },
    chainCirculating,
  } as unknown as StablecoinData;
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
    const asset = xautAsset();
    const before = structuredClone(asset);

    const captured = await captureSafetyScoreV9SupplyAttributionById(
      [asset],
      OBSERVED_AT_SEC,
      chainRpcs(),
    );

    expect(asset).toEqual(before);
    expect(captured["xaut-tether"]).toMatchObject({
      model: "canonical-lock-mint-partition-v1",
      observedAtSec: OBSERVED_AT_SEC,
    });
    const rows = captured["xaut-tether"]!.currentSupplyUsdByChain;
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
    const existing = {
      Ethereum: {
        current: XAUT_AGGREGATE_SUPPLY_USD,
        circulatingPrevDay: XAUT_AGGREGATE_SUPPLY_USD,
        circulatingPrevWeek: XAUT_AGGREGATE_SUPPLY_USD,
        circulatingPrevMonth: XAUT_AGGREGATE_SUPPLY_USD,
      },
    };

    await expect(
      captureSafetyScoreV9SupplyAttributionById(
        [xautAsset(existing)],
        OBSERVED_AT_SEC,
        chainRpcs(),
      ),
    ).resolves.toEqual({});
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();

    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue(null);
    await expect(
      captureSafetyScoreV9SupplyAttributionById(
        [xautAsset()],
        OBSERVED_AT_SEC,
        chainRpcs(),
      ),
    ).resolves.toEqual({});
  });
});
