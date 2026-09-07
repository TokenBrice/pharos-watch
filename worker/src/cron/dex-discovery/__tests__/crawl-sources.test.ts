import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCircuitOutcomeRecord } from "../../../test-helpers/cron";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const fetchDsTokenPairsWithStatusMock = vi.hoisted(() => vi.fn());
const fetchDsTokenPoolsWithStatusMock = vi.hoisted(() => vi.fn());
const censusStageMocks = vi.hoisted(() => ({
  aquarius: vi.fn(),
  tezos: vi.fn(),
  iconBalanced: vi.fn(),
  kavaSwap: vi.fn(),
}));

vi.mock("../../dex-liquidity/crawl-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../dex-liquidity/crawl-helpers")>();
  return {
    ...actual,
    crawlTokenPools: vi.fn().mockResolvedValue({ stoppedEarly: false }),
  };
});

vi.mock("../../../lib/abort", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/abort")>("../../../lib/abort");
  return {
    ...actual,
    sleepWithSignal: vi.fn(async () => {}),
  };
});

vi.mock("../../../lib/coingecko-onchain", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/coingecko-onchain")>(
    "../../../lib/coingecko-onchain",
  );
  return {
    ...actual,
    fetchCgTokenPoolsWithStatus: vi.fn(async () => ({ transportOk: true, schemaDegraded: false, pools: [] })),
  };
});

vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

vi.mock("../../../lib/dexscreener", () => ({
  fetchDsTokenPoolsWithStatus: fetchDsTokenPoolsWithStatusMock,
  fetchDsTokenPairsWithStatus: fetchDsTokenPairsWithStatusMock,
  dsRateLimit: vi.fn().mockResolvedValue(undefined),
  getDsTrackedTokenPriceUsd: vi.fn(
    (pair: { baseToken: { address: string }; priceUsd: string | null }, trackedAddress: string) => ({
      side: pair.baseToken.address?.toLowerCase() === trackedAddress.toLowerCase() ? "base" : null,
      priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    }),
  ),
}));

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

vi.mock("../crawl-soroban-pools", () => ({
  crawlSorobanPoolsStage: censusStageMocks.aquarius,
}));

vi.mock("../crawl-tezos-pools", () => ({
  crawlTezosPoolsStage: censusStageMocks.tezos,
}));

vi.mock("../crawl-icon-balanced-pools", () => ({
  crawlIconBalancedPoolsStage: censusStageMocks.iconBalanced,
}));

vi.mock("../crawl-kava-swap-pools", () => ({
  crawlKavaSwapPoolsStage: censusStageMocks.kavaSwap,
}));

import { crawlCoin } from "../crawl-sources";
import { crawlCoinGeckoPoolsStage } from "../crawl-coingecko-pools";
import {
  createDexScreenerDiscoveryRunState,
  finalizeDexScreenerDiscoveryRun,
} from "../crawl-dexscreener-pools";
import { createCrawlStageContext, knownPoolIdKey } from "../staged-pool";
import { crawlTokenPools } from "../../dex-liquidity/crawl-helpers";
import { dsRateLimit, fetchDsTokenPairsWithStatus, fetchDsTokenPoolsWithStatus } from "../../../lib/dexscreener";
import { fetchCgTokenPoolsWithStatus } from "../../../lib/coingecko-onchain";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { shouldAttemptFetch, recordOutcome } from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { QUALITY_MULTIPLIERS } from "../../../lib/dex-cron-constants";

function createMockDb(): D1Database {
  return makeNoopD1({
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
  });
}

function createCoinGeckoStageContext() {
  return createCrawlStageContext({
    stablecoinId: "usdc-circle",
    knownPoolIds: new Set(),
    nowSec: 1_800_000_000,
    pools: [],
    priceObs: [],
  });
}

describe("crawlCoin DexScreener hardening", () => {
  beforeEach(() => {
    vi.mocked(crawlTokenPools).mockReset();
    vi.mocked(crawlTokenPools).mockResolvedValue({ stoppedEarly: false });
    vi.mocked(fetchDsTokenPairsWithStatus).mockReset();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.mocked(dsRateLimit).mockReset();
    vi.mocked(dsRateLimit).mockResolvedValue(undefined);
    vi.mocked(fetchCgTokenPoolsWithStatus).mockReset();
    vi.mocked(fetchJsonWithRetry).mockReset();
    vi.mocked(shouldAttemptFetch).mockReset();
    vi.mocked(recordOutcome).mockReset();
    censusStageMocks.aquarius.mockReset();
    censusStageMocks.aquarius.mockResolvedValue({ providerChecks: [] });
    censusStageMocks.tezos.mockReset();
    censusStageMocks.tezos.mockResolvedValue({ providerChecks: [] });
    censusStageMocks.iconBalanced.mockReset();
    censusStageMocks.iconBalanced.mockResolvedValue({ providerChecks: [] });
    censusStageMocks.kavaSwap.mockReset();
    censusStageMocks.kavaSwap.mockResolvedValue({ providerChecks: [] });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcome).mockResolvedValue(mockCircuitOutcomeRecord());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips malformed DexScreener pairs and keeps valid pairs in the same response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        {
          chainId: "ethereum",
          dexId: "uniswap-v3",
          pairAddress: "0xbadpool",
          labels: ["V3"],
          baseToken: { address: undefined, name: "Broken Token", symbol: "BROKE" },
          quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1.00",
          volume: { h24: 12_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 60_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        } as never,
        {
          chainId: "ethereum",
          dexId: "uniswap-v3",
          pairAddress: "0xgoodpool",
          labels: ["V3"],
          baseToken: { address: "0xabc", name: "Test USD", symbol: "TUSD" },
          quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1.00",
          volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 75_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        } as never,
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "test-coin",
      [{ chain: "ethereum", address: "0xAbC", decimals: 18 }],
      null,
      new Set(),
    );

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.poolId).toBe("ethereum:0xgoodpool");
    expect("priceObs" in result).toBe(false);
    expect(fetchDsTokenPairsWithStatus).toHaveBeenCalledTimes(1);
    expect(fetchDsTokenPoolsWithStatus).not.toHaveBeenCalled();
    const malformedLog = warnSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { message: string; metadata?: { arguments?: unknown[] } })
      .find((record) => record.message.includes("dexscreener malformed pair"));
    expect(malformedLog).toMatchObject({
      message: expect.stringContaining("[dex-discovery] dexscreener malformed pair for ethereum:0xAbC"),
      metadata: { arguments: [expect.objectContaining({
        pairAddress: "0xbadpool",
        dexId: "uniswap-v3",
        baseToken: null,
        quoteToken: "0xquote",
      })] },
    });
  });

  it("reports every eligible DexScreener pair in the deployment census, including known pools", async () => {
    const pair = {
      chainId: "ethereum",
      dexId: "uniswap-v3",
      labels: ["V3"],
      baseToken: { address: "0xabc", name: "Test USD", symbol: "TUSD" },
      quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
      priceUsd: "1.00",
      volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
      liquidity: { usd: 75_000, base: 0, quote: 0 },
      pairCreatedAt: null,
    };
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        { ...pair, pairAddress: "0xknownpool" },
        { ...pair, pairAddress: "0xnewpool" },
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set([knownPoolIdKey("test-coin", "ethereum:0xknownpool")]),
    );

    expect(result.pools.map((pool) => pool.poolId)).toEqual(["ethereum:0xnewpool"]);
    expect(result.deploymentOutcomes[0]).toMatchObject({
      outcome: "observed_pools",
      observedPoolCount: 2,
    });
  });

  it("records one DexScreener failure for a crawl with only target errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchDsTokenPairsWithStatus).mockRejectedValueOnce(new Error("DexScreener boom"));

    const result = await crawlCoin(
      createMockDb(),
      "test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set(),
    );

    expect(result).toMatchObject({ pools: [], unresolvedChains: [] });
    expect(result.deploymentOutcomes[0]).toMatchObject({ outcome: "provider_inaccessible" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[dex-discovery] dexscreener error for ethereum:0xabc"));
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY, false);
  });

  it("records DexScreener discovery success when any target request reaches the source", async () => {
    vi.mocked(fetchDsTokenPairsWithStatus)
      .mockRejectedValueOnce(new Error("first target failed"))
      .mockResolvedValueOnce({
        ok: true,
        pairs: [],
      });

    const result = await crawlCoin(
      createMockDb(),
      "test-coin",
      [
        { chain: "ethereum", address: "0xabc", decimals: 18 },
        { chain: "bsc", address: "0xdef", decimals: 18 },
      ],
      null,
      new Set(),
    );

    expect(result).toMatchObject({ pools: [], unresolvedChains: [] });
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY, true);
  });

  it("paces every DexScreener request across consecutive one-target coin crawls", async () => {
    const events: string[] = [];
    vi.mocked(dsRateLimit).mockImplementation(async () => {
      events.push("pace");
    });
    vi.mocked(fetchDsTokenPairsWithStatus).mockImplementation(async () => {
      events.push("fetch");
      return { ok: true, pairs: [] };
    });

    await crawlCoin(
      createMockDb(),
      "first-test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set(),
    );
    await crawlCoin(
      createMockDb(),
      "second-test-coin",
      [{ chain: "bsc", address: "0xdef", decimals: 18 }],
      null,
      new Set(),
    );

    expect(events).toEqual(["pace", "fetch", "pace", "fetch"]);
    expect(dsRateLimit).toHaveBeenCalledTimes(2);
  });

  it("latches a hard refusal across coin crawls and records one run-level failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValueOnce({
      ok: false,
      pairs: [],
      status: 429,
      contentType: "text/plain",
      error: "HTTP 429; body starts with: error code: 1015",
      hardRefusal: true,
    });
    const db = createMockDb();
    const runState = createDexScreenerDiscoveryRunState();

    await crawlCoin(
      db,
      "first-test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      runState,
    );
    await crawlCoin(
      db,
      "second-test-coin",
      [{ chain: "bsc", address: "0xdef", decimals: 18 }],
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      runState,
    );
    await finalizeDexScreenerDiscoveryRun(db, runState);

    expect(fetchDsTokenPairsWithStatus).toHaveBeenCalledTimes(1);
    expect(fetchDsTokenPoolsWithStatus).not.toHaveBeenCalled();
    expect(shouldAttemptFetch).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY, false);
    expect(runState).toMatchObject({
      attemptedRequests: 1,
      successfulRequests: 0,
      hardRefusal: {
        status: 429,
        contentType: "text/plain",
        error: expect.stringContaining("1015"),
      },
    });
    const hardRefusalLog = warnSpy.mock.calls.find(
      ([message]) =>
        typeof message === "string" &&
        message.includes('"event":"dex_discovery.dexscreener_hard_refusal"'),
    )?.[0];
    expect(JSON.parse(String(hardRefusalLog))).toMatchObject({
      scope: "lib",
      level: "warn",
      event: "dex_discovery.dexscreener_hard_refusal",
      job: "sync-dex-discovery",
      provider: "dexscreener",
      status: 429,
    });
  });

  it("records DexScreener discovery success when a hard refusal follows a successful request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchDsTokenPairsWithStatus)
      .mockResolvedValueOnce({ ok: true, pairs: [] })
      .mockResolvedValueOnce({
        ok: false,
        pairs: [],
        status: 429,
        contentType: "text/plain",
        error: "HTTP 429; body starts with: error code: 1015",
        hardRefusal: true,
      });
    const db = createMockDb();
    const runState = createDexScreenerDiscoveryRunState();

    await crawlCoin(
      db,
      "first-test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      runState,
    );
    await crawlCoin(
      db,
      "second-test-coin",
      [{ chain: "bsc", address: "0xdef", decimals: 18 }],
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      runState,
    );
    await finalizeDexScreenerDiscoveryRun(db, runState);

    expect(fetchDsTokenPairsWithStatus).toHaveBeenCalledTimes(2);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.DEXSCREENER_LIQUIDITY, true);
    expect(runState).toMatchObject({
      attemptedRequests: 2,
      successfulRequests: 1,
      hardRefusal: { status: 429 },
      outcomeRecorded: true,
    });
  });

  it("keeps CoinGecko onchain staging output aligned with current discovery rows", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: true,
      schemaDegraded: false,
      pools: [
        {
          id: "cg-pool",
          type: "pool",
          attributes: {
            address: "0xPool",
            name: "USDC / USDT",
            pool_created_at: "2025-01-01T00:00:00.000Z",
            base_token_price_usd: "1.0002",
            quote_token_price_usd: "0.9999",
            reserve_in_usd: "220000",
            volume_usd: { h24: "18000" },
          },
          relationships: {
            base_token: { data: { id: "token_0xabc", type: "token" } },
            quote_token: { data: { id: "token_0xquote", type: "token" } },
            dex: { data: { id: "uniswap-v3", type: "dex" } },
          },
        } as never,
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.unresolvedChains).toEqual([]);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      poolId: "ethereum:0xpool",
      stablecoinId: "usdc-circle",
      source: "cg_onchain",
      chain: "ethereum",
      protocol: "uniswap-v3",
      dexId: "uniswap-v3",
      symbol: "USDC / USDT",
      tvlUsd: 220000,
      volume24h: 18000,
      qualityMultiplier: QUALITY_MULTIPLIERS["generic"],
      poolType: "cg-concentrated",
      feeTier: null,
      balanceRatio: null,
      baseToken: "0xabc",
      quoteToken: "0xquote",
      quoteSymbol: null,
      priceUsd: 1.0002,
      lockedLiqPct: null,
    });
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.CG_ONCHAIN, true);
    expect(crawlTokenPools).not.toHaveBeenCalled();
    expect(fetchDsTokenPairsWithStatus).not.toHaveBeenCalled();
    expect(fetchJsonWithRetry).toHaveBeenCalledWith(
      "https://api.curve.finance/v1/getPools/all/ethereum",
      expect.anything(),
      1,
      { timeoutMs: 8_000, maxResponseBytes: 4 * 1024 * 1024 },
    );
  });

  it("preserves non-EVM CoinGecko pool and token identities from provider ingress", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: true,
      schemaDegraded: false,
      pools: [
        {
          id: "solana_PoolCase",
          type: "pool",
          attributes: {
            address: "PoolCase",
            name: "EUSD / USDC",
            pool_created_at: "2025-01-01T00:00:00.000Z",
            base_token_price_usd: "1",
            quote_token_price_usd: "1",
            reserve_in_usd: "220000",
            volume_usd: { h24: "18000" },
          },
          relationships: {
            base_token: { data: { id: "solana_MintCase", type: "token" } },
            quote_token: { data: { id: "solana_QuoteCase", type: "token" } },
            dex: { data: { id: "raydium", type: "dex" } },
          },
        } as never,
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "eusd-telcoin",
      [{ chain: "solana", address: "MintCase", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(fetchCgTokenPoolsWithStatus).toHaveBeenCalledWith(
      "solana",
      "MintCase",
      expect.any(AbortSignal),
      "test-key",
      expect.any(Object),
    );
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      poolId: "solana:PoolCase",
      baseToken: "MintCase",
      quoteToken: "QuoteCase",
    });
  });

  it("preserves non-EVM DexScreener identities and rejects case-distinct token matches", async () => {
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "PoolCase",
          baseToken: { address: "MintCase", name: "Test USD", symbol: "TUSD" },
          quoteToken: { address: "QuoteCase", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1",
          priceNative: "1",
          volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 75_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        },
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "poolCase",
          baseToken: { address: "mintCase", name: "Different Token", symbol: "OTHER" },
          quoteToken: { address: "QuoteCase", name: "USD Coin", symbol: "USDC" },
          priceUsd: "1",
          priceNative: "1",
          volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 75_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        },
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "test-coin",
      [{ chain: "solana", address: "MintCase", decimals: 6 }],
      null,
      new Set(),
    );

    expect(fetchDsTokenPairsWithStatus).toHaveBeenCalledWith(
      "solana",
      "MintCase",
      expect.any(AbortSignal),
      expect.any(Number),
      0,
    );
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      poolId: "solana:PoolCase",
      baseToken: "MintCase",
      quoteToken: "QuoteCase",
    });
  });

  it("keeps shared CoinGecko onchain pools distinct across stablecoins", async () => {
    const sharedPool = {
      id: "cg-pool",
      type: "pool",
      attributes: {
        address: "0xPool",
        name: "USDC / USDT",
        pool_created_at: "2025-01-01T00:00:00.000Z",
        base_token_price_usd: "1.0002",
        quote_token_price_usd: "0.9999",
        reserve_in_usd: "220000",
        volume_usd: { h24: "18000" },
      },
      relationships: {
        base_token: { data: { id: "token_0xabc", type: "token" } },
        quote_token: { data: { id: "token_0xquote", type: "token" } },
        dex: { data: { id: "uniswap-v3", type: "dex" } },
      },
    } as never;
    vi.mocked(fetchCgTokenPoolsWithStatus)
      .mockResolvedValueOnce({ transportOk: true, schemaDegraded: false, pools: [sharedPool] })
      .mockResolvedValueOnce({ transportOk: true, schemaDegraded: false, pools: [sharedPool] });

    const knownPoolIds = new Set<string>();
    const usdcResult = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      knownPoolIds,
    );
    const usdtResult = await crawlCoin(
      createMockDb(),
      "usdt-tether",
      [{ chain: "ethereum", address: "0xQuote", decimals: 6 }],
      "test-key",
      knownPoolIds,
    );

    expect(usdcResult.pools.map((pool) => pool.poolId)).toEqual(["ethereum:0xpool"]);
    expect(usdtResult.pools.map((pool) => pool.poolId)).toEqual(["ethereum:0xpool"]);
    expect(knownPoolIds).toEqual(
      new Set([knownPoolIdKey("usdc-circle", "ethereum:0xpool"), knownPoolIdKey("usdt-tether", "ethereum:0xpool")]),
    );
  });

  it("rejects CoinGecko onchain pools whose tracked token price is implausible", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: true,
      schemaDegraded: false,
      pools: [
        {
          id: "eth_0xc537e898cd774e2dcba3b14ea6f34c93d5ea45e1-2236",
          type: "pool",
          attributes: {
            address: "0xc537e898cd774e2dcba3b14ea6f34c93d5ea45e1-2236",
            name: "XAUt / sUSDS",
            pool_created_at: "2026-01-27T20:19:51Z",
            base_token_price_usd: "76259889535.2567",
            quote_token_price_usd: "18550521.8243312",
            reserve_in_usd: "2020820673.4245",
            volume_usd: { h24: "1035914339.44693" },
          },
          relationships: {
            base_token: { data: { id: "eth_0x68749665ff8d2d112fa859aa293f07a622782f38", type: "token" } },
            quote_token: { data: { id: "eth_0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", type: "token" } },
            dex: { data: { id: "carbon-defi-ethereum", type: "dex" } },
          },
        } as never,
      ],
    });

    const result = await crawlCoin(
      createMockDb(),
      "xaut-tether",
      [{ chain: "ethereum", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.pools).toEqual([]);
  });

  it("records CoinGecko onchain failures when the helper reports a bad response", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: false,
      schemaDegraded: false,
      pools: [],
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.pools).toEqual([]);
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.CG_ONCHAIN, false);
  });

  it("marks CoinGecko transport failures retryable with a provider-specific class", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: false,
      schemaDegraded: false,
      pools: [],
    });

    const result = await crawlCoinGeckoPoolsStage({
      db: createMockDb(),
      coinTargets: [{ chain: "ethereum", address: "0xabc", decimals: 6 }],
      cgApiKey: "test-key",
      context: createCoinGeckoStageContext(),
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "ethereum",
        address: "0xabc",
        provider: "coingecko",
        status: "failure",
        retryable: true,
        error: "coingecko-transport-failure",
      },
    ]);
  });

  it("keeps timeout and fetch exceptions retryable but malformed payloads non-retryable", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus)
      .mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"))
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockRejectedValueOnce(new SyntaxError("Unexpected token"))
      .mockResolvedValueOnce({
        transportOk: true,
        schemaDegraded: true,
        pools: [],
      });

    const result = await crawlCoinGeckoPoolsStage({
      db: createMockDb(),
      coinTargets: [
        { chain: "ethereum", address: "0xabc", decimals: 6 },
        { chain: "ethereum", address: "0xdef", decimals: 6 },
        { chain: "ethereum", address: "0xghi", decimals: 6 },
        { chain: "ethereum", address: "0xjkl", decimals: 6 },
      ],
      cgApiKey: "test-key",
      context: createCoinGeckoStageContext(),
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "ethereum",
        address: "0xabc",
        provider: "coingecko",
        status: "failure",
        retryable: true,
        error: "coingecko-timeout",
      },
      {
        chain: "ethereum",
        address: "0xdef",
        provider: "coingecko",
        status: "failure",
        retryable: true,
        error: "coingecko-fetch-error",
      },
      {
        chain: "ethereum",
        address: "0xghi",
        provider: "coingecko",
        status: "degraded",
        error: "coingecko-malformed-payload",
      },
      {
        chain: "ethereum",
        address: "0xjkl",
        provider: "coingecko",
        status: "degraded",
        error: "coingecko-malformed-payload",
      },
    ]);
  });

  it("keeps CoinGecko schema-degraded responses out of circuit failure accounting", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: true,
      schemaDegraded: true,
      pools: [],
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.pools).toEqual([]);
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.CG_ONCHAIN, true);
    expect(result.deploymentOutcomes[0]).toMatchObject({
      outcome: "provider_inaccessible",
      reason: "A completed direct-token provider response was schema-degraded",
    });
  });

  it("does not use a CoinGecko price observation as a separate completion signal", async () => {
    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValueOnce({
      transportOk: true,
      schemaDegraded: false,
      pools: [],
    });
    vi.mocked(crawlTokenPools).mockImplementationOnce(async (config) => {
      expect(config.tokens).toEqual([
        {
          sourceChain: "eth",
          ourChain: "ethereum",
          address: "0xabc",
          stablecoinId: "usdc-circle",
        },
      ]);
      return { stoppedEarly: false };
    });

    await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(crawlTokenPools).not.toHaveBeenCalled();
  });

  it("preserves non-EVM token case in GeckoTerminal requests", async () => {
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValueOnce({ ok: true, pairs: [] });
    vi.mocked(crawlTokenPools).mockImplementationOnce(async (config) => {
      expect(config.tokens).toEqual([
        {
          sourceChain: "solana",
          ourChain: "solana",
          address: "MintCase",
          stablecoinId: "eusd-telcoin",
        },
      ]);
      return { stoppedEarly: false };
    });

    await crawlCoin(
      createMockDb(),
      "eusd-telcoin",
      [{ chain: "solana", address: "MintCase", decimals: 6 }],
      null,
      new Set(),
    );

    expect(crawlTokenPools).toHaveBeenCalledTimes(1);
  });

  it("preserves provider order and fallback target policy when earlier stages miss", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: string[] = [];

    vi.mocked(fetchCgTokenPoolsWithStatus).mockImplementation(async (network) => {
      events.push(`cg:${network}`);
      return { transportOk: false, schemaDegraded: false, pools: [] };
    });
    vi.mocked(crawlTokenPools).mockImplementation(async (config) => {
      events.push("gt");
      for (const token of config.tokens) {
        config.onRequestResult?.(token, token.ourChain === "ethereum" ? "failure" : "success");
      }
      return { stoppedEarly: false };
    });
    vi.mocked(fetchDsTokenPairsWithStatus).mockImplementation(async (chain) => {
      events.push(`ds:${chain}`);
      return { ok: true, pairs: [] };
    });
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
      const isCurve = String(url).includes("api.curve.finance");
      events.push(isCurve ? "curve" : "tickers");
      return {
        response: new Response(null, { status: 200 }),
        body: isCurve ? { data: { poolData: [] } } : { tickers: [] },
      };
    });
    censusStageMocks.aquarius.mockImplementation(async () => {
      events.push("aquarius");
      return { providerChecks: [] };
    });
    censusStageMocks.tezos.mockImplementation(async () => {
      events.push("tezos");
      return { providerChecks: [] };
    });
    censusStageMocks.iconBalanced.mockImplementation(async () => {
      events.push("icon-balanced");
      return { providerChecks: [] };
    });
    censusStageMocks.kavaSwap.mockImplementation(async () => {
      events.push("kava-swap");
      return { providerChecks: [] };
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [
        { chain: "ethereum", address: "0xabc", decimals: 6 },
        { chain: "plasma", address: "0xdef", decimals: 6 },
      ],
      "test-key",
      new Set(),
    );

    expect(result).toMatchObject({
      pools: [],
      unresolvedChains: [],
    });
    expect(events).toEqual([
      "cg:eth",
      "gt",
      "ds:ethereum",
      "tickers",
      "curve",
      "aquarius",
      "tezos",
      "icon-balanced",
      "kava-swap",
    ]);
    expect(vi.mocked(fetchDsTokenPairsWithStatus).mock.calls.map(([chain]) => chain)).toEqual(["ethereum"]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Chain "plasma"'));
  });

  it("honors an early stop between the serial census stages", async () => {
    censusStageMocks.tezos.mockResolvedValueOnce({ providerChecks: [], stoppedEarly: true });

    const result = await crawlCoin(createMockDb(), "usdc-circle", [], "test-key", new Set());

    expect(result).toMatchObject({ pools: [], unresolvedChains: [] });
    expect(censusStageMocks.aquarius).toHaveBeenCalledTimes(1);
    expect(censusStageMocks.tezos).toHaveBeenCalledTimes(1);
    expect(censusStageMocks.iconBalanced).not.toHaveBeenCalled();
    expect(censusStageMocks.kavaSwap).not.toHaveBeenCalled();
  });

  it("contains optional Curve timeouts without failing the coin crawl", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValue({
      transportOk: true,
      schemaDegraded: false,
      pools: [],
    });
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
      if (String(url).includes("api.curve.finance")) throw timeout;
      return {
        response: new Response(null, { status: 200 }),
        body: { tickers: [] },
      };
    });

    await expect(
      crawlCoin(
        createMockDb(),
        "usdc-circle",
        [{ chain: "ethereum", address: "0xabc", decimals: 6 }],
        "test-key",
        new Set(),
      ),
    ).resolves.toMatchObject({
      pools: [],
      unresolvedChains: [],
    });
  });

  it("reports chains unsupported by every discovery pool provider", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchCgTokenPoolsWithStatus).mockResolvedValue({
      transportOk: true,
      schemaDegraded: false,
      pools: [],
    });
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      body: { tickers: [] },
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "unsupported-chain", address: "0xabc", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.unresolvedChains).toEqual(["unsupported-chain"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported-chain"),
    );
  });

  it("keeps CoinGecko tickers staging output aligned with current orderbook rows", async () => {
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      body: {
        tickers: [
          {
            base: "USDC",
            target: "USD",
            market: { name: "Kinesis", identifier: "kinesis" },
            converted_last: { usd: 1.001 },
            converted_volume: { usd: 20_000 },
            cost_to_move_down_usd: 40_000,
            cost_to_move_up_usd: 45_000,
            target_coin_id: undefined,
            is_anomaly: false,
            is_stale: false,
            trust_score: null,
          },
          {
            base: "USDC",
            target: "USDT",
            market: { name: "Kinesis", identifier: "kinesis" },
            converted_last: { usd: 0.999 },
            converted_volume: { usd: 10_000 },
            cost_to_move_down_usd: 20_000,
            cost_to_move_up_usd: 25_000,
            target_coin_id: "tether",
            is_anomaly: false,
            is_stale: false,
            trust_score: null,
          },
        ],
      },
    });

    const result = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xabc", decimals: 6 }],
      null,
      new Set(),
    );

    expect(result.pools).toEqual([
      {
        poolId: "orderbook:kinesis:usdc-circle",
        stablecoinId: "usdc-circle",
        source: "cg_tickers",
        chain: "orderbook",
        protocol: "kinesis",
        dexId: "kinesis",
        symbol: "USDC / USD",
        tvlUsd: 60_000,
        volume24h: 30_000,
        qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
        poolType: "orderbook",
        feeTier: null,
        balanceRatio: null,
        isStable: null,
        baseToken: null,
        quoteToken: null,
        quoteSymbol: "USD",
        priceUsd: (1.001 * 20_000 + 0.999 * 10_000) / 30_000,
        lockedLiqPct: null,
        rawJson: JSON.stringify({
          orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
          orderbookDepthUsd: 60_000,
          orderbookDepthUpUsd: 70_000,
        }),
        discoveredAt: expect.any(Number),
        refreshedAt: expect.any(Number),
      },
    ]);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[0]?.[0]).toContain("depth=true");
  });

  it("keeps same-exchange CoinGecko tickers pools distinct across stablecoins", async () => {
    vi.mocked(fetchDsTokenPairsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
    vi.mocked(fetchJsonWithRetry).mockImplementation(async () => ({
      response: new Response(null, { status: 200 }),
      body: {
        tickers: [
          {
            base: "USD",
            target: "USD",
            market: { name: "Kinesis", identifier: "kinesis" },
            converted_last: { usd: 1 },
            converted_volume: { usd: 20_000 },
            cost_to_move_down_usd: 40_000,
            cost_to_move_up_usd: 45_000,
            target_coin_id: undefined,
            is_anomaly: false,
            is_stale: false,
            trust_score: null,
          },
        ],
      },
    }));

    const knownPoolIds = new Set<string>();
    const usdcResult = await crawlCoin(
      createMockDb(),
      "usdc-circle",
      [{ chain: "ethereum", address: "0xabc", decimals: 6 }],
      null,
      knownPoolIds,
    );
    const usdtResult = await crawlCoin(
      createMockDb(),
      "usdt-tether",
      [{ chain: "ethereum", address: "0xdef", decimals: 6 }],
      null,
      knownPoolIds,
    );

    expect(usdcResult.pools.map((pool) => pool.poolId)).toEqual(["orderbook:kinesis:usdc-circle"]);
    expect(usdtResult.pools.map((pool) => pool.poolId)).toEqual(["orderbook:kinesis:usdt-tether"]);
    expect(knownPoolIds).toEqual(
      new Set([
        knownPoolIdKey("usdc-circle", "orderbook:kinesis:usdc-circle"),
        knownPoolIdKey("usdt-tether", "orderbook:kinesis:usdt-tether"),
      ]),
    );
  });
});
