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
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import { applyListAggregatorDowngrade } from "../enrich-prices-primary-hardening";
import { validateCompositePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { classifyPrimaryDepegTrust, getDexAggregateObservedAt } from "../../../lib/depeg-trust-policy";
import { decodeCurrentReserveNavPrice } from "../../../lib/reserve-nav-price";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { FLUID_SWAP_STATUS_MAX_AGE_SEC } from "@shared/lib/fluid-swap-status";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { decideDepegAsset } from "../../depeg-detection/decision-engine";
import { attachDetectionReferenceContext } from "../../depeg-detection/reference-policy";
import { referenceState } from "../../depeg-detection/__tests__/reference-fixtures";
import {
  createEmptyPrimaryConsensusQuoteMaps as emptyQuotes,
  type PrimaryConsensusQuoteMaps,
  type PrimaryDexRows,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset, PriceValidationStats, PrimaryPriceResult } from "../enrich-prices-shared";

function activeFluidPool(poolAddress: string, checkedAtSec: number) {
  return { fluidSwapStatus: { status: "active", reason: "fluid-swaps-active",
    poolAddress, checkedAtSec, maxAgeSec: FLUID_SWAP_STATUS_MAX_AGE_SEC } } as const;
}

function createStats(): PriceValidationStats {
  return {
    attempted: 0,
    high: 0,
    singleSource: 0,
    cgOnly: 0,
    low: 0,
  };
}

type ConsensusOptions = Pick<Parameters<typeof buildPrimaryConsensusResults>[0],
  "references" | "dexRows" | "dexPriceSources" | "nowSec">;

function consensusFor(asset: PeggedAsset, quoteMaps: PrimaryConsensusQuoteMaps, options: Partial<ConsensusOptions> = {}) {
  const results = new Map<string, PrimaryPriceResult>();
  buildPrimaryConsensusResults({
    candidates: [asset], quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec: 1_800_000_000,
    resolveDlListQuote: () => undefined, results, stats: createStats(), ...options,
  });
  return results.get(asset.id);
}

const usg = { id: "usg-tangent", name: "USG", symbol: "USG", pegType: "peggedUSD" };
const usgNow = 1_800_000_000;
const usgPool = "ethereum:0xf000000000000000000000000000000000000001";
const usgSecondPool = "ethereum:0xf000000000000000000000000000000000000002";
function usgCurveQuotes() {
  const maps = emptyQuotes();
  maps.curvePrices.set(usg.id, 0.98);
  maps.curveObservedAtByCoinId.set(usg.id, usgNow);
  maps.curvePricePoolKeysByCoinId.set(usg.id, ["ethereum:0x97ba10115da528c113462ede9c20d7adc806d93f"]);
  return maps;
}

const usgObservation: DexPriceObs = {
  protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "direct_api", identityConfidence: "exact",
  observedAt: usgNow, price: 0.98, tvl: 1e6, poolKey: usgPool,
};

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
            extra: pool.source === "fluid" ? activeFluidPool(pool.poolAddress, nowSec) : undefined,
          }))),
        });
        const loaded = await loadDexPrices(db, nowSec);
        const result = consensusFor({ id, name: "BRZ", symbol: "BRZ", pegType: "peggedREAL" },
          emptyQuotes(), { references: refs, dexRows: loaded.dexPriceRows,
            dexPriceSources: loaded.dexPriceSources, nowSec });
        if (mode !== "independent") {
          expect(loaded.dexPriceRows.has(id)).toBe(false);
          expect(result).toBeUndefined();
          return;
        }
        expect(result!.fiatPremiumEvidence).toEqual({
          "fluid-dex": { priceUsd: price, observedAtSec: at, upstreamKeys: [`ethereum:${address(4)}`, "venue:bitstamp"] },
          "balancer-dex": { priceUsd: price, observedAtSec: at + 10, upstreamKeys: [`ethereum:${address(5)}`, "venue:coinbase"] },
        });
        expect(validatePrimaryPriceCandidate({ ...result!, candidatePrices: result!.allPrices, validationReferences: refs,
          validationContext: buildPriceValidationContext({ stablecoinId: id, pegType: "peggedREAL" }),
        })).toMatchObject({ accepted: true, reason: "corroborated_fiat_premium" });
      } finally {
        sqlite.close();
      }
    },
  );

  it("counts a shared Bitstamp conversion once across distinct USG pools", () => {
    for (const [conversion, trust] of [["bitstamp", "confirm_required"], ["coinbase", "authoritative"]]) {
      const result = consensusFor(usg, usgCurveQuotes(), {
        dexPriceSources: new Map([[usg.id, [{ protocol: usgObservation.protocol, chain: "ethereum",
          price: 0.98, tvl: 1e6, observedAt: usgNow, updatedAt: usgNow,
          pricePoolKeys: [usgPool], upstreamKeys: [usgPool, `venue:${conversion}`] }]]]),
      })!;
      expect(classifyPrimaryDepegTrust({ price: result.price, priceSource: result.source, priceConfidence: result.confidence,
        priceObservedAt: result.observedAt, priceObservedAtMode: result.observedAtMode, agreeSources: result.agreeSources }, usgNow))
        .toBe(trust);
    }
  });

  it("keeps mixed conversion evidence out of the independent USG vote", async () => {
    const { id } = usg;
    const nowSec = usgNow;
    const tracked: DexPriceObs = { ...usgObservation,
      counterpartyPrice: { stablecoinId: "usdc-circle", source: "bitstamp", priceUsd: 0.98, observedAtSec: nowSec } };
    const untracked: DexPriceObs = { ...usgObservation, price: 0.999, tvl: 1e4, poolKey: usgSecondPool };
    const bitstampOnly = emptyQuotes();
    bitstampOnly.bitstampPrices.set("USG", 0.98);
    bitstampOnly.bitstampObservedAtBySymbol.set("USG", nowSec);
    for (const rows of [[tracked, untracked], [tracked, { ...untracked, poolKey: tracked.poolKey, price: tracked.price }]]) {
      const protocol = aggregateProtocolSources(collapseDuplicateObservations(rows).collapsed)[0]!;
      expect(protocol).toMatchObject({ price: 0.98, upstreamKeys: [], pricePoolKeys: [] });
      for (const [maps, hardSource] of [[usgCurveQuotes(), "curve-onchain"], [bitstampOnly, "bitstamp"]] as const) {
        const result = consensusFor(usg, maps, { dexPriceSources: new Map([[id, [{ ...protocol, updatedAt: nowSec }]]]) });
        expect(result).toMatchObject({ price: 0.98, agreeSources: [hardSource], confidence: "single-source" });
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
    const pool = usgObservation;
    const mark = { stablecoinId: "usdc-circle", priceUsd: 0.98, observedAtSec: usgNow };
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
    const nowSec = usgNow, at = nowSec - 12, id = usg.id;
    const pool = {
      stablecoinId: id, chain: "ethereum", source: "direct_api" as const, tvlUsd: 1e6, priceObservedAt: at, price: 0.98,
      priceCounterparty: { stablecoinId: "usdc-circle", source: "bitstamp", priceUsd: 0.98, observedAtSec: at },
      project: "uniswap-v3", poolId: usgPool,
    };
    const sibling = { ...pool, project: "balancer", poolId: usgSecondPool,
      priceCounterparty: { ...pool.priceCounterparty, source: "kraken" } };
    const fluidAddress = "0xf000000000000000000000000000000000000003";
    const stale = { ...sibling, project: "fluid", poolId: `ethereum:${fluidAddress}`, extra: activeFluidPool(fluidAddress, nowSec),
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
      expect(wire.sources).toEqual([]);
      expect(wire.lineageSources).toEqual(["balancer", "uniswap-v3"].map((protocol) =>
        expect.objectContaining({ protocol, aggregateObservedAt: displayClock })));
      expect((await loadDexPrices(db, nowSec)).dexPriceSources.get(id)?.map(({ protocol }) => protocol)).toEqual(["balancer", "uniswap-v3"]);
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

  it("admits the Aero USDT quote only alongside disjoint upstream prices", async () => {
    const id = "usdt-tether", nowSec = 1_800_000_000, at = nowSec - 12;
    const poolId = "ink:0xa7b947ffe3b14e71be2c60e316ea315a24ccc73c";
    for (const [venue, price, confidence, agreeSources] of [
      ["bitstamp", 0.9601, "high", ["kraken", "aero-dex"]],
      ["kraken", 1, "single-source", ["coingecko", "defillama-list"]],
    ] as const) {
      const { db, sqlite, generationId } = seedPublishedDexGeneration({ nowSec });
      try {
        await computeDexPrices({ db, generationId, nowSec, primaryPrices: new Map([[id, 1]]),
          retainedPoolsByStablecoin: makePricePoolMap([{ stablecoinId: id, poolId, chain: "ink", project: "aero",
            source: "direct_api", tvlUsd: 182_384, price: 0.9602, priceObservedAt: at,
            priceCounterparty: { stablecoinId: "usdc-circle", source: `binance+${venue}`, priceUsd: 1, observedAtSec: at },
          }]),
        });
        const wire = JSON.parse(readPublicPriceRows(sqlite)[0]!.price_sources_json!);
        const { dexPriceRows, dexPriceSources } = await loadDexPrices(db, nowSec);
        const quoteMaps = emptyQuotes();
        quoteMaps.krakenPrices.set("USDT", 0.96);
        quoteMaps.krakenObservedAt = at;
        quoteMaps.cgQuotes.set("tether", { price: 1, observedAt: at, observedAtMode: "upstream" });
        const results = new Map<string, PrimaryPriceResult>(), stats = createStats();
        buildPrimaryConsensusResults({ candidates: [{ id, name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD" }],
          quoteMaps, dexRows: dexPriceRows, dexPriceSources, nowSec, results, stats,
          resolveDlListQuote: () => ({ price: 1, observedAt: at, observedAtMode: "upstream" }),
        });
        applyListAggregatorDowngrade(results, stats);
        expect(results.get(id)).toMatchObject({ price, confidence, agreeSources });
        expect(wire).toMatchObject({ aggregateObservedAt: null, sources: [], lineageSources: [
          { protocol: "aero", upstreamKeys: [poolId, "venue:binance", `venue:${venue}`] },
        ] });
      } finally { sqlite.close(); }
    }
  });

  it("withholds an undated CoinGecko price from primary consensus", () => {
    const quoteMaps = emptyQuotes();
    quoteMaps.cgQuotes.set("freedom-dollar", { price: 0.842295, observedAt: null, observedAtMode: null });
    expect(consensusFor({ id: "fusd-freedom-dollar", name: "Freedom Dollar", symbol: "FUSD", geckoId: "freedom-dollar" },
      quoteMaps)).toBeUndefined();
  });

  it("uses a dated Bitstamp quote without borrowing its clock for a Kraken trade", () => {
    const nowSec = 1_800_000_000;
    const asset = { id: "usdt-tether", name: "Tether", symbol: "USDT", pegType: "peggedUSD" };
    const quoteMaps = emptyQuotes();
    quoteMaps.bitstampPrices.set("USDT", 0.991);
    quoteMaps.bitstampObservedAtBySymbol.set("USDT", nowSec - 12);
    quoteMaps.krakenPrices.set("USDT", 0.987);
    quoteMaps.krakenObservedAt = nowSec;
    quoteMaps.krakenQuoteBasisBySymbol.set("USDT", "last-trade");
    const undated = consensusFor(asset, quoteMaps);
    expect(undated).toMatchObject({ price: 0.991, agreeSources: ["bitstamp"], confidence: "single-source",
      observedAt: nowSec - 12, allPrices: { bitstamp: 0.991 }, diagnosticPrices: { kraken: 0.987 } });
    expect(undated?.allPrices).not.toHaveProperty("kraken");
    quoteMaps.krakenObservedAtBySymbol.set("USDT", nowSec - 20);
    const dated = consensusFor(asset, quoteMaps);
    expect(dated).toMatchObject({ price: 0.989, confidence: "high", observedAt: nowSec - 20 });
    expect(new Set(dated?.agreeSources)).toEqual(new Set(["bitstamp", "kraken"]));
  });

  it("preserves the oldest clock and weakest clock mode in Kraken composites and never re-clocks stale Depth books", () => {
    const now = 1_800_000_000;
    const asset = { id: "paxg-paxos", name: "PAX Gold", symbol: "PAXG", geckoId: "pax-gold", pegType: "peggedGOLD" };
    const quotes = emptyQuotes();
    quotes.krakenPrices.set("PAXG", 3_000);
    quotes.krakenObservedAtBySymbol.set("PAXG", now - 100);
    quotes.krakenQuoteBasisBySymbol.set("PAXG", "bid-ask-midpoint");
    quotes.cgQuotes.set("pax-gold", { price: 3_001, observedAt: now - 20, observedAtMode: "upstream" });
    expect(consensusFor(asset, quotes)).toMatchObject({
      source: "coingecko+kraken", confidence: "high", observedAt: now - 100, observedAtMode: "upstream",
    });
    // Stale Depth book (> 600s) is rejected rather than re-clocked to krakenObservedAt (local_fetch).
    quotes.krakenObservedAt = now - 5;
    quotes.krakenObservedAtBySymbol.set("PAXG", now - 601);
    expect(consensusFor(asset, quotes)).toMatchObject({
      source: "coingecko", confidence: "single-source", observedAt: now - 20, observedAtMode: "upstream",
    });
    // Non-Depth Ticker quotes still use local_fetch when krakenObservedAtBySymbol has no entry.
    quotes.krakenObservedAtBySymbol.clear();
    expect(consensusFor(asset, quotes)).toMatchObject({
      source: "coingecko+kraken", confidence: "high", observedAt: now - 20, observedAtMode: "local_fetch",
    });
    expect(getPricingSourceRegistryEntry("kraken")).toMatchObject({
      defaultObservedAtMode: "local_fetch", supportsUpstreamObservedAt: false, depegSourceFamily: "market:kraken",
    });
  });

  // Pharos publication captured at 00:38:40 UTC and Kraken books at 00:41:14 UTC on 2026-11-20.
  // The public median and oldest clock stand in for unpublished legs, with a controlled dated reference.
  it.each([
    ["eurc-circle", 1.0967139057919377, 1795134643, 1.097285, 1795135274, 1.0967582021062146, 501.5e6, "cg+cb"],
    ["zchf-frankencoin", 1.1841783666300865, 1795134643, 1.18456, 1795135204, 1.1844481951970627, 38.2e6, "cg"],
    ["xaut-tether", 3607.1463280560174, 1795134623, 3594.9, 1795135274, 3616.2728131424715, 2702e6, "cg"],
    ["paxg-paxos", 3602.8, 1795134643, 3590.555, 1795135274, 3616.2728131424715, 1613e6, "cg+cb"],
    ["europ-schuman", 1.0959010027968699, 1795134643, 1.0965, 1795135182, 1.0967582021062146, 14.8e6, "cg"],
    ["audx-aussie-dollar-token", 0.665475, 1795134649, 0.66519, 1795135207, 0.6655512028506889, 2.28e6, ""],
    ["tgbp-tokenised", 1.30921901164242, 1795134643, 1.308765, 1795135268, 1.308556256796314, 26e6, "cg+cb"],
    ["qcad-stablecorp", 0.69725, 1795134649, 0.69735, 1795135155, 0.6971186691168064, 1.44e6, ""],
    ["mxnb-juno", 0.052458002522130134, 1795134623, 0.052365, 1795135167, 0.052371087912464864, 4.48e6, "cg"],
    ["brl1-brl1", 0.16755573336961216, 1795134643, 0.167275, 1795135262, 0.16849199663016007, 3.2e6, "cg"],
  ] as const)("replays the captured quote clocks through depeg detection for %s", (id, baselinePrice, baselineAt, price, observedAt, reference, supply, coLegs) => {
    const bookCaptureAt = 1795135274;
    const meta = TRACKED_META_BY_ID.get(id)!;
    const pegType = pegTypeFromCurrency(meta.flags.pegCurrency)!;
    const asset = { id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId, pegType, circulating: { [pegType]: supply } };
    const symbol = asset.symbol.toUpperCase();
    const quotes = emptyQuotes();
    quotes.krakenPrices.set(symbol, baselinePrice);
    quotes.krakenObservedAt = baselineAt;
    quotes.krakenQuoteBasisBySymbol.set(symbol, "bid-ask-midpoint");
    if (coLegs) quotes.cgQuotes.set(meta.geckoId!, { price: baselinePrice, observedAt: baselineAt, observedAtMode: "upstream" });
    if (coLegs === "cg+cb") {
      quotes.coinbasePrices.set(symbol, baselinePrice);
      quotes.coinbaseObservedAtBySymbol.set(symbol, baselineAt);
    }
    const pegRates = { [pegType]: reference };
    const fx = referenceState(pegRates, baselineAt);
    const referenceContext = attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
    const detectorVerdict = (now: number, expectedKrakenPrice: number | undefined) => {
      const primary = consensusFor(asset, quotes, { nowSec: now })!;
      expect(primary.allPrices?.kraken).toBe(expectedKrakenPrice);
      return {
        primary,
        observation: decideDepegAsset({ now, meta, pegRates, pegRateSources: { [pegType]: "fx" }, pegRateCounts: {}, referenceContext,
          asset: { ...asset, price: primary.price, priceSource: primary.source, priceConfidence: primary.confidence,
            priceObservedAt: primary.observedAt, priceObservedAtMode: primary.observedAtMode, priceQuoteBasis: primary.priceQuoteBasis,
            agreeSources: primary.agreeSources } }).observation,
      };
    };
    expect(detectorVerdict(1795135120, baselinePrice).observation).toEqual({ kind: "unavailable", reason: "invalid-reference" });
    quotes.krakenPrices.set(symbol, price);
    quotes.krakenObservedAtBySymbol.set(symbol, observedAt);
    const clocked = detectorVerdict(bookCaptureAt, price);
    expect(clocked.observation).toEqual({ kind: "observed" });
    expect(clocked.primary.observedAtMode).toBe("upstream");
    if (id === "tgbp-tokenised") {
      // Mixed-case `tGBP` must resolve both Coinbase (with Bitstamp anchor) and Kraken venue keys.
      quotes.cgQuotes.clear();
      quotes.coinbaseObservedAtBySymbol.set(symbol, observedAt);
      const venueOnly = consensusFor(asset, quotes, { nowSec: bookCaptureAt })!;
      expect(venueOnly.upstreamKeys).toEqual(["venue:bitstamp", "venue:coinbase", "venue:kraken"]);
    }
    if (symbol === "ZCHF") {
      // Once the Kraken Depth clock expires (> 600s) and CG has also aged out, Kraken stays withheld
      // rather than being re-clocked to krakenObservedAt (local_fetch).
      quotes.krakenObservedAt = observedAt + 601;
      expect(consensusFor(asset, quotes, { nowSec: observedAt + 601 })).toBeUndefined();
    }
  });

  it.each([["audx-aussie-dollar-token", "AUDX"], ["qcad-stablecorp", "QCAD"]])(
    "counts one venue for the reviewed %s mirror and withholds expired Depth books", (id, symbol) => {
      const nowSec = 1_800_000_000;
      const quoteMaps = emptyQuotes();
      quoteMaps.krakenPrices.set(symbol, 1.02);
      quoteMaps.krakenObservedAt = nowSec - 5;
      quoteMaps.krakenQuoteBasisBySymbol.set(symbol, "bid-ask-midpoint");
      quoteMaps.cgQuotes.set(id, { price: 1.021, observedAt: nowSec, observedAtMode: "upstream" });
      const asset = { id, name: symbol, symbol, geckoId: id, pegType: "peggedUSD" };
      expect(consensusFor(asset, quoteMaps)).toMatchObject({
        source: "kraken", observedAt: nowSec - 5, observedAtMode: "local_fetch", priceQuoteBasis: "bid-ask-midpoint",
        price: 1.02, confidence: "single-source", agreeSources: ["kraken"],
        candidateSources: ["kraken", "coingecko"], diagnosticPrices: { coingecko: 1.021 }, allPrices: { kraken: 1.02 },
      });
      quoteMaps.krakenPrices.set(symbol, 1.019);
      quoteMaps.krakenObservedAtBySymbol.set(symbol, nowSec - 599);
      expect(consensusFor(asset, quoteMaps)).toMatchObject({
        price: 1.019, source: "kraken", confidence: "single-source", agreeSources: ["kraken"],
        observedAt: nowSec - 599, observedAtMode: "upstream", priceQuoteBasis: "bid-ask-midpoint",
      });
      // Once the Depth book ages out (> 600s), it is rejected rather than re-clocked to local_fetch.
      quoteMaps.krakenObservedAt = nowSec + 3;
      expect(consensusFor(asset, quoteMaps, { nowSec: nowSec + 3 })).toMatchObject({
        price: 1.021, source: "coingecko", confidence: "single-source", agreeSources: ["coingecko"],
        observedAt: nowSec, observedAtMode: "upstream",
      });
    },
  );

  it("selects the dated QCAD mirror when Kraken supplies an undated trade", () => {
    const nowSec = 1_800_000_000;
    const id = "qcad-stablecorp";
    const geckoId = "stablecorp-qcad";
    const quoteMaps = emptyQuotes();
    quoteMaps.krakenPrices.set("QCAD", 0.695);
    quoteMaps.krakenObservedAt = nowSec;
    quoteMaps.krakenQuoteBasisBySymbol.set("QCAD", "last-trade");
    quoteMaps.cgQuotes.set(geckoId, { price: 0.72, observedAt: nowSec - 10, observedAtMode: "upstream" });
    const result = consensusFor({ id, name: "QCAD", symbol: "QCAD", geckoId, pegType: "peggedCAD" }, quoteMaps);
    expect(result).toMatchObject({
      price: 0.72, source: "coingecko", observedAt: nowSec - 10, observedAtMode: "upstream",
      agreeSources: ["coingecko"], allPrices: { coingecko: 0.72 }, diagnosticPrices: { kraken: 0.695 },
    });
    expect(result?.allPrices).not.toHaveProperty("kraken");
  });

  it("admits a five-day issuer NAV round and expires it one second after the configured budget", () => {
    const id = "mf-one-midas";
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
    const quoteMaps = emptyQuotes();
    quoteMaps.navPrices.set(id, quote);
    const asset = { id, name: meta.name, symbol: meta.symbol, pegType: "peggedUSD", navToken: true };
    const build = (nowSec: number) => consensusFor(asset, quoteMaps, { nowSec });
    expect(build(observedAt + quote.maxAgeSec! + 1)).toBeUndefined();
    expect(build(fetchedAt)).toMatchObject({ source: "chainlink-nav", price: 1.23, observedAt, observedAtMode: "upstream" });
  });

  it("keeps the valid native candidate through family collapse and final peg validation, only for HBD", () => {
    const nowSec = 1_800_000_000;
    const quoteMaps = emptyQuotes();
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
      const quoteMaps = emptyQuotes();
      if (input.aggregatorLegsOnly) {
        asset.geckoId = "usd-coin";
        quoteMaps.cgQuotes.set("usd-coin", { price: 0.9999, observedAt: nowSec - 30, observedAtMode: "upstream" });
      } else delete asset.geckoId;
      if (input.withIndependentLegs && !input.aggregatorLegsOnly) {
        quoteMaps.krakenPrices.set("USDC", 0.9999); quoteMaps.krakenObservedAt = nowSec - 60;
        quoteMaps.binancePrices.set("USDC", 1.0001); quoteMaps.binanceObservedAt = nowSec - 30;
      }
      const dexRows = new Map([[asset.id, { stablecoin_id: asset.id, dex_price_usd: input.dexPrice ?? 0.999936, deviation_from_primary_bps: 0, source_pool_count: 748, source_total_tvl: sourceTotalTvl, updated_at: nowSec - 1, aggregateObservedAt: input.dexAgeSec == null ? null : nowSec - input.dexAgeSec }]]) as PrimaryDexRows;
      return consensusFor(asset, quoteMaps, { dexRows, nowSec });
    }

    it("keeps a DEX aggregate older than the primary budget from ageing fresh agreement", () => {
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: true });
      expect(result?.agreeSources).not.toContain("dex-promoted");
      expect(result?.candidateSources).not.toContain("dex-promoted");
      expect(result).toMatchObject({ confidence: "high", observedAt: nowSec - 60 });
    });

    it("admits a DEX aggregate inside the strictest co-leg window as an agreeing leg", () => {
      const result = build({ dexAgeSec: 100, withIndependentLegs: true });
      expect(result?.agreeSources).toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it("keeps a DEX aggregate past a co-leg's window from failing the composite's freshness", () => {
      const result = build({ dexAgeSec: 1_200, withIndependentLegs: true, aggregatorLegsOnly: true })!;
      expect(result.candidateSources).not.toContain("dex-promoted");
      expect(result.observedAt).toBe(nowSec - 30);
      expect(validateCompositePricingSourceFreshness({ source: result.source, observedAt: result.observedAt, observedAtMode: result.observedAtMode, nowSec, requireObservedAt: true }).accepted).toBe(true);
    });

    it.each([0.999936, 0.4])("keeps an older DEX aggregate as the sole leg with its own clock ($%s)", (price) => {
      expect(build({ dexAgeSec: 3_018, withIndependentLegs: false, dexPrice: price })).toMatchObject({ source: "dex-promoted", price, confidence: "single-source", observedAt: nowSec - 3_018 });
    });

    it.each([["usdc-circle", 250_000, 60, false], ["vusd-virtue", 249_999, 60, false], ["vusd-virtue", 250_000, 4500, true], ["vusd-virtue", 250_000, 4501, false]] as const)(
      "preserves the %s aggregate tier at TVL %s and original age %s", (id, tvl, dexAgeSec, accepted) => {
        expect(build({ dexAgeSec, withIndependentLegs: false }, { ...usdc, id }, tvl) != null).toBe(accepted);
      });

    it.each([null, 21_600, 4500])("rejects original age %s despite fresh publication", (dexAgeSec) => {
      expect(build({ dexAgeSec, withIndependentLegs: false })).toBeUndefined();
      expect(build({ dexAgeSec, withIndependentLegs: true })?.candidateSources).not.toContain("dex-promoted");
    });
  });

  describe("promoted DEX protocol lane", () => {
    const nowSec = 1_793_601_977;
    const pmusd: PeggedAsset = { id: "pmusd-precious-metals", name: "Precious Metals USD", symbol: "pmUSD", geckoId: "precious-metals-usd", pegType: "peggedUSD" };
    const routePoolKey = "ethereum:0xecb0f0d68c19bdaadaebe24f6752a4db34e2c2cb", independentPoolKeys = ["ethereum:0x0000000000000000000000000000000000000001"];

    function build(laneAgeSec: number, cgPrice: number | null = 0.534161, pricePoolKeys: string[] | null = independentPoolKeys, protocol = "curve"): PrimaryPriceResult | undefined {
      const quoteMaps = emptyQuotes();
      if (cgPrice != null) quoteMaps.cgQuotes.set("precious-metals-usd", { price: cgPrice, observedAt: nowSec - 20, observedAtMode: "upstream" });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      quoteMaps.curvePricePoolKeysByCoinId.set(pmusd.id, [routePoolKey]);
      return consensusFor(pmusd, quoteMaps, { dexPriceSources: new Map([[pmusd.id, [{ protocol, chain: "ethereum", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - laneAgeSec, pricePoolKeys: pricePoolKeys ?? undefined }]]]), nowSec });
    }

    const trustOf = (r: PrimaryPriceResult) => classifyPrimaryDepegTrust({ price: r.price, priceSource: r.source, priceConfidence: r.confidence, priceObservedAt: r.observedAt, priceObservedAtMode: r.observedAtMode, agreeSources: r.agreeSources }, nowSec);

    it.each([
      ["curve", "same pool", [routePoolKey]], ["curve", "explicitly unavailable", []],
      ["uniswap-v3", "overlapping conversion pool", [...independentPoolKeys, routePoolKey]],
      ["uniswap-v3", "explicitly unavailable", []], ["uniswap-v3", "unregistered chain", ["unverified:fake-pool"]],
    ])("keeps the %s leg diagnostic-only with %s provenance", (protocol, _provenance, pricePoolKeys) => {
      const dexSource = `${protocol}-dex`, result = build(90, 0.545, pricePoolKeys, protocol);
      expect(result).toMatchObject({ source: "curve-onchain", confidence: "low", observedAt: nowSec - 30, agreeSources: ["curve-onchain"], diagnosticPrices: { [dexSource]: 0.53416 } });
      expect(result?.allPrices).not.toHaveProperty(dexSource);
      expect(result?.candidateSources).toContain(dexSource);
      expect(trustOf(result!)).toBe("confirm_required");
    });

    it("keeps the legacy DEX vote when its writer omitted pool lineage", () => {
      expect(trustOf(build(90, 0.545, null, "uniswap-v3")!)).toBe("authoritative");
    });

    it("keeps a lane past the strictest co-leg window from ageing fresh hard agreement past the depeg budget", () => {
      const result = build(2_071)!;
      expect(result).toMatchObject({ source: "coingecko+curve-onchain", confidence: "high", observedAt: nowSec - 30, candidateSources: ["coingecko", "curve-onchain", "curve-dex"] });
      expect(trustOf(result)).toBe("authoritative");
      expect(validateCompositePricingSourceFreshness({ source: result.source, observedAt: result.observedAt, observedAtMode: result.observedAtMode, nowSec, requireObservedAt: true }).accepted).toBe(true);
      expect(result.agreeSources).not.toContain("curve-dex");
    });

    it("drops a lane inside the primary budget too while the fresh legs agree", () => {
      const result = build(1_500)!;
      expect(result).toMatchObject({ source: "coingecko+curve-onchain", observedAt: nowSec - 30 });
      expect(result.candidateSources).toContain("curve-dex");
    });

    it("admits a lane inside the strictest co-leg window as an agreeing leg", () => {
      const result = build(100);
      expect(result?.agreeSources).toContain("curve-dex");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it.each([[null, false], [0.545, true]] as const)("keeps Curve agreement through missing/divergent CG (%s), dated by the older lane", (cgPrice, hasDisagree) => {
      const result = build(1_500, cgPrice)!;
      expect(result).toMatchObject({ source: "curve-dex+curve-onchain", confidence: "high", observedAt: nowSec - 1_500 });
      if (hasDisagree) expect(result.disagreeSources).toContain("coingecko");
      expect(trustOf(result)).toBe("authoritative");
    });

    it.each([
      [0.545, 0.54505, 0.53416, "curve-dex+curve-onchain", "high", nowSec - 1_500, "authoritative"],
      [0.537, 0.537, 0.535, "coingecko+defillama-list", "single-source", nowSec - 25, "confirm_required"],
    ] as const)("handles list-pair vs Curve rejoin (cg=%s lane=%s -> %s)", (cgPrice, dlPrice, lanePrice, source, confidence, observedAt, trust) => {
      const quoteMaps = emptyQuotes();
      quoteMaps.cgQuotes.set("precious-metals-usd", { price: cgPrice, observedAt: nowSec - 20, observedAtMode: "upstream" });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      quoteMaps.curvePricePoolKeysByCoinId.set(pmusd.id, [routePoolKey]);
      const results = new Map<string, PrimaryPriceResult>(), stats = createStats();
      buildPrimaryConsensusResults({
        candidates: [pmusd], quoteMaps, dexRows: new Map(), nowSec, results, stats,
        dexPriceSources: new Map([[pmusd.id, [{ protocol: "curve", chain: "ethereum", price: lanePrice, tvl: 7_684_693, updatedAt: nowSec - 1_500, pricePoolKeys: independentPoolKeys }]]]),
        resolveDlListQuote: () => ({ price: dlPrice, observedAt: nowSec - 25, observedAtMode: "upstream" }),
      });
      applyListAggregatorDowngrade(results, stats);
      const result = results.get(pmusd.id)!;
      expect(result).toMatchObject({ source, confidence, observedAt });
      expect(trustOf(result)).toBe(trust);
      if (confidence === "high") expect(result.disagreeSources).toEqual(expect.arrayContaining(["coingecko", "defillama-list"]));
      else {
        expect(result.agreeSources).not.toContain("curve-dex");
        expect(result.candidateSources).toContain("curve-dex");
        expect(validateCompositePricingSourceFreshness({ source: result.source, observedAt: result.observedAt, observedAtMode: result.observedAtMode, nowSec, requireObservedAt: true }).accepted).toBe(true);
      }
    });

    it("does not rescue a missing CoinGecko leg with a lane past the primary budget", () => {
      const result = build(2_071, null)!;
      expect(result).toMatchObject({ source: "curve-onchain", confidence: "single-source", observedAt: nowSec - 30, candidateSources: ["curve-onchain", "curve-dex"] });
      expect(trustOf(result)).toBe("confirm_required");
    });
  });

  it("does not treat two chains of one promoted DEX protocol as independent corroboration", () => {
    const nowSec = 1_800_000_000;
    const asset: PeggedAsset = { id: "cgusd-cygnus-finance", name: "Cygnus USD", symbol: "cgUSD", pegType: "peggedUSD" };
    const result = consensusFor(asset, emptyQuotes(), {
      dexPriceSources: new Map([[asset.id, ["ethereum", "base"].map((chain) => ({
        protocol: "uniswap-v3", chain, price: 0.99, tvl: 50_000, updatedAt: nowSec - 60,
      }))]]), nowSec,
    });
    expect(result).toBeUndefined();
  });

  it("quarantines CG micro-volume outliers, records R1 unknown volume, and exempts NAV", () => {
    const nowSec = 1_800_000_000, quoteMaps = emptyQuotes();
    quoteMaps.cgQuotes.set("a7a5", { price: 0.001774, observedAt: nowSec - 10, observedAtMode: "upstream", volume24hUsd: 7.06 });
    quoteMaps.cgQuotes.set("u", { price: 0.85, observedAt: nowSec - 10, observedAtMode: "upstream", volume24hUsd: null });
    quoteMaps.cgQuotes.set("n", { price: 1.4, observedAt: nowSec - 10, observedAtMode: "upstream", volume24hUsd: 5 });
    const results = new Map<string, PrimaryPriceResult>(), stats = createStats(), rejectedCgReasons = new Map<string, string>();
    const providerDiagnostics: Parameters<typeof buildPrimaryConsensusResults>[0]["providerDiagnostics"] = [];
    buildPrimaryConsensusResults({
      candidates: [
        { id: "a7a5-old-vector", name: "A7A5", symbol: "A7A5", geckoId: "a7a5", pegType: "peggedRUB" },
        { id: "u", name: "U", symbol: "U", geckoId: "u", pegType: "peggedUSD" },
        { id: "n", name: "N", symbol: "N", geckoId: "n", pegType: "peggedUSD", navToken: true },
      ],
      references: { rates: { peggedRUB: 0.01218 }, type: "fresh", updatedAt: nowSec },
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec,
      resolveDlListQuote: () => undefined, results, stats, providerDiagnostics, rejectedCgReasons,
    });
    expect(results.has("a7a5-old-vector")).toBe(false);
    expect([results.get("u")?.price, results.get("n")?.price]).toEqual([0.85, 1.4]);
    expect(rejectedCgReasons.get("a7a5-old-vector")).toBe("coingecko_micro_volume_outlier");
    expect(stats).toMatchObject({ cgMicroVolumeRejected: 1, cgVolumeUnavailable: 1, cgOnly: 2 });
    expect(providerDiagnostics[0]?.assetAttempts?.[0]).toMatchObject({ assetId: "a7a5-old-vector", result: "rejected", rejectionClass: "coingecko_micro_volume_outlier" });
  });

  it.each([
    [1.13, 0.93, null, undefined, "hive_market_divergence_veto", "vetoed"],
    [0.96, 0.93, null, 0.96, undefined, "agreed"],
    [null, 0.93, null, undefined, undefined, "no_cg_quote"],
    [1.13, null, "rpc_timeout", 1.13, undefined, "unavailable"],
  ] as const)("HBD Hive veto-only check (cg=%s hive=%s -> %s)", (cgUsd, hiveMid, unavail, expectedPrice, expectedReject, status) => {
    const nowSec = 1_800_000_000, quoteMaps = emptyQuotes();
    if (cgUsd != null) quoteMaps.cgQuotes.set("hive_dollar", { price: cgUsd, observedAt: nowSec - 10, observedAtMode: "upstream", volume24hUsd: 200_000 });
    if (hiveMid != null) quoteMaps.hiveVetoMid = { price: hiveMid, observedAt: nowSec - 5, observedAtMode: "local_fetch", admittedForPublication: false, rejectionReason: "insufficient_depth" };
    quoteMaps.hiveVetoUnavailableReason = unavail;
    const nativeMarket = { vetoStatus: null as string | null, vetoReason: null as string | null, vetoDivergenceBps: null as number | null };
    const results = new Map<string, PrimaryPriceResult>(), stats = createStats(), rejectedCgReasons = new Map<string, string>();
    buildPrimaryConsensusResults({
      candidates: [{ id: "hbd-hive", name: "HBD", symbol: "HBD", geckoId: "hive_dollar", pegType: "peggedUSD" }],
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec, resolveDlListQuote: () => undefined,
      results, stats, rejectedCgReasons,
      providerDiagnostics: [{ source: "hive-native-cg", stage: "primary", endpoint: "api.hive.blog", status: null, ok: true, success: false, nativeMarket: nativeMarket as never }],
    });
    expect(results.get("hbd-hive")?.price).toBe(expectedPrice);
    expect(rejectedCgReasons.get("hbd-hive")).toBe(expectedReject);
    expect(nativeMarket.vetoStatus).toBe(status);
    if (status === "unavailable") expect(stats.hiveVetoUnavailable).toBe(1);
    if (status === "vetoed") expect(stats.hiveDivergenceVetoed).toBe(1);
  });
});
