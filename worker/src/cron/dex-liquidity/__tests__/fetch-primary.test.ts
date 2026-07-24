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
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { buildDlStablecoinPoolsCache } from "../../yield-sync/cache";
import type { LlamaPool } from "../types";
import { buildCurveLookups, fetchDataSources } from "../fetch-primary";
import { buildPoolFingerprint } from "../pool-helpers";
import { CURVE_CHAINS } from "../constants";

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

const PRIMARY_POOL_LOOKUPS = {
  chainAddressToId: new Map<string, string>(),
  symbolToChainScopedIds: new Map([["USDC", new Map([["ethereum", ["usdc-circle"]]])]]),
};

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

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).not.toBeNull();
    // Curve calls should not have been made
    const curveCalls = vi
      .mocked(fetchJsonWithRetry)
      .mock.calls.filter((call) => String(call[0]).includes("api.curve.finance"));
    expect(curveCalls).toHaveLength(0);
  });

  it("records success when at least 1 Curve chain succeeds", async () => {
    mockDlYieldsSuccess();
    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).not.toBeNull();
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(expect.anything(), "curve-liquidity-api", true);
  });

  it("caps Curve API fetch concurrency below the DEX job peak", async () => {
    let activeCurveRequests = 0;
    let maxActiveCurveRequests = 0;

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
        activeCurveRequests++;
        maxActiveCurveRequests = Math.max(maxActiveCurveRequests, activeCurveRequests);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeCurveRequests--;
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

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);

    expect(result).not.toBeNull();
    expect(maxActiveCurveRequests).toBe(4);
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

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).not.toBeNull(); // DL is still up
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(expect.anything(), "curve-liquidity-api", false);
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

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("returns null when both DL and Curve fail (catastrophic)", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).toBeNull();
  });

  it("returns DL-only data when circuit breaker is open and DL succeeds", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("compacts raw yields before Curve while preserving raw cache, fallback, and count semantics", async () => {
    const trackedAddress = "0x1111111111111111111111111111111111111111";
    const makePool = (overrides: Partial<LlamaPool>): LlamaPool => ({
      pool: "untracked",
      chain: "ethereum",
      project: "untracked-project",
      symbol: "UNKNOWN-QUOTE",
      tvlUsd: 100_000,
      volumeUsd1d: 10_000,
      volumeUsd7d: 70_000,
      stablecoin: false,
      underlyingTokens: ["0x2222222222222222222222222222222222222222"],
      apyBase: null,
      apyReward: null,
      apy: 0,
      sigma: 0,
      exposure: "single",
      count: 20,
      ...overrides,
    });
    const trackedPool = makePool({
      pool: "tracked",
      project: "tracked-project",
      exposure: "multi",
      underlyingTokens: [trackedAddress, "0x3333333333333333333333333333333333333333"],
    });
    const yieldCacheOnlyPool = makePool({
      pool: "yield-cache-only",
      stablecoin: true,
    });
    const fallbackOnlyPool = makePool({
      pool: "fallback-only",
      project: "fallback-only-project",
      exposure: "multi",
    });
    const rawPools = [
      trackedPool,
      yieldCacheOnlyPool,
      fallbackOnlyPool,
      ...Array.from({ length: 998 }, (_, index) => makePool({ pool: `untracked-${index}` })),
    ];
    const chainAddressToId = new Map([[`ethereum:${trackedAddress}`, "tracked-coin"]]);
    const lookupGetSpy = vi.spyOn(chainAddressToId, "get");

    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return { response: new Response("", { status: 200 }), body: { data: rawPools } };
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return { response: new Response("", { status: 200 }), body: [] };
      }
      if (urlStr.includes("api.curve.finance")) {
        expect(lookupGetSpy).toHaveBeenCalled();
        return { response: new Response("", { status: 200 }), body: { data: { poolData: [] } } };
      }
      return null;
    });

    const result = await fetchDataSources(null, createMockDb(), {
      chainAddressToId,
      symbolToChainScopedIds: new Map(),
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ rawPoolCount: 1_001, pools: [trackedPool] });
    expect(result!.dexProjects).toContain("fallback-only-project");
    expect(vi.mocked(buildDlStablecoinPoolsCache)).toHaveBeenCalledWith([
      expect.objectContaining({ pool: "yield-cache-only" }),
    ]);
  });

  it("fails the yields source closed when a malformed row prevents compaction", async () => {
    const malformedPool = {
      ...FAKE_DL_POOLS[0],
      symbol: null,
    } as unknown as LlamaPool;

    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return {
          response: new Response("", { status: 200 }),
          body: { data: [malformedPool, ...FAKE_DL_POOLS.slice(1)] },
        };
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return { response: new Response("", { status: 200 }), body: [] };
      }
      if (urlStr.includes("api.curve.finance")) {
        return { response: new Response("", { status: 200 }), body: { data: { poolData: [] } } };
      }
      return null;
    });

    const result = await fetchDataSources(null, createMockDb(), PRIMARY_POOL_LOOKUPS);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      pools: [],
      rawPoolCount: 0,
      dlYieldsAvailable: false,
    });
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DL_YIELDS, false);
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

  it("skips Curve fingerprinting for malformed coin addresses while preserving later pools", async () => {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const makeApiPool = (address: string, coins: Array<{ symbol: string; address: unknown }>, usdTotal = 200_000) => ({
      address,
      name: coins.map((coin) => coin.symbol).join("/"),
      amplificationCoefficient: "1000",
      coins: coins.map((coin) => ({
        ...coin,
        poolBalance: "100000000000",
        usdPrice: 1,
        decimals: "6",
      })),
      usdTotal,
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
              { symbol: "USDC", address: null },
              { symbol: "USDT", address: USDT },
            ]),
            makeApiPool("0x2222222222222222222222222222222222222222", [
              { symbol: "USDC", address: USDC },
              { symbol: "USDT", address: USDT },
            ]),
          ],
        },
      },
    ];

    const { curvePoolMap, priceObservations } = await buildCurveLookups(
      curvePayloads as never,
      new Map([["USDC", ["usd-coin"]]]),
      new Map([["USDC", new Map([["ethereum", ["usd-coin"]]])]]),
      new Map([[`ethereum:${USDC}`, "usd-coin"]]),
    );

    expect(curvePoolMap.has("ethereum:0x1111111111111111111111111111111111111111")).toBe(true);
    expect(curvePoolMap.has("ethereum:0x2222222222222222222222222222222222222222")).toBe(true);
    expect(curvePoolMap.get(`fp:ethereum:curve:${[USDC, USDT].sort().join(":")}`)).toBe(
      curvePoolMap.get("ethereum:0x2222222222222222222222222222222222222222"),
    );
    expect(priceObservations.get("usd-coin")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          poolKey: "ethereum:0x2222222222222222222222222222222222222222",
          identityConfidence: "exact",
        }),
      ]),
    );
  });

  it("indexes pools by coin-set fingerprint and fails closed on duplicates", async () => {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const makeApiPool = (address: string, coins: Array<{ symbol: string; address: string }>, usdTotal = 200_000) => ({
      address,
      name: coins.map((coin) => coin.symbol).join("/"),
      amplificationCoefficient: "1000",
      coins: coins.map((coin) => ({
        ...coin,
        poolBalance: "100000000000",
        usdPrice: 1,
        decimals: "6",
      })),
      usdTotal,
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
            // Dust duplicates do not poison the retained pool's address-grade join.
            makeApiPool(
              "0x4444444444444444444444444444444444444444",
              [
                { symbol: "USDC", address: USDC },
                { symbol: "FRAX", address: "0x853d955acef822db058eb8505911ed77f175b99e" },
              ],
              40,
            ),
          ],
        },
      },
    ];

    const { curvePoolMap, curvePoolCandidatesByFingerprint } = await buildCurveLookups(
      curvePayloads,
      new Map(),
      new Map(),
      new Map(),
    );

    const duplicatedFingerprint = `fp:ethereum:curve:${[USDC, USDT].sort().join(":")}`;
    expect(curvePoolMap.has(duplicatedFingerprint)).toBe(false);
    expect(curvePoolCandidatesByFingerprint.get(duplicatedFingerprint)?.map((entry) => entry.poolAddress)).toEqual([
      "0x1111111111111111111111111111111111111111",
      "0x3333333333333333333333333333333333333333",
    ]);
    const uniqueFingerprint = `fp:ethereum:curve:${[USDC, "0x853d955acef822db058eb8505911ed77f175b99e"].sort().join(":")}`;
    expect(curvePoolMap.get(uniqueFingerprint)).toBe(
      curvePoolMap.get("ethereum:0x2222222222222222222222222222222222222222"),
    );
    expect(curvePoolCandidatesByFingerprint.get(uniqueFingerprint)).toEqual([
      curvePoolMap.get("ethereum:0x2222222222222222222222222222222222222222"),
    ]);
    // Address keys stay intact for all three pools.
    expect(curvePoolMap.has("ethereum:0x1111111111111111111111111111111111111111")).toBe(true);
    expect(curvePoolMap.has("ethereum:0x3333333333333333333333333333333333333333")).toBe(true);
    expect(curvePoolMap.has("ethereum:0x4444444444444444444444444444444444444444")).toBe(true);
  });

  it("keeps the appended Curve API chains at the tail of the fetch order", () => {
    // Payloads are index-aligned to CURVE_CHAINS in both fetchDataSources and
    // buildCurveLookups; appended chains must stay appended.
    expect(CURVE_CHAINS.slice(0, 8)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "fraxtal",
      "sonic",
      "taiko",
      "zksync",
    ]);
    expect(CURVE_CHAINS.slice(8)).toEqual(["optimism", "avalanche", "fantom", "kava"]);
  });

  it("indexes appended-chain payloads (optimism) for address, fingerprint, and symbol joins", async () => {
    // Shape mirrors the live Curve getPools/all/optimism 3pool response.
    const DAI = "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1";
    const USDC = "0x0b2c639c533813f4aa9d7837caf62653d097ff85";
    const USDT = "0x94b008aa00579c1307b0ef2c499aad98a8ce58e58";
    const optimismPayload = {
      data: {
        poolData: [
          {
            address: "0x1337BedC9D22ecbe766dF105c9623922A27963EC",
            name: "Curve.fi DAI/USDC/USDT",
            amplificationCoefficient: "2000",
            coins: [
              { symbol: "DAI", address: DAI, poolBalance: "31868512011738815990995", usdPrice: 1, decimals: "18" },
              { symbol: "USDC", address: USDC, poolBalance: "30000000000", usdPrice: 1, decimals: "6" },
              { symbol: "USDT", address: USDT, poolBalance: "30000000000", usdPrice: 1, decimals: "6" },
            ],
            usdTotal: 92_000,
            isMetaPool: false,
            assetTypeName: "usd",
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
    };
    const curvePayloads = [...Array(8).fill(null), optimismPayload];

    const { curvePoolMap } = await buildCurveLookups(curvePayloads, new Map(), new Map(), new Map());

    const byAddress = curvePoolMap.get("optimism:0x1337bedc9d22ecbe766df105c9623922a27963ec");
    expect(byAddress).toBeDefined();
    const fingerprintKey = buildPoolFingerprint("optimism", "curve", [DAI, USDC, USDT]);
    expect(fingerprintKey).not.toBeNull();
    expect(curvePoolMap.get(fingerprintKey!)).toBe(byAddress);
    expect(curvePoolMap.get("optimism:DAI-USDC-USDT")).toBe(byAddress);
  });
});
