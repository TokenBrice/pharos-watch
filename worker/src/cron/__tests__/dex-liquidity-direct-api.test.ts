import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeChainRpcConfig } from "../../test-helpers/chain-rpc-fixtures.test-support";
import { fetchBalancerPools } from "../dex-liquidity/fetch-balancer";
import { fetchFluidPools } from "../dex-liquidity/fetch-fluid";
import { fetchOrcaPools } from "../dex-liquidity/fetch-orca";
import { fetchRaydiumPools } from "../dex-liquidity/fetch-raydium";
import { jsonResponse, mockFetch as createFetchMock } from "@shared/test-utils/mock-fetch";
import {
  fetchDirectApiFixture,
  makeBalancerPool,
  makeCursorDb,
  makeFluidRpcResponse,
  makeFluidTicker,
  makeOrcaPool,
  orcaRoute,
} from "./dex-liquidity-direct-api.test-support";
import { acknowledgeDexSourcePagination } from "../dex-liquidity/source-pagination-state";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../dex-liquidity/orchestrator-phases/authoritative";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

vi.mock("../../lib/abort", async () => {
  const actual = await vi.importActual<typeof import("../../lib/abort")>("../../lib/abort");
  return {
    ...actual,
    sleepWithSignal: vi.fn(async () => {}),
  };
});

let mockFetch = createFetchMock([], { requireMatch: true });

function mockJsonFetch(body: unknown, status = 200): void {
  mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

function mockTextFetch(body: string, status: number): void {
  mockFetch.mockImplementation(() => Promise.resolve(new Response(body, { status })));
}

function makeFluidEthRpcs() {
  return new Map<string, ChainRpcConfig>([
    ["ethereum", makeChainRpcConfig({
      chainId: "ethereum",
      chainName: "Ethereum",
      rpcUrls: ["https://rpc.example"],
      explorerUrl: "https://etherscan.io",
    })],
  ]);
}

function makeRaydiumPool(overrides: Record<string, unknown> = {}) {
  return {
    type: "Concentrated",
    id: "pool1",
    mintA: { address: "addr1", symbol: "USDC", decimals: 6 },
    mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
    price: 1.0,
    tvl: 100_000,
    mintAmountA: 50_000,
    mintAmountB: 50_000,
    feeRate: 0.0001,
    day: { volume: 5_000 },
    ...overrides,
  };
}

function raydiumPage(rows: unknown[]) {
  return jsonResponse({ success: true, data: { count: rows.length, data: rows } });
}

function balancerTokens(a = "0xa", b = "0xb") {
  return [
    { address: a, symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
    { address: b, symbol: "USDT", decimals: 6, balance: "50000", balanceUSD: "50000" },
  ];
}

function orcaResponse(data: unknown[], next: string | null = null) {
  return { data, meta: { cursor: { next } } };
}

describe("fetchFluidPools", () => {
  const FLUID_POOL_ADDRESS = "0x1111111111111111111111111111111111111111";

  afterEach(() => {
    mockFetch = createFetchMock([], { requireMatch: true });
  });

  it("fetches all chains and normalizes to DexApiPool[]", async () => {
    mockJsonFetch([makeFluidTicker()]);
    const pools = await fetchFluidPools();
    expect(pools.pools.length).toBeGreaterThan(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
    const pool = pools.pools[0];
    expect(pool.source).toBe("fluid");
    expect(pool.poolType).toBe("fluid-dex");
    expect(pool.tvlUsd).toBe(500_000);
    expect(pool.price).toBeCloseTo(0.9999);
    expect(pool.tokens).toHaveLength(2);
  });

  it("hydrates balances and fee rate from the Fluid DexReservesResolver when available", async () => {
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([makeFluidTicker()]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("ethereum-rpc.publicnode.com") || url.includes("eth.llamarpc.com")) {
        const body = String(init?.body ?? "");
        if (body.includes("0x957755e6")) return Promise.resolve(makeFluidRpcResponse([1_500_000, 500_000, 0, 0]));
        if (body.includes("0x55181f11")) return Promise.resolve(makeFluidRpcResponse([0, 0, 500_000, 2_500_000, 0, 0]));
        if (body.includes("0x42fcc6fb")) return Promise.resolve(makeFluidRpcResponse([100]));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });
    const pools = await fetchFluidPools();
    expect(pools.pools[0].balances).toEqual([2_000_000, 3_000_000]);
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001);
  });

  it.each(["all", "collateral", "debt"])(
    "keeps Fluid source healthy when retained-pool enrichment fails (%s)",
    async (failedRead) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockImplementation((input, init) => {
        const url = String(input);
        if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
          return Promise.resolve(jsonResponse([makeFluidTicker()]));
        }
        if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url === "https://rpc.example") {
          const body = String(init?.body ?? "");
          if (failedRead !== "all") {
            if (body.includes("0x957755e6") && failedRead !== "collateral") {
              return Promise.resolve(makeFluidRpcResponse([1_500_000, 500_000, 0, 0]));
            }
            if (body.includes("0x55181f11") && failedRead !== "debt") {
              return Promise.resolve(makeFluidRpcResponse([0, 0, 500_000, 2_500_000, 0, 0]));
            }
            if (body.includes("0x42fcc6fb")) return Promise.resolve(makeFluidRpcResponse([100]));
          }
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: `0x${"z".repeat(64)}` }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const pools = await fetchFluidPools(undefined, makeFluidEthRpcs());
      expect(pools.pools.map((pool) => pool.poolAddress)).toEqual([FLUID_POOL_ADDRESS]);
      expect(pools.pools[0]).toMatchObject({
        balances: null,
        feeRate: failedRead === "all" ? null : 0.0001,
        tvlUsd: 500_000,
        tokenVolumes24h: [100_000, 100_000],
      });
      expect(pools.ok).toBe(true);
      expect(pools.degraded).toBe(false);
      expect(pools.errors).toEqual([]);
      expect(pools.warnings).toHaveLength(1);
      expect(pools.warnings?.[0]).toContain("enrichment failed");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[fetch-fluid] Pool enrichment failed:"));
      warnSpy.mockRestore();
    },
  );

  it("skips malformed Fluid pool IDs while preserving valid pools", async () => {
    const malformedPoolAddress = "not-a-20-byte-hex-address";
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([
          makeFluidTicker(),
          makeFluidTicker({
            ticker_id: "0xbroken_0xquote",
            last_price: "1.0001",
            base_volume: "50000",
            target_volume: "50000",
            pool_id: malformedPoolAddress,
            liquidity_in_usd: "400000",
          }),
        ]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === "https://rpc.example") {
        const body = String(init?.body ?? "");
        if (body.includes("0x957755e6")) return Promise.resolve(makeFluidRpcResponse([1_500_000, 500_000, 0, 0]));
        if (body.includes("0x55181f11")) return Promise.resolve(makeFluidRpcResponse([0, 0, 500_000, 2_500_000, 0, 0]));
        if (body.includes("0x42fcc6fb")) return Promise.resolve(makeFluidRpcResponse([100]));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const pools = await fetchFluidPools(undefined, makeFluidEthRpcs());
    expect(pools.pools.map((pool) => pool.poolAddress)).toEqual([FLUID_POOL_ADDRESS]);
    expect(pools.pools[0].balances).toEqual([2_000_000, 3_000_000]);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
    expect(pools.warnings?.[0]).toContain(malformedPoolAddress);
    expect(pools.warnings?.[0]).toContain("invalid EVM address");
    expect(mockFetch.mock.calls.filter(([input]) => String(input) === "https://rpc.example")).toHaveLength(3);
  });

  it("handles chain failure gracefully with Promise.allSettled", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    const pools = await fetchFluidPools();
    expect(Array.isArray(pools.pools)).toBe(true);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it.each([
    { label: "complete failure", setup: () => mockFetch.mockRejectedValue(new Error("all chains down")) },
    { label: "non-array response body", setup: () => mockJsonFetch({ error: "bad request" }) },
    { label: "HTTP 500 error", setup: () => mockTextFetch("Server Error", 500) },
  ])("returns empty degraded result on $label", async ({ setup }) => {
    setup();
    const pools = await fetchFluidPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("skips tickers with zero/invalid TVL and nulls invalid price, feeRate, and balances", async () => {
    mockJsonFetch([
      makeFluidTicker({ pool_id: "0x3333333333333333333333333333333333333333", liquidity_in_usd: "0" }),
      makeFluidTicker({ pool_id: "0x4444444444444444444444444444444444444444", liquidity_in_usd: "NaN" }),
    ]);
    const empty = await fetchFluidPools();
    expect(empty).toMatchObject({ pools: [], ok: true, degraded: false });

    mockJsonFetch([
      makeFluidTicker({ pool_id: "0x3333333333333333333333333333333333333333", last_price: "not-a-number", liquidity_in_usd: "100000" }),
    ]);
    const invalidPrice = await fetchFluidPools();
    expect(invalidPrice.pools[0]).toMatchObject({ price: null, feeRate: null, balances: null });
  });
});

describe("fetchBalancerPools", () => {
  afterEach(() => {
    mockFetch = createFetchMock([], { requireMatch: true });
  });

  it("fetches stable pools, prefers exact address over 32-byte vault id, and classifies weighted/stable variants", async () => {
    mockJsonFetch({
      data: {
        poolGetPools: [
          makeBalancerPool({
            id: "0x4e415957aa4fd703ad701e43ee5335d1d7891d8300020000000000000000053b",
            address: "0x4e415957aa4fd703ad701e43ee5335d1d7891d83",
            dynamicData: { totalLiquidity: "1000000", volume24h: "50000", swapFee: "0.0001" },
            poolTokens: [
              { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, balance: "500000", balanceUSD: "500000" },
              { address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", symbol: "GHO", decimals: 18, balance: "500000", balanceUSD: "500000" },
            ],
          }),
          makeBalancerPool({
            id: "0xweighted",
            type: "WEIGHTED",
            chain: "ARBITRUM",
            dynamicData: { totalLiquidity: "200000", volume24h: "10000", swapFee: "0.003" },
            poolTokens: balancerTokens("0xtoken1", "0xtoken2"),
          }),
        ],
      },
    });
    const pools = await fetchBalancerPools();
    expect(pools.pools).toHaveLength(2);
    expect(pools.pools[0]).toMatchObject({
      source: "balancer",
      poolType: "balancer-stable",
      tvlUsd: 1_000_000,
      poolAddress: "0x4e415957aa4fd703ad701e43ee5335d1d7891d83",
      balances: [500_000, 500_000],
      balancesNormalized: true,
    });
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001);
    expect(pools.pools[1].poolType).toBe("balancer-weighted");

    const stableTypes = ["STABLE", "COMPOSABLE_STABLE", "META_STABLE", "PHANTOM_STABLE", "GYRO", "GYROE"];
    mockJsonFetch({
      data: {
        poolGetPools: stableTypes.map((type, i) => makeBalancerPool({
          id: `0xpool${i}`,
          type,
          poolTokens: balancerTokens(`0xtoken${i}a`, `0xtoken${i}b`),
        })),
      },
    });
    const stableResult = await fetchBalancerPools();
    expect(stableResult.pools).toHaveLength(stableTypes.length);
    for (const pool of stableResult.pools) {
      expect(pool.poolType).toBe("balancer-stable");
    }
  });

  it("derives per-token priceUsd, nulls zero-balance prices, and maps chain enums", async () => {
    mockJsonFetch({
      data: {
        poolGetPools: [
          makeBalancerPool({
            id: "0xp1",
            chain: "MAINNET",
            poolTokens: [
              { address: "0xa", symbol: "USDC", decimals: 6, balance: "100000", balanceUSD: "100050" },
              { address: "0xb", symbol: "DAI", decimals: 18, balance: "99950", balanceUSD: "99950" },
            ],
          }),
          makeBalancerPool({
            id: "0xp2",
            chain: "POLYGON",
            poolTokens: [
              { address: "0xa", symbol: "USDC", decimals: 6, balance: "0", balanceUSD: "0" },
              { address: "0xb", symbol: "DAI", decimals: 18, balance: "50000", balanceUSD: "50000" },
            ],
          }),
        ],
      },
    });
    const pools = await fetchBalancerPools();
    expect(pools.pools[0].chain).toBe("ethereum");
    expect(pools.pools[0].tokens[0].priceUsd).toBeCloseTo(100_050 / 100_000);
    expect(pools.pools[0].tokens[1].priceUsd).toBeCloseTo(1.0);
    expect(pools.pools[1].chain).toBe("polygon");
    expect(pools.pools[1].tokens[0].priceUsd).toBeNull();
    expect(pools.pools[1].tokens[1].priceUsd).toBeCloseTo(1.0);
  });

  it("paginates through multiple pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeBalancerPool({
      id: `0xpool${i}`,
      poolTokens: balancerTokens(`0xa${i}`, `0xb${i}`),
    }));
    const page2 = [makeBalancerPool({
      id: "0xpoolLast",
      type: "WEIGHTED",
      chain: "BASE",
      poolTokens: balancerTokens("0xlast1", "0xlast2"),
    })];
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: page1 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: page2 } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const pools = await fetchBalancerPools();
    expect(pools.pools.length).toBe(1001);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "unknown chain", pool: makeBalancerPool({ id: "0xpool", chain: "UNKNOWN_CHAIN", poolTokens: balancerTokens().slice(0, 1) }) },
    { label: "zero TVL", pool: makeBalancerPool({ id: "0xpool", dynamicData: { totalLiquidity: "0", volume24h: "0", swapFee: "0.0001" }, poolTokens: balancerTokens().slice(0, 1) }) },
  ])("skips pools with $label without degrading", async ({ pool }) => {
    mockJsonFetch({ data: { poolGetPools: [pool] } });
    const pools = await fetchBalancerPools();
    expect(pools).toMatchObject({ pools: [], ok: true, degraded: false });
  });

  it.each([
    { label: "HTTP 500", setup: () => mockTextFetch("Internal Server Error", 500), err: undefined },
    { label: "missing poolGetPools", setup: () => mockJsonFetch({ data: {} }), err: undefined },
    { label: "invalid JSON", setup: () => mockFetch.mockResolvedValueOnce(new Response("{bad-json", { status: 200 })), err: "invalid JSON" },
    { label: "null JSON root", setup: () => mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 })), err: "non-object JSON root" },
  ])("returns degraded empty result on $label", async ({ setup, err }) => {
    setup();
    const pools = await fetchBalancerPools();
    expect(pools).toMatchObject({ pools: [], ok: false, degraded: true });
    if (err) expect(pools.errors[0]).toContain(err);
  });

  it("skips malformed Balancer pool rows while preserving valid rows from the same page", async () => {
    mockJsonFetch({
      data: {
        poolGetPools: [
          { id: "0xbroken", type: "STABLE", chain: "MAINNET", poolTokens: balancerTokens().slice(0, 1) },
          makeBalancerPool({ id: "0xvalid", poolTokens: balancerTokens("0xb", "0xc") }),
        ],
      },
    });
    const pools = await fetchBalancerPools();
    expect(pools).toMatchObject({ ok: true, degraded: false });
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("0xvalid");
    expect(pools.warnings).toContain("page 1 skipped 1 malformed pool rows");
  });
});

describe("fetchRaydiumPools", () => {
  afterEach(() => {
    mockFetch = createFetchMock([], { requireMatch: true });
  });

  it("fetches concentrated and standard pools, maps to solana, and nulls zero prices", async () => {
    mockFetch
      .mockResolvedValueOnce(raydiumPage([
        makeRaydiumPool({
          id: "poolAddr1",
          price: 0.9999,
          tvl: 42_000_000,
          mintAmountA: 20_000_000,
          mintAmountB: 22_000_000,
          day: { volume: 2_000_000 },
        }),
        makeRaydiumPool({ id: "zeroPrice", price: 0 }),
      ]))
      .mockResolvedValueOnce(raydiumPage([
        makeRaydiumPool({ type: "Standard", id: "stdPool", price: 1.0001, feeRate: 0.0025 }),
      ]));

    const pools = await fetchRaydiumPools();
    expect(pools.pools).toHaveLength(3);
    expect(pools.pools[0]).toMatchObject({
      source: "raydium",
      chain: "solana",
      poolType: "raydium-clmm",
      tvlUsd: 42_000_000,
      balances: [20_000_000, 22_000_000],
    });
    expect(pools.pools[0].price).toBeCloseTo(0.9999);
    expect(pools.pools[1].price).toBeNull();
    expect(pools.pools[2]).toMatchObject({
      chain: "solana",
      poolType: "raydium-amm",
      balancesNormalized: true,
    });
  });

  it("filters low-TVL rows on a short page", async () => {
    mockJsonFetch({
      success: true,
      data: {
        count: 2,
        data: [
          makeRaydiumPool({ id: "pool1", tvl: 50_000 }),
          makeRaydiumPool({ id: "pool2", tvl: 5_000 }),
        ],
      },
    });
    const pools = await fetchRaydiumPools();
    const clmm = pools.pools.filter((p) => p.poolType === "raydium-clmm");
    expect(clmm).toHaveLength(1);
    expect(clmm[0].tvlUsd).toBe(50_000);
  });

  it.each([
    { eligiblePages: [1], expectedPages: [1, 2, 3] },
    { eligiblePages: [1, 3], expectedPages: [1, 2, 3, 4, 5] },
  ])("stops after two consecutive full low-TVL pages, resetting on eligibility: $eligiblePages", async ({
    eligiblePages,
    expectedPages,
  }) => {
    const requested: Record<string, number[]> = { concentrated: [], standard: [] };
    mockFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("poolType")!;
      const page = Number(url.searchParams.get("page"));
      if (url.origin !== "https://api-v3.raydium.io" || !requested[type]) {
        throw new Error(`Unexpected request: ${url}`);
      }
      requested[type].push(page);
      const rows = type === "standard" || page > expectedPages.length
        ? []
        : Array.from({ length: 1000 }, (_, index) => makeRaydiumPool({
            id: `page-${page}-row-${index}`,
            tvl: eligiblePages.includes(page) && index === 0 ? 50_000 : 5_000,
          }));
      return jsonResponse({ success: true, data: { data: rows } });
    });
    const result = await fetchRaydiumPools();
    expect(requested).toEqual({ concentrated: expectedPages, standard: [1] });
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual(eligiblePages.map((page) => `page-${page}-row-0`));
    expect(result.degraded).toBe(false);
  });

  it.each([
    { label: "network error", setup: () => mockFetch.mockRejectedValue(new Error("network error")), err: undefined },
    { label: "HTTP 503", setup: () => mockTextFetch("error", 503), err: undefined },
    { label: "null data body", setup: () => mockJsonFetch({ success: true, data: null }), err: undefined },
    { label: "null JSON root", setup: () => mockFetch.mockImplementation(() => Promise.resolve(new Response("null", { status: 200 }))), err: "non-object JSON root" },
  ])("handles $label gracefully", async ({ setup, err }) => {
    setup();
    const pools = await fetchRaydiumPools();
    expect(pools).toMatchObject({ pools: [], ok: false, degraded: true });
    if (err) expect(pools.errors.every((error) => error.includes(err))).toBe(true);
  });

  it("preserves Raydium standard pools when concentrated returns invalid JSON", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("{bad-json", { status: 200 }))
      .mockResolvedValueOnce(raydiumPage([makeRaydiumPool({ type: "Standard", id: "stdPool", price: 1.0001, feeRate: 0.0025 })]));

    const pools = await fetchRaydiumPools();
    expect(pools).toMatchObject({ ok: true, degraded: true });
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolType).toBe("raydium-amm");
    expect(pools.errors.some((error) => error.includes("invalid JSON"))).toBe(true);
  });

  it("skips malformed Raydium pool rows while preserving valid rows from the same page", async () => {
    const broken = makeRaydiumPool({ id: "brokenPool" });
    delete (broken as Record<string, unknown>).mintA;
    mockFetch
      .mockResolvedValueOnce(raydiumPage([broken, makeRaydiumPool({ id: "validPool" })]))
      .mockResolvedValueOnce(raydiumPage([]));

    const pools = await fetchRaydiumPools();
    expect(pools.ok).toBe(true);
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("validPool");
    expect(pools.physicalPoolCensus).toEqual({
      exactPoolKeys: ["solana:brokenPool", "solana:validPool"],
      incompleteChains: [],
    });
  });

  it.each([true, false])(
    "preserves raw Raydium confirmation keys and withholds damaged census authority (identity %s)",
    async (hasIdentity) => {
      mockFetch
        .mockResolvedValueOnce(raydiumPage([
          { id: hasIdentity ? "brokenPool" : "", tvl: 100_000 },
          makeRaydiumPool({ id: "validPool" }),
        ]))
        .mockResolvedValueOnce(raydiumPage([]));
      const result = await fetchRaydiumPools();
      expect(result.pools).toHaveLength(1);
      const phase = await fetchDirectApiFixture(
        [{ name: "Raydium", circuitKey: "raydium", normalizedProtocol: "raydium", supportedChains: ["solana"], censusScope: "exhaustive", result }],
        { chainAddressToId: new Map(), symbolToChainScopedIds: new Map(), contractMetaByChainAddress: new Map() },
      );
      const index = buildAuthoritativeStagedPoolConfirmationIndex(phase.results);
      expect(index.enforcedChainsByProtocol.get("raydium")?.has("solana") ?? false).toBe(hasIdentity);
      expect(index.confirmedExactKeysByProtocol.get("raydium")?.has("solana:brokenPool") ?? false).toBe(hasIdentity);
    },
  );

  it("never infers exhausted Raydium coverage from full pages with unreadable TVL", async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const rows = url.searchParams.get("poolType") === "standard"
        ? []
        : page <= 2
          ? Array.from({ length: 1000 }, (_, index) => ({ id: `unknown-${page}-${index}`, tvl: "unknown" }))
          : [makeRaydiumPool({ id: "late-valid" })];
      return jsonResponse({ success: true, data: { data: rows } });
    });
    const result = await fetchRaydiumPools();
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual(["late-valid"]);
    expect(result.physicalPoolCensus?.exactPoolKeys).toContain("solana:late-valid");
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("poolType=concentrated"))).toHaveLength(3);
  });
});

describe("fetchOrcaPools", () => {
  afterEach(() => {
    mockFetch = createFetchMock([], { requireMatch: true });
  });

  it("fetches whirlpools, parses string balances, and nulls invalid price strings", async () => {
    mockJsonFetch(orcaResponse([
      makeOrcaPool("9tXiuRRw7kbejLhZXtxDxYs2REe43uH2e7k1kocgdM9B", {
        price: "0.99991840037040574739",
        tvlUsdc: "29901161.1424620915653082",
        tokenBalanceA: "250000500000",
        tokenBalanceB: "249999500000",
        stats: { "24h": { volume: "1635006.18" } },
      }),
      makeOrcaPool("invalidPricePool", { price: "invalid" }),
    ]));

    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(2);
    expect(pools.pools[0]).toMatchObject({
      source: "orca",
      poolType: "orca-whirlpool",
      balances: [250_000.5, 249_999.5],
    });
    expect(pools.pools[0].price).toBeCloseTo(0.9999184);
    expect(pools.pools[0].tvlUsd).toBeCloseTo(29_901_161.14);
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001);
    expect(pools.pools[1].price).toBeNull();
  });

  it("skips malformed Orca pool rows while preserving valid rows from the same page", async () => {
    const missingToken = makeOrcaPool("brokenPoolMissingToken");
    delete (missingToken as Record<string, unknown>).tokenA;
    const badDecimals = makeOrcaPool("brokenPoolBadDecimals", {
      tokenA: { address: "mintA", symbol: "USDC", decimals: "6" as unknown as number },
    });
    mockJsonFetch(orcaResponse([missingToken, badDecimals, makeOrcaPool("validPool")]));

    const pools = await fetchOrcaPools();
    expect(pools).toMatchObject({ ok: true, degraded: false });
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("validPool");
    expect(pools.warnings).toContain("page 1 skipped 2 malformed pool rows");
    expect(pools.physicalPoolCensus).toEqual({
      exactPoolKeys: ["solana:brokenPoolMissingToken", "solana:brokenPoolBadDecimals", "solana:validPool"],
      incompleteChains: [],
    });
  });

  it.each([true, false])(
    "preserves raw Orca identities and never acknowledges an unreadable inventory row (identity %s)",
    async (hasIdentity) => {
      mockJsonFetch(orcaResponse([{ address: hasIdentity ? "brokenPool" : "" }, makeOrcaPool("validPool")]));
      const { db } = fixtures.open();
      const result = await fetchOrcaPools(undefined, db);
      expect(result.pools).toHaveLength(1);
      const phase = await fetchDirectApiFixture(
        [{ name: "Orca", circuitKey: "orca", normalizedProtocol: "orca", supportedChains: ["solana"], censusScope: "exhaustive", result }],
        { chainAddressToId: new Map(), symbolToChainScopedIds: new Map(), contractMetaByChainAddress: new Map() },
      );
      const index = buildAuthoritativeStagedPoolConfirmationIndex(phase.results);
      expect(result.pagination?.state).toBe(hasIdentity ? "complete" : "partial");
      expect(result.pendingPaginationUpdates).toHaveLength(hasIdentity ? 1 : 0);
      expect(index.enforcedChainsByProtocol.get("orca")?.has("solana") ?? false).toBe(hasIdentity);
      expect(index.confirmedExactKeysByProtocol.get("orca")?.has("solana:brokenPool") ?? false).toBe(hasIdentity);
    },
  );

  it.each([
    { label: "429 rate limit", setup: () => mockTextFetch("rate limited", 429), degraded: true, err: undefined },
    { label: "HTTP 500 error", setup: () => mockTextFetch("error", 500), degraded: true, err: undefined },
    { label: "empty response", setup: () => mockJsonFetch(orcaResponse([])), degraded: false, err: undefined },
    { label: "all pools below minTvl", setup: () => mockJsonFetch(orcaResponse([makeOrcaPool("pool1", { tvlUsdc: "5000" })])), degraded: true, err: "page 1 had no eligible pools despite minTvl filter" },
  ])("marks Orca $label as unavailable", async ({ setup, degraded, err }) => {
    setup();
    const pools = await fetchOrcaPools();
    expect(pools).toMatchObject({ pools: [], ok: false, degraded });
    if (err) expect(pools.errors).toContain(err);
  });

  it("follows cursor-based pagination", async () => {
    mockFetch = createFetchMock([
      orcaRoute(null, [{ body: orcaResponse([makeOrcaPool("pool1")], "cursor123") }]),
      orcaRoute("cursor123", [{ body: orcaResponse([makeOrcaPool("pool2")]) }]),
    ], { requireMatch: true, strictUrl: true });

    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(2);
    expect(pools.censusScope).toBe("exhaustive");
    expect(buildAuthoritativeStagedPoolConfirmationIndex([{
      name: "Orca", circuitKey: "orca", normalizedProtocol: "orca", supportedChains: ["solana"],
      censusScope: "exhaustive", result: pools, authoritativeExactPoolKeys: new Set(["solana:pool1", "solana:pool2"]),
    }]).enforcedChainsByProtocol.get("orca")).toEqual(new Set(["solana"]));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("next=cursor123");
    expect(secondCallUrl).toContain("sortBy=tvl");
    expect(secondCallUrl).toContain("sortDirection=desc");
    expect(secondCallUrl).toContain("minTvl=10000");
  });

  it("does not certify an exhaustive census from a full page with no readable next cursor", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => makeOrcaPool(`fullPage${index}`));
    mockFetch = createFetchMock([orcaRoute(null, [{ body: { data: rows, meta: {} } }])], {
      requireMatch: true,
      strictUrl: true,
    });
    const { db, sqlite } = fixtures.open();
    const result = await fetchOrcaPools(undefined, db);

    expect(result.pools).toHaveLength(200);
    expect(result.pagination).toMatchObject({ state: "partial", cycleCompleted: false });
    expect(result.censusScope).toBe("bounded-sample");
    expect(buildAuthoritativeStagedPoolConfirmationIndex([{
      name: "Orca", circuitKey: "orca", normalizedProtocol: "orca", supportedChains: ["solana"],
      censusScope: "exhaustive", result, authoritativeExactPoolKeys: new Set(result.physicalPoolCensus?.exactPoolKeys ?? []),
    }]).enforcedChainsByProtocol.has("orca")).toBe(false);

    await acknowledgeDexSourcePagination(db, result.pendingPaginationUpdates ?? []);
    const persisted = sqlite.prepare(
      "SELECT cursor, completed_at FROM dex_source_pagination_state WHERE source_key = 'orca:solana'",
    ).get() as { cursor: string | null; completed_at: number | null } | undefined;
    expect(persisted?.completed_at ?? null).toBeNull();
  });

  it("refreshes the Orca head before resuming a durable tail cursor", async () => {
    mockFetch = createFetchMock([
      orcaRoute(null, [{ body: orcaResponse([makeOrcaPool("head")], "fresh-head-tail") }]),
      orcaRoute("stored-cursor", [{ body: orcaResponse([makeOrcaPool("stored-tail")]) }]),
    ], { requireMatch: true, strictUrl: true });
    const { db, state } = makeCursorDb("stored-cursor");

    const result = await fetchOrcaPools(undefined, db);
    expect(String(mockFetch.mock.calls[0][0])).toContain("sortBy=tvl");
    expect(String(mockFetch.mock.calls[1][0])).toContain("next=stored-cursor");
    expect(String(mockFetch.mock.calls[1][0])).toContain("minTvl=10000");
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual(["head", "stored-tail"]);
    expect(result.pagination).toMatchObject({ state: "partial", headRefreshed: true, cycleCompleted: true });
    expect(buildAuthoritativeStagedPoolConfirmationIndex([{
      name: "Orca", circuitKey: "orca", normalizedProtocol: "orca", supportedChains: ["solana"],
      censusScope: "exhaustive", result, authoritativeExactPoolKeys: new Set(["solana:head", "solana:stored-tail"]),
    }]).enforcedChainsByProtocol.has("orca")).toBe(false);
    expect(state.cursor).toBe("stored-cursor");
    await acknowledgeDexSourcePagination(db, result.pendingPaginationUpdates ?? []);
    expect(state.cursor).toBe("fresh-head-tail");
  });

  it("keeps a failed acknowledgement retryable without degrading fetched evidence", async () => {
    mockFetch = createFetchMock([
      orcaRoute(null, [1, 2].map((run) => ({ body: orcaResponse([makeOrcaPool(`head-${run}`)], `fresh-head-tail-${run}`) }))),
      orcaRoute("stored-tail", [1, 2].map((run) => ({ body: orcaResponse([makeOrcaPool(`tail-${run}`)]) }))),
    ], { requireMatch: true, strictUrl: true });
    const { db, state } = makeCursorDb("stored-tail", 1);

    const failedWrite = await fetchOrcaPools(undefined, db);
    expect(state.writeAttempts).toBe(0);
    const failedAck = await acknowledgeDexSourcePagination(db, failedWrite.pendingPaginationUpdates ?? []);
    const retriedWrite = await fetchOrcaPools(undefined, db);

    expect(failedWrite).toMatchObject({ ok: true, degraded: false });
    expect(failedAck).toEqual({
      attempts: 1,
      written: 0,
      failures: [{ sourceKey: "orca:solana", errorClass: "write-failed" }],
    });
    expect(retriedWrite).toMatchObject({ ok: true, degraded: false });
    expect(await acknowledgeDexSourcePagination(db, retriedWrite.pendingPaginationUpdates ?? [])).toEqual({
      attempts: 1,
      written: 1,
      failures: [],
    });
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("next=stored-tail");
    expect(String(mockFetch.mock.calls[3]?.[0])).toContain("next=stored-tail");
    expect(state.cursor).toBe("fresh-head-tail-2");
  });

  it("preserves a far-tail cursor across a transient failure and retries it next run", async () => {
    mockFetch = createFetchMock([
      orcaRoute(null, [1, 2].map((run) => ({ body: orcaResponse([makeOrcaPool(`head-${run}`)], `fresh-head-tail-${run}`) }))),
      orcaRoute("far-tail-cursor", [
        { response: new Response("temporary upstream failure", { status: 503 }) },
        { body: orcaResponse([makeOrcaPool("far-tail-retry")]) },
      ]),
    ], { requireMatch: true, strictUrl: true });
    const { db, state } = makeCursorDb("far-tail-cursor");

    const transientFailure = await fetchOrcaPools(undefined, db);
    await acknowledgeDexSourcePagination(db, transientFailure.pendingPaginationUpdates ?? []);
    const retriedTail = await fetchOrcaPools(undefined, db);
    await acknowledgeDexSourcePagination(db, retriedTail.pendingPaginationUpdates ?? []);

    expect(transientFailure).toMatchObject({ ok: true, degraded: true });
    expect(transientFailure.pagination).toMatchObject({ state: "partial", cursor: "far-tail-cursor", cycleCompleted: false });
    expect(retriedTail).toMatchObject({ ok: true, degraded: false });
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("next=far-tail-cursor");
    expect(String(mockFetch.mock.calls[3]?.[0])).toContain("next=far-tail-cursor");
    expect(state.persistedCursors).toEqual(["far-tail-cursor", "fresh-head-tail-2"]);
  });

  it("resets a tail only when the API explicitly rejects its cursor", async () => {
    mockFetch = createFetchMock([
      orcaRoute(null, [{ body: orcaResponse([makeOrcaPool("head")], "fresh-head-tail") }]),
      orcaRoute("expired-tail", [{ response: new Response("expired cursor", { status: 404 }) }]),
    ], { requireMatch: true, strictUrl: true });
    const { db, state } = makeCursorDb("expired-tail");

    const result = await fetchOrcaPools(undefined, db);
    expect(result.pagination).toMatchObject({ state: "partial", cursor: "fresh-head-tail" });
    expect(result.errors).toContain("API rejected tail cursor (404); restarting from refreshed head");
    expect(state.cursor).toBe("expired-tail");
    await acknowledgeDexSourcePagination(db, result.pendingPaginationUpdates ?? []);
    expect(state.cursor).toBe("fresh-head-tail");
  });

  it("stops pagination on 429 mid-pagination and returns partial results", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(orcaResponse([makeOrcaPool("pool1")], "cursor456")))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("pool1");
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });
});
