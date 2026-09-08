import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";

const evmRpcMocks = vi.hoisted(() => ({
  fetchEtherscanUint256AtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEtherscanProxyHex: vi.fn(),
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmStorageAtBlock: vi.fn(),
  fetchEvmCodeAtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => evmRpcMocks);
const hashMock = vi.hoisted(() => vi.fn());
vi.mock("viem/utils", () => ({
  keccak256: hashMock,
}));

import {
  fetchEvmBlockNumber,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
  fetchEvmUint256AtBlock,
} from "../../../lib/evm-rpc";
import { fetchMakinaStrategyReserves } from "../makina-strategy";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const STRATEGY_FIXTURE = JSON.parse(readFileSync(join(FIXTURES_DIR, "makina-strategy.json"), "utf8"));
const ALLOCATIONS_FIXTURE = JSON.parse(readFileSync(join(FIXTURES_DIR, "makina-allocations.json"), "utf8"));
const MACHINE = "0x6b006870c83b1cd49e766ac9209f8d68763df721";
const ASYNC_REDEEMER = "0x1303c26cfe06bac5bfee29907f37919643def75c";
const DUSD = "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BEACON = "0x1f20cdfa19b860f0dd78fefbb052be5aa5003dd9";
const REVIEWED_IMPLEMENTATION = "0x49c4762ab838f2e5d8252b69b90a1e8587a74511";
const REVIEWED_IMPLEMENTATION_CODE_HASH =
  "0x395083795e58602401305485b5328241fb589687c9edac0dddede880a083524f";
const BLOCK = 25_646_765;

function uint256Result(value: bigint | number): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressResult(address: string): `0x${string}` {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function baseConfig(): LiveReservesConfig {
  return {
    adapter: "makina-strategy",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: {
        kind: "http-json",
        url: "https://api.makina.finance/v1/strategies/dusd",
      },
    },
    params: {
      allocationsUrl: "https://api.makina.finance/v1/strategies/dusd/allocations",
      machineAddress: MACHINE,
      asyncRedeemerAddress: ASYNC_REDEEMER,
      accountingTokenSymbol: "USDC",
      accountingTokenDecimals: 6,
      otherThresholdPct: 2,
      reconciliationTolerancePct: 0.5,
    },
  };
}

function dusdCoin(): StablecoinMeta {
  return {
    id: "dusd-dialectic",
    contracts: [{ chain: "ethereum", address: DUSD, decimals: 18 }],
  } as StablecoinMeta;
}

function mockMakinaJson(): void {
  fetchWithRetryMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/allocations")) return jsonResponse(ALLOCATIONS_FIXTURE);
    return jsonResponse(STRATEGY_FIXTURE);
  });
}

function mockSuccessfulRouteReads(overrides: Record<string, `0x${string}`> = {}): void {
  vi.mocked(fetchEvmBlockNumber).mockResolvedValue(BLOCK);
  vi.mocked(fetchEvmStorageAtBlock).mockResolvedValue(addressResult(BEACON));
  vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(addressResult(REVIEWED_IMPLEMENTATION));
  vi.mocked(fetchEvmCodeAtBlock).mockResolvedValue("0x6000");
  vi.mocked(fetchEvmUint256AtBlock).mockResolvedValue(3_104_889_979n);
  vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
    calls.map((call) => {
      if (call.label in overrides) {
        return { label: call.label, success: true, returnData: overrides[call.label] };
      }
      switch (call.label) {
        case "redeemer-machine":
          return { label: call.label, success: true, returnData: addressResult(MACHINE) };
        case "machine-accounting-token":
          return { label: call.label, success: true, returnData: addressResult(USDC) };
        case "machine-share-token":
          return { label: call.label, success: true, returnData: addressResult(DUSD) };
        case "machine-idle-usdc":
          return { label: call.label, success: true, returnData: uint256Result(120_722_783n) };
        case "redeemer-locked-shares":
          return { label: call.label, success: true, returnData: uint256Result(3_000n * 10n ** 18n) };
        case "redeemer-reserved-usdc":
          return { label: call.label, success: true, returnData: uint256Result(3_679n) };
        case "redeemer-whitelist":
          return { label: call.label, success: true, returnData: uint256Result(0) };
        case "redeemer-sanctions-check":
          return { label: call.label, success: true, returnData: uint256Result(1) };
        case "redeemer-finalization-delay":
          return { label: call.label, success: true, returnData: uint256Result(43_200) };
        case "redeemer-next-request-id":
          return { label: call.label, success: true, returnData: uint256Result(344) };
        case "redeemer-last-finalized-request-id":
          return { label: call.label, success: true, returnData: uint256Result(342) };
        case "redeemer-min-redeem-amount":
          return { label: call.label, success: true, returnData: uint256Result(10n ** 18n) };
        default:
          return { label: call.label, success: false, returnData: "0x" as `0x${string}` };
      }
    }),
  );
}

describe("fetchMakinaStrategyReserves redemption telemetry", () => {
  beforeEach(() => {
    resetRpcMocks();
    hashMock.mockReturnValue(REVIEWED_IMPLEMENTATION_CODE_HASH);
    mockMakinaJson();
    mockSuccessfulRouteReads();
  });

  it("publishes same-block backlog-adjusted DUSD queue capacity after validating the redeemer identity", async () => {
    const result = await fetchMakinaStrategyReserves(
      dusdCoin(),
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      settlementBoundUnproven: true,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      blockNumber: BLOCK,
      holderEligibility: "any-holder",
      queueDepthUsd: 3_104.889979,
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("settlementDelaySec");
    expect(result.metadata?.redemptionQueue).toMatchObject({
      minimumFinalizationDelaySec: 43_200,
      pendingRequestCount: 1,
      lockedShares: 3_000,
      grossIdleCapacityUsd: 120.722783,
      queueDepthUsd: 3_104.889979,
      reservedUnclaimedUsdc: 0.003679,
      settlementBoundUnproven: true,
      capacityBasis: "live-proxy-buffer",
      implementationAddress: REVIEWED_IMPLEMENTATION,
      implementationRuntimeCodeHash: REVIEWED_IMPLEMENTATION_CODE_HASH,
    });
    expect(fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledWith(
      "ethereum",
      expect.any(Array),
      BLOCK,
      expect.any(Object),
    );
    expect(fetchEvmUint256AtBlock).toHaveBeenCalledWith(
      "ethereum",
      MACHINE,
      expect.stringContaining("0x07a2d13a"),
      BLOCK,
      expect.any(Object),
    );
  });

  it.each([
    { locked: 0n, converted: 0n, capacity: 120.722783, next: 343 },
    { locked: 100n * 10n ** 18n, converted: 103_496_333n, capacity: 17.226450, next: 344 },
  ])("subtracts converted locked shares from idle USDC: $capacity USD available", async ({ locked, converted, capacity, next }) => {
    mockSuccessfulRouteReads({
      "redeemer-locked-shares": uint256Result(locked),
      "redeemer-next-request-id": uint256Result(next),
    });
    vi.mocked(fetchEvmUint256AtBlock).mockResolvedValue(converted);
    const result = await fetchMakinaStrategyReserves(
      dusdCoin(), baseConfig(), new AbortController().signal, { chainRpcs: testChainRpcs },
    );
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: expect.closeTo(capacity, 6) });
    expect(fetchEvmUint256AtBlock).toHaveBeenCalledWith(
      "ethereum", MACHINE, `0x07a2d13a${uint256Result(locked).slice(2)}`, BLOCK, expect.any(Object),
    );
  });

  it("withholds telemetry when unchanged implementation has a different runtime hash", async () => {
    hashMock.mockReturnValue(`0x${"11".repeat(32)}`);
    const result = await fetchMakinaStrategyReserves(
      dusdCoin(), baseConfig(), new AbortController().signal, { chainRpcs: testChainRpcs },
    );
    expect(result.metadata?.totalReserveUsd).toBe(11_000);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.map(({ code }) => code)).toContain("makina-redemption-telemetry-unavailable");
  });

  it("withholds telemetry for each mismatched route identity", async () => {
    for (const label of ["redeemer-machine", "machine-accounting-token", "machine-share-token"]) {
      mockSuccessfulRouteReads({ [label]: addressResult("0x9999999999999999999999999999999999999999") });
      const result = await fetchMakinaStrategyReserves(
        dusdCoin(), baseConfig(), new AbortController().signal, { chainRpcs: testChainRpcs },
      );
      expect(result.metadata?.totalReserveUsd, label).toBe(11_000);
      expect(result.metadata?.redemption, label).toBeUndefined();
      expect(result.warnings?.map(({ code }) => code), label).toContain("makina-redemption-telemetry-unavailable");
    }
  });

  it("withholds telemetry when finalized request counter reaches or exceeds next request", async () => {
    for (const finalized of [344, 345]) {
      mockSuccessfulRouteReads({ "redeemer-last-finalized-request-id": uint256Result(finalized) });
      const result = await fetchMakinaStrategyReserves(
        dusdCoin(), baseConfig(), new AbortController().signal, { chainRpcs: testChainRpcs },
      );
      expect(result.metadata?.totalReserveUsd).toBe(11_000);
      expect(result.metadata?.redemption).toBeUndefined();
      expect(result.warnings?.map(({ code }) => code)).toContain("makina-redemption-telemetry-unavailable");
    }
  });

  it("keeps reserve composition but withholds queue capacity when the redeemer implementation drifts", async () => {
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(addressResult("0x9999999999999999999999999999999999999999"));

    const result = await fetchMakinaStrategyReserves(
      dusdCoin(),
      baseConfig(),
      new AbortController().signal,
      { chainRpcs: testChainRpcs },
    );

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.map((warning) => warning.code)).toContain("makina-redemption-telemetry-unavailable");
    expect(fetchEvmUint256AtBlock).not.toHaveBeenCalledWith(
      "ethereum",
      MACHINE,
      expect.stringContaining("0x07a2d13a"),
      BLOCK,
      expect.any(Object),
    );
  });
});
