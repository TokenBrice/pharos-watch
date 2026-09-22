import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/dexscreener", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/dexscreener")>();
  return {
    ...actual,
    fetchDsTokenPoolsWithStatus: vi.fn(),
    dsRateLimit: vi.fn(async () => undefined),
  };
});

import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { fetchDsTokenPoolsWithStatus } from "../../../lib/dexscreener";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { runDexScreenerPass } from "../enrich-prices-dexscreener-pass";
import type { PeggedAsset } from "../enrich-prices";

function makeMissingAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "143",
    name: "Verified USD",
    symbol: "USDV",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: null,
    priceSource: "missing",
    priceConfidence: null,
    priceUpdatedAt: null,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: ["Ethereum"],
    ...overrides,
  };
}

function exactPool(tokenAddress: string, pairAddress: string, priceUsd: string, liquidityUsd = 100_000) {
  return {
    chainId: "base",
    dexId: "uniswap",
    pairAddress,
    baseToken: { address: tokenAddress, name: "Fixture USD", symbol: "FIX" },
    quoteToken: { address: "0xusdc", name: "USD Coin", symbol: "USDC" },
    priceUsd,
    priceNative: null,
    volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
    liquidity: { usd: liquidityUsd, base: 50_000, quote: 50_000 },
    pairCreatedAt: null,
  };
}

function circuitClosedDb() {
  return mockD1([
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
      rows: [],
      first: null,
    },
  ], { assertMatchesUsed: true });
}

describe("runDexScreenerPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not make a DexScreener lookup when an asset has no target", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await runDexScreenerPass([makeMissingAsset()], undefined, undefined);

    expect(result).toMatchObject({ resolved: 0, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records thrown exact lookups as failed provider outcomes", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockRejectedValueOnce(new Error("dns failed"));
    const db = circuitClosedDb();

    const result = await runDexScreenerPass(
      [
        makeMissingAsset({
          id: "exact-usd",
          symbol: "EXACT",
          address: "0xabc",
          chains: ["Base"],
        }),
      ],
      undefined,
      db,
    );

    expect(result).toMatchObject({
      resolved: 0,
      failures: [],
      diagnostics: [
        expect.objectContaining({
          source: "dexscreener-exact",
          endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
          ok: false,
          success: false,
          errorClass: "Error",
          errorMessage: "dns failed",
        }),
      ],
    });
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledWith(
      "base",
      "0xabc",
      expect.any(AbortSignal),
      expect.any(Number),
      0,
    );

    const circuitWrites = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    const exactWrite = circuitWrites.find((entry) => entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`);

    expect(JSON.parse(String(exactWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
  });

  it("includes DexScreener response status details in exact lookup diagnostics", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({
      ok: false,
      pairs: [],
      status: 429,
      contentType: "text/html",
      error: "HTTP 429 for https://api.dexscreener.com/tokens/v1/base/0xabc; body starts with: rate limited",
      hardRefusal: true,
    });
    const db = circuitClosedDb();

    const result = await runDexScreenerPass(
      [
        makeMissingAsset({
          id: "exact-usd",
          symbol: "EXACT",
          address: "0xabc",
          chains: ["Base"],
        }),
      ],
      undefined,
      db,
    );

    expect(result).toMatchObject({
      resolved: 0,
      failures: [],
      diagnostics: [
        expect.objectContaining({
          source: "dexscreener-exact",
          endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
          status: 429,
          ok: false,
          success: false,
          errorClass: "rate-limited",
          errorMessage: expect.stringContaining("HTTP 429"),
        }),
      ],
    });

    const circuitWrites = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    const exactWrite = circuitWrites.find((entry) => entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`);
    expect(JSON.parse(String(exactWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
  });

  it("does not wait indefinitely when an exact lookup never settles", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReturnValueOnce(new Promise(() => {}));
    const db = circuitClosedDb();

    const resultPromise = runDexScreenerPass(
      [
        makeMissingAsset({
          id: "exact-usd",
          symbol: "EXACT",
          address: "0xabc",
          chains: ["Base"],
        }),
      ],
      undefined,
      db,
    );
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(resultPromise).resolves.toMatchObject({
      resolved: 0,
      failures: [],
      diagnostics: [
        expect.objectContaining({
          source: "dexscreener-exact",
          endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
          ok: false,
          success: false,
          errorClass: "TimeoutError",
        }),
      ],
    });
  });

  it("averages the two middle exact fallback prices for even pool counts", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        exactPool("0xabc", "0xpair1", "0.99"),
        exactPool("0xabc", "0xpair2", "1.01"),
      ],
    });

    const asset = makeMissingAsset({
      id: "exact-usd",
      symbol: "EXACT",
      address: "0xabc",
      chains: ["Base"],
    });
    const result = await runDexScreenerPass([asset], undefined, undefined);

    expect(result).toMatchObject({ resolved: 1, failures: [] });
    expect(asset.price).toBe(1.0);
    expect(asset.priceSource).toBe("dexscreener-exact");
    expect(asset.priceConfidence).toBe("fallback");
  });

  it("resolves multiple same-chain assets through one address batch", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        exactPool("0xaaa", "0xpair-a", "0.99"),
        exactPool("0xbbb", "0xpair-b", "1.01"),
      ],
    });

    const multiChain = makeMissingAsset({
      id: "multi-chain",
      symbol: "MULTI",
      address: "0xaaa",
      chains: ["Base"],
      circulating: { peggedUSD: 2_000_000 },
    });
    const singleChain = makeMissingAsset({
      id: "single-chain",
      symbol: "SINGLE",
      address: "0xbbb",
      chains: ["Base"],
      circulating: { peggedUSD: 1_000_000 },
    });

    const result = await runDexScreenerPass([multiChain, singleChain], undefined, undefined);

    expect(result.resolved).toBe(2);
    expect(multiChain.price).toBe(0.99);
    expect(singleChain.price).toBe(1.01);
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledTimes(1);
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledWith(
      "base",
      "0xaaa,0xbbb",
      expect.any(AbortSignal),
      expect.any(Number),
      0,
    );
  });

  it("prioritizes a longer-streak asset under the 30-address batch cap", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockImplementation(async (_chain, addresses) => ({
      ok: true,
      pairs: addresses.includes("0xstreaked") ? [exactPool("0xstreaked", "0xstreaked-pool", "1")] : [],
    }));
    const db = circuitClosedDb();
    vi.spyOn(Date, "now").mockReturnValue(0);
    const streaked = makeMissingAsset({
      id: "streaked",
      symbol: "STRK",
      address: "0xstreaked",
      chains: ["Base"],
      circulating: { peggedUSD: 1 },
    });
    const fresh = Array.from({ length: 30 }, (_, index) =>
      makeMissingAsset({
        id: `fresh-${index}`,
        symbol: `FRESH${index}`,
        address: `0xfresh${index}`,
        chains: ["Base"],
        circulating: { peggedUSD: 1_000_000 - index },
      }),
    );

    await runDexScreenerPass(
      [streaked, ...fresh],
      undefined,
      db,
      undefined,
      new Map([["streaked", 5]]),
    );

    expect(streaked.price).toBe(1);
    expect(fresh[29].price).toBeNull();
  });

  it.each([2, 4, 6])("visits every chain over repeated hourly invocations (%i chains)", async (chainCount) => {
    const visited: string[] = [];
    vi.mocked(fetchDsTokenPoolsWithStatus).mockImplementation(async (chain) => {
      visited.push(chain);
      return { ok: true, pairs: [] };
    });
    const chains = ["base", "ethereum", "solana", "avalanche", "arbitrum", "optimism"].slice(0, chainCount);
    const assets = chains.map((chain) => makeMissingAsset({
      id: `hourly-${chain}`, address: `0x${chain}`, chains: [chain],
    }));
    const firstRunMs = Date.UTC(2026, 8, 15, 5, 0, 30);
    for (let hour = 0; hour < chainCount * 2; hour++) {
      await runDexScreenerPass(assets, undefined, undefined, undefined, undefined, firstRunMs + hour * 3_600_000);
    }
    expect([...new Set(visited.slice(0, chainCount))].sort()).toEqual([...chains].sort());
    expect(visited.slice(chainCount)).toEqual(visited.slice(0, chainCount));
  });

  it("rotates an oversized chain's address window on its next hourly visit", async () => {
    const baseBatches: string[][] = [];
    const visited: string[] = [];
    vi.mocked(fetchDsTokenPoolsWithStatus).mockImplementation(async (chain, addresses) => {
      visited.push(chain);
      if (chain === "base") baseBatches.push(addresses.split(","));
      return { ok: true, pairs: [] };
    });
    const baseAssets = Array.from({ length: 31 }, (_, index) => makeMissingAsset({
      id: `base-${String(index).padStart(2, "0")}`, address: `0xbase${index}`, chains: ["base"],
    }));
    const assets = [...baseAssets, makeMissingAsset({ id: "ethereum-asset", address: "0xethereum", chains: ["ethereum"] })];
    for (let hour = 0; hour < 4; hour++) {
      await runDexScreenerPass(assets, undefined, undefined, undefined, undefined, hour * 3_600_000);
    }
    expect(visited).toEqual(["base", "ethereum", "base", "ethereum"]);
    expect(baseBatches.map((batch) => batch.length)).toEqual([30, 30]);
    expect(new Set(baseBatches.flat())).toEqual(new Set(baseAssets.map((asset) => asset.address)));
    expect(baseBatches[1][0]).toBe("0xbase30");
  });

  it("bounds a stalled batch without issuing another request", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReturnValueOnce(new Promise(() => {}));
    const db = circuitClosedDb();

    const stalled = makeMissingAsset({
      id: "stalled",
      symbol: "STALL",
      address: "0xaaa",
      chains: ["Base"],
      circulating: { peggedUSD: 2_000_000 },
    });
    const second = makeMissingAsset({
      id: "second",
      symbol: "SECOND",
      address: "0xbbb",
      chains: ["Base"],
      circulating: { peggedUSD: 1_000_000 },
    });

    const resultPromise = runDexScreenerPass([stalled, second], undefined, db);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.resolved).toBe(0);
    expect(second.price).toBeNull();
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledTimes(1);
  });
});


describe("DexScreener observed response diagnostics", () => {
  afterEach(() => vi.mocked(fetchDsTokenPoolsWithStatus).mockReset());

  it.each([{ pairs: [] }, { pairs: [exactPool("0xabc", "0xpool", "1", 1)] }])("records successful nonresolving calls without failing the circuit", async ({ pairs }) => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({ ok: true, pairs });
    const db = circuitClosedDb();
    const result = await runDexScreenerPass([makeMissingAsset({ address: "0xabc", chains: ["Base"] })], undefined, db);
    expect(result.resolved).toBe(0);
    expect(result.diagnostics).toEqual([expect.objectContaining({ source: "dexscreener-exact", ok: true,
      success: true, candidateCount: 1, responseRowCount: pairs.length, resolvedCount: 0 })]);
    const write = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`);
    expect(JSON.parse(String(write?.binds[1]))).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it.each([
    ["DexScreener payload schema changed: expected array or object.pairs[]", "invalid-shape"],
    ["DexScreener payload contained no valid pair rows", "invalid-pairs"],
    ["DexScreener JSON parse failed: bad json", "malformed-json"],
  ])("classifies HTTP200 failure: %s", async (error, errorClass) => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({ ok: false, pairs: [], status: 200, error });
    const result = await runDexScreenerPass([makeMissingAsset({ address: "0xabc", chains: ["Base"] })], undefined, undefined);
    expect(result.diagnostics?.[0]).toMatchObject({ status: 200, success: false, errorClass });
  });
});
