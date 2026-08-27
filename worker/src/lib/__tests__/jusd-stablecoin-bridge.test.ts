import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import fixture from "./fixtures/jusd-citrea-bridge.json";

const fetchJsonWithRetryMock = vi.fn();
const shouldAttemptFetchMock = vi.fn();
const recordOutcomeSafeMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
}));

vi.mock("../circuit-breaker", () => ({
  shouldAttemptFetch: (...args: unknown[]) => shouldAttemptFetchMock(...args),
  recordOutcomeSafe: (...args: unknown[]) => recordOutcomeSafeMock(...args),
}));

vi.mock("viem/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/utils")>();
  return {
    ...actual,
    keccak256: (code: string) => {
      if (code === "0x6000") return "0xf822bbd111d9275ce9d4e62bfff5f45932618ab55960e4c8fadfc9d7f0ca4265";
      if (code === "0x6001") return "0x3aaff2c68217cc43382a63e0e583b4049d374e4261f22f10b5c636fa2a468605";
      return "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    },
  };
});

import { fetchAuthoritativeLivePriceOverrides } from "../authoritative-price-sources";
import { jusdStablecoinBridgeProvider } from "../authoritative-price-sources/jusd-stablecoin-bridge";
import { CIRCUIT_SOURCE } from "../constants";

interface RpcRequest {
  id: string;
  method: string;
  params: unknown[];
}

interface FixtureOverrides {
  chainId?: string;
  blockNumber?: string;
  blockTimestamp?: string;
  jusdCode?: string;
  bridgeCode?: string;
  jusdDecimals?: string;
  jusdReserve?: string;
  bridgeUsd?: string;
  bridgeJusd?: string;
  stopped?: string;
  horizon?: string;
  limit?: string;
  minted?: string;
  isMinter?: string;
  quoteDecimals?: string;
  quoteBalance?: string;
  burnCapability?: string;
  omitResultId?: string;
}

function abiWord(value: string): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiAddress(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function installRpcFixture(overrides: FixtureOverrides = {}): void {
  fetchJsonWithRetryMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const calls = JSON.parse(String(init.body)) as RpcRequest[];
    const values: Record<string, unknown> = {
      "chain-id": overrides.chainId ?? fixture.chainId,
      "latest-block": {
        number: overrides.blockNumber ?? fixture.block.number,
        timestamp: overrides.blockTimestamp ?? fixture.block.timestamp,
      },
      "jusd-code": overrides.jusdCode ?? fixture.jusd.runtimeCode,
      "bridge-code": overrides.bridgeCode ?? fixture.bridge.runtimeCode,
      "jusd-decimals": abiWord(overrides.jusdDecimals ?? fixture.jusd.decimals),
      "jusd-reserve": abiAddress(overrides.jusdReserve ?? fixture.jusd.reserve),
      "bridge-usd": abiAddress(overrides.bridgeUsd ?? fixture.bridge.quoteToken),
      "bridge-jusd": abiAddress(overrides.bridgeJusd ?? fixture.jusd.address),
      "bridge-stopped": abiWord(overrides.stopped ?? fixture.bridge.stopped),
      "bridge-horizon": abiWord(overrides.horizon ?? fixture.bridge.horizon),
      "bridge-limit": abiWord(overrides.limit ?? fixture.bridge.limit),
      "bridge-minted": abiWord(overrides.minted ?? fixture.bridge.minted),
      "bridge-minter": abiWord(overrides.isMinter ?? fixture.bridge.isMinter),
      "quote-decimals": abiWord(overrides.quoteDecimals ?? fixture.bridge.quoteDecimals),
      "quote-balance": abiWord(overrides.quoteBalance ?? fixture.bridge.quoteBalance),
      "burn-capability": overrides.burnCapability ?? "0x",
    };
    const body = [...calls]
      .reverse()
      .filter((call) => call.id !== overrides.omitResultId)
      .map((call) => ({
        jsonrpc: "2.0",
        id: call.id,
        result: values[call.id],
      }));
    return { response: new Response(null, { status: 200 }), body };
  });
}

function makeAssets(parentOverrides: Partial<PeggedAsset> = {}): PeggedAsset[] {
  const nowSec = Math.floor(Date.now() / 1_000);
  return [
    {
      id: "jusd-juicedollar",
      name: "Juice Dollar",
      symbol: "JUSD",
      price: null,
    },
    {
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      price: 0.9998,
      priceSource: "coingecko+pyth",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      priceObservedAtMode: "upstream",
      ...parentOverrides,
    },
  ];
}

describe("JuiceDollar Citrea StablecoinBridge price source", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixture.now));
    fetchJsonWithRetryMock.mockReset();
    shouldAttemptFetchMock.mockReset().mockResolvedValue(true);
    recordOutcomeSafeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prices JUSD from a fresh, fully funded, executable USDT.e bridge", async () => {
    const db = {} as D1Database;
    installRpcFixture();
    const assets = makeAssets();

    const overrides = await fetchAuthoritativeLivePriceOverrides(assets, undefined, undefined, { db });
    const override = overrides.get("jusd-juicedollar");

    expect(jusdStablecoinBridgeProvider).toMatchObject({
      source: "protocol-redeem",
      liveCircuitSource: CIRCUIT_SOURCE.JUSD_CITREA_BRIDGE,
    });
    expect(jusdStablecoinBridgeProvider).not.toHaveProperty("recordNullLiveResultAsCircuitFailure");
    expect(override).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdt-tether",
        juiceDollarBridge: {
          chain: "citrea",
          bridge: fixture.bridge.address,
          quoteToken: fixture.bridge.quoteToken,
          quoteParentId: "usdt-tether",
          blockNumber: Number(BigInt(fixture.block.number)),
          simulatedJusd: 1,
        },
      },
    });
    expect(override?.metadata?.juiceDollarBridge?.redeemableJusd).toBeCloseTo(57_375.94899182, 8);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.JUSD_CITREA_BRIDGE, true);
    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("pins every route read and the holder-independent burn capability call to the fresh Citrea block", async () => {
    installRpcFixture();
    const assets = makeAssets();

    await jusdStablecoinBridgeProvider.fetchLivePrice?.(assets[0]!, {
      assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    });

    const routeRequest = JSON.parse(String(fetchJsonWithRetryMock.mock.calls[1]![1].body)) as RpcRequest[];
    const blockTag = fixture.block.number.toLowerCase();
    const stateCalls = routeRequest.filter((call) => call.method === "eth_call" || call.method === "eth_getCode");
    for (const call of stateCalls) {
      expect(call.params[call.params.length - 1]).toBe(blockTag);
    }
    const burnCapability = routeRequest.find((call) => call.id === "burn-capability");
    expect(burnCapability).toEqual({
      jsonrpc: "2.0",
      id: "burn-capability",
      method: "eth_call",
      params: [
        {
          from: "0x0000000000000000000000000000000000000001",
          to: fixture.bridge.address,
          data: `0x42966c68${"0".repeat(64)}`,
        },
        blockTag,
      ],
    });
    expect(routeRequest.map((call) => call.id)).not.toContain("reserve-balance");
    expect(routeRequest.map((call) => call.id)).not.toContain("reserve-allowance");
    for (const [, init, retries, options] of fetchJsonWithRetryMock.mock.calls) {
      expect(init.method).toBe("POST");
      expect(retries).toBe(0);
      expect(options).toMatchObject({ timeoutMs: 3_500, maxResponseBytes: 256 * 1024 });
    }
  });

  it("heals the circuit after a validated all-zero-capacity route without publishing a price", async () => {
    const db = {} as D1Database;
    installRpcFixture({ minted: "0x0" });
    await expect(fetchAuthoritativeLivePriceOverrides(makeAssets(), undefined, undefined, { db })).resolves.toEqual(new Map());
    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(2);
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.JUSD_CITREA_BRIDGE, true);
  });

  it("records provider failures after a Citrea transport error", async () => {
    const db = {} as D1Database;
    fetchJsonWithRetryMock.mockReset().mockResolvedValueOnce(null);
    await expect(fetchAuthoritativeLivePriceOverrides(makeAssets(), undefined, undefined, { db })).resolves.toEqual(new Map());
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.JUSD_CITREA_BRIDGE, false);
  });

  it("throws provider failures on wrong bridge token identities or runtime bytecode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const overrides of [
      { bridgeUsd: "0x1111111111111111111111111111111111111111" },
      { bridgeJusd: "0x1111111111111111111111111111111111111111" },
      { jusdReserve: "0x1111111111111111111111111111111111111111" },
      { bridgeCode: "0x6002" },
      { jusdCode: "0x6002" },
    ]) {
      fetchJsonWithRetryMock.mockReset();
      installRpcFixture(overrides);
      const assets = makeAssets();
      await expect(
        jusdStablecoinBridgeProvider.fetchLivePrice?.(assets[0]!, {
          assetsById: new Map(assets.map((asset) => [asset.id, asset])),
        }),
      ).rejects.toThrow(/jusd-stablecoin-bridge/);
    }
  });

  it("admits stopped and expired bridges when the public burn path remains executable", async () => {
    for (const overrides of [{ stopped: "0x1" }, { horizon: "0x6a588000" }]) {
      fetchJsonWithRetryMock.mockReset();
      installRpcFixture(overrides);
      const assets = makeAssets();

      await expect(
        jusdStablecoinBridgeProvider.fetchLivePrice?.(assets[0]!, {
          assetsById: new Map(assets.map((asset) => [asset.id, asset])),
        }),
      ).resolves.toMatchObject({ price: 0.9998, source: "protocol-redeem" });
    }
  });

  it("throws provider failures when bridge state has identity or schema drift", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const overrides of [
      { isMinter: "0x0" },
      { quoteDecimals: "0x12" },
      { jusdDecimals: "0x6" },
      { limit: "0x1" },
      { omitResultId: "bridge-minted" },
    ]) {
      fetchJsonWithRetryMock.mockReset();
      installRpcFixture(overrides);
      const assets = makeAssets();
      await expect(
        jusdStablecoinBridgeProvider.fetchLivePrice?.(assets[0]!, {
          assetsById: new Map(assets.map((asset) => [asset.id, asset])),
        }),
      ).rejects.toThrow(/jusd-stablecoin-bridge/);
    }
  });

  it("returns validated no-quote outcomes for underfunded routes without sentinel-account preconditions", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const overrides of [
      { quoteBalance: "0x1" },
      { minted: "0xde0b6b3a7640000", quoteBalance: "0xf4240" },
    ]) {
      fetchJsonWithRetryMock.mockReset();
      installRpcFixture(overrides);
      const assets = makeAssets();
      await expect(
        jusdStablecoinBridgeProvider.fetchLivePrice?.(assets[0]!, {
          assetsById: new Map(assets.map((asset) => [asset.id, asset])),
        }),
      ).resolves.toEqual({ kind: "validated-no-quote", circuitOutcome: "success" });
    }
  });

  it("throws a provider failure for a stale Citrea head", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installRpcFixture({ blockTimestamp: "0x6a588000" });
    const staleAssets = makeAssets();
    await expect(
      jusdStablecoinBridgeProvider.fetchLivePrice?.(staleAssets[0]!, {
        assetsById: new Map(staleAssets.map((asset) => [asset.id, asset])),
      }),
    ).rejects.toThrow(/freshness validation failed/);
    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an untrusted-parent pre-RPC null circuit-neutral", async () => {
    const staleObservedAt = Math.floor(Date.now() / 1_000) - 60 * 60;
    const assets = makeAssets({
      priceSource: "cached+coingecko",
      priceConfidence: "fallback",
      priceObservedAt: staleObservedAt,
    });

    const db = {} as D1Database;
    await expect(fetchAuthoritativeLivePriceOverrides(assets, undefined, undefined, { db })).resolves.toEqual(new Map());
    expect(fetchJsonWithRetryMock).not.toHaveBeenCalled();
    expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
  });
});
