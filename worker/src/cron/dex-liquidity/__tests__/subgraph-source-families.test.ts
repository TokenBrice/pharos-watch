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
  UNIV3_SUBGRAPHS,
  buildAerodromePairQuery,
  buildUniswapV4PoolQuery,
  buildUniV3PoolQuery,
} from "../constants";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../../measured-execution/inventory";

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
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const url = String(input);
      const matchedChain = configuredChains.find(([, subgraphId]) => url.endsWith(subgraphId))?.[0];
      if (!matchedChain) {
        throw new Error("Unexpected Uni V3 subgraph URL");
      }
      const response = new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
      inFlight--;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const chainAddressToId = new Map(
      configuredChains.map(([chain]) => [`${chain}:${token0}`, "usdc-circle"]),
    );
    const result = await fetchUniV3Data("graph-key", new Map(), chainAddressToId);

    expect(fetchMock).toHaveBeenCalledTimes(configuredChains.length);
    expect(maxInFlight).toBe(5);
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).endsWith(UNIV3_SUBGRAPHS.bsc),
    )).toBe(true);
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
