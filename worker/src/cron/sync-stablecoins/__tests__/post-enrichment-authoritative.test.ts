import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { savePriceCache, getPriceCache } from "../../../lib/price-cache";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createValidationContextResolver, applyConsensusResults, buildPreviousTrustedPriceLookup, prevalidatePrices } from "../pricing";
import { runSharedPriceCompletion } from "../post-enrichment";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";
import { createAuthoritativeLivePriceOverrideStats } from "../../../lib/authoritative-price-sources";
import { loadOpenConfirmedDepegs } from "../../../lib/open-confirmed-depegs";
import { MAX_OPEN_DEPEG_EVENTS } from "../../../lib/depeg-threshold-policy";
import { classifyPrimaryDepegTrust } from "../../../lib/depeg-trust-policy";
import { writePriceCorroborationObservations } from "../price-corroboration-observations";
import { normalizeStablecoinsPayload } from "../shared";


const authoritativeMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("../../../lib/authoritative-price-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/authoritative-price-sources")>();
  return {
    ...actual,
    fetchAuthoritativeLivePriceOverrides: authoritativeMocks.fetch,
  };
});

describe("runSharedPriceCompletion authoritative repair", () => {
  beforeEach(() => {
    authoritativeMocks.fetch.mockReset().mockResolvedValue(new Map());
  });

  it("re-resolves local authoritative dependencies after fallback without repeating RPC providers", async () => {
    authoritativeMocks.fetch.mockResolvedValueOnce(new Map([["usdn-noble", { price: 0.9998, source: "protocol-redeem", confidence: "high", observedAt: 1_800_000_000, observedAtMode: "local_fetch" }]]));
    const asset: PeggedAsset = { id: "usdn-noble", name: "Noble Dollar", symbol: "USDN", pegType: "peggedUSD", price: null };
    const chainRpcs = new Map();
    const initialOverrides = new Map();
    const result = await runSharedPriceCompletion({
      assets: [asset], db: mockD1([]), syncStartSec: 1_800_000_000, validationContexts: createValidationContextResolver(),
      authoritativeOverrides: initialOverrides, chainRpcs, authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(), priceCache: new Map(),
    }, "");
    expect(authoritativeMocks.fetch).toHaveBeenCalledOnce();
    expect(authoritativeMocks.fetch).toHaveBeenCalledWith([asset], undefined, undefined, expect.objectContaining({ localRepairOnly: true, chainRpcs }));
    expect(asset).toMatchObject({ price: 0.9998, priceSource: "protocol-redeem", priceConfidence: "high" });
    expect(result).toMatchObject({ authoritativeOverrideCount: 1 });
    expect(initialOverrides.size).toBe(0);
  });

  it("reuses the loaded replay snapshot without another D1 price-cache read", async () => {
    const now = Math.floor(Date.now() / 1000);
    const asset: PeggedAsset = { id: "fixture-usd", name: "Fixture", symbol: "FIX", pegType: "peggedUSD", price: null };
    // Strict D1 has only the corroboration read; a replay-table reload would fail.
    const db = mockD1([{ match: "FROM cache", rows: [] }]);
    const result = await runSharedPriceCompletion({
      assets: [asset], db, syncStartSec: now, validationContexts: createValidationContextResolver(),
      authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
      priceCache: new Map([[asset.id, {
        price: 1, updatedAt: now - 30, source: "coingecko", confidence: "single-source",
        observedAt: now - 30, observedAtMode: "upstream", syncedAt: now - 30,
      }]]),
    }, "");
    expect(result).toMatchObject({ cachedFallbackCount: 1 });
    expect(asset).toMatchObject({ price: 1, priceSource: "cached", priceConfidence: "fallback", priceObservedAt: now - 30 });
  });

  it("publishes a clockless MONEY cache row with only its collection clock", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      const asset: PeggedAsset = { id: "money-defi-money", name: "MONEY", symbol: "MONEY", pegType: "peggedUSD", price: null };
      await savePriceCache(db, [{ id: asset.id, price: 0.998, source: "coingecko-low-volume", confidence: "fallback",
        observedAt: null, observedAtMode: "unknown", syncedAt: now - 60 }]);
      const result = await runSharedPriceCompletion({ assets: [asset], db, syncStartSec: now,
        validationContexts: createValidationContextResolver(), authoritativeOverrides: new Map(),
        authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(), priceCache: await getPriceCache(db),
      }, "");
      expect(result).toMatchObject({ cachedFallbackCount: 1 });
      expect(asset).toMatchObject({ price: 0.998, priceObservedAt: null, priceUpdatedAt: null, priceSyncedAt: now - 60 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["defillama", "unknown", 60, false],
    ["chainlink-nav", "upstream", 5 * 86_400, true],
    ["chainlink-nav", "upstream", 48 * 3600, false],
  ] as const)("replays %s only within its original observation policy", async (source, mode, age, accepted) => {
    const now = Math.floor(Date.now() / 1000);
    const id = source === "defillama" ? "usdt-tether" : accepted ? "mre7yield-midas" : "eutbl-spiko";
    const asset: PeggedAsset = { id, name: id, symbol: id, pegType: id === "eutbl-spiko" ? "peggedEUR" : "peggedUSD", price: null };
    const observedAt = now - age;
    const result = await runSharedPriceCompletion({
      assets: [asset], db: mockD1([{ match: "FROM cache", rows: [] }]), syncStartSec: now,
      validationContexts: createValidationContextResolver(),
      authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
      priceCache: new Map([[id, {
        price: 1.001, updatedAt: observedAt, source, confidence: "single-source",
        observedAt, observedAtMode: mode, syncedAt: observedAt, hasExplicitClocks: true,
      }]]),
    }, "");
    expect(result).toMatchObject({ cachedFallbackCount: Number(accepted) });
    if (accepted) expect(asset).toMatchObject({ priceSource: "cached", priceObservedAt: observedAt, priceUpdatedAt: observedAt });
    else expect(asset.price).toBeNull();
  });

  it("withholds an uncorroborated AZND Curve exact-pool override", async () => {
    const asset: PeggedAsset = { id: "aznd-mu-digital", name: "Anzen USDz NZD", symbol: "AZND", pegType: "peggedUSD", price: null };
    const result = await runSharedPriceCompletion({
      assets: [asset], db: mockD1([]), syncStartSec: 1_800_000_000, validationContexts: createValidationContextResolver(),
      authoritativeOverrides: new Map([[asset.id, { price: 0.194, source: "curve-thin-onchain", confidence: "fallback", observedAt: 1_799_999_940, observedAtMode: "upstream" }]]),
      previousTrustedPrices: new Map([[asset.id, { price: 1, source: "pyth", confidence: "high", observedAt: 1_799_000_000, agreeSources: ["pyth"] }]]),
      authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(), priceCache: new Map(),
    }, "");
    expect("authoritativeOverrideStats" in result).toBe(true);
    if (!("authoritativeOverrideStats" in result)) throw new Error("Expected shared price completion result");
    expect(result).toMatchObject({ authoritativeOverrideCount: 0, rejectedCount: 0 });
    expect(result.authoritativeOverrideStats.assetAttempts).toEqual([
      expect.objectContaining({ assetId: asset.id, adapter: "curve-thin-onchain", source: "curve-thin-onchain", state: "attempted", result: "rejected", rejectionClass: "severe_downside_requires_corroboration" }),
    ]);
    expect(asset.price).toBeNull();
    expect(asset.priceSource).toBeUndefined();
  });

  it("loads open confirmed depegs fail-closed and publishes low-confidence continuity without caching or trust", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare(
        `INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source)
         VALUES (1,'pmusd-raac','pmUSD','peggedUSD','below',-5920,?,NULL,0.408,1,'live'),(2,'deadzone-usd','DZN','peggedUSD','below',-2500,?,NULL,0.75,1,'live'),
                (3,'closed-coin','CLS','peggedUSD','below',-500,1000,2000,0.95,1,'live'),(4,'disputed-coin','DSP','peggedUSD','below',-500,1000,NULL,0.95,1,'live'),
                (5,'flip-coin','FLP','peggedUSD','above',300,1000,NULL,1.03,1,'live'),(6,'flip-coin','FLP','peggedUSD','below',-400,2000,NULL,0.96,1,'live')`,
      ).run(now - 86_400, now - 86_400);
      sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (4,'live','disputed',1000,1000)").run();
      sqlite.prepare(
        "INSERT INTO depeg_pending (stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, last_seen_bps, last_seen_at, last_price, peg_reference, reason) VALUES ('pending-only','PND','peggedUSD','below',-5500,1500,0.45,-5500,1500,0.45,1,'confirmation-window')",
      ).run();
      await writePriceCorroborationObservations(db, [
        { id: "pmusd-raac", source: "defillama-contract", price: 0.408, observedAt: now - 60, observedAtMode: "upstream" },
        { id: "deadzone-usd", source: "dexscreener-exact", chain: "ethereum", target: "0xpool", price: 0.75, recentActivity: { evidence: "positive-volume-m5", collectedAt: now - 60 }, observedAt: null, observedAtMode: "unknown" },
        { id: "pending-only", source: "defillama-contract", price: 0.408, observedAt: now - 60, observedAtMode: "upstream" },
      ], now - 60);

      const openDepegs = await loadOpenConfirmedDepegs(db);
      expect(openDepegs).toMatchObject({ status: "ok", openEventCount: 4 });
      expect(Object.fromEntries(openDepegs.byId)).toEqual({ "pmusd-raac": { direction: "below" }, "deadzone-usd": { direction: "below" }, "flip-coin": { direction: "below" } });
      expect(await loadOpenConfirmedDepegs({ prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database)).toEqual({
        status: "unavailable", reason: "open-depeg-read-failed", byId: new Map(), openEventCount: null,
      });
      expect(await loadOpenConfirmedDepegs(mockD1([{
        match: "FROM depeg_events",
        rows: Array.from({ length: MAX_OPEN_DEPEG_EVENTS }, (_, i) => ({ id: i + 1, stablecoin_id: `c-${i}`, direction: "below", started_at: 1000 + i, audit_verdict: null })),
      }]))).toEqual({ status: "unavailable", reason: "open-depeg-limit-reached", byId: new Map(), openEventCount: null });

      const row = (id: string): PeggedAsset => ({ id, name: id, symbol: id.toUpperCase(), pegType: "peggedUSD", price: null });
      const prim = (price: number, allPrices: Record<string, number>, source = "coingecko+defillama-list"): PrimaryPriceResult => ({
        price, source, selectedSource: "coingecko", confidence: "single-source", dlPrice: allPrices["defillama-list"] ?? null, cgPrice: allPrices.coingecko ?? null,
        candidateSources: Object.keys(allPrices), agreeSources: Object.keys(allPrices), allPrices, observedAt: now - 30, observedAtMode: "upstream",
      });
      const ctx = createValidationContextResolver();
      const base = { db, syncStartSec: now, validationContexts: ctx, openConfirmedDepegs: openDepegs.byId, authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(), priceCache: new Map() };

      const pAsset = row("pmusd-raac");
      const pMap = new Map([["pmusd-raac", prim(0.40765, { coingecko: 0.4078, "defillama-list": 0.4075 })]]);
      applyConsensusResults({ assets: [pAsset], primaryPriceResults: pMap, openConfirmedDepegs: openDepegs.byId, validationContexts: ctx, syncStartSec: now, reason: "primary" });
      prevalidatePrices({ assets: [pAsset], primaryPriceResults: pMap, openConfirmedDepegs: openDepegs.byId, validationContexts: ctx, logLabel: "Pre-reject" });
      const pDone = await runSharedPriceCompletion({ ...base, assets: [pAsset], primaryPriceResults: pMap }, "");
      expect("priceCacheEntries" in pDone && pDone.priceCacheEntries).toEqual([]);
      expect(pAsset).toMatchObject({ price: 0.40765, priceConfidence: "low", pricePublicationReason: "open-confirmed-depeg-continuity" });
      expect(classifyPrimaryDepegTrust(pAsset, now)).toBe("confirm_required");
      expect(buildPreviousTrustedPriceLookup(new Map([[pAsset.id, pAsset]]), now).size).toBe(0);
      expect(normalizeStablecoinsPayload({ peggedAssets: [pAsset] }).peggedAssets[0]).toMatchObject({ priceConfidence: "low", pricePublicationReason: "open-confirmed-depeg-continuity" });

      const [fAsset, dzAsset, pendAsset] = [row("pmusd-raac"), row("deadzone-usd"), row("pending-only")];
      const sMap = new Map([["pmusd-raac", prim(0.4078, { coingecko: 0.4078 }, "coingecko")], ["deadzone-usd", prim(0.76, { coingecko: 0.76 }, "coingecko")], ["pending-only", prim(0.4078, { coingecko: 0.4078 }, "coingecko")]]);
      const sDone = await runSharedPriceCompletion({ ...base, assets: [fAsset, dzAsset, pendAsset], primaryPriceResults: sMap }, "");
      expect("priceCacheEntries" in sDone && sDone.priceCacheEntries).toEqual([]);
      expect(fAsset).toMatchObject({ price: 0.408, priceSource: "defillama-contract", priceConfidence: "low", pricePublicationReason: "open-confirmed-depeg-continuity" });
      expect(dzAsset).toMatchObject({ price: 0.75, priceSource: "dexscreener-exact", priceConfidence: "low", pricePublicationReason: "open-confirmed-depeg-continuity" });
      expect(pendAsset.price).toBeNull();
      expect(classifyPrimaryDepegTrust(fAsset, now)).toBe("confirm_required");
      expect(classifyPrimaryDepegTrust(dzAsset, now)).toBe("confirm_required");
    } finally {
      sqlite.close();
    }
  });
});
