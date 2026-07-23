import { beforeEach, describe, expect, it, vi } from "vitest";

const activeStablecoins = vi.hoisted(() => [
  {
    id: "usdc-circle",
    symbol: "USDC",
    geckoId: "usd-coin",
    flags: { governance: "centralized", pegCurrency: "USD", navToken: false },
    contracts: [{ chain: "solana", address: "MintCase", decimals: 6 }],
  },
  {
    id: "usdt-tether",
    symbol: "USDT",
    geckoId: "tether",
    flags: { governance: "centralized", pegCurrency: "USD", navToken: false },
  },
]);

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_STABLECOINS: activeStablecoins,
  TRACKED_META_BY_ID: new Map(activeStablecoins.map((stablecoin) => [stablecoin.id, stablecoin])),
}));

vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

vi.mock("../../../lib/cron-logger", () => ({
  logCronEvent: vi.fn(async () => {}),
}));

vi.mock("../../../lib/dexscreener", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/dexscreener")>("../../../lib/dexscreener");
  return {
    ...actual,
    fetchDsTokenPoolsWithStatus: vi.fn(),
    dsRateLimit: vi.fn(async () => {}),
  };
});

vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

vi.mock("../../../lib/abort", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/abort")>("../../../lib/abort");
  return {
    ...actual,
    sleepWithSignal: vi.fn(async () => {}),
  };
});

import { ORDERBOOK_TVL_FACTOR } from "../constants";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "../coingecko-tickers-shared";
import {
  fetchCgTickersFallback,
  fetchDsFallbackPools,
  getCgTickersFallbackTargets,
  getDsFallbackTargets,
  getFallbackTargets,
} from "../fetch-fallbacks";
import { buildPoolIdentity, createKnownPoolIdentityIndex, registerKnownPoolIdentity } from "../pool-identity";
import type { CgTicker, DexPriceObs, LiquidityMetrics } from "../types";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { fetchDsTokenPoolsWithStatus } from "../../../lib/dexscreener";
import { recordOutcome } from "../../../lib/circuit-breaker";

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

function makeTicker(overrides: Partial<CgTicker> = {}): CgTicker {
  return {
    base: "USDC",
    target: "USD",
    market: { name: "Example Exchange", identifier: "example" },
    converted_last: { usd: 1.0 },
    converted_volume: { usd: 10_000 },
    bid_ask_spread_percentage: 0.1,
    is_anomaly: false,
    is_stale: false,
    trust_score: null,
    ...overrides,
  };
}

function makeMetric(overrides: Partial<LiquidityMetrics> = {}): LiquidityMetrics {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    totalTvlUsd: 1_000_000,
    totalVolume24hUsd: 100_000,
    totalVolume7dUsd: 700_000,
    poolCount: 5,
    chains: new Set(["ethereum"]),
    pairs: new Set(["USDC/USDT"]),
    protocolTvl: { curve: 1_000_000 },
    chainTvl: { ethereum: 1_000_000 },
    qualityAdjustedTvl: 850_000,
    topPools: [],
    effectiveTvl: 850_000,
    organicTvlWeightedSum: 0,
    totalTvlForOrganic: 0,
    balanceRatioWeightedSum: 0,
    totalTvlForBalance: 0,
    stressWeightedSum: 0,
    oldestPoolDays: 30,
    lockedLiqWeightedSum: 0,
    totalTvlForLocked: 0,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<DexPriceObs> = {}): DexPriceObs {
  return {
    price: 1,
    tvl: 1_000_000,
    chain: "ethereum",
    protocol: "curve",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchJsonWithRetry).mockReset();
  vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
  vi.mocked(recordOutcome).mockReset();
  vi.mocked(recordOutcome).mockResolvedValue({} as Awaited<ReturnType<typeof recordOutcome>>);
});

describe("DexScreener fallback identity", () => {
  it("preserves non-EVM identity case and rejects case-distinct tracked tokens", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "PoolCase",
          baseToken: { address: "MintCase", name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "QuoteCase", name: "Tether", symbol: "USDT" },
          priceUsd: "1",
          priceNative: "1",
          volume: { h24: 20_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        },
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "poolCase",
          baseToken: { address: "mintCase", name: "Different Token", symbol: "OTHER" },
          quoteToken: { address: "QuoteCase", name: "Tether", symbol: "USDT" },
          priceUsd: "1",
          priceNative: "1",
          volume: { h24: 20_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        },
      ],
    });

    const result = await fetchDsFallbackPools(createMockDb(), new Map(), new Map(), createKnownPoolIdentityIndex());

    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledWith("solana", "MintCase", undefined);
    expect(result.newPools.get("usdc-circle")).toEqual([
      expect.objectContaining({
        address: "PoolCase",
        chain: "solana",
      }),
    ]);
  });

  it("compacts repeated exact pools without changing derived-identity cardinality", async () => {
    const pair = {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "11111111111111111111111111111111",
      baseToken: { address: "MintCase", name: "USD Coin", symbol: "USDC" },
      quoteToken: { address: "QuoteCase", name: "Tether", symbol: "USDT" },
      priceUsd: "1",
      priceNative: "1",
      volume: { h24: 20_000, h6: 0, h1: 0, m5: 0 },
      liquidity: { usd: 100_000, base: 0, quote: 0 },
      pairCreatedAt: null,
    };
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({ ok: true, pairs: [pair, pair] });
    const known = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain: "solana",
        protocol: "raydium",
        tokenAddresses: ["MintCase", "QuoteCase"],
        poolType: "generic",
      }),
    );

    const result = await fetchDsFallbackPools(createMockDb(), new Map(), new Map(), known);

    expect(result.newPools.get("usdc-circle")).toHaveLength(1);
    expect(result.priceObs.get("usdc-circle")).toHaveLength(1);
  });

  it("finalizes useful partial pools when the crawl deadline expires", async () => {
    const contracts = activeStablecoins[0]!.contracts!;
    contracts.push({ chain: "solana", address: "SecondMint", decimals: 6 });
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(fetchDsTokenPoolsWithStatus).mockImplementationOnce(async () => {
      now = 200;
      return {
        ok: true,
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: "11111111111111111111111111111111",
            baseToken: { address: "MintCase", name: "USD Coin", symbol: "USDC" },
            quoteToken: { address: "QuoteCase", name: "Tether", symbol: "USDT" },
            priceUsd: "1",
            priceNative: "1",
            volume: { h24: 20_000, h6: 0, h1: 0, m5: 0 },
            liquidity: { usd: 100_000, base: 0, quote: 0 },
            pairCreatedAt: null,
          },
        ],
      };
    });

    try {
      const result = await fetchDsFallbackPools(
        createMockDb(),
        new Map(),
        new Map(),
        createKnownPoolIdentityIndex(),
        undefined,
        100,
      );

      expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledTimes(1);
      expect(result.newPools.get("usdc-circle")).toHaveLength(1);
    } finally {
      contracts.pop();
      nowSpy.mockRestore();
    }
  });

  it("keeps finalized pools when circuit-breaker telemetry fails", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValueOnce({
      ok: true,
      pairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "11111111111111111111111111111111",
          baseToken: { address: "MintCase", name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "QuoteCase", name: "Tether", symbol: "USDT" },
          priceUsd: "1",
          priceNative: "1",
          volume: { h24: 20_000, h6: 0, h1: 0, m5: 0 },
          liquidity: { usd: 100_000, base: 0, quote: 0 },
          pairCreatedAt: null,
        },
      ],
    });
    vi.mocked(recordOutcome).mockRejectedValueOnce(new Error("D1 unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await fetchDsFallbackPools(createMockDb(), new Map(), new Map(), createKnownPoolIdentityIndex());

      expect(result.newPools.get("usdc-circle")).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"fallback_circuit_telemetry_failed"'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("DexScreener fallback targeting", () => {
  it("does not crawl a coin when only measured-balance coverage is weak", () => {
    const metrics = new Map([["usdc-circle", makeMetric({ totalTvlForBalance: 0 })]]);
    const observations = new Map([["usdc-circle", [makeObservation(), makeObservation({ protocol: "uniswap-v3" })]]]);

    expect(getFallbackTargets(metrics, observations, { requireTrackedContracts: true }).map((meta) => meta.id)).toEqual(
      ["usdc-circle"],
    );
    expect(getDsFallbackTargets(metrics, observations)).toEqual([]);
  });
});

describe("CoinGecko tickers shared helpers", () => {
  it("filters out stale, anomalous, non-USD, and low-volume tickers", () => {
    const filtered = filterValidCgTickers([
      makeTicker(),
      makeTicker({ is_stale: true, market: { name: "Stale", identifier: "stale" } }),
      makeTicker({ is_anomaly: true, market: { name: "Anomaly", identifier: "anomaly" } }),
      makeTicker({ market: { name: "No Trust", identifier: "no-trust" } }),
      makeTicker({ target: "EUR", target_coin_id: undefined, market: { name: "EUR", identifier: "eur" } }),
      makeTicker({ target: "USDT", target_coin_id: "tether", market: { name: "USDT", identifier: "usdt" } }),
      makeTicker({ converted_volume: { usd: 999 }, market: { name: "Tiny", identifier: "tiny" } }),
      makeTicker({ converted_last: { usd: 0 }, market: { name: "Zero Price", identifier: "zero-price" } }),
      makeTicker({ market: { name: "Missing Id", identifier: "" } }),
    ]);

    expect(filtered.map((ticker) => ticker.market.identifier)).toEqual(["example", "no-trust", "usdt"]);
  });

  it("aggregates valid tickers by exchange and computes weighted prices", () => {
    const aggregates = aggregateCgTickersByExchange([
      makeTicker({
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 1.0 },
        converted_volume: { usd: 20_000 },
      }),
      makeTicker({
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 0.99 },
        converted_volume: { usd: 10_000 },
      }),
      makeTicker({
        market: { name: "Kraken", identifier: "kraken" },
        converted_last: { usd: 1.01 },
        converted_volume: { usd: 5_000 },
      }),
    ]);

    expect(aggregates.get("kinesis")).toEqual({
      name: "Kinesis",
      volumeUsd: 30_000,
      priceVolumeWeightedSum: 29_900,
      depthDownUsd: 0,
      depthDownCount: 0,
      depthUpUsd: 0,
      depthUpCount: 0,
    });
    expect(aggregates.get("kraken")).toEqual({
      name: "Kraken",
      volumeUsd: 5_000,
      priceVolumeWeightedSum: 5_050,
      depthDownUsd: 0,
      depthDownCount: 0,
      depthUpUsd: 0,
      depthUpCount: 0,
    });
  });

  it("builds synthetic orderbook TVL and price observations with plausibility gating", () => {
    const summaries = buildCgTickerExchangeSummaries(
      new Map([
        [
          "kinesis",
          {
            name: "Kinesis",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 0,
            depthDownCount: 0,
            depthUpUsd: 0,
            depthUpCount: 0,
          },
        ],
        [
          "tiny",
          {
            name: "Tiny Exchange",
            volumeUsd: 10_000,
            priceVolumeWeightedSum: 12_000,
            depthDownUsd: 0,
            depthDownCount: 0,
            depthUpUsd: 0,
            depthUpCount: 0,
          },
        ],
      ]),
    );

    expect(summaries).toEqual([
      {
        exchangeId: "kinesis",
        exchangeName: "Kinesis",
        volumeUsd: 20_000,
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: null,
        depthUpUsd: null,
        tvlBasis: "volume-derived",
        priceUsd: 1,
      },
      {
        exchangeId: "tiny",
        exchangeName: "Tiny Exchange",
        volumeUsd: 10_000,
        volumeDerivedTvlUsd: 10_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 10_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: null,
        depthUpUsd: null,
        tvlBasis: "volume-derived",
        priceUsd: 1.2,
      },
    ]);

    const priceObs = buildCgTickerPriceObservations("usdc-circle", summaries);

    expect(priceObs).toEqual([
      {
        price: 1,
        tvl: 20_000 * ORDERBOOK_TVL_FACTOR,
        chain: "orderbook",
        protocol: "cg-ticker-kinesis",
      },
    ]);
  });

  it("uses measured 2% downside orderbook depth when available, capped by volume-derived TVL", () => {
    const summaries = buildCgTickerExchangeSummaries(
      new Map([
        [
          "deep",
          {
            name: "Deep Exchange",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 500_000,
            depthDownCount: 1,
            depthUpUsd: 450_000,
            depthUpCount: 1,
          },
        ],
        [
          "shallow",
          {
            name: "Shallow Exchange",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 12_000,
            depthDownCount: 1,
            depthUpUsd: 18_000,
            depthUpCount: 1,
          },
        ],
      ]),
    );

    expect(summaries).toEqual([
      expect.objectContaining({
        exchangeId: "deep",
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: 500_000,
        depthUpUsd: 450_000,
        tvlBasis: "coingecko-depth-2pct-capped-by-volume",
      }),
      expect.objectContaining({
        exchangeId: "shallow",
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 12_000,
        depthDownUsd: 12_000,
        depthUpUsd: 18_000,
        tvlBasis: "coingecko-depth-2pct-capped-by-volume",
      }),
    ]);
  });
});

describe("fetchCgTickersFallback", () => {
  it("targets absent or tiny DEX coverage but skips already-covered DEX assets", () => {
    const metrics = new Map<string, LiquidityMetrics>([
      [
        "usdc-circle",
        makeMetric({
          stablecoinId: "usdc-circle",
          totalTvlUsd: 100_000_000,
          poolCount: 80,
          totalTvlForBalance: 10_000_000,
        }),
      ],
      [
        "usdt-tether",
        makeMetric({
          stablecoinId: "usdt-tether",
          totalTvlUsd: 50_000,
          poolCount: 1,
        }),
      ],
    ]);
    const priceObservations = new Map<string, DexPriceObs[]>([
      ["usdc-circle", [makeObservation()]],
      ["usdt-tether", [makeObservation({ tvl: 50_000 })]],
    ]);

    expect(getCgTickersFallbackTargets(metrics, priceObservations).map((meta) => meta.id)).toEqual(["usdt-tether"]);
  });

  it("keeps orderbook fallback for assets with no pool or no price observation", () => {
    const metrics = new Map<string, LiquidityMetrics>([
      ["usdc-circle", makeMetric({ stablecoinId: "usdc-circle", poolCount: 0, totalTvlUsd: 0 })],
      ["usdt-tether", makeMetric({ stablecoinId: "usdt-tether", poolCount: 5, totalTvlUsd: 1_000_000 })],
    ]);

    expect(getCgTickersFallbackTargets(metrics, new Map()).map((meta) => meta.id)).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it("emits distinct synthetic orderbook pool ids for different stablecoins on the same exchange", async () => {
    vi.mocked(fetchJsonWithRetry).mockImplementation(async () => ({
      response: new Response("", { status: 200 }),
      body: {
        tickers: [
          makeTicker({
            market: { name: "Kinesis", identifier: "kinesis" },
            converted_last: { usd: 1 },
            converted_volume: { usd: 20_000 },
            cost_to_move_down_usd: 40_000,
            cost_to_move_up_usd: 45_000,
          }),
        ],
      },
    }));

    const result = await fetchCgTickersFallback(createMockDb(), new Map(), new Map(), createKnownPoolIdentityIndex());

    const poolIdsFor = (stablecoinId: string) =>
      result.newPools.get(stablecoinId)?.map((pool) => `${pool.chain}:${pool.address}`);

    expect(poolIdsFor("usdc-circle")).toEqual(["orderbook:kinesis:usdc-circle"]);
    expect(poolIdsFor("usdt-tether")).toEqual(["orderbook:kinesis:usdt-tether"]);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(2);
  });
});
