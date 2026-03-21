import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock circuit breaker module
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Mock fetch-retry
vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async () => new Response("{}", { status: 200 })),
}));

vi.mock("../../../lib/coingecko-onchain", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/coingecko-onchain")>("../../../lib/coingecko-onchain");
  return {
    ...actual,
    fetchCgTokensBatch: vi.fn(async () => []),
  };
});

// Mock db-cache
vi.mock("../../../lib/db-cache", () => ({
  setCache: vi.fn(async () => {}),
  getCache: vi.fn(async () => null),
}));

// Mock yield cache builder
vi.mock("../../yield-sync/cache", () => ({
  buildDlStablecoinPoolsCache: vi.fn(() => ({})),
}));

import { shouldAttemptFetch, recordOutcome } from "../../../lib/circuit-breaker";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchCgTokensBatch } from "../../../lib/coingecko-onchain";
import { fetchDataSources, fetchGtTokenBatch, fetchCgTokenBatchPrices } from "../fetch-primary";

function createMockDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

// Generate 1000+ minimal pool entries to pass the DL threshold
const FAKE_DL_POOLS = Array.from({ length: 1001 }, (_, i) => ({
  pool: `pool-${i}`,
  chain: "ethereum",
  project: "aave-v3",
  symbol: `USDC-${i}`,
  tvlUsd: 100000,
  apy: 5,
  apyBase: 5,
  apyReward: 0,
  stablecoin: true,
  exposure: "single",
  underlyingTokens: null,
}));

function mockDlYieldsSuccess() {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("yields.llama.fi")) {
      return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
    }
    if (urlStr.includes("api.llama.fi/protocols")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (urlStr.includes("api.curve.finance")) {
      return new Response(JSON.stringify({ data: { poolData: [] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("fetchDataSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    mockDlYieldsSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips Curve when circuit breaker is open", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    // Curve calls should not have been made
    const curveCalls = vi.mocked(fetchWithRetry).mock.calls.filter(
      (call) => String(call[0]).includes("api.curve.finance"),
    );
    expect(curveCalls).toHaveLength(0);
  });

  it("records success when at least 1 Curve chain succeeds", async () => {
    mockDlYieldsSuccess();
    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      true,
    );
  });

  it("records failure when all Curve chains fail", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull(); // DL is still up
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      false,
    );
  });

  it("returns DL-only data when Curve fails", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("returns null when both DL and Curve fail (catastrophic)", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      return new Response("error", { status: 500 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).toBeNull();
  });

  it("returns DL-only data when circuit breaker is open and DL succeeds", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });
});

describe("token batch price observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps GeckoTerminal token batches into DexPriceObs using tracked batch lookups", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{
        id: "token-1",
        type: "token",
        attributes: {
          address: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
          name: "USD Coin",
          symbol: "USDC",
          coingecko_coin_id: "usd-coin",
          price_usd: "1.0003",
          total_reserve_in_usd: "85000",
          volume_usd: { h24: "10000" },
        },
      }],
    }), { status: 200 }));

    const observations = await fetchGtTokenBatch(
      new Map(),
      undefined,
      new Map([["ethereum", [{
        chain: "ethereum",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        stablecoinId: "usdc-circle",
      }]]]),
    );

    expect(observations.get("usdc-circle")).toEqual([{
      price: 1.0003,
      tvl: 85000,
      chain: "ethereum",
      protocol: "geckoterminal-aggregate",
    }]);
  });

  it("maps CoinGecko token batches into DexPriceObs with the same gating rules", async () => {
    vi.mocked(fetchCgTokensBatch).mockResolvedValueOnce([{
      id: "token-1",
      type: "token",
      attributes: {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        name: "USD Coin",
        symbol: "USDC",
        coingecko_coin_id: "usd-coin",
        price_usd: "0.9995",
        total_reserve_in_usd: "120000",
        volume_usd: { h24: "15000" },
      },
    }]);

    const observations = await fetchCgTokenBatchPrices(
      new Map(),
      undefined,
      new Map([["ethereum", [{
        chain: "ethereum",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        stablecoinId: "usdc-circle",
      }]]]),
      undefined,
      undefined,
      "test-key",
    );

    expect(observations.get("usdc-circle")).toEqual([{
      price: 0.9995,
      tvl: 120000,
      chain: "ethereum",
      protocol: "coingecko-aggregate",
    }]);
  });

  it("enforces plausibility and minimum-TVL gating for GT and CG token batches", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{
        id: "gt-bad",
        type: "token",
        attributes: {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USD Coin",
          symbol: "USDC",
          coingecko_coin_id: "usd-coin",
          price_usd: "10",
          total_reserve_in_usd: "90000",
          volume_usd: { h24: "1000" },
        },
      }, {
        id: "gt-small",
        type: "token",
        attributes: {
          address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
          name: "USD Coin",
          symbol: "USDC",
          coingecko_coin_id: "usd-coin",
          price_usd: "1.0",
          total_reserve_in_usd: "49999",
          volume_usd: { h24: "1000" },
        },
      }],
    }), { status: 200 }));
    vi.mocked(fetchCgTokensBatch).mockResolvedValueOnce([{
      id: "cg-bad",
      type: "token",
      attributes: {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        name: "USD Coin",
        symbol: "USDC",
        coingecko_coin_id: "usd-coin",
        price_usd: "10",
        total_reserve_in_usd: "75000",
        volume_usd: { h24: "1000" },
      },
    }, {
      id: "cg-small",
      type: "token",
      attributes: {
        address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        name: "USD Coin",
        symbol: "USDC",
        coingecko_coin_id: "usd-coin",
        price_usd: "1.0",
        total_reserve_in_usd: "49999",
        volume_usd: { h24: "1000" },
      },
    }]);

    const chainAddresses = new Map([["ethereum", [
      {
        chain: "ethereum",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        stablecoinId: "usdc-circle",
      },
      {
        chain: "ethereum",
        address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        stablecoinId: "usdc-circle",
      },
    ]]]);

    await expect(fetchGtTokenBatch(new Map(), undefined, chainAddresses)).resolves.toEqual(new Map());
    await expect(fetchCgTokenBatchPrices(new Map(), undefined, chainAddresses, undefined, undefined, "test-key")).resolves.toEqual(new Map());
  });
});
