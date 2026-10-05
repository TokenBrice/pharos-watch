import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUniswapV4Data,
  fetchUniV3Data,
} from "../subgraph-source-families";
import {
  UNISWAP_V4_SUBGRAPHS,
  UNIV3_BASE_POOL_MAX_PAGES,
  UNIV3_POOL_MAX_PAGES,
  UNIV3_POOL_PAGE_SIZE,
  UNIV3_SUBGRAPHS,
  buildUniV3MessariPoolQuery,
  buildUniV3PoolQuery,
} from "../constants";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../../measured-execution/inventory";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { computeUniswapV4PoolId, UNISWAP_V4_HOOK_FREE_ADDRESS } from "../../measured-execution/uniswap-v4";

// Captured at Graph block 26088668 on 2026-09-30; Initialize block 24974199:
// https://etherscan.io/tx/0xdbfd03418344a5db0e0910874e6b15da64bd8edff032253e20de67e709918d7c
const THUSD_POOL = {
  id: "0xb30bf32e26a35328286df33c17dd01e1051b5e3a0ec55a4a211e6957594b5a0d",
  token0: { id: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: "6" },
  token1: { id: "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3", symbol: "thUSD", decimals: "6" },
  feeTier: "100", tickSpacing: "1", hooks: UNISWAP_V4_HOOK_FREE_ADDRESS,
  liquidity: "1215742317323", totalValueLockedUSD: "-222031.942086",
  token0Price: "0.9988856322499521", token1Price: "1.0011156109509132",
};

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("subgraph source families", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty Uni V3 lookups when Graph API key is missing", async () => {
    const result = await fetchUniV3Data(null, new Map(), new Map());

    expect(result.uniV3PoolFees.size).toBe(0);
    expect(result.uniV3SymbolFees.size).toBe(0);
    expect(result.uniV3PriceObs.size).toBe(0);
  });

  it("returns empty Uniswap V4 lookups when Graph API key is missing", async () => {
    const result = await fetchUniswapV4Data(null, new Map());

    expect(result.uniswapV4ExecutionCandidates.size).toBe(0);
  });

  it("retains raw negative exact identity while rejecting missing, malformed, changed and conflicting rows", async () => {
    const poolWithFee = (fee: number) => ({
      ...THUSD_POOL, feeTier: String(fee),
      id: computeUniswapV4PoolId({
        currency0: THUSD_POOL.token0.id as `0x${string}`,
        currency1: THUSD_POOL.token1.id as `0x${string}`,
        feePips: fee, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
      }),
    });
    const malformed = poolWithFee(200);
    const changed = poolWithFee(300);
    const conflicting = poolWithFee(400);
    const missing = poolWithFee(500);
    mockFetch([{
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: async (request) => {
        const body = await request.json() as { query: string };
        const query = body.query;
        return { body: { data: { pools: query.includes("id_in") ? [
          THUSD_POOL,
          { ...malformed, token0: { ...malformed.token0, decimals: "NaN" } },
          { ...changed, token1: { ...changed.token1, id: "0x0000000000000000000000000000000000000001" } },
          conflicting, { ...conflicting, liquidity: "2" },
        ] : [] } } };
      },
    }], { requireMatch: true });
    const result = await fetchUniswapV4Data("graph-key", new Map([["ethereum",
      [THUSD_POOL.id, malformed.id, changed.id, conflicting.id, missing.id]]]));
    const candidates = [...result.uniswapV4ExecutionCandidates.values()].flat();
    expect(candidates).toEqual([expect.objectContaining({
      poolId: THUSD_POOL.id, tvlUsd: -222031.942086, activeLiquidity: "1215742317323",
    })]);
    expect(result.failedChains).toEqual([]);
  });

  it("consumes each exact response before requesting the next bounded batch", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => {
      const feePips = index + 100;
      return { ...THUSD_POOL, feeTier: String(feePips),
        id: computeUniswapV4PoolId({
          currency0: THUSD_POOL.token0.id as `0x${string}`,
          currency1: THUSD_POOL.token1.id as `0x${string}`,
          feePips, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
        }) };
    });
    const bodyStarted = createDeferred<void>();
    const releaseBody = createDeferred<void>();
    const batches: number[] = [];
    let firstBodyConsumed = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const query = (JSON.parse(init.body as string) as { query: string }).query;
      const match = query.match(/id_in: (\[[^\]]+\])/);
      if (!match) return new Response(JSON.stringify({ data: { pools: [] } }));
      const ids = JSON.parse(match[1]!) as string[];
      batches.push(ids.length);
      if (batches.length > 1) expect(firstBodyConsumed).toBe(true);
      const payload = JSON.stringify({ data: { pools: rows.filter((row) => ids.includes(row.id)) } });
      return new Response(new ReadableStream({
        async start(controller) {
          if (batches.length === 1) {
            bodyStarted.resolve(undefined);
            await releaseBody.promise;
            firstBodyConsumed = true;
          }
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }));
    }));
    const pending = fetchUniswapV4Data("graph-key", new Map([["ethereum", rows.map((row) => row.id)]]));
    void pending.then(
      () => bodyStarted.reject(new Error("Exact body did not start")),
      (error: unknown) => bodyStarted.reject(error),
    );
    try {
      await bodyStarted.promise;
      expect(batches).toEqual([100]);
    } finally {
      releaseBody.resolve(undefined);
    }
    const result = await pending;
    expect(batches).toEqual([100, 1]);
    expect([...result.uniswapV4ExecutionCandidates.values()].flat().map((candidate) => candidate.poolId))
      .toEqual(rows.map((row) => row.id));
  });

  it("names a failed exact identity source without accepting a broad copy", async () => {
    mockFetch([{
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: async (request) => {
        const body = await request.json() as { query: string };
        return body.query.includes("id_in")
          ? { body: { errors: [{ message: "Exact lookup unavailable" }] } }
          : { body: { data: { pools: [{ ...THUSD_POOL, totalValueLockedUSD: "5561855" }] } } };
      },
    }], { requireMatch: true });
    const result = await fetchUniswapV4Data("graph-key", new Map([["ethereum", [THUSD_POOL.id]]]));
    expect(result.failedChains).toEqual(["ethereum"]);
    expect(result.failedChainReasons.ethereum).toBe("graphql");
    expect([...result.uniswapV4ExecutionCandidates.values()].flat()
      .some((candidate) => candidate.chain === "ethereum" && candidate.poolId === THUSD_POOL.id)).toBe(false);
  });

  it("paginates the Uni V3 query by embedding the skip offset and page size", () => {
    expect(buildUniV3PoolQuery(0)).toContain(`first: ${UNIV3_POOL_PAGE_SIZE}`);
    expect(buildUniV3PoolQuery(0)).toContain("skip: 0");
    expect(buildUniV3PoolQuery(2000)).toContain("skip: 2000");
  });

  it("queries the bounded six-chain Uni V3 family and creates BSC shadow candidates", async () => {
    const configuredChains = Object.entries(UNIV3_SUBGRAPHS);
    expect(configuredChains.map(([chain]) => chain)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "celo",
      "bsc",
    ]);

    const token0 = "0x1111111111111111111111111111111111111111";
    const token1 = "0x2222222222222222222222222222222222222222";
    const poolAddress = "0x3333333333333333333333333333333333333333";
    let inFlight = 0;
    let maxInFlight = 0;
    const waveStarted = createDeferred<void>();
    const releaseWave = createDeferred<void>();
    const fetchMock = mockFetch([{
      match: (request) => configuredChains.some(([, subgraphId]) => request.url.endsWith(subgraphId)),
      respond: async (request) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 5) waveStarted.resolve(undefined);
        await releaseWave.promise;
        inFlight--;
        if (request.url.endsWith(UNIV3_SUBGRAPHS.celo)) {
          return {
            body: {
              data: {
                liquidityPools: [
                  {
                    id: poolAddress,
                    inputTokens: [
                      { id: token0, symbol: "USDC", decimals: 6 },
                      { id: token1, symbol: "USDT", decimals: 18 },
                    ],
                    inputTokenBalances: ["500000000000", "500000000000000000000000"],
                    fees: [{ feeType: "FIXED_TRADING_FEE", feePercentage: "0.3" }],
                    // 1.0001^276324 * 10^(6 - 18) ≈ 1 USDT per USDC.
                    tick: "276324",
                    totalValueLockedUSD: "0",
                  },
                ],
              },
            },
          };
        }
        return {
          body: {
            data: {
              pools: [
                {
                  id: poolAddress,
                  token0: { id: token0, symbol: "USDC", decimals: "6" },
                  token1: { id: token1, symbol: "USDT", decimals: "18" },
                  feeTier: "3000",
                  totalValueLockedUSD: "1000000",
                  volumeUSD: "500000",
                  token0Price: "1",
                  token1Price: "1",
                  totalValueLockedToken0: "500000",
                  totalValueLockedToken1: "500000",
                },
              ],
            },
          },
        };
      },
    }], { requireMatch: true });

    const chainAddressToId = new Map(
      configuredChains.map(([chain]) => [`${chain}:${token0}`, "usdc-circle"]),
    );
    const pending = fetchUniV3Data("graph-key", new Map(), chainAddressToId);
    void pending.catch((error: unknown) => waveStarted.reject(error));
    // Failure-only watchdog: release blocked work even if the concurrency cap regresses below five.
    const deadlockGuard = setTimeout(() => waveStarted.reject(new Error("First wave did not start")), 1000);
    try {
      await waveStarted.promise;
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(inFlight).toBe(5);
    } finally {
      clearTimeout(deadlockGuard);
      releaseWave.resolve(undefined);
      await pending;
    }
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(configuredChains.length);
    expect(maxInFlight).toBe(5);
    expect(fetchMock.getHistory().some(({ url }) => url.endsWith(UNIV3_SUBGRAPHS.bsc))).toBe(true);
    expect(result.uniV3ExecutionCandidates.size).toBe(configuredChains.length);
    const bscKey = buildUniV3ExecutionCandidateKey("bsc", [token0, token1], 3000);
    expect(bscKey).not.toBeNull();
    expect(result.uniV3ExecutionCandidates.get(bscKey!)).toEqual([
      expect.objectContaining({
        chain: "bsc",
        poolAddress,
        feePips: 3000,
      }),
    ]);
    expect(result.uniV3PoolFees.has(`bsc:${poolAddress}`)).toBe(false);
    expect(result.uniV3SymbolFees.has("bsc:USDC:USDT")).toBe(false);
    expect(result.uniV3PriceObs.get("usdc-circle")?.map((observation) => observation.chain)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "celo",
    ]);
  });

  it("stops the Base Uni V3 lane after one full page so the slow Base deployment stays inside the shared per-chain timeout", async () => {
    const token0 = "0x1111111111111111111111111111111111111111";
    const token1 = "0x2222222222222222222222222222222222222222";
    const fullPage = Array.from({ length: UNIV3_POOL_PAGE_SIZE }, (_, i) => ({
      id: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      token0: { id: token0, symbol: "USDC", decimals: "6" },
      token1: { id: token1, symbol: "USDT", decimals: "18" },
      feeTier: "3000",
      totalValueLockedUSD: "1000000",
      volumeUSD: "500000",
      token0Price: "1",
      token1Price: "1",
      totalValueLockedToken0: "500000",
      totalValueLockedToken1: "500000",
    }));

    const fetchMock = mockFetch([{
      match: (request) => request.url.endsWith(UNIV3_SUBGRAPHS.base),
      respond: () => ({ body: { data: { pools: fullPage } } }),
    }, {
      match: (request) => request.url.endsWith(UNIV3_SUBGRAPHS.ethereum),
      respond: () => ({ body: { data: { pools: fullPage } } }),
    }, {
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: () => ({ body: { data: { pools: [] } } }),
    }], { requireMatch: true });

    const result = await fetchUniV3Data("graph-key", new Map(), new Map());

    expect(result.failedChains).toEqual([]);
    // Base answers a full 1000-pool page in a measured ~8s, and the family's
    // single 15s per-chain signal covers every page, so Base must stop after
    // one page; the other chains keep the full page budget.
    expect(fetchMock.getHistory().filter(({ url }) => url.endsWith(UNIV3_SUBGRAPHS.base)).length)
      .toBe(UNIV3_BASE_POOL_MAX_PAGES);
    expect(fetchMock.getHistory().filter(({ url }) => url.endsWith(UNIV3_SUBGRAPHS.ethereum)).length)
      .toBe(UNIV3_POOL_MAX_PAGES);
    expect(result.uniV3ExecutionCandidates.get(buildUniV3ExecutionCandidateKey("base", [token0, token1], 3000)!))
      .toHaveLength(UNIV3_POOL_PAGE_SIZE);
  });

  it("requests exact V4 PoolKey fields and retains hooked collisions", async () => {
    expect(Object.keys(UNISWAP_V4_SUBGRAPHS)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "bsc",
    ]);
    // PoolKey fields are exercised through the returned collision candidates.

    const token0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const token1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    let inFlight = 0;
    let maxInFlight = 0;
    const waveStarted = createDeferred<void>();
    const releaseWave = createDeferred<void>();
    const fetchMock = mockFetch([{
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 5) waveStarted.resolve(undefined);
        await releaseWave.promise;
        inFlight--;
        return {
          body: { data: { pools: [
            {
              id: `0x${"1".repeat(64)}`,
              token0: { id: token0, symbol: "USDC", decimals: "6" },
              token1: { id: token1, symbol: "USDT", decimals: "6" },
              feeTier: "100",
              tickSpacing: "1",
              hooks: "0x0000000000000000000000000000000000000000",
              liquidity: "123456789",
              totalValueLockedUSD: "1000000",
              token0Price: "1",
              token1Price: "1",
            },
            {
              id: `0x${"2".repeat(64)}`,
              token0: { id: token0, symbol: "USDC", decimals: "6" },
              token1: { id: token1, symbol: "USDT", decimals: "6" },
              feeTier: "100",
              tickSpacing: "1",
              hooks: "0x0000000000000000000000000000000000000001",
              liquidity: "0",
              totalValueLockedUSD: "900000",
              token0Price: "1",
              token1Price: "1",
            },
          ] } },
        };
      },
    }], { requireMatch: true });

    const pending = fetchUniswapV4Data("graph-key", new Map());
    void pending.catch((error: unknown) => waveStarted.reject(error));
    // Failure-only watchdog; successful runs wait on the response gate, never the clock.
    const deadlockGuard = setTimeout(() => waveStarted.reject(new Error("First wave did not start")), 1000);
    try {
      await waveStarted.promise;
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(inFlight).toBe(5);
    } finally {
      clearTimeout(deadlockGuard);
      releaseWave.resolve(undefined);
      await pending;
    }
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(5);
    const key = buildUniswapV4ExecutionCandidateKey(
      "ethereum",
      [token0, token1],
      100,
    );
    expect(key).not.toBeNull();
    expect(result.uniswapV4ExecutionCandidates.get(key!)?.map((row) => row.hookAddress))
      .toEqual([
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000001",
      ]);
    expect(result.uniswapV4ExecutionCandidates.get(key!)?.map((row) => row.activeLiquidity))
      .toEqual(["123456789", "0"]);
  });

  it("reads the Celo lane through the Messari schema with tick spot prices and balance-derived TVL", async () => {
    const usdt = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
    const cusd = "0x765de816845861e75a25fca122bb6898b8b1282a";
    const usdc = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
    const usdtUsdcPool = "0x1a810e0b6c2dd5629afa2f0c898b9512c6f78846";
    const usdtCusdPool = "0x5dc631ad6c26bea1a59fbf2c2680cf3df43d249f";
    const unorderedPool = "0x4444444444444444444444444444444444444444";
    const dustPool = "0x5555555555555555555555555555555555555555";
    const tradingFee = (feePercentage: string) => [
      { feeType: "FIXED_PROTOCOL_FEE", feePercentage: "0" },
      { feeType: "FIXED_LP_FEE", feePercentage },
      { feeType: "FIXED_TRADING_FEE", feePercentage },
    ];
    // Live Celo rows (2026-09-28): the deployment prices USD₮ at ~$4.84 and
    // USDC at $0, so its `totalValueLockedUSD` must not reach the lookups.
    const celoPools = [
      {
        id: usdtUsdcPool,
        inputTokens: [
          { id: usdt, symbol: "USD₮", decimals: 6 },
          { id: usdc, symbol: "USDC", decimals: 6 },
        ],
        inputTokenBalances: ["100882319722", "86069486562"],
        fees: tradingFee("0.01"),
        tick: "-2",
        totalValueLockedUSD: "487967.6232870665396164666847742079",
      },
      {
        id: usdtCusdPool,
        inputTokens: [
          { id: usdt, symbol: "USD₮", decimals: 6 },
          { id: cusd, symbol: "cUSD", decimals: 18 },
        ],
        inputTokenBalances: ["412427378097", "229522950517790733582893"],
        fees: tradingFee("0.01"),
        tick: "276321",
        totalValueLockedUSD: "2220257.323562950490716069290656678",
      },
      {
        id: unorderedPool,
        inputTokens: [
          { id: usdc, symbol: "USDC", decimals: 6 },
          { id: usdt, symbol: "USD₮", decimals: 6 },
        ],
        inputTokenBalances: ["100000000000", "100000000000"],
        fees: tradingFee("0.05"),
        tick: "0",
        totalValueLockedUSD: "200000",
      },
      {
        id: dustPool,
        inputTokens: [
          { id: usdt, symbol: "USD₮", decimals: 6 },
          { id: usdc, symbol: "USDC", decimals: 6 },
        ],
        inputTokenBalances: ["1000000000", "1000000000"],
        fees: tradingFee("0.05"),
        tick: "0",
        totalValueLockedUSD: "9000000",
      },
    ];
    const fetchMock = mockFetch([{
      match: (request) => request.url.endsWith(UNIV3_SUBGRAPHS.celo),
      respond: () => ({ body: { data: { liquidityPools: celoPools } } }),
    }, {
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: () => ({ body: { data: { pools: [] } } }),
    }], { requireMatch: true });

    const result = await fetchUniV3Data(
      "graph-key",
      new Map(),
      new Map([[`celo:${usdt}`, "usdt-tether"], [`celo:${cusd}`, "cusd-celo"]]),
    );

    expect(result.failedChains).toEqual([]);
    const celoRequests = fetchMock.getHistory().filter(({ url }) => url.endsWith(UNIV3_SUBGRAPHS.celo));
    expect(celoRequests).toHaveLength(1);
    expect(JSON.parse(celoRequests[0]!.body ?? "{}").query).toBe(buildUniV3MessariPoolQuery(0, [usdt, cusd]));

    // FIXED_TRADING_FEE 0.01% -> 100 pips; the unordered and sub-floor rows are dropped.
    expect(result.uniV3PoolFees.get(`celo:${usdtUsdcPool}`)).toBe(100);
    expect(result.uniV3PoolFees.get(`celo:${usdtCusdPool}`)).toBe(100);
    expect(result.uniV3PoolFees.has(`celo:${unorderedPool}`)).toBe(false);
    expect(result.uniV3PoolFees.has(`celo:${dustPool}`)).toBe(false);

    // USDC is the reference side: USD₮ is priced at token1 per token0 from the
    // tick, and TVL is valued from balances rather than the ~$488K reported.
    const [usdtObs] = result.uniV3PriceObs.get("usdt-tether") ?? [];
    const usdtPerUsdc = Math.pow(1.0001, -2);
    expect(usdtObs?.chain).toBe("celo");
    expect(usdtObs?.price).toBeCloseTo(usdtPerUsdc, 12);
    expect(usdtObs?.tvl).toBeCloseTo(86_069.486562 + 100_882.319722 * usdtPerUsdc, 3);

    // Neither USD₮ nor cUSD is a USD reference symbol: no price observation,
    // but the pool still resolves as a measured-execution candidate.
    expect(result.uniV3PriceObs.has("cusd-celo")).toBe(false);
    const cusdPerUsdt = Math.pow(1.0001, 276_321) * 1e-12;
    const [cusdCandidate] = result.uniV3ExecutionCandidates.get(
      buildUniV3ExecutionCandidateKey("celo", [usdt, cusd], 100)!,
    ) ?? [];
    expect(cusdCandidate).toMatchObject({ chain: "celo", poolAddress: usdtCusdPool, feePips: 100 });
    expect(cusdCandidate?.token1Price).toBeCloseTo(cusdPerUsdt, 12);
    expect(cusdCandidate?.token0Price).toBeCloseTo(1 / cusdPerUsdt, 12);
    expect(cusdCandidate?.tokens).toEqual([
      { address: usdt, symbol: "USD₮", decimals: 6 },
      { address: cusd, symbol: "cUSD", decimals: 18 },
    ]);
  });

  it("records chains whose subgraph answers with a GraphQL error and no entities", async () => {
    mockFetch([{
      match: "gateway.thegraph.com/api/graph-key/subgraphs/id/",
      respond: async () => ({
        body: { errors: [{ message: "Type 'Query' has no field 'pools'" }] },
      }),
    }], { requireMatch: true });

    const result = await fetchUniV3Data("graph-key", new Map(), new Map());

    expect([...result.failedChains].sort()).toEqual(Object.keys(UNIV3_SUBGRAPHS).sort());
    expect(result.uniV3PriceObs.size).toBe(0);
  });
});
