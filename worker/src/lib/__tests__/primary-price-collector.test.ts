import { describe, it, expect } from "vitest";
import { buildPrimarySourceCandidates, type PrimaryCollectedQuotes } from "../pricing/primary-price-collector";

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

const protocol = (protocol: string, price: number, tvl: number, updatedAt = 1_700_000_000, chain = "ethereum") => ({
  protocol, price, tvl, updatedAt, chain,
});
const aggregate = (price: number, pools: number, tvl: number, aggregateObservedAt: number | null = 1_700_000_000) => ({
  dex_price_usd: price, source_pool_count: pools, source_total_tvl: tvl, updated_at: 1_700_000_000, aggregateObservedAt,
});

describe("buildPrimarySourceCandidates", () => {
  it("admits only fresh typed native HBD quotes and does not create a DEX confidence profile", () => {
    const nowSec = 1_800_000_000;
    const collected = makeCollected({ hiveNativeQuote: { price: 0.98662, observedAt: nowSec - 4, observedAtMode: "local_fetch" } });
    const result = buildPrimarySourceCandidates({ id: "hbd-hive", symbol: "HBD" }, collected, { nowSec });
    expect(result.sources).toMatchObject([{ source: "hive-native-cg", price: 0.98662, weight: 2, observedAt: nowSec - 4, observedAtMode: "local_fetch" }]);
    expect(result.priceSourceConfidenceProfile).toBeNull();
    expect(buildPrimarySourceCandidates({ id: "other", symbol: "HBD" }, collected, { nowSec }).sources).toEqual([]);
    expect(buildPrimarySourceCandidates({ id: "hbd-hive", symbol: "HBD" }, collected, { nowSec: nowSec + 901 }).sources).toEqual([]);
    expect(buildPrimarySourceCandidates({ id: "hbd-hive", symbol: "HBD" }, makeCollected(), { nowSec }).sources).toEqual([]);
  });
  it("withholds the aggregate DEX promotion when the only protocol candidate lacks hard corroboration", () => {
    const collected = makeCollected({
      cgPrice: 1.0,
      cgObservedAt: 1_700_000_000,
      protocolSources: [
        protocol("balancer", 1.0, 500_000),
      ],
      dexAggregateQuote: aggregate(1.0, 3, 500_000),
    });

    const { sources, hasPromotedDexProtocolSource, dexCandidateTelemetry, priceSourceConfidenceProfile } =
      buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, { nowSec: 1_700_000_030 });

    // P1-13 (PRICE-05) admits DEX lanes per candidate; it does not re-admit the aggregate once every lane
    // is rejected. CoinGecko alone is a soft aggregator and cannot corroborate the lone Balancer lane.
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

  it("rejects a lone promoted DEX protocol when no validated source can corroborate it", () => {
    const collected = makeCollected({
      protocolSources: [
        protocol("balancer", 1.0, 500_000),
      ],
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } =
      buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, { nowSec: 1_700_000_030 });

    expect(sources).toEqual([]);
    expect(dexCandidateTelemetry).toMatchObject([
      {
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
        protocol("balancer", 1.0, 500_000),
      ],
      dexAggregateQuote: aggregate(1.0, 4, 900_000),
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

  it("promotes an Aero protocol lane as aero-dex when a hard CEX source agrees", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [{ protocol: "aero", price: 1.0, tvl: 500_000, updatedAt: 1_700_000_000, chain: "base" }],
    });
    const { sources, dexCandidateTelemetry } =
      buildPrimarySourceCandidates({ id: "dusd-test", symbol: "DUSD" }, collected, { nowSec: 1_700_000_030 });
    expect(sources.map((s) => s.source)).toEqual(["binance", "aero-dex"]);
    expect(dexCandidateTelemetry).toMatchObject([{ sourceKey: "aero-dex", status: "accepted" }]);
  });

  it("admits mapped Uniswap DEX protocol lanes and withholds the aggregate", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        protocol("uniswap-v4", 1.0001, 55_000_000),
      ],
      dexAggregateQuote: aggregate(1.0001, 6, 55_000_000),
    });

    const { sources, dexCandidateTelemetry, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "susde-ethena", symbol: "sUSDe" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources.map((source) => source.source)).toEqual(["binance", "uniswap-v4-dex"]);
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
        protocol("balancer", 1.0001, 500_000),
        protocol("uniswap-v3", 1.0002, 1_500_000, 1_700_000_000, "base"),
      ],
      dexAggregateQuote: aggregate(1.00015, 7, 2_000_000),
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

  it("admits only the promoted DEX lane corroborated by a hard source", () => {
    const collected = makeCollected({
      binancePrice: 1,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        protocol("curve", 1.0001, 2_000_000),
        protocol("balancer", 0.9, 2_000_000),
        protocol("uniswap-v3", 1.1, 2_000_000, 1_700_000_000, "base"),
      ],
    });

    const { sources, dexCandidateTelemetry } = buildPrimarySourceCandidates(
      { id: "usdc-circle", symbol: "USDC" },
      collected,
      { nowSec: 1_700_000_030 },
    );

    expect(sources.map((source) => source.source)).toEqual(["binance", "curve-dex"]);
    expect(dexCandidateTelemetry).toMatchObject([
      { sourceKey: "curve-dex", status: "accepted" },
      { sourceKey: "balancer-dex", status: "excluded", reason: "lacked_corroboration" },
      { sourceKey: "uniswap-v3-dex", status: "excluded", reason: "lacked_corroboration" },
    ]);
  });

  it("records explicit exclusion reasons for unmapped and below-threshold DEX protocol candidates", () => {
    const collected = makeCollected({
      protocolSources: [
        protocol("unknown-protocol", 1.0, 500_000),
        protocol("balancer", 1.0, 49_999),
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
        protocol("balancer", Number.NaN, 500_000),
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
      dexAggregateQuote: aggregate(1.0, 3, 250_000),
    });

    const { sources, priceSourceConfidenceProfile } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
      { nowSec: 1_700_000_100 },
    );

    expect(sources.map((source) => source.source)).toEqual(["dex-promoted"]);
    expect(sources[0]?.observedAt).toBe(1_700_000_000);
    expect(priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 0,
      freshestDexLaneAgeSec: 100,
      aggregateLaneOnly: true,
    });
  });

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_700_000_001, 1_700_000_000 - 21_600])(
    "cannot renew aggregate clock %s through fresh publication", (aggregateObservedAt) => {
      const quote = { ...aggregate(1, 3, 2_000_000), aggregateObservedAt };
      expect(buildPrimarySourceCandidates({ id: "test", symbol: "TEST" }, makeCollected({ dexAggregateQuote: quote }), {
        nowSec: 1_700_000_000,
      }).sources).toEqual([]);
    },
  );

  it("preserves Binance overlap suppression even without an accepted protocol DEX lane", () => {
    const collected = makeCollected({
      binancePrice: 0.9995,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        protocol("binance", 0.9995, 8_000_000, 1_700_000_000, "cex"),
      ],
      dexAggregateQuote: aggregate(0.9995, 2, 8_000_000),
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

  it("rejects stale per-protocol DEX lanes even when other live sources exist", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        protocol("balancer", 1.0, 500_000, 1_699_995_400),
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

  describe("co-leg budget for protocol lanes", () => {
    // pmUSD at the 2026-11-02 06:45 UTC run: Curve on-chain (300 s window) and
    // CoinGecko (900 s) put the co-leg budget at 300 - 180 = 120 s.
    const nowSec = 1_793_601_977;
    const pmusd = { id: "pmusd-precious-metals", symbol: "pmUSD" };
    const curveLane = (ageSec: number) => ({
      protocol: "curve", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - ageSec, chain: "ethereum",
    });
    const freshLegs = (cgPrice: number | null) => ({
      cgPrice,
      cgObservedAt: cgPrice == null ? null : nowSec - 20,
      cgObservedAtMode: cgPrice == null ? null : "upstream" as const,
      curvePrice: 0.53416,
      curveObservedAt: nowSec - 30,
    });

    it("keeps a lane past the strictest co-leg window out and records its budget and age", () => {
      // A 34-minute-old curve-dex lane, inside its own 35-minute source budget.
      const { sources, hasPromotedDexProtocolSource, coLegHeldDexSources, dexCandidateTelemetry, priceSourceConfidenceProfile } =
        buildPrimarySourceCandidates(pmusd, makeCollected({ ...freshLegs(0.534161), protocolSources: [curveLane(2_071)] }), {
          nowSec,
          freshLegsAgree: () => true,
        });

      expect(sources.map((source) => source.source)).toEqual(["coingecko", "curve-onchain"]);
      expect(hasPromotedDexProtocolSource).toBe(true);
      expect(coLegHeldDexSources).toEqual(["curve-dex"]);
      expect(dexCandidateTelemetry).toMatchObject([
        { sourceKey: "curve-dex", status: "excluded", reason: "outside_co_leg_budget", coLegBudgetSec: 120, ageSec: 2_071 },
      ]);
      expect(priceSourceConfidenceProfile).toBeNull();
    });

    it("admits a lane exactly at the co-leg budget and holds one a second past it", () => {
      const build = (ageSec: number) =>
        buildPrimarySourceCandidates(pmusd, makeCollected({ ...freshLegs(0.534161), protocolSources: [curveLane(ageSec)] }), {
          nowSec,
          freshLegsAgree: () => true,
        });

      expect(build(120).sources.map((source) => source.source)).toEqual(["coingecko", "curve-onchain", "curve-dex"]);
      expect(build(121).sources.map((source) => source.source)).toEqual(["coingecko", "curve-onchain"]);
      expect(build(121).dexCandidateTelemetry).toMatchObject([{ reason: "outside_co_leg_budget", coLegBudgetSec: 120, ageSec: 121 }]);
    });

    it("lets a lane inside the primary budget rejoin when the fresh legs cannot agree", () => {
      // CoinGecko missing: Curve on-chain alone cannot form a cluster.
      const build = (ageSec: number) =>
        buildPrimarySourceCandidates(pmusd, makeCollected({ ...freshLegs(null), protocolSources: [curveLane(ageSec)] }), {
          nowSec,
          freshLegsAgree: () => false,
        });

      const admitted = build(1_800);
      expect(admitted.sources.map((source) => source.source)).toEqual(["curve-onchain", "curve-dex"]);
      expect(admitted.sources.find((source) => source.source === "curve-dex")?.observedAt).toBe(nowSec - 1_800);
      expect(admitted.coLegHeldDexSources).toEqual([]);
      expect(admitted.dexCandidateTelemetry).toMatchObject([{ sourceKey: "curve-dex", status: "accepted" }]);

      const tooOld = build(1_801);
      expect(tooOld.sources.map((source) => source.source)).toEqual(["curve-onchain"]);
      expect(tooOld.dexCandidateTelemetry).toMatchObject([{ reason: "outside_co_leg_budget", ageSec: 1_801 }]);
    });

    it("never lets an older lane rejoin without a consensus authority or a hard leg to agree with", () => {
      const withoutAuthority = buildPrimarySourceCandidates(
        pmusd,
        makeCollected({ ...freshLegs(null), protocolSources: [curveLane(1_500)] }),
        { nowSec },
      );
      expect(withoutAuthority.sources.map((source) => source.source)).toEqual(["curve-onchain"]);

      // CoinGecko is soft: a lone soft leg gives the older lane nothing hard to agree with.
      const softOnly = buildPrimarySourceCandidates(
        pmusd,
        makeCollected({ cgPrice: 0.53416, cgObservedAt: nowSec - 20, cgObservedAtMode: "upstream", protocolSources: [curveLane(1_500)] }),
        { nowSec, freshLegsAgree: () => false },
      );
      expect(softOnly.sources.map((source) => source.source)).toEqual(["coingecko"]);
    });

    it("does not let a lane outside the budget corroborate one inside it", () => {
      // CoinGecko alone (soft, 900 s window): budget 720 s, and no hard leg.
      const { sources, dexCandidateTelemetry } = buildPrimarySourceCandidates(
        { id: "dusd-test", symbol: "DUSD" },
        makeCollected({
          cgPrice: 1.0,
          cgObservedAt: 1_700_000_000,
          cgObservedAtMode: "upstream",
          protocolSources: [
            { protocol: "balancer", price: 1.0001, tvl: 500_000, updatedAt: 1_700_000_000 - 60, chain: "ethereum" },
            { protocol: "uniswap-v3", price: 1.0002, tvl: 500_000, updatedAt: 1_700_000_000 - 1_000, chain: "base" },
          ],
        }),
        { nowSec: 1_700_000_000, freshLegsAgree: () => false },
      );

      expect(sources.map((source) => source.source)).toEqual(["coingecko"]);
      expect(dexCandidateTelemetry).toMatchObject([
        { sourceKey: "balancer-dex", status: "excluded", reason: "lacked_corroboration" },
        { sourceKey: "uniswap-v3-dex", status: "excluded", reason: "outside_co_leg_budget", coLegBudgetSec: 720, ageSec: 1_000 },
      ]);
    });
  });

  it("keeps protocol lanes that are the only legs on their own freshness window", () => {
    const nowSec = 1_700_000_000;
    const collected = makeCollected({
      protocolSources: [
        { protocol: "balancer", price: 1.0001, tvl: 500_000, updatedAt: nowSec - 2_000, chain: "ethereum" },
        { protocol: "uniswap-v3", price: 1.0002, tvl: 1_500_000, updatedAt: nowSec - 2_000, chain: "base" },
      ],
    });

    const { sources } = buildPrimarySourceCandidates({ id: "usdc-circle", symbol: "USDC" }, collected, { nowSec });

    expect(sources.map((source) => source.source)).toEqual(["balancer-dex", "uniswap-v3-dex"]);
  });

  it("records missing and invalid DEX observation timestamps as explicit exclusions", () => {
    const candidate = (updatedAt: number | null) => (protocol("balancer", 1.0, 500_000, updatedAt as number));
    const nowSec = 1_700_000_030;

    const missing = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      makeCollected({ protocolSources: [candidate(null)] }),
      { nowSec },
    );
    expect(missing.sources).toEqual([]);
    expect(missing.dexCandidateTelemetry).toMatchObject([
      { sourceKey: "balancer-dex", status: "excluded", reason: "missing_observed_at" },
    ]);

    const invalid = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      makeCollected({ protocolSources: [candidate(-1)] }),
      { nowSec },
    );
    expect(invalid.sources).toEqual([]);
    expect(invalid.dexCandidateTelemetry).toMatchObject([
      { sourceKey: "balancer-dex", status: "excluded", reason: "invalid_observed_at" },
    ]);
  });

  it("rejects future-skewed CEX, aggregator, and DEX observations", () => {
    const collected = makeCollected({
      cgPrice: 1.0,
      cgObservedAt: 1_700_001_000,
      cgObservedAtMode: "upstream",
      coinbasePrice: 1.0,
      coinbaseObservedAt: 1_700_001_000,
      protocolSources: [
        protocol("balancer", 1.0, 500_000, 1_700_001_000),
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
