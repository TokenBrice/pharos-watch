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

describe("runDexScreenerPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.unstubAllGlobals();
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
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledWith("base", "0xabc", undefined, expect.any(Number), 0);

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

  it("attempts one deployment per asset before spending requests on second deployments", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({
      ok: true,
      pairs: [],
    });

    const multiChain = makeMissingAsset({
      id: "multi-chain",
      symbol: "MULTI",
      address: "0xaaa",
      chains: ["Ethereum", "Base", "Arbitrum"],
      circulating: { peggedUSD: 2_000_000 },
    });
    const singleChain = makeMissingAsset({
      id: "single-chain",
      symbol: "SINGLE",
      address: "0xbbb",
      chains: ["Base"],
      circulating: { peggedUSD: 1_000_000 },
    });

    await runDexScreenerPass([multiChain, singleChain], undefined, undefined);

    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledTimes(4);
    const firstTwoAddresses = vi
      .mocked(fetchDsTokenPoolsWithStatus)
      .mock.calls.slice(0, 2)
      .map((call) => call[1]);
    expect(firstTwoAddresses).toEqual(["0xaaa", "0xbbb"]);
  });
});
