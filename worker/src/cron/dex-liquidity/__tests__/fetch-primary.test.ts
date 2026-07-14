import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock circuit breaker module
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Mock fetch-retry
vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(async () => ({
    response: new Response("{}", { status: 200 }),
    body: {},
  })),
}));

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
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { buildCurveLookups, fetchDataSources } from "../fetch-primary";

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
  vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("yields.llama.fi")) {
      return {
        response: new Response("", { status: 200 }),
        body: { data: FAKE_DL_POOLS },
      };
    }
    if (urlStr.includes("api.llama.fi/protocols")) {
      return {
        response: new Response("", { status: 200 }),
        body: [],
      };
    }
    if (urlStr.includes("api.curve.finance")) {
      return {
        response: new Response("", { status: 200 }),
        body: { data: { poolData: [] } },
      };
    }
    return {
      response: new Response("", { status: 200 }),
      body: {},
    };
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
    const curveCalls = vi.mocked(fetchJsonWithRetry).mock.calls.filter(
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
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return {
          response: new Response("", { status: 200 }),
          body: { data: FAKE_DL_POOLS },
        };
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return {
          response: new Response("", { status: 200 }),
          body: [],
        };
      }
      if (urlStr.includes("api.curve.finance")) {
        return null;
      }
      return {
        response: new Response("", { status: 200 }),
        body: {},
      };
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
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return {
          response: new Response("", { status: 200 }),
          body: { data: FAKE_DL_POOLS },
        };
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return {
          response: new Response("", { status: 200 }),
          body: [],
        };
      }
      if (urlStr.includes("api.curve.finance")) {
        return null;
      }
      return {
        response: new Response("", { status: 200 }),
        body: {},
      };
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("returns null when both DL and Curve fail (catastrophic)", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);

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

describe("buildCurveLookups", () => {
  it("uses one computed Curve USD balance surface for ratio and balance details", async () => {
    const curvePayloads = [
      {
        data: {
          poolData: [
            {
              address: "0x1111111111111111111111111111111111111111",
              name: "USDC/USDT",
              amplificationCoefficient: "1000",
              coins: [
                {
                  symbol: "USDC",
                  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                  poolBalance: "120000000000",
                  usdPrice: 1,
                  decimals: "6",
                },
                {
                  symbol: "USDT",
                  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                  poolBalance: "80000000000",
                  usdPrice: 1,
                  decimals: "6",
                },
              ],
              usdTotal: 200_000,
              isMetaPool: false,
              assetTypeName: "USD",
              totalSupply: 0,
              registryId: "factory-stable-ng",
              isBroken: false,
              virtualPrice: "1",
              usdTotalExcludingBasePool: 0,
              creationTs: 123,
              basePoolAddress: null,
              gaugeCrvApy: null,
            },
          ],
        },
      },
    ];
    const symbolToIds = new Map([
      ["USDC", ["usd-coin"]],
      ["USDT", ["tether"]],
    ]);
    const symbolToChainScopedIds = new Map([
      ["USDC", new Map([["ethereum", ["usd-coin"]]])],
      ["USDT", new Map([["ethereum", ["tether"]]])],
    ]);
    const chainAddressToId = new Map([
      ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usd-coin"],
      ["ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", "tether"],
    ]);

    const { curvePoolMap, priceObservations } = await buildCurveLookups(
      curvePayloads,
      symbolToIds,
      symbolToChainScopedIds,
      chainAddressToId,
    );

    const entry = curvePoolMap.get("ethereum:0x1111111111111111111111111111111111111111");
    expect(entry).toBeDefined();
    expect(curvePoolMap.get("ethereum:USDC-USDT")).toBe(entry);
    expect(entry!.balanceRatio).toBeCloseTo(80_000 / 120_000, 5);
    expect(entry!.balanceDetails).toEqual([
      { symbol: "USDC", balancePct: 60, isTracked: true },
      { symbol: "USDT", balancePct: 40, isTracked: true },
    ]);
    expect(priceObservations.get("usd-coin")).toEqual([
      expect.objectContaining({
        price: 1,
        tvl: 200_000,
        chain: "ethereum",
        protocol: "curve",
        poolKey: "ethereum:0x1111111111111111111111111111111111111111",
        identityConfidence: "exact",
        sourceFamily: "dl",
      }),
    ]);
    expect(priceObservations.get("tether")).toEqual([
      expect.objectContaining({
        price: 1,
        tvl: 200_000,
        chain: "ethereum",
        protocol: "curve",
        poolKey: "ethereum:0x1111111111111111111111111111111111111111",
        identityConfidence: "exact",
        sourceFamily: "dl",
      }),
    ]);
  });

  it("indexes pools by coin-set fingerprint and fails closed on duplicates", async () => {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const makeApiPool = (address: string, coins: Array<{ symbol: string; address: string }>) => ({
      address,
      name: coins.map((coin) => coin.symbol).join("/"),
      amplificationCoefficient: "1000",
      coins: coins.map((coin) => ({
        ...coin,
        poolBalance: "100000000000",
        usdPrice: 1,
        decimals: "6",
      })),
      usdTotal: 200_000,
      isMetaPool: false,
      assetTypeName: "USD",
      totalSupply: 0,
      registryId: "factory-stable-ng",
      isBroken: false,
      virtualPrice: "1",
      usdTotalExcludingBasePool: 0,
      creationTs: 123,
      basePoolAddress: null,
      gaugeCrvApy: null,
    });
    const curvePayloads = [
      {
        data: {
          poolData: [
            makeApiPool("0x1111111111111111111111111111111111111111", [
              { symbol: "USDC", address: USDC },
              { symbol: "USDT", address: USDT },
            ]),
            // Distinct coin set: fingerprint survives.
            makeApiPool("0x2222222222222222222222222222222222222222", [
              { symbol: "USDC", address: USDC },
              { symbol: "FRAX", address: "0x853d955acef822db058eb8505911ed77f175b99e" },
            ]),
            // Same coin set as the first pool: both fingerprints fail closed.
            makeApiPool("0x3333333333333333333333333333333333333333", [
              { symbol: "USDC", address: USDC },
              { symbol: "USDT", address: USDT },
            ]),
          ],
        },
      },
    ];

    const { curvePoolMap } = await buildCurveLookups(curvePayloads, new Map(), new Map(), new Map());

    const duplicatedFingerprint = `fp:ethereum:curve:${[USDC, USDT].sort().join(":")}`;
    expect(curvePoolMap.has(duplicatedFingerprint)).toBe(false);
    const uniqueFingerprint = `fp:ethereum:curve:${[USDC, "0x853d955acef822db058eb8505911ed77f175b99e"].sort().join(":")}`;
    expect(curvePoolMap.get(uniqueFingerprint)).toBe(
      curvePoolMap.get("ethereum:0x2222222222222222222222222222222222222222"),
    );
    // Address keys stay intact for all three pools.
    expect(curvePoolMap.has("ethereum:0x1111111111111111111111111111111111111111")).toBe(true);
    expect(curvePoolMap.has("ethereum:0x3333333333333333333333333333333333333333")).toBe(true);
  });
});
