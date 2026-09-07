import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureFetchPrimaryPrices,
  fixtureApplyPoolChallenge,
  fixtureApplyListAggregatorDowngrade,
  installPrimaryPriceRoutes,
  makePoolChallengeInputs,
  makePrimaryPriceResult,
  makePrimaryPriceResults,
  makePriceConsensusResult,
  makePriceValidationStats,
  makePrimaryPricingDb,
  type PriceValidationContext,
  type PriceValidationReferences,
} from "./enrich-prices.test-support";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

const installFetch = installPrimaryPriceRoutes;
import { selectDexPriceChallengerRowsFromPools } from "../dex-liquidity/challenger-publish";
import type { PoolEntry } from "../dex-liquidity/types";

const fixtureMockD1 = makePrimaryPricingDb;

describe("pool challenge — soft-only high confidence downgrade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePoolChallengeDb(
    poolSources: Array<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>,
  ) {
    return fixtureMockD1([
      { match: "circuit", rows: [] },
      { match: "price_sources_json", rows: poolSources },
    ]);
  }

  it("replaces price when ≥2 protocols diverge from soft consensus", async () => {
    // CG = $0.995, DL-list = $0.994 → agree within 50bps → high confidence
    // Two protocols (curve and balancer) show diverging prices → replace with TVL-weighted mean
    const assets = [makePeggedAsset({
      id: "dusd-dtrinity",
      name: "dUSD",
      symbol: "dUSD",
      geckoId: "dtrinity-usd",
    })];

    installFetch({ coingecko: { body: { "dtrinity-usd": { usd: 0.995 } } } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([
      {
        stablecoin_id: "dusd-dtrinity",
        price_sources_json: JSON.stringify([
          { protocol: "uniswap-v3", chain: "ethereum", price: 1.0, tvl: 1_480_000 },
          { protocol: "curve", chain: "ethereum", price: 0.8, tvl: 849_000 },
          { protocol: "balancer", chain: "ethereum", price: 0.82, tvl: 967_000 },
        ]),
        updated_at: nowSec - 60,
      },
    ]);

    const dlListPrices = new Map([
      ["dusd-dtrinity", { price: 0.994, observedAt: null, observedAtMode: "unknown" as const }],
    ]);
    const { results, stats } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("dusd-dtrinity")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
    expect(stats.high).toBe(0);

    // ≥2 protocols (curve + balancer) diverge → price replaced with the
    // protocol-aware weighted median of corroborating divergent groups.
    expect(result.source).toBe("pool-tvl-weighted");
    expect(result.price).toBeCloseTo(0.82, 6);
  });

  it("downgrades but preserves price when only single protocol diverges", async () => {
    // CG = $0.995, DL-list = $0.994 → agree within 50bps → high confidence
    // Only one protocol (curve) diverges → downgrade confidence but keep consensus price
    const assets = [makePeggedAsset({
      id: "dusd-dtrinity",
      name: "dUSD",
      symbol: "dUSD",
      geckoId: "dtrinity-usd",
    })];

    installFetch({ coingecko: { body: { "dtrinity-usd": { usd: 0.995 } } } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([
      {
        stablecoin_id: "dusd-dtrinity",
        price_sources_json: JSON.stringify([
          { protocol: "uniswap-v3", chain: "ethereum", price: 1.0, tvl: 1_480_000 },
          { protocol: "curve", chain: "ethereum", price: 0.8, tvl: 849_000 },
        ]),
        updated_at: nowSec - 60,
      },
    ]);

    const dlListPrices = new Map([
      ["dusd-dtrinity", { price: 0.994, observedAt: null, observedAtMode: "unknown" as const }],
    ]);
    const { results } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("dusd-dtrinity")!;
    expect(result.confidence).toBe("low");
    // Single protocol diverges → price preserved (not replaced)
    expect(result.source).not.toBe("pool-tvl-weighted");
  });

  it("does NOT downgrade via pool challenge when pool divergence is <500bps", async () => {
    const assets = [makePeggedAsset({
      id: "dusd-dtrinity",
      name: "dUSD",
      symbol: "dUSD",
      geckoId: "dtrinity-usd",
    })];

    installFetch({ coingecko: { body: { "dtrinity-usd": { usd: 0.995 } } } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([
      {
        stablecoin_id: "dusd-dtrinity",
        price_sources_json: JSON.stringify([
          { protocol: "curve", chain: "ethereum", price: 0.97, tvl: 500_000 }, // ~2.5% divergence = 254bps, below 500
        ]),
        updated_at: nowSec - 60,
      },
    ]);

    const dlListPrices = new Map([
      ["dusd-dtrinity", { price: 0.994, observedAt: null, observedAtMode: "unknown" as const }],
    ]);
    const { results } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    // Pool challenge doesn't fire (<500bps), but CG+DL-only downgrade applies
    expect(results.get("dusd-dtrinity")!.confidence).toBe("single-source");
    expect(results.get("dusd-dtrinity")!.source).not.toBe("pool-tvl-weighted");
  });
});

describe("applyPoolChallenge", () => {
  it("replaces a bad soft price when a dominant and minority DEX protocol agree", () => {
    const makePool = (poolId: string, project: string, tvlUsd: number, price: number): PoolEntry => ({
      poolId,
      project,
      chain: "MegaETH",
      tvlUsd,
      symbol: "USDm-pair",
      volumeUsd1d: 10_000,
      volumeUsd7d: 70_000,
      poolType: "generic",
      source: "gecko_terminal",
      price,
    });
    const selectedRows = selectDexPriceChallengerRowsFromPools(
      "usdm-mega",
      [
        makePool("megaeth:kumbaya-btc", "kumbaya", 2_737_890, 0.99911),
        makePool("megaeth:kumbaya-mega", "kumbaya", 665_442, 1.00165),
        makePool("megaeth:kumbaya-stcusd", "kumbaya", 431_793, 1.00091),
        makePool("megaeth:kumbaya-usdt0", "kumbaya", 194_442, 1.0013),
        makePool("megaeth:prism-usdt0", "prism-megaeth", 173_064, 1.0013),
      ],
      100_000,
    );
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "usdm-mega",
      result: {
          price: 0.94012,
          source: "coingecko",
          selectedSource: "coingecko",
          priceEstimator: "selected_source",
          confidence: "low",
          dlPrice: null,
          cgPrice: 0.94012,
          candidateSources: ["coingecko", "dex-promoted"],
          agreeSources: ["coingecko"],
          disagreeSources: ["dex-promoted"],
          allPrices: { coingecko: 0.94012, "dex-promoted": 0.99911 },
      },
      pools: selectedRows.map((row) => ({
        price: row.priceUsd,
        tvlUsd: row.tvlUsd,
        protocol: row.protocol,
        chain: row.chain,
      })),
      stats: { high: 0, low: 1 },
    });

    const downgrades = fixtureApplyPoolChallenge(
      results,
      pools,
      pegTypes,
      stats,
    );

    expect(downgrades).toBe(1);
    expect(results.get("usdm-mega")).toMatchObject({
      source: "pool-tvl-weighted",
      price: 0.99911,
      confidence: "low",
    });
  });

  it("fires for non-USD peg at 300 bps divergence (single protocol: downgrade only, no price replace)", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "jpyc-jpyc",
      pegType: "peggedJPY",
      result: makePriceConsensusResult({
        price: 0.00682,
        source: "coingecko+defillama-list+dex-promoted",
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }),
      pools: [{ price: 0.00704, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("jpyc-jpyc")!.confidence).toBe("low");
    // Single protocol → confidence downgraded but price preserved
    expect(results.get("jpyc-jpyc")!.price).toBe(0.00682);
    expect(results.get("jpyc-jpyc")!.source).not.toBe("pool-tvl-weighted");
  });

  it("does NOT fire for USD peg at 300 bps divergence", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "usdt-tether",
      result: makePriceConsensusResult({
        source: "coingecko+defillama-list+dex-promoted",
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }),
      pools: [{ price: 0.97, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0);
    expect(results.get("usdt-tether")!.confidence).toBe("high");
  });

  it("downgrades but does NOT replace price when only one protocol diverges (500+ bps)", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [{ price: 0.8, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    // Single protocol → price preserved, only confidence downgraded
    expect(results.get("dusd-test")!.price).toBe(1.0);
    expect(results.get("dusd-test")!.source).not.toBe("pool-tvl-weighted");
  });

  it("replaces price when ≥2 independent protocols diverge", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [
        { price: 0.8, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" },
        { price: 0.82, tvlUsd: 300_000, protocol: "uniswap", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
    // Protocol-aware weighted median across corroborating divergent protocols.
    expect(results.get("dusd-test")!.price).toBeCloseTo(0.8, 6);
  });

  it("does NOT replace price when multiple pools from SAME protocol diverge", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "xusd-test",
      result: makePriceConsensusResult(),
      pools: [
        { price: 0.8, tvlUsd: 12_000_000, protocol: "balancer", chain: "ethereum" },
        { price: 0.82, tvlUsd: 12_000_000, protocol: "balancer", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("xusd-test")!.confidence).toBe("low");
    // Same protocol (balancer) → price preserved despite massive TVL
    expect(results.get("xusd-test")!.price).toBe(1.0);
    expect(results.get("xusd-test")!.source).not.toBe("pool-tvl-weighted");
  });

  it("replaces recovered soft consensus when a high-TVL DEX protocol agrees with a hard depeg candidate", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "apxusd-apyx",
      result: {
          price: 0.995975,
          source: "coingecko+defillama-list+uniswap-v4-dex",
          selectedSource: "coingecko",
          priceEstimator: "cluster_median",
          confidence: "high",
          dlPrice: 0.9959,
          cgPrice: 0.9958,
          candidateSources: ["coingecko", "defillama-list", "curve-onchain", "curve-dex", "uniswap-v4-dex"],
          agreeSources: ["coingecko", "defillama-list", "uniswap-v4-dex"],
          disagreeSources: ["curve-onchain", "curve-dex"],
          allPrices: {
            coingecko: 0.9958,
            "defillama-list": 0.9959,
            "curve-onchain": 0.9577061374623745,
            "curve-dex": 0.9577061374623745,
            "uniswap-v4-dex": 1.0002443828,
          },
      },
      pools: [
          {
            price: 0.9577061374623745,
            tvlUsd: 50_206_292,
            protocol: "curve",
            chain: "ethereum",
            observedAt: 1_780_641_624,
          },
          {
            price: 1.0002443828,
            tvlUsd: 1_936_131,
            protocol: "uniswap-v4",
            chain: "ethereum",
            observedAt: 1_780_641_624,
          },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("apxusd-apyx")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("pool-tvl-weighted");
    expect(result.price).toBeCloseTo(0.9577061374623745, 9);
    expect(result.agreeSources).toEqual(["pool-tvl-weighted"]);
    expect(result.observedAt).toBe(1_780_641_624);
  });

  it("replaces depeg-sized soft consensus when a high-TVL DEX protocol agrees with a hard depeg candidate", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "apxusd-apyx",
      result: {
          price: 0.9207390119709549,
          source: "alchemy-address+coingecko+curve-dex",
          selectedSource: "coingecko",
          priceEstimator: "cluster_median",
          confidence: "low",
          dlPrice: 0.9029027110580571,
          cgPrice: 0.920669,
          candidateSources: [
            "coingecko",
            "defillama-list",
            "curve-onchain",
            "alchemy-address",
            "curve-dex",
            "uniswap-v4-dex",
          ],
          agreeSources: ["coingecko", "alchemy-address", "curve-dex"],
          disagreeSources: ["defillama-list", "curve-onchain", "uniswap-v4-dex"],
          allPrices: {
            coingecko: 0.920669,
            "defillama-list": 0.9029027110580571,
            "curve-onchain": 0.9096446090435735,
            "alchemy-address": 0.9207390119709549,
            "curve-dex": 0.9207390119709549,
            "uniswap-v4-dex": 1.0001161257,
          },
      },
      pools: [
          {
            price: 0.9096446090435735,
            tvlUsd: 17_862_827,
            protocol: "curve",
            chain: "ethereum",
            observedAt: 1_780_760_659,
          },
          {
            price: 1.0001161257,
            tvlUsd: 1_328_507,
            protocol: "uniswap-v4",
            chain: "ethereum",
            observedAt: 1_780_760_659,
          },
      ],
      stats: { high: 0, low: 1 },
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("apxusd-apyx")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("pool-tvl-weighted");
    expect(result.price).toBeCloseTo(0.9096446090435735, 9);
    expect(result.allPrices).toEqual({ "pool-tvl-weighted": result.price });
    expect(result.observedAt).toBe(1_780_760_659);
  });

  it("replaces recovered soft consensus when multiple high-TVL DEX protocols directionally corroborate a depeg", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "apxusd-apyx",
      result: makePriceConsensusResult({
        price: 0.9996,
        selectedSource: "coingecko",
        priceEstimator: "cluster_median",
        dlPrice: 0.9995,
        cgPrice: 0.9996,
        candidateSources: ["coingecko", "defillama-list", "curve-dex", "uniswap-v4-dex"],
        disagreeSources: ["curve-dex", "uniswap-v4-dex"],
        allPrices: {
          coingecko: 0.9996,
          "defillama-list": 0.9995,
          "curve-dex": 0.9344,
          "uniswap-v4-dex": 0.9551,
        },
      }),
      pools: [
          { price: 0.9344, tvlUsd: 13_500_000, protocol: "curve", chain: "ethereum", observedAt: 1_780_700_000 },
          { price: 0.9551, tvlUsd: 7_500_000, protocol: "uniswap-v4", chain: "ethereum", observedAt: 1_780_700_020 },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("apxusd-apyx")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("pool-tvl-weighted");
    expect(result.price).toBeCloseTo(0.9344, 6);
    expect(result.allPrices).toEqual({ "pool-tvl-weighted": result.price });
    expect(result.observedAt).toBe(1_780_700_000);
  });

  it("ignores incoherent high-TVL outliers when coherent DEX protocols directionally corroborate a depeg", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult({
        selectedSource: "coingecko",
        priceEstimator: "cluster_median",
        candidateSources: ["coingecko", "defillama-list", "curve-dex", "uniswap-v4-dex", "balancer-dex"],
        disagreeSources: ["curve-dex", "uniswap-v4-dex", "balancer-dex"],
        allPrices: {
          coingecko: 1.0,
          "defillama-list": 1.0,
          "curve-dex": 0.985,
          "uniswap-v4-dex": 0.986,
          "balancer-dex": 0.93,
        },
      }),
      pools: [
          { price: 0.985, tvlUsd: 6_000_000, protocol: "curve", chain: "ethereum", observedAt: 1_780_700_000 },
          { price: 0.986, tvlUsd: 6_000_000, protocol: "uniswap-v4", chain: "ethereum", observedAt: 1_780_700_020 },
          { price: 0.93, tvlUsd: 6_000_000, protocol: "balancer", chain: "ethereum", observedAt: 1_780_700_040 },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("dusd-test")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("pool-tvl-weighted");
    expect(result.price).toBeCloseTo(0.985, 6);
    expect(result.allPrices).toEqual({ "pool-tvl-weighted": result.price });
    expect(result.observedAt).toBe(1_780_700_000);
  });

  it("does not replace with high-TVL DEX protocols that disagree directionally or incoherently", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [
          { price: 0.8, tvlUsd: 7_000_000, protocol: "curve", chain: "ethereum" },
          { price: 0.955, tvlUsd: 7_000_000, protocol: "uniswap-v4", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("dusd-test")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.price).toBe(1.0);
    expect(result.source).not.toBe("pool-tvl-weighted");
  });

  it("treats promoted DEX sources as pool-challenge eligible when no exempt hard source agrees", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult({
        source: "balancer-dex+coingecko",
        candidateSources: ["coingecko", "balancer-dex"],
        agreeSources: ["coingecko", "balancer-dex"],
      }),
      pools: [
          { price: 0.8, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" },
          { price: 0.82, tvlUsd: 300_000, protocol: "uniswap", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
  });

  it("uses protocol-level medians before cross-protocol replacement", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [
          { price: 0.79, tvlUsd: 200_000, protocol: "curve", chain: "ethereum" },
          { price: 0.81, tvlUsd: 600_000, protocol: "curve", chain: "ethereum" },
          { price: 0.84, tvlUsd: 300_000, protocol: "uniswap", chain: "ethereum" },
      ],
    });

    fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
    expect(results.get("dusd-test")!.price).toBeCloseTo(0.81, 6);
  });

  it("ignores inverse commodity protocol medians before pool challenge replacement", () => {
    const assetId = "xaum-matrixdock";
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId,
      pegType: "peggedGOLD",
      result: makePrimaryPriceResult({
        price: 4_170,
        source: "coingecko",
        confidence: "single-source",
        dlPrice: null,
        cgPrice: 4_170,
        candidateSources: ["coingecko"],
        agreeSources: ["coingecko"],
      }),
      pools: [
          { price: 1 / 4_229, tvlUsd: 800_000, protocol: "curve", chain: "ethereum" },
          { price: 1 / 4_180, tvlUsd: 600_000, protocol: "balancer", chain: "ethereum" },
          { price: 4_229, tvlUsd: 399_000, protocol: "uniswap-v3", chain: "ethereum" },
      ],
      stats: { high: 0, singleSource: 1, cgOnly: 1 },
    });
    const references: PriceValidationReferences = {
      rates: { peggedGOLD: 4_220 },
      type: "fresh",
      updatedAt: Math.floor(Date.now() / 1000),
    };
    const validationContext: PriceValidationContext = {
      stablecoinId: assetId,
      pegCurrency: "GOLD",
      pegType: "peggedGOLD",
      pegClass: "commodity",
      navToken: false,
      commodityOunces: 1,
      tracked: true,
    };
    const downgrades = fixtureApplyPoolChallenge(
      results,
      pools,
      pegTypes,
      stats,
      references,
      undefined,
      new Map([[assetId, validationContext]]),
    );

    expect(downgrades).toBe(0);
    expect(results.get(assetId)!.price).toBe(4_170);
    expect(results.get(assetId)!.source).toBe("coingecko");
    expect(results.get(assetId)!.confidence).toBe("single-source");
    expect(stats.singleSource).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("preserves corroborated severe downside even when multiple DEX protocols diverge upward", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "usr-resolv",
      result: makePriceConsensusResult({
        price: 0.1525,
        confidence: "single-source",
        dlPrice: 0.1524,
        cgPrice: 0.1525,
        candidateSources: ["coingecko", "defillama-list", "pyth", "dex-promoted"],
        allPrices: {
          coingecko: 0.1525,
          "defillama-list": 0.1524,
          pyth: 0.151,
          "dex-promoted": 1.0007,
        },
      }),
      pools: [
          { price: 1.0007, tvlUsd: 1_460_000, protocol: "pancakeswap", chain: "bsc" },
          { price: 0.9942, tvlUsd: 46_000, protocol: "uniswap-v2", chain: "bsc" },
          { price: 0.3017, tvlUsd: 790_000, protocol: "uniswap-v4", chain: "ethereum" },
      ],
      stats: { high: 0, singleSource: 1 },
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);
    const result = results.get("usr-resolv")!;

    expect(downgrades).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.price).toBe(0.1525);
    expect(result.source).toBe("coingecko+defillama-list");
    expect(result.source).not.toBe("pool-tvl-weighted");
    expect(stats.singleSource).toBe(0);
    expect(stats.low).toBe(1);
  });

  it("does NOT count a protocol as diverging when its protocol-level median still agrees", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "usr-test",
      result: makePriceConsensusResult({ price: 0.125 }),
      pools: [
          { price: 0.9993, tvlUsd: 1_451_774, protocol: "bunni", chain: "ethereum" },
          { price: 0.1273, tvlUsd: 373_555, protocol: "uniswap", chain: "ethereum" },
          { price: 0.1293, tvlUsd: 296_968, protocol: "uniswap", chain: "ethereum" },
          { price: 0.4233, tvlUsd: 142_247, protocol: "uniswap", chain: "ethereum" },
          { price: 0.1294, tvlUsd: 72_578, protocol: "curve", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("usr-test")!.confidence).toBe("low");
    expect(results.get("usr-test")!.price).toBe(0.125);
    expect(results.get("usr-test")!.source).not.toBe("pool-tvl-weighted");
  });

  it("skips results with hard sources in agreeSources", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "usdt-tether",
      result: makePriceConsensusResult({
        source: "coingecko+binance",
        candidateSources: ["coingecko", "binance"],
        agreeSources: ["coingecko", "binance"],
      }),
      pools: [{ price: 0.8, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0); // binance is a hard source
  });

  it("updates allPrices to reflect pool-tvl-weighted replacement source", () => {
    const assetId = "usr-resolv";
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId,
      // Near peg — will be replaced by depegged pools.
      result: makePriceConsensusResult({
        selectedSource: "coingecko",
        priceEstimator: "selected_source",
        disagreeSources: [],
        allPrices: { coingecko: 1.0, "defillama-list": 1.0 },
        observedAt: 1_000,
        observedAtMode: "upstream",
        observedAtBySource: { coingecko: 1_000, "defillama-list": 1_000 },
        observedAtModeBySource: { coingecko: "upstream", "defillama-list": "upstream" },
      }),
      pools: [
          { price: 0.8, tvlUsd: 2_000_000, protocol: "curve", chain: "ethereum", observedAt: 900 },
          { price: 0.8, tvlUsd: 1_500_000, protocol: "uniswap", chain: "ethereum", observedAt: 950 },
      ],
    });

    fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    const updated = results.get(assetId);
    expect(updated).toBeDefined();
    expect(updated!.price).toBeCloseTo(0.8, 5);
    expect(updated!.source).toBe("pool-tvl-weighted");
    expect(updated!.allPrices).toEqual({ "pool-tvl-weighted": updated!.price });
    expect(updated!.observedAtBySource).toEqual({ "pool-tvl-weighted": 900 });
    expect(updated!.observedAtModeBySource).toEqual({ "pool-tvl-weighted": "local_fetch" });
  });

  it("does NOT downgrade NAV tokens even when pool prices diverge", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "ousg-ondo-finance",
      result: makePriceConsensusResult({ price: 110.15, dlPrice: 110.15, cgPrice: 110.15 }),
      pools: [{ price: 100.0, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }],
    });
    const navTokenAssetIds = new Set(["ousg-ondo-finance"]);

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats, undefined, navTokenAssetIds);

    expect(downgrades).toBe(0);
    expect(results.get("ousg-ondo-finance")!.confidence).toBe("high");
    expect(results.get("ousg-ondo-finance")!.price).toBe(110.15);
  });

  // --- Boundary tests: verify the peggedUSD 500 bps / non-USD peg-aware threshold is inclusive. ---
  // Boundary check in applyPoolChallenge is `bps >= poolChallengeBps`, so a protocol median that
  // produces a bps value at or above the threshold fires; strictly below does not.

  it("fires at exactly the USD threshold (500 bps) — inclusive boundary", () => {
    // price 0.9512 vs consensus 1.0 → bps = 0.0488 / 0.9756 * 10_000 ≈ 500.205 bps (≥500 → triggers).
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [{ price: 0.9512, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    // Single protocol at boundary → confidence downgraded, price preserved.
    expect(results.get("dusd-test")!.price).toBe(1.0);
    expect(results.get("dusd-test")!.source).not.toBe("pool-tvl-weighted");
  });

  it("does NOT fire just below the USD threshold (~499 bps)", () => {
    // price 0.9513 vs consensus 1.0 → bps ≈ 499.15 bps (<500 → no downgrade).
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [{ price: 0.9513, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0);
    expect(results.get("dusd-test")!.confidence).toBe("high");
    expect(results.get("dusd-test")!.price).toBe(1.0);
  });

  it("fires at the non-USD peg-aware threshold (peggedJPY, 300 bps)", () => {
    // peggedJPY → min(2 * 150, 500) = 300 bps. consensus 0.00682 vs pool 0.006618 → ≈300.64 bps.
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "jpyc-jpyc",
      pegType: "peggedJPY",
      result: makePriceConsensusResult({
        price: 0.00682,
        source: "coingecko+defillama-list+dex-promoted",
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }),
      pools: [{ price: 0.006618, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("jpyc-jpyc")!.confidence).toBe("low");
    // Single protocol → price preserved.
    expect(results.get("jpyc-jpyc")!.price).toBe(0.00682);
    expect(results.get("jpyc-jpyc")!.source).not.toBe("pool-tvl-weighted");
  });

  it("replaces price when exactly 2 independent protocols hit the boundary", () => {
    // Two protocols each at ~500 bps → divergingProtocolGroups.length >= 2 → TVL-weighted median.
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult(),
      pools: [
          { price: 0.9512, tvlUsd: 600_000, protocol: "curve", chain: "ethereum" },
          { price: 0.95, tvlUsd: 400_000, protocol: "uniswap", chain: "ethereum" },
      ],
    });

    const downgrades = fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
    // Weighted median across {0.9512 @ 600k, 0.95 @ 400k} → higher-weight point sorted first.
    expect(results.get("dusd-test")!.price).toBeCloseTo(0.9512, 6);
  });

  it("propagates result.observedAt = min(poolObservedAts) after replacement", () => {
    const { results, pools, pegTypes, stats } = makePoolChallengeInputs({
      assetId: "dusd-test",
      result: makePriceConsensusResult({ observedAt: 5_000, observedAtMode: "upstream" }),
      pools: [
          { price: 0.8, tvlUsd: 500_000, protocol: "curve", chain: "ethereum", observedAt: 1_200 },
          { price: 0.82, tvlUsd: 300_000, protocol: "uniswap", chain: "ethereum", observedAt: 800 },
      ],
    });

    fixtureApplyPoolChallenge(results, pools, pegTypes, stats);

    const updated = results.get("dusd-test")!;
    expect(updated.source).toBe("pool-tvl-weighted");
    // Top-level observedAt = min across diverging protocol groups' observedAts.
    expect(updated.observedAt).toBe(800);
    expect(updated.observedAtMode).toBe("local_fetch");
    expect(updated.observedAtBySource).toEqual({ "pool-tvl-weighted": 800 });
    expect(updated.observedAtModeBySource).toEqual({ "pool-tvl-weighted": "local_fetch" });
  });
});

describe("applyListAggregatorDowngrade", () => {
  it("downgrades 2-source list-aggregator clusters (coingecko + defillama-list)", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "coingecko+defillama-list",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["coingecko", "defillama-list"],
      agreeSources: ["coingecko", "defillama-list"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("single-source");
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
  });

  it("downgrades 2-source list-aggregator clusters even when detail endpoint is the second voice", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "coingecko+defillama",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["coingecko", "defillama"],
      agreeSources: ["coingecko", "defillama"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("single-source");
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
  });

  it("downgrades CMC-style list aggregators when paired only with another list aggregator", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "coingecko+coinmarketcap",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["coingecko", "coinmarketcap"],
      agreeSources: ["coingecko", "coinmarketcap"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("single-source");
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
  });

  it("normalizes composite agree source labels before applying list-aggregator downgrade", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "coingecko+defillama-list",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["coingecko", "defillama-list"],
      agreeSources: ["coingecko+defillama-list"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("single-source");
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
  });

  it("does NOT downgrade when cluster includes a non-list-aggregator source (binance)", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "binance+coingecko",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["binance", "coingecko"],
      agreeSources: ["binance", "coingecko"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("high");
    expect(stats.high).toBe(1);
  });

  it("does NOT downgrade 3-source list-aggregator clusters", () => {
    const results = makePrimaryPriceResults("usdt-tether", {
      source: "coingecko+defillama+defillama-list",
      dlPrice: 1.0,
      cgPrice: 1.0,
      candidateSources: ["coingecko", "defillama", "defillama-list"],
      agreeSources: ["coingecko", "defillama", "defillama-list"],
    });
    const stats = makePriceValidationStats();
    fixtureApplyListAggregatorDowngrade(results, stats);
    expect(results.get("usdt-tether")!.confidence).toBe("high");
  });
});
