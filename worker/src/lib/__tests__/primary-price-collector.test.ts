import { describe, it, expect } from "vitest";
import { buildPrimarySourceCandidates, type PrimaryCollectedQuotes } from "../primary-price-collector";

function makeCollected(overrides: Partial<PrimaryCollectedQuotes> = {}): PrimaryCollectedQuotes {
  return {
    cgPrice: null,
    cgObservedAt: null,
    cgObservedAtMode: null,
    cgTickerPrice: null,
    cgTickerObservedAt: null,
    binancePrice: null,
    binanceObservedAt: null,
    krakenPrice: null,
    krakenObservedAt: null,
    bitstampPrice: null,
    bitstampObservedAt: null,
    coinbasePrice: null,
    coinbaseObservedAt: null,
    curvePrice: null,
    curveObservedAt: null,
    curveOraclePrice: null,
    curveOracleObservedAt: null,
    ...overrides,
  };
}

describe("buildPrimarySourceCandidates", () => {
  it("withholds aggregate DEX promotion when a single protocol candidate lacks hard corroboration", () => {
    const collected = makeCollected({
      cgPrice: 1.0,
      cgObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
      dexAggregateQuote: {
        dex_price_usd: 1.0,
        updated_at: 1_700_000_000,
        source_pool_count: 3,
        source_total_tvl: 500_000,
      },
    });

    const { sources, hasPromotedDexProtocolSource, dexCandidateTelemetry, priceSourceConfidenceProfile } =
      buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, { nowSec: 1_700_000_030 });

    expect(hasPromotedDexProtocolSource).toBe(true);
    expect(sources.some((s) => s.source.endsWith("-dex"))).toBe(false);
    expect(sources.map((s) => s.source)).toEqual(["coingecko"]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        stablecoinId: "dusd-test",
        sourceKey: "balancer-dex",
        status: "excluded",
        reason: "lacked_corroboration",
      },
    ]);
    expect(priceSourceConfidenceProfile).toBeNull();
  });

  it("accepts a single promoted DEX protocol when a hard CEX source agrees and withholds the aggregate", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
      dexAggregateQuote: {
        dex_price_usd: 1.0,
        updated_at: 1_700_000_000,
        source_pool_count: 4,
        source_total_tvl: 900_000,
      },
    });

    const { sources, hasPromotedDexProtocolSource, dexCandidateTelemetry, priceSourceConfidenceProfile } =
      buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, { nowSec: 1_700_000_030 });

    expect(hasPromotedDexProtocolSource).toBe(true);
    expect(sources.map((s) => s.source)).toEqual(["binance", "balancer-dex"]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        stablecoinId: "dusd-test",
        sourceKey: "balancer-dex",
        status: "accepted",
      },
    ]);
    expect(priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 1,
      freshestDexLaneAgeSec: 30,
      aggregateLaneOnly: false,
    });
  });

  it("admits mapped Uniswap DEX protocol lanes and withholds the aggregate", () => {
    const collected = makeCollected({
      pythQuote: {
        price: 1.0,
        confidenceBps: 5,
        publishTime: 1_700_000_000,
      },
      protocolSources: [
        {
          protocol: "uniswap-v4",
          price: 1.0001,
          tvl: 55_000_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
      dexAggregateQuote: {
        dex_price_usd: 1.0001,
        updated_at: 1_700_000_000,
        source_pool_count: 6,
        source_total_tvl: 55_000_000,
      },
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "susde-ethena", symbol: "sUSDe" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources.map((source) => source.source)).toEqual(["pyth", "uniswap-v4-dex"]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "uniswap-v4-dex",
        status: "accepted",
      },
    ]);
    expect(priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 1,
      freshestDexLaneAgeSec: 30,
      aggregateLaneOnly: false,
    });
  });

  it("accepts multiple promoted DEX protocols and withholds the aggregate", () => {
    const collected = makeCollected({
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0001,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
        {
          protocol: "uniswap-v3",
          price: 1.0002,
          tvl: 1_500_000,
          updatedAt: 1_700_000_000,
          chain: "base",
        },
      ],
      dexAggregateQuote: {
        dex_price_usd: 1.00015,
        updated_at: 1_700_000_000,
        source_pool_count: 7,
        source_total_tvl: 2_000_000,
      },
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "usdc-circle", symbol: "USDC" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources.map((source) => source.source)).toEqual(["balancer-dex", "uniswap-v3-dex"]);
    expect(dexCandidateTelemetry).toMatchObject([
      { sourceKey: "balancer-dex", status: "accepted" },
      { sourceKey: "uniswap-v3-dex", status: "accepted" },
    ]);
    expect(priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 2,
      freshestDexLaneAgeSec: 30,
      aggregateLaneOnly: false,
    });
  });

  it("accepts Curve as a promoted DEX protocol when a hard source agrees", () => {
    const collected = makeCollected({
      pythQuote: {
        price: 1.096,
        confidenceBps: 8,
        publishTime: 1_700_000_000,
      },
      protocolSources: [
        {
          protocol: "curve",
          price: 1.0959,
          tvl: 60_000_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, dexCandidateTelemetry } = buildPrimarySourceCandidates(
      { id: "susds-sky", symbol: "sUSDS" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources.some((s) => s.source === "curve-dex")).toBe(true);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "curve-dex",
        status: "accepted",
      },
    ]);
  });

  it("records explicit exclusion reasons for unmapped and below-threshold DEX protocol candidates", () => {
    const collected = makeCollected({
      protocolSources: [
        {
          protocol: "unknown-protocol",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 49_999,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources).toEqual([]);
    expect(priceSourceConfidenceProfile).toBeNull();
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "unknown-protocol-dex",
        status: "excluded",
        reason: "missing_registry_mapping",
      },
      {
        sourceKey: "balancer-dex",
        status: "excluded",
        reason: "below_tvl_threshold",
        thresholdTvlUsd: 50_000,
      },
    ]);
  });

  it("records invalid-price telemetry for mapped fresh DEX protocol candidates", () => {
    const collected = makeCollected({
      protocolSources: [
        {
          protocol: "balancer",
          price: Number.NaN,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources).toEqual([]);
    expect(priceSourceConfidenceProfile).toBeNull();
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "balancer-dex",
        price: null,
        status: "excluded",
        reason: "invalid_price",
      },
    ]);
  });

  it("profiles aggregate-only DEX promotion without counting it as an active protocol lane", () => {
    const collected = makeCollected({
      dexAggregateQuote: {
        dex_price_usd: 1.0,
        updated_at: 1_700_000_000,
        source_pool_count: 3,
        source_total_tvl: 250_000,
      },
    });

    const { sources, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_100 },
    );

    expect(sources.map((source) => source.source)).toEqual(["dex-promoted"]);
    expect(priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 0,
      freshestDexLaneAgeSec: 100,
      aggregateLaneOnly: true,
    });
  });

  it("preserves Binance overlap suppression even without an accepted protocol DEX lane", () => {
    const collected = makeCollected({
      binancePrice: 0.9995,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "binance",
          price: 0.9995,
          tvl: 8_000_000,
          updatedAt: 1_700_000_000,
          chain: "cex",
        },
      ],
      dexAggregateQuote: {
        dex_price_usd: 0.9995,
        updated_at: 1_700_000_000,
        source_pool_count: 2,
        source_total_tvl: 8_000_000,
      },
    });

    const { sources, hasPromotedDexProtocolSource, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "bfusd-binance", symbol: "BFUSD" },
      collected,
      {
        nowSec: 1_700_000_100,
      },
    );

    expect(sources.map((source) => source.source)).toEqual(["binance"]);
    expect(hasPromotedDexProtocolSource).toBe(false);
    expect(priceSourceConfidenceProfile).toBeNull();
  });

  it("admits fresh reserve NAV telemetry as a hard protocol source", () => {
    const collected = makeCollected({
      navQuote: {
        source: "chainlink-nav",
        price: 1.1248,
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
      },
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usyc-hashnote", symbol: "USYC" }, collected, {
      nowSec: 1_700_000_100,
    });

    expect(sources).toMatchObject([
      {
        source: "chainlink-nav",
        price: 1.1248,
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
        weight: 3,
      },
    ]);
  });

  it('stamps Bitstamp source with observedAtMode="upstream" when upstream observed-at is supplied', () => {
    const collected = makeCollected({
      bitstampPrice: 0.9999,
      bitstampObservedAt: 1_776_439_395,
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usdt-test", symbol: "USDT" }, collected, {
      nowSec: 1_776_439_400,
    });

    const bitstamp = sources.find((s) => s.source === "bitstamp");
    expect(bitstamp).toBeDefined();
    expect(bitstamp?.observedAt).toBe(1_776_439_395);
    expect(bitstamp?.observedAtMode).toBe("upstream");
  });

  it('stamps Coinbase source with observedAtMode="upstream" when upstream observed-at is supplied', () => {
    const collected = makeCollected({
      coinbasePrice: 0.9998,
      coinbaseObservedAt: 1_776_439_504,
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usdt-test", symbol: "USDT" }, collected, {
      nowSec: 1_776_439_510,
    });

    const coinbase = sources.find((s) => s.source === "coinbase");
    expect(coinbase).toBeDefined();
    expect(coinbase?.observedAt).toBe(1_776_439_504);
    expect(coinbase?.observedAtMode).toBe("upstream");
  });

  it("rejects DefiLlama list prices without observed-at metadata", () => {
    const collected = makeCollected({
      dlListQuote: {
        price: 1.0001,
        observedAt: null,
        observedAtMode: "unknown",
      },
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usdt-test", symbol: "USDT" }, collected, {
      nowSec: 1_776_439_510,
    });

    expect(sources.some((source) => source.source === "defillama-list")).toBe(false);
  });

  it("rejects stale Bitstamp and Coinbase upstream observations before hard-market admission", () => {
    const collected = makeCollected({
      bitstampPrice: 0.9999,
      bitstampObservedAt: 1_776_438_000,
      coinbasePrice: 0.9998,
      coinbaseObservedAt: 1_776_438_050,
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usdt-test", symbol: "USDT" }, collected, {
      nowSec: 1_776_439_000,
    });

    expect(sources.some((source) => source.source === "bitstamp")).toBe(false);
    expect(sources.some((source) => source.source === "coinbase")).toBe(false);
  });

  it("admits exact-address provider quotes as soft non-authoritative candidate sources", () => {
    const collected = makeCollected({
      addressProviderQuotes: [
        {
          stablecoinId: "dusd-test",
          source: "dexpaprika-address",
          chain: "base",
          address: "0x123",
          priceUsd: 1.0001,
          observedAt: 1_700_000_000,
          observedAtMode: "upstream",
          liquidityUsd: 125_000,
          poolCount: 2,
        },
        {
          stablecoinId: "dusd-test",
          source: "moralis-address",
          chain: "base",
          address: "0x123",
          priceUsd: 1.0002,
          observedAt: 1_700_000_020,
          observedAtMode: "local_fetch",
          liquidityUsd: 130_000,
        },
      ],
    });

    const { sources } = buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, {
      nowSec: 1_700_000_030,
    });

    expect(sources.map((source) => source.source)).toEqual(["dexpaprika-address", "moralis-address"]);
    expect(sources[0]).toMatchObject({
      source: "dexpaprika-address",
      price: 1.0001,
      observedAtMode: "upstream",
      weight: 1,
      metadata: {
        chain: "base",
        address: "0x123",
        liquidityUsd: 125_000,
        poolCount: 2,
      },
    });
  });

  it("rejects stale per-protocol DEX lanes even when other live sources exist", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_699_995_400,
          chain: "ethereum",
        },
      ],
    });

    const { sources, dexCandidateTelemetry } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_000 },
    );

    expect(sources.map((source) => source.source)).toEqual(["binance"]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "balancer-dex",
        status: "excluded",
        reason: "stale_source_age",
      },
    ]);
  });

  it("rejects future-skewed oracle, CEX, aggregator, and DEX observations", () => {
    const collected = makeCollected({
      cgPrice: 1.0,
      cgObservedAt: 1_700_001_000,
      cgObservedAtMode: "upstream",
      pythQuote: {
        price: 1.0,
        confidenceBps: 5,
        publishTime: 1_700_001_000,
      },
      coinbasePrice: 1.0,
      coinbaseObservedAt: 1_700_001_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_001_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, dexCandidateTelemetry } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_000 },
    );

    expect(sources).toEqual([]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
        sourceKey: "balancer-dex",
        status: "excluded",
        reason: "future_source_timestamp",
      },
    ]);
  });
});
