import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAerodromeData,
  fetchUniswapV4Data,
  fetchUniV3Data,
} from "../subgraph-source-families";
import {
  AERODROME_PAIR_PAGE_SIZE,
  UNISWAP_V4_POOL_PAGE_SIZE,
  UNIV3_POOL_PAGE_SIZE,
  buildAerodromePairQuery,
  buildUniswapV4PoolQuery,
  buildUniV3PoolQuery,
} from "../constants";
import { buildUniswapV4ExecutionCandidateKey } from "../../measured-execution/inventory";

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

  it("returns empty Aerodrome lookups when Graph API key is missing", async () => {
    const result = await fetchAerodromeData(null, new Map(), new Map());

    expect(result.aerodromePriceObs.size).toBe(0);
    expect(result.aerodromeIsStable.size).toBe(0);
    expect(result.aerodromeV2ExecutionCandidates.size).toBe(0);
  });

  it("returns empty Uniswap V4 lookups when Graph API key is missing", async () => {
    const result = await fetchUniswapV4Data(null);

    expect(result.uniswapV4ExecutionCandidates.size).toBe(0);
  });

  it("paginates the Uni V3 query by embedding the skip offset and page size", () => {
    expect(buildUniV3PoolQuery(0)).toContain(`first: ${UNIV3_POOL_PAGE_SIZE}`);
    expect(buildUniV3PoolQuery(0)).toContain("skip: 0");
    expect(buildUniV3PoolQuery(2000)).toContain("skip: 2000");
  });

  it("paginates the Aerodrome query by embedding the skip offset and page size", () => {
    expect(buildAerodromePairQuery(0)).toContain(`first: ${AERODROME_PAIR_PAGE_SIZE}`);
    expect(buildAerodromePairQuery(0)).toContain("skip: 0");
    expect(buildAerodromePairQuery(1000)).toContain("skip: 1000");
  });

  it("requests exact V4 PoolKey fields and retains hooked collisions", async () => {
    expect(buildUniswapV4PoolQuery(0)).toContain(
      `first: ${UNISWAP_V4_POOL_PAGE_SIZE}`,
    );
    expect(buildUniswapV4PoolQuery(2000)).toContain("skip: 2000");
    expect(buildUniswapV4PoolQuery(0)).toContain("tickSpacing");
    expect(buildUniswapV4PoolQuery(0)).toContain("hooks");
    expect(buildUniswapV4PoolQuery(0)).toContain("liquidity");

    const token0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const token1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              pools: [
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
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await fetchUniswapV4Data("graph-key");
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
});
