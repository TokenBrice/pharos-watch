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
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
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

function circuitClosedDb() {
  return mockD1([
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
      rows: [],
      first: null,
    },
  ]);
}

describe("runDexScreenerPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not use the retired symbol-search fallback for addressless assets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await runDexScreenerPass([makeMissingAsset()], undefined, undefined);

    expect(result).toMatchObject({ resolved: 0, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records thrown exact lookups as failed provider outcomes", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockRejectedValueOnce(new Error("dns failed"));
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

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
    expect(circuitWrites.some((entry) => entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_SEARCH}`)).toBe(
      false,
    );
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
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

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
          errorClass: "upstream-error",
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
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

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
        {
          chainId: "base",
          dexId: "uniswap",
          pairAddress: "0xpair1",
          baseToken: { address: "0xabc", name: "Exact USD", symbol: "EXACT" },
          quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
          priceUsd: "0.99",
          priceNative: null,
          volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
          pairCreatedAt: null,
        },
        {
          chainId: "base",
          dexId: "uniswap",
          pairAddress: "0xpair2",
          baseToken: { address: "0xabc", name: "Exact USD", symbol: "EXACT" },
          quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1.01",
          priceNative: null,
          volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
          pairCreatedAt: null,
        },
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
        {
          chainId: "base",
          dexId: "aerodrome",
          pairAddress: "0xpair-a",
          baseToken: { address: "0xaaa", name: "Multi USD", symbol: "MULTI" },
          quoteToken: { address: "0xusdc", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1.00",
          priceNative: null,
          volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
          pairCreatedAt: null,
        },
        {
          chainId: "base",
          dexId: "aerodrome",
          pairAddress: "0xpair-b",
          baseToken: { address: "0xbbb", name: "Single USD", symbol: "SINGLE" },
          quoteToken: { address: "0xusdc", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1.00",
          priceNative: null,
          volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
          pairCreatedAt: null,
        },
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
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
    const db = circuitClosedDb();
    vi.spyOn(Date, "now").mockReturnValue(0);

    // One low-circulating asset with a long miss streak plus 30 fresh,
    // higher-circulating assets. The cap is 30, so a circulating-only tiebreak
    // would drop the streaked asset; streak priority must attempt it and drop
    // the lowest-circulating fresh asset instead.
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

    const fetchedAddresses = String(vi.mocked(fetchDsTokenPoolsWithStatus).mock.calls[0]?.[1]).split(",");
    expect(fetchedAddresses).toHaveLength(30);
    expect(fetchedAddresses).toContain("0xstreaked");
    expect(fetchedAddresses).not.toContain("0xfresh29");
  });

  it("rotates the single batch across candidate chains", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
    const db = circuitClosedDb();
    const baseAssets = Array.from({ length: 31 }, (_, index) =>
      makeMissingAsset({
        id: `base-${String(index).padStart(2, "0")}`,
        symbol: `BASE${index}`,
        address: `0xbase${index}`,
        chains: ["Base"],
      }),
    );
    const assets = [
      ...baseAssets,
      makeMissingAsset({
        id: "ethereum-asset",
        symbol: "ETH",
        address: "0xethereum",
        chains: ["Ethereum"],
      }),
    ];

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    await runDexScreenerPass(assets, undefined, db);
    const cycle0Chain = vi.mocked(fetchDsTokenPoolsWithStatus).mock.calls[0]?.[0];

    vi.mocked(fetchDsTokenPoolsWithStatus).mockClear();
    nowSpy.mockReturnValue(15 * 60 * 1_000);
    await runDexScreenerPass(assets, undefined, db);
    const cycle1Chain = vi.mocked(fetchDsTokenPoolsWithStatus).mock.calls[0]?.[0];

    expect([cycle0Chain, cycle1Chain]).toEqual(["base", "ethereum"]);
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
    expect(vi.mocked(fetchDsTokenPoolsWithStatus).mock.calls[0]?.[1]).toBe("0xaaa,0xbbb");
  });
});
