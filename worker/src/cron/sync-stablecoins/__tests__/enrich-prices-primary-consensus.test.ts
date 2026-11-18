import { describe, expect, it } from "vitest";
import { readPublicPriceRows, seedPublishedDexGeneration } from "../../dex-liquidity/__tests__/scoring-test-support";
import { makePricePoolMap } from "../../dex-liquidity/__tests__/scoring-test-builders";
import { computeDexPrices } from "../../dex-liquidity/dex-price-publisher";
import { aggregateProtocolSources, collapseDuplicateObservations } from "../../dex-liquidity/scoring-helpers";
import type { DexPriceObs } from "../../dex-liquidity/types";
import { forDexPriceCandidateCollection } from "../../dex-liquidity/price-sanity";
import { extractPriceObservations } from "../../../lib/dex-api-pool-shaping";
import type { DexApiPool } from "../../../lib/dex-api-types";
import { loadDexPrices } from "../../../lib/depeg-helpers";
import { buildPriceValidationContext } from "../../../lib/price-validation";
import { validatePrimaryPriceCandidate } from "../../../lib/price-publish-policy";
import type { PrimaryPriceWithFiatPremiumEvidence } from "../pricing";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import { applyListAggregatorDowngrade } from "../enrich-prices-primary-hardening";
import { validateCompositePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { classifyPrimaryDepegTrust, getDexAggregateObservedAt } from "../../../lib/depeg-trust-policy";
import { decodeCurrentReserveNavPrice } from "../../../lib/reserve-nav-price";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  createEmptyPrimaryConsensusQuoteMaps,
  type PrimaryDexPriceSources,
  type PrimaryDexRows,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset, PriceValidationStats, PrimaryPriceResult } from "../enrich-prices-shared";

function createStats(): PriceValidationStats {
  return {
    attempted: 0,
    high: 0,
    singleSource: 0,
    cgOnly: 0,
    low: 0,
  };
}

describe("buildPrimaryConsensusResults", () => {
  it.each(["independent", "shared pool", "shared conversion", "shared conversion pool"] as const)(
    "requires disjoint dated DEX evidence for a BRZ premium (%s)", async (mode) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const id = "brz-transfero";
      const price = 0.246;
      const at = nowSec - 75;
      const refs = { rates: { peggedREAL: 0.2 }, type: "fresh" as const, updatedAt: at };
      const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
      const assets = new Map([
        [`ethereum:${address(1)}`, id], [`ethereum:${address(2)}`, "usdc-circle"],
        [`ethereum:${address(3)}`, "usdt-tether"],
      ]);
      const pools: DexApiPool[] = (["fluid", "balancer"] as const).map((source, index) => ({
        source, poolAddress: address(mode === "shared pool" ? 4 : 4 + index), chain: "ethereum", poolType: "stable",
        tokens: [{ address: address(1), symbol: "BRZ", decimals: 18 },
          { address: address(2 + index), symbol: index ? "USDT" : "USDC", decimals: 6 }],
        price, ratioObservedAtSec: nowSec - 30, tvlUsd: 2_000_000, volume24hUsd: 50_000, feeRate: null, balances: null,
      }));
      const conversionPool = mode === "shared conversion pool" ? [`ethereum:${address(8)}`] : [];
      const prices = Object.assign(new Map([["usdc-circle", 1], ["usdt-tether", 1]]), {
        marketMarks: new Map([
          ["usdc-circle", { priceUsd: 1, observedAtSec: at, source: "bitstamp",
            ...(conversionPool.length ? { upstreamKeys: [...conversionPool, "venue:bitstamp"] } : {}) }],
          ["usdt-tether", { priceUsd: 1, observedAtSec: at + 10, source: mode === "shared conversion" ? "bitstamp" : "coinbase",
            ...(conversionPool.length ? { upstreamKeys: [...conversionPool, "venue:coinbase"] } : {}) }],
        ]),
      });
      const evidence = extractPriceObservations(pools, assets, new Map(), forDexPriceCandidateCollection(refs), prices, nowSec);
      expect(evidence.get(id)?.map((row) => row.observedAt)).toEqual([at, at + 10]);
      const { db, sqlite, generationId } = seedPublishedDexGeneration({ nowSec });
      try {
        await computeDexPrices({ db, generationId, nowSec, references: refs, exactPriceEvidenceByStablecoin: evidence,
          primaryPrices: new Map([[id, 0.2]]), retainedPoolsByStablecoin: makePricePoolMap(pools.map((pool) => ({
            stablecoinId: id, poolId: `ethereum:${pool.poolAddress}`, project: pool.source, chain: pool.chain, tvlUsd: pool.tvlUsd,
          }))),
        });
        const loaded = await loadDexPrices(db, nowSec);
        const results = new Map<string, PrimaryPriceWithFiatPremiumEvidence>();
        buildPrimaryConsensusResults({ candidates: [{ id, name: "BRZ", symbol: "BRZ", pegType: "peggedREAL" }],
          references: refs, quoteMaps: createEmptyPrimaryConsensusQuoteMaps(), dexRows: loaded.dexPriceRows,
          dexPriceSources: loaded.dexPriceSources, nowSec, resolveDlListQuote: () => undefined, results, stats: createStats(),
        });
        if (mode !== "independent") {
          expect(loaded.dexPriceRows.has(id)).toBe(false);
          expect(results.has(id)).toBe(false);
          return;
        }
        const result = results.get(id)!;
        expect(result.fiatPremiumEvidence).toEqual({
          "fluid-dex": { priceUsd: price, observedAtSec: at, upstreamKeys: [`ethereum:${address(4)}`, "venue:bitstamp"] },
          "balancer-dex": { priceUsd: price, observedAtSec: at + 10, upstreamKeys: [`ethereum:${address(5)}`, "venue:coinbase"] },
        });
        expect(validatePrimaryPriceCandidate({ ...result, candidatePrices: result.allPrices, validationReferences: refs,
          validationContext: buildPriceValidationContext({ stablecoinId: id, pegType: "peggedREAL" }),
        })).toMatchObject({ accepted: true, reason: "corroborated_fiat_premium" });
      } finally {
        sqlite.close();
      }
    },
  );

  it("counts a shared Bitstamp conversion once across distinct USG pools", () => {
    const id = "usg-tangent", nowSec = 1_800_000_000;
    const curve = "ethereum:0x97ba10115da528c113462ede9c20d7adc806d93f";
    const second = "ethereum:0xf000000000000000000000000000000000000001";
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.curvePrices.set(id, 0.98);
    quoteMaps.curveObservedAtByCoinId.set(id, nowSec);
    quoteMaps.curvePricePoolKeysByCoinId.set(id, [curve]);
    for (const conversion of ["bitstamp", "coinbase"]) {
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({ candidates: [{ id, name: "USG", symbol: "USG", pegType: "peggedUSD" }],
        quoteMaps, dexRows: new Map(), dexPriceSources: new Map([[id, [{ protocol: "uniswap-v3",
          chain: "ethereum", price: 0.98, tvl: 1e6, observedAt: nowSec, updatedAt: nowSec,
          pricePoolKeys: [second], upstreamKeys: [second, `venue:${conversion}`] }]]]), nowSec,
        resolveDlListQuote: () => undefined, results, stats: createStats() });
      const result = results.get(id)!;
      expect(classifyPrimaryDepegTrust({ price: result.price, priceSource: result.source, priceConfidence: result.confidence,
        priceObservedAt: result.observedAt, priceObservedAtMode: result.observedAtMode, agreeSources: result.agreeSources }, nowSec))
        .toBe(conversion === "bitstamp" ? "confirm_required" : "authoritative");
    }
  });

  it("keeps mixed conversion evidence out of the independent USG vote", async () => {
    const nowSec = 1_800_000_000, id = "usg-tangent";
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.curvePrices.set(id, 0.98);
    quoteMaps.curveObservedAtByCoinId.set(id, nowSec);
    quoteMaps.curvePricePoolKeysByCoinId.set(id, ["ethereum:0x97ba10115da528c113462ede9c20d7adc806d93f"]);
    const tracked: DexPriceObs = { protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "direct_api",
      identityConfidence: "exact", observedAt: nowSec, price: 0.98, tvl: 1e6,
      poolKey: "ethereum:0xf000000000000000000000000000000000000001",
      counterpartyPrice: { stablecoinId: "usdc-circle", source: "bitstamp", priceUsd: 0.98, observedAtSec: nowSec } };
    const untracked = { ...tracked, counterpartyPrice: undefined, price: 0.999, tvl: 1e4,
      poolKey: "ethereum:0xf000000000000000000000000000000000000002" };
    const bitstampOnly = createEmptyPrimaryConsensusQuoteMaps();
    bitstampOnly.bitstampPrices.set("USG", 0.98);
    bitstampOnly.bitstampObservedAtBySymbol.set("USG", nowSec);
    for (const rows of [[tracked, untracked], [tracked, { ...untracked, poolKey: tracked.poolKey, price: tracked.price }]]) {
      const protocol = aggregateProtocolSources(collapseDuplicateObservations(rows).collapsed)[0]!;
      expect(protocol).toMatchObject({ price: 0.98, upstreamKeys: [], pricePoolKeys: [] });
      for (const [maps, hardSource] of [[quoteMaps, "curve-onchain"], [bitstampOnly, "bitstamp"]] as const) {
        const results = new Map<string, PrimaryPriceResult>();
        buildPrimaryConsensusResults({ candidates: [{ id, name: "USG", symbol: "USG", pegType: "peggedUSD" }],
          quoteMaps: maps, dexRows: new Map(), dexPriceSources: new Map([[id, [{ ...protocol, updatedAt: nowSec }]]]), nowSec,
          resolveDlListQuote: () => undefined, results, stats: createStats() });
        expect(results.get(id)).toMatchObject({ price: 0.98, agreeSources: [hardSource], confidence: "single-source" });
      }
    }
    const { db, sqlite, generationId } = seedPublishedDexGeneration({ nowSec });
    try {
      await computeDexPrices({ db, generationId, nowSec, primaryPrices: new Map([[id, 0.98]]),
        retainedPoolsByStablecoin: makePricePoolMap([tracked, untracked].map((pool) => ({
          stablecoinId: id, poolId: pool.poolKey!, project: pool.protocol, chain: pool.chain, source: "direct_api",
          tvlUsd: Math.max(50_000, pool.tvl), priceEvidenceTvlUsd: pool.tvl, price: pool.price,
          priceObservedAt: pool.observedAt, priceCounterparty: pool.counterpartyPrice,
        }))),
      });
      const [row] = readPublicPriceRows(sqlite);
      expect(row).toMatchObject({ dex_price_usd: 0.98, source_pool_count: 2, source_total_tvl: 1_010_000 });
      const wire = JSON.parse(row!.price_sources_json!);
      expect(wire).toMatchObject({ aggregateObservedAt: null, sources: [], displaySources: [{ price: 0.98, aggregateObservedAt: null }] });
      expect(getDexAggregateObservedAt(wire, nowSec, "display").aggregateObservedAt).toBe(nowSec);
      const loaded = await loadDexPrices(db, nowSec);
      expect(loaded.dexPriceRows.get(id)?.aggregateObservedAt).toBeNull();
      expect(loaded.dexPriceSources.has(id)).toBe(false);
    } finally { sqlite.close(); }
  });

  it("keeps a lone incomplete conversion receipt through protocol aggregation and duplicate collapse", () => {
    const nowSec = 1_800_000_000;
    const pool: DexPriceObs = {
      protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "direct_api", identityConfidence: "exact",
      observedAt: nowSec, price: 0.98, tvl: 1e6, poolKey: "ethereum:0xf000000000000000000000000000000000000001",
    };
    const mark = { stablecoinId: "usdc-circle", priceUsd: 0.98, observedAtSec: nowSec };
    for (const counterpartyPrice of [
      { ...mark, source: "bitstamp+coingecko" }, { ...mark, source: "bitstamp", upstreamKeys: [], pricePoolKeys: [] },
    ]) {
      const observed = { ...pool, counterpartyPrice };
      for (const rows of [[observed], [pool, observed]]) {
        expect(aggregateProtocolSources(collapseDuplicateObservations(rows).collapsed)[0])
          .toMatchObject({ price: 0.98, upstreamKeys: [], pricePoolKeys: [] });
      }
    }
    expect(aggregateProtocolSources([pool])[0]).not.toHaveProperty("upstreamKeys");
  });

  it("withholds rollback voting clocks for a known Curve overlap while admitting the independent protocol", async () => {
    const nowSec = 1_800_000_000, at = nowSec - 12, id = "usg-tangent";
    const pool = {
      stablecoinId: id, chain: "ethereum", source: "direct_api" as const, tvlUsd: 1e6, priceObservedAt: at, price: 0.98,
      priceCounterparty: { stablecoinId: "usdc-circle", source: "bitstamp", priceUsd: 0.98, observedAtSec: at },
      project: "uniswap-v3", poolId: "ethereum:0xf000000000000000000000000000000000000001",
    };
    const sibling = { ...pool, project: "balancer", poolId: "ethereum:0xf000000000000000000000000000000000000002",
      priceCounterparty: { ...pool.priceCounterparty, source: "kraken" } };
    const stale = { ...sibling, project: "fluid", poolId: "ethereum:0xf000000000000000000000000000000000000003",
      tvlUsd: 2e6, priceObservedAt: nowSec - 36 * 60 };
    const { db, sqlite, generationId } = seedPublishedDexGeneration({ nowSec });
    try {
      const direct = { ...sibling, stablecoinId: "usdt-tether" };
      await computeDexPrices({ db, generationId, nowSec, retainedPoolsByStablecoin: makePricePoolMap([pool, sibling, stale, direct]),
        primaryPrices: new Map([[id, 0.98], [direct.stablecoinId, 0.98]]) });
      const rows = readPublicPriceRows(sqlite);
      const wire = JSON.parse(rows.find((row) => row.stablecoin_id === id)!.price_sources_json!);
      const displayClock = stale.priceObservedAt;
      expect(wire).toMatchObject({ aggregateObservedAt: null, displayAggregateObservedAt: displayClock });
      expect(wire.sources).toEqual([expect.objectContaining({ protocol: "balancer", aggregateObservedAt: displayClock })]);
      expect(wire.displaySources).toEqual([
        expect.objectContaining({ protocol: "fluid", aggregateObservedAt: null, displayAggregateObservedAt: displayClock }),
        expect.objectContaining({ protocol: "balancer", observedAt: at, aggregateObservedAt: displayClock }),
        expect.objectContaining({ protocol: "uniswap-v3", aggregateObservedAt: null, displayAggregateObservedAt: displayClock,
          upstreamKeys: [pool.poolId, "venue:bitstamp"] }),
      ]);
      const directWire = JSON.parse(rows.find((row) => row.stablecoin_id === direct.stablecoinId)!.price_sources_json!);
      expect(directWire).toMatchObject({ aggregateObservedAt: null, displayAggregateObservedAt: at,
        sources: [], displaySources: [{ protocol: direct.project, aggregateObservedAt: null, displayAggregateObservedAt: at }] });
    } finally { sqlite.close(); }
  });

  it("withholds an undated CoinGecko price from primary consensus", () => {
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.cgQuotes.set("freedom-dollar", { price: 0.842295, observedAt: null, observedAtMode: null });
    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates: [{ id: "fusd-freedom-dollar", name: "Freedom Dollar", symbol: "FUSD", geckoId: "freedom-dollar" }],
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec: 1_800_000_000,
      resolveDlListQuote: () => undefined, results, stats: createStats(),
    });
    expect(results.size).toBe(0);
  });

  it("uses a dated Bitstamp quote without borrowing its clock for a Kraken trade", () => {
    const nowSec = 1_800_000_000;
    const id = "usdt-tether";
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.bitstampPrices.set("USDT", 0.991);
    quoteMaps.bitstampObservedAtBySymbol.set("USDT", nowSec - 12);
    quoteMaps.krakenPrices.set("USDT", 0.987);
    quoteMaps.krakenObservedAt = nowSec;
    quoteMaps.krakenQuoteBasisBySymbol.set("USDT", "last-trade");
    const results = new Map<string, PrimaryPriceResult>();
    const runConsensus = () => buildPrimaryConsensusResults({
      candidates: [{ id, name: "Tether", symbol: "USDT", pegType: "peggedUSD" }],
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec,
      resolveDlListQuote: () => undefined, results, stats: createStats(),
    });
    runConsensus();
    expect(results.get(id)).toMatchObject({ price: 0.991, agreeSources: ["bitstamp"], confidence: "single-source",
      observedAt: nowSec - 12, allPrices: { bitstamp: 0.991 }, diagnosticPrices: { kraken: 0.987 } });
    expect(results.get(id)?.allPrices).not.toHaveProperty("kraken");
    quoteMaps.krakenObservedAtBySymbol.set("USDT", nowSec - 20);
    runConsensus();
    expect(results.get(id)).toMatchObject({ price: 0.989, confidence: "high", observedAt: nowSec - 20 });
    expect(new Set(results.get(id)?.agreeSources)).toEqual(new Set(["bitstamp", "kraken"]));
  });

  it.each([["audx-aussie-dollar-token", "AUDX"], ["qcad-stablecorp", "QCAD"]])(
    "counts one venue for the reviewed %s mirror", (id, symbol) => {
      const nowSec = 1_800_000_000;
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.krakenPrices.set(symbol, 1.02);
      quoteMaps.krakenObservedAt = nowSec - 5;
      quoteMaps.krakenQuoteBasisBySymbol.set(symbol, "last-trade");
      quoteMaps.cgQuotes.set(id, { price: 1.021, observedAt: nowSec, observedAtMode: "upstream" });
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [{ id, name: symbol, symbol, geckoId: id, pegType: "peggedUSD" }], quoteMaps,
        dexRows: new Map(), dexPriceSources: new Map(), nowSec, resolveDlListQuote: () => undefined,
        results, stats: createStats(),
      });
      expect(results.get(id)).toMatchObject({
        source: "kraken", observedAt: null, observedAtMode: "unknown", priceQuoteBasis: "last-trade", price: 1.02, confidence: "single-source", agreeSources: ["kraken"],
        candidateSources: ["kraken", "coingecko"], diagnosticPrices: { coingecko: 1.021 }, allPrices: { kraken: 1.02 },
      });
    },
  );

  it("admits a five-day issuer NAV round and expires it one second after the configured budget", () => {
    const id = "mre7yield-midas";
    const meta = TRACKED_META_BY_ID.get(id)!;
    const fingerprint = computeLiveReserveConfigFingerprint(meta.liveReservesConfig!);
    const observedAt = 1_790_000_000;
    const fetchedAt = observedAt + 5 * 86400;
    const quote = decodeCurrentReserveNavPrice({
      source: "chainlink-nav", fetched_at: fetchedAt,
      metadata: JSON.stringify({ navPerToken: 1.23, sourceTimestamp: observedAt }),
      attempt_id: "success", last_success_at: fetchedAt, last_success_attempt_id: "success",
      config_fingerprint: fingerprint, state_config_fingerprint: fingerprint,
      last_attempt_id: "success", pending_attempt_id: null,
    }, meta, fetchedAt)!;
    const build = (nowSec: number) => {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.navPrices.set(id, quote);
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [{ id, name: meta.name, symbol: meta.symbol, pegType: "peggedUSD", navToken: true }],
        quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec,
        resolveDlListQuote: () => undefined, results, stats: createStats(),
      });
      return results.get(id);
    };
    expect(build(observedAt + quote.maxAgeSec! + 1)).toBeUndefined();
    expect(build(fetchedAt)).toMatchObject({ source: "chainlink-nav", price: 1.23, observedAt, observedAtMode: "upstream" });
  });

  it("keeps the valid native candidate through family collapse and final peg validation, only for HBD", () => {
    const nowSec = 1_800_000_000;
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.cgQuotes.set("hive_dollar", { price: 2.25, observedAt: nowSec, observedAtMode: "upstream" });
    quoteMaps.hiveNativeQuote = { price: 0.98662, observedAt: nowSec - 4, observedAtMode: "local_fetch" };
    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates: [{ id: "hbd-hive", name: "HBD", symbol: "HBD", geckoId: "hive_dollar", pegType: "peggedUSD" }, { id: "test-usd", name: "Other", symbol: "OTHER", pegType: "peggedUSD" }],
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec,
      resolveDlListQuote: () => undefined, results, stats: createStats(),
    });
    expect(results.get("hbd-hive")).toMatchObject({ source: "hive-native-cg", price: 0.98662, confidence: "single-source", observedAt: nowSec - 4, observedAtMode: "local_fetch" });
    expect(results.has("test-usd")).toBe(false);
  });
  describe("DEX aggregate leg", () => {
    const nowSec = 1_790_629_276;
    const usdc: PeggedAsset = { id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD" };

    function build(input: { dexAgeSec: number | null; withIndependentLegs: boolean; aggregatorLegsOnly?: boolean; dexPrice?: number }, asset = usdc, sourceTotalTvl = 2_411_298_816): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (input.aggregatorLegsOnly) {
        asset.geckoId = "usd-coin";
        quoteMaps.cgQuotes.set("usd-coin", { price: 0.9999, observedAt: nowSec - 30, observedAtMode: "upstream" });
      } else {
        delete asset.geckoId;
      }
      if (input.withIndependentLegs && !input.aggregatorLegsOnly) {
        quoteMaps.krakenPrices.set("USDC", 0.9999);
        quoteMaps.krakenObservedAt = nowSec - 60;
        quoteMaps.binancePrices.set("USDC", 1.0001);
        quoteMaps.binanceObservedAt = nowSec - 30;
      }
      const dexRows = new Map([[
        asset.id,
        {
          stablecoin_id: asset.id,
          dex_price_usd: input.dexPrice ?? 0.999936,
          deviation_from_primary_bps: 0,
          source_pool_count: 748,
          source_total_tvl: sourceTotalTvl,
          updated_at: nowSec - 1,
          aggregateObservedAt: input.dexAgeSec == null ? null : nowSec - input.dexAgeSec,
        },
      ]]) as PrimaryDexRows;
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [asset],
        quoteMaps,
        dexRows,
        dexPriceSources: new Map() as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => undefined,
        results,
        stats: createStats(),
      });
      return results.get(asset.id);
    }

    it("keeps a DEX aggregate older than the primary budget from ageing fresh agreement", () => {
      // The previous hourly DEX run's row, 50 minutes old: still inside its own
      // 75-minute window, outside the 30-minute primary budget.
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: true });

      expect(result?.agreeSources).not.toContain("dex-promoted");
      expect(result?.candidateSources).not.toContain("dex-promoted");
      expect(result?.confidence).toBe("high");
      expect(result?.observedAt).toBe(nowSec - 60);
    });

    it("admits a DEX aggregate inside the strictest co-leg window as an agreeing leg", () => {
      const result = build({ dexAgeSec: 100, withIndependentLegs: true });

      expect(result?.agreeSources).toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it("keeps a DEX aggregate past a co-leg's window from failing the composite's freshness", () => {
      // 20 minutes old: inside the 30-minute primary budget, outside CoinGecko's
      // 15-minute window, so admitting it stamped USDC stale for every
      // authoritative child priced from it.
      const result = build({ dexAgeSec: 1_200, withIndependentLegs: true, aggregatorLegsOnly: true });

      expect(result?.candidateSources).not.toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 30);
      expect(validateCompositePricingSourceFreshness({
        source: result!.source,
        observedAt: result!.observedAt,
        observedAtMode: result!.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
    });

    it.each([0.999936, 0.4])("keeps an older DEX aggregate as the sole leg with its own clock ($%s)", (price) => {
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: false, dexPrice: price });

      expect(result).toMatchObject({
        source: "dex-promoted",
        price,
        confidence: "single-source",
        observedAt: nowSec - 3_018,
      });
    });

    it.each([
      ["usdc-circle", 250_000, 60, false],
      ["vusd-virtue", 249_999, 60, false],
      ["vusd-virtue", 250_000, 4500, true],
      ["vusd-virtue", 250_000, 4501, false],
    ] as const)("preserves the %s aggregate tier at TVL %s and original age %s", (id, tvl, dexAgeSec, accepted) => {
      expect(build({ dexAgeSec, withIndependentLegs: false }, { ...usdc, id }, tvl) != null).toBe(accepted);
    });

    it.each([null, 21_600, 4500])("rejects original age %s despite fresh publication", (dexAgeSec) => {
      expect(build({ dexAgeSec, withIndependentLegs: false })).toBeUndefined();
      expect(build({ dexAgeSec, withIndependentLegs: true })?.candidateSources).not.toContain("dex-promoted");
    });
  });

  describe("promoted DEX protocol lane", () => {
    // pmUSD at the 2026-11-02 06:45 UTC run, when its open depeg event went blind.
    const nowSec = 1_793_601_977;
    const pmusd: PeggedAsset = {
      id: "pmusd-precious-metals", name: "Precious Metals USD", symbol: "pmUSD",
      geckoId: "precious-metals-usd", pegType: "peggedUSD",
    };

    const routePoolKey = "ethereum:0xecb0f0d68c19bdaadaebe24f6752a4db34e2c2cb";
    const independentPoolKeys = ["ethereum:0x0000000000000000000000000000000000000001"];

    function build(
      laneAgeSec: number, cgPrice: number | null = 0.534161,
      pricePoolKeys: string[] | null = independentPoolKeys, protocol = "curve",
    ): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (cgPrice != null) {
        quoteMaps.cgQuotes.set("precious-metals-usd", { price: cgPrice, observedAt: nowSec - 20, observedAtMode: "upstream" });
      }
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      quoteMaps.curvePricePoolKeysByCoinId.set(pmusd.id, [routePoolKey]);
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol, chain: "ethereum", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - laneAgeSec, pricePoolKeys: pricePoolKeys ?? undefined,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => undefined,
        results,
        stats: createStats(),
      });
      return results.get(pmusd.id);
    }

    const trustOf = (result: PrimaryPriceResult) => classifyPrimaryDepegTrust({
      price: result.price,
      priceSource: result.source,
      priceConfidence: result.confidence,
      priceObservedAt: result.observedAt,
      priceObservedAtMode: result.observedAtMode,
      agreeSources: result.agreeSources,
    }, nowSec);

    it.each([
      ["curve", "same pool", [routePoolKey]], ["curve", "explicitly unavailable", []],
      ["uniswap-v3", "overlapping conversion pool", [...independentPoolKeys, routePoolKey]],
      ["uniswap-v3", "explicitly unavailable", []],
      ["uniswap-v3", "unregistered chain", ["unverified:fake-pool"]],
    ])("keeps the %s leg diagnostic-only with %s provenance", (protocol, _provenance, pricePoolKeys) => {
      const dexSource = `${protocol}-dex`;
      const result = build(90, 0.545, pricePoolKeys, protocol);
      expect(result).toMatchObject({
        source: "curve-onchain", confidence: "low", observedAt: nowSec - 30,
        agreeSources: ["curve-onchain"], diagnosticPrices: { [dexSource]: 0.53416 },
      });
      expect(result?.allPrices).not.toHaveProperty(dexSource);
      expect(result?.candidateSources).toContain(dexSource);
      expect(trustOf(result!)).toBe("confirm_required");
    });

    it("keeps the legacy DEX vote when its writer omitted pool lineage", () => {
      expect(trustOf(build(90, 0.545, null, "uniswap-v3")!)).toBe("authoritative");
    });

    it("keeps a lane past the strictest co-leg window from ageing fresh hard agreement past the depeg budget", () => {
      // 34 minutes old: inside the 35-minute protocol-source budget, outside the
      // 30-minute primary budget, so it stamped the composite untrusted.
      const result = build(2_071);

      expect(result).toMatchObject({ source: "coingecko+curve-onchain", confidence: "high", observedAt: nowSec - 30 });
      expect(trustOf(result!)).toBe("authoritative");
      expect(validateCompositePricingSourceFreshness({
        source: result!.source,
        observedAt: result!.observedAt,
        observedAtMode: result!.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
      // The held lane was read this run: it stays an available candidate, so the
      // three-source depth that keeps pmUSD out of the corroboration probes holds.
      expect(result!.candidateSources).toEqual(["coingecko", "curve-onchain", "curve-dex"]);
      expect(result!.agreeSources).not.toContain("curve-dex");
    });

    it("drops a lane inside the primary budget too while the fresh legs agree", () => {
      const result = build(1_500);

      expect(result).toMatchObject({ source: "coingecko+curve-onchain", observedAt: nowSec - 30 });
      expect(result!.candidateSources).toContain("curve-dex");
    });

    it("admits a lane inside the strictest co-leg window as an agreeing leg", () => {
      const result = build(100);

      expect(result?.agreeSources).toContain("curve-dex");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it("keeps Curve agreement through a missing CoinGecko leg, dated by the older lane", () => {
      const result = build(1_500, null);

      expect(result).toMatchObject({ source: "curve-dex+curve-onchain", confidence: "high", observedAt: nowSec - 1_500 });
      expect(trustOf(result!)).toBe("authoritative");
    });

    it("keeps Curve agreement through a CoinGecko leg more than 50 bps away, dated by the older lane", () => {
      // 0.5450 sits about 200 bps from the Curve quote, outside the agreement threshold.
      const result = build(1_500, 0.545);

      expect(result).toMatchObject({ source: "curve-dex+curve-onchain", confidence: "high", observedAt: nowSec - 1_500 });
      expect(result!.disagreeSources).toContain("coingecko");
      expect(trustOf(result!)).toBe("authoritative");
    });

    it("does not let a list-aggregator pair block a lane that agrees with a diverging hard leg", () => {
      // CoinGecko and DefiLlama-list agree with each other but are later reduced
      // to `single-source`; Curve on-chain diverges. The 25-minute curve-dex lane
      // agrees with Curve and must rejoin, restoring the pre-6.68 authoritative
      // composite instead of the downgraded list pair outvoting Curve.
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.cgQuotes.set("precious-metals-usd", {
        price: 0.545,
        observedAt: nowSec - 20,
        observedAtMode: "upstream",
      });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      quoteMaps.curvePricePoolKeysByCoinId.set(pmusd.id, [routePoolKey]);
      const results = new Map<string, PrimaryPriceResult>();
      const stats = createStats();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol: "curve", chain: "ethereum", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - 1_500, pricePoolKeys: independentPoolKeys,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => ({ price: 0.54505, observedAt: nowSec - 25, observedAtMode: "upstream" }),
        results,
        stats,
      });
      applyListAggregatorDowngrade(results, stats);

      const result = results.get(pmusd.id)!;
      expect(result).toMatchObject({
        source: "curve-dex+curve-onchain",
        confidence: "high",
        observedAt: nowSec - 1_500,
      });
      expect(result.disagreeSources).toEqual(expect.arrayContaining(["coingecko", "defillama-list"]));
      expect(trustOf(result)).toBe("authoritative");
    });

    it("does not rejoin a lane that lands in the list pair's group instead of the hard leg's", () => {
      // The CoinGecko/list pair sits about 53 bps from Curve, so a 25-minute lane
      // at 0.535 agrees with both. Rejoining it creates a three-source cluster
      // with the pair, not Curve: the composite is dated 1,500 s old, fails its
      // CoinGecko leg's freshness, and escapes the list-pair downgrade. The lane
      // must stay held; the fresh list pair is the correct single-source result.
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.cgQuotes.set("precious-metals-usd", {
        price: 0.537,
        observedAt: nowSec - 20,
        observedAtMode: "upstream",
      });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      quoteMaps.curvePricePoolKeysByCoinId.set(pmusd.id, [routePoolKey]);
      const results = new Map<string, PrimaryPriceResult>();
      const stats = createStats();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol: "curve", chain: "ethereum", price: 0.535, tvl: 7_684_693, updatedAt: nowSec - 1_500, pricePoolKeys: independentPoolKeys,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => ({ price: 0.537, observedAt: nowSec - 25, observedAtMode: "upstream" }),
        results,
        stats,
      });
      applyListAggregatorDowngrade(results, stats);

      const result = results.get(pmusd.id)!;
      expect(result).toMatchObject({
        source: "coingecko+defillama-list",
        confidence: "single-source",
        observedAt: nowSec - 25,
      });
      expect(result.agreeSources).not.toContain("curve-dex");
      expect(result.candidateSources).toContain("curve-dex");
      expect(validateCompositePricingSourceFreshness({
        source: result.source,
        observedAt: result.observedAt,
        observedAtMode: result.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
    });

    it("does not rescue a missing CoinGecko leg with a lane past the primary budget", () => {
      const result = build(2_071, null);

      expect(result).toMatchObject({ source: "curve-onchain", confidence: "single-source", observedAt: nowSec - 30 });
      expect(trustOf(result!)).toBe("confirm_required");
      expect(result!.candidateSources).toEqual(["curve-onchain", "curve-dex"]);
    });
  });

  it("does not treat two chains of one promoted DEX protocol as independent corroboration", () => {
    const nowSec = 1_800_000_000;
    const asset: PeggedAsset = { id: "cgusd-cygnus-finance", name: "Cygnus USD", symbol: "cgUSD", pegType: "peggedUSD" };
    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates: [asset],
      quoteMaps: createEmptyPrimaryConsensusQuoteMaps(),
      dexRows: new Map(),
      dexPriceSources: new Map([[asset.id, ["ethereum", "base"].map((chain) => ({
        protocol: "uniswap-v3", chain, price: 0.99, tvl: 50_000, updatedAt: nowSec - 60,
      }))]]),
      nowSec,
      resolveDlListQuote: () => undefined,
      results,
      stats: createStats(),
    });
    expect(results.size).toBe(0);
  });
});
