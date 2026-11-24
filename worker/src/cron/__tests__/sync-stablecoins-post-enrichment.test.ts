import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { normalizeStablecoinsPayload } from "../sync-stablecoins/shared";
import {
  loadPriceCorroborationObservations,
  writePriceCorroborationObservations,
} from "../sync-stablecoins/price-corroboration-observations";
import * as detection from "../detect-depegs";
import * as confirmation from "../confirm-pending-depegs";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";
import { isAbortResult, runDepegPipeline, runPostEnrichmentPricePipeline } from "../sync-stablecoins/post-enrichment";
import type { PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import { buildPriceValidationContext, type PriceValidationContext } from "../../lib/price-validation";
import { createAuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";
import { computePriceConsensus } from "../../lib/price-consensus";
import { applyConsensusResults, prevalidatePrices, type PrimaryPriceWithFiatPremiumEvidence } from "../sync-stablecoins/pricing";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function makeValidationContext(asset: PeggedAsset): PriceValidationContext {
  return buildPriceValidationContext({
    stablecoinId: asset.id,
    pegType: asset.pegType,
    navToken: asset.navToken,
    commodityOunces: asset.commodityOunces,
  });
}

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    id: "eurc-circle",
    name: "EURC",
    symbol: "EURC",
    geckoId: "euro-coin",
    pegType: "peggedEUR",
    pegMechanism: "fiat-backed",
    circulating: { peggedEUR: 1_000_000 },
    price: 1.12,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceObservedAt: 1_700_000_000,
    priceObservedAtMode: "upstream",
    navToken: false,
    ...overrides,
  });
}

function pipelineInput(
  asset: PeggedAsset,
  db: D1Database = mockD1(),
): Parameters<typeof runPostEnrichmentPricePipeline>[0] {
  return {
    assets: [asset], db, syncStartSec: 1_700_000_050,
    validationReferences: {
      rates: { peggedEUR: 1.08 }, type: "fresh", updatedAt: 1_700_000_000,
      typeByPeg: { peggedEUR: "fresh" },
    },
    validationContexts: { get: makeValidationContext },
    previousTrustedPrices: new Map(), priceCache: new Map(),
    authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
  };
}

const depegCensus = {
  scope: "psi-non-nav-before-supply-floor" as const,
  evaluatedAt: 1_700_000_000,
  eligibleCount: 3,
  observedCount: 1,
  unavailableCount: 2,
  belowFloorCount: 0,
  reasonCounts: { "asset-absent": 1, "primary-unusable": 1 },
};

describe("runDepegPipeline capacity holds", () => {
  it.each(["detection", "confirmation"] as const)("propagates %s holds independently of thrown errors", async (stage) => {
    const detect = vi.spyOn(detection, "detectDepegEvents").mockResolvedValue({ status: "completed", census: depegCensus });
    const confirm = vi.spyOn(confirmation, "confirmPendingDepegs").mockResolvedValue({ status: "completed", providerDiagnostics: [] });
    const held = { status: "held", reason: "depeg-open-event-limit-reached" } as const;
    if (stage === "detection") detect.mockResolvedValue({ ...held, census: null });
    else confirm.mockResolvedValue({ ...held, providerDiagnostics: [] });
    try {
      const result = await runDepegPipeline(mockD1(), [], undefined, undefined, undefined, "", "");
      expect(result).toMatchObject({
        depegHeldReason: "depeg-open-event-limit-reached", depegErrorCount: 0, depegErrors: [],
      });
      expect(result).toMatchObject(stage === "detection"
        ? { depegObservation: null, depegObservationUnavailableReason: "depeg-open-event-limit-reached" }
        : { depegObservation: depegCensus });
      if (stage === "confirmation") expect(result).not.toHaveProperty("depegObservationUnavailableReason");
    } finally {
      detect.mockRestore();
      confirm.mockRestore();
    }
  });

  it("keeps a late detector hold's completed census and names detector errors", async () => {
    const detect = vi.spyOn(detection, "detectDepegEvents")
      .mockResolvedValueOnce({ status: "held", reason: "depeg-open-event-limit-reached", census: depegCensus })
      .mockRejectedValueOnce(new Error("boom"));
    const confirm = vi.spyOn(confirmation, "confirmPendingDepegs").mockResolvedValue({ status: "completed", providerDiagnostics: [] });
    try {
      const late = await runDepegPipeline(mockD1(), [], undefined, undefined, undefined, "", "");
      expect(late).toMatchObject({ depegHeldReason: "depeg-open-event-limit-reached", depegObservation: depegCensus });
      expect(late).not.toHaveProperty("depegObservationUnavailableReason");
      await expect(runDepegPipeline(mockD1(), [], undefined, undefined, undefined, "", "")).resolves.toMatchObject({
        depegErrorCount: 1, depegObservation: null, depegObservationUnavailableReason: "depeg-detection-error",
      });
    } finally {
      detect.mockRestore();
      confirm.mockRestore();
    }
  });
});

describe("runPostEnrichmentPricePipeline", () => {
  it.each([
    ["gbpm-mento", "peggedGBP", 1.32, "coingecko-low-volume", 40 * 3600, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 1200, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coingecko-low-volume", 8 * 86400, 900, false],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 3601, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 7292, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 8401, 900, false],
    ["usdt-tether", "peggedUSD", 1, "coingecko-onchain-address", 901, 900, false],
    ["usdt-tether", "peggedUSD", 0.998, "defillama-contract", 2 * 3600, 900, true],
    ["usdt-tether", "peggedUSD", 0.998, "defillama-contract", 3 * 3600 + 60, 900, false],
    ["gbpm-mento", "peggedGBP", 1.32, "coingecko-low-volume", 41 * 3600, 3601, true],
    ["usdt-tether", "peggedUSD", 1, "coingecko-low-volume", 40 * 3600, 4501, false],
    ["usdt-tether", "peggedUSD", 1, "cached", 60, 30, false],
    ["usdt-tether", "peggedUSD", 0.45, "coinmarketcap", 60, 30, false],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", -60, 30, false],
  ] as const)("revalidates staged %s %s %s %s evidence aged %s with stage age %s", async (
    id, pegType, price, source, observationAge, stageAge, accepted,
  ) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const asset = makeAsset({ id, pegType, price: null, priceSource: undefined, priceConfidence: null });
    try {
      await writePriceCorroborationObservations(db, [{
        id, source, price, observedAt: now - observationAge, observedAtMode: "upstream",
      }], now - stageAge);
      const result = await runPostEnrichmentPricePipeline({
        assets: [asset], db, syncStartSec: now,
        priceCache: new Map(), validationContexts: { get: makeValidationContext },
        validationReferences: { rates: { [pegType]: pegType === "peggedUSD" ? 1 : price }, type: "fresh", updatedAt: now },
        previousTrustedPrices: new Map(),
        authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
      }, "");
      expect(isAbortResult(result)).toBe(false);
      const normalized = normalizeStablecoinsPayload({ peggedAssets: [asset] }).peggedAssets[0]!;
      expect(normalized.price).toBe(accepted ? price : null);
      if (accepted) {
        expect(normalized.priceSource).toBe(source);
        expect(normalized.priceConfidence).toBe("fallback");
        expect(normalized.priceObservedAt).toBe(now - observationAge);
      }
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });

  it("accounts for superseded observations without changing already-priced assets", async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const missing = makeAsset({ id: "usdt-tether", pegType: "peggedUSD", price: null });
    const priced = makeAsset({ id: "usdc-circle", pegType: "peggedUSD", price: 1 });
    const observation = (id: string, price = 1) => ({
      id, source: "coinmarketcap", price, observedAt: now - 60, observedAtMode: "upstream" as const,
    });
    try {
      await writePriceCorroborationObservations(db, [
        { ...observation(missing.id, 0.45), observedAt: now - 120 }, observation(missing.id), { ...observation(missing.id, 1.001), observedAt: now - 90 },
        observation(priced.id), observation("absent"),
        { ...observation(missing.id), source: "cached" },
        { ...observation(missing.id), observedAt: null },
        { ...observation(missing.id), observedAt: now + 1 },
        { ...observation(missing.id), observedAt: now - 3600 },
      ], now - 30);
      const result = await runPostEnrichmentPricePipeline({
        ...pipelineInput(missing, db), assets: [missing, priced], priceCache: new Map(),
      }, "");
      if (isAbortResult(result)) throw new Error("unexpected abort");
      expect(missing.price).toBe(1);
      expect(missing.priceSource).toBe("coinmarketcap");
      expect(priced.price).toBe(1);
      expect(priced.priceSource).toBe("coingecko");
      expect(result.cachedFallbackCount).toBe(1);
      expect(result.priceObservationEffectiveness).toEqual({
        stagingStatus: "ok", stagingSlotStartedAt: now - 30, stagingAgeSec: 30, hourlyStagingStatus: "ok", dexStagingStatus: "missing",
        loadedObservationCount: 9, eligibleObservationCount: 3,
        discarded: { sourceIneligible: 1, unknownTime: 1, futureTime: 1, sourceExpired: 0, superseded: 3 },
        publication: { alreadyPriced: 1, assetAbsent: 1, policyRejected: 0, selected: 1, notNeededAfterSelection: 0 },
        minimumFreshnessHeadroomSec: 8340,
      });
      const effectiveness = result.priceObservationEffectiveness!;
      expect(Object.values(effectiveness.discarded).reduce((sum, count) => sum + count, 0)
        + effectiveness.eligibleObservationCount).toBe(effectiveness.loadedObservationCount);
      expect(Object.values(effectiveness.publication).reduce((sum, count) => sum + count, 0))
        .toBe(effectiveness.eligibleObservationCount);
      // Even with no missing assets, the read measures observations that are not needed.
      const second = await runPostEnrichmentPricePipeline({
        ...pipelineInput(priced, db), priceCache: new Map(),
      }, "");
      if (isAbortResult(second)) throw new Error("unexpected abort");
      expect(second.priceObservationEffectiveness?.publication).toEqual({
        alreadyPriced: 1, assetAbsent: 2, policyRejected: 0, selected: 0, notNeededAfterSelection: 0,
      });
      expect(second.cachedFallbackCount).toBe(0);
      // Repeated staged defillama-contract placeholders across unrelated assets are rejected via policyRejected.
      const nusd = makeAsset({ id: "nusd-nexus", pegType: "peggedUSD", price: null, priceSource: undefined, priceConfidence: null });
      const usdu = makeAsset({ id: "usdu-usdu-finance", pegType: "peggedUSD", price: null, priceSource: undefined, priceConfidence: null });
      const ausd = makeAsset({ id: "ausd-agora", pegType: "peggedUSD", price: null, priceSource: undefined, priceConfidence: null });
      const iusd = makeAsset({ id: "iusd-initia", pegType: "peggedUSD", price: null, priceSource: undefined, priceConfidence: null });
      await writePriceCorroborationObservations(db, [
        { id: nusd.id, source: "defillama-contract", price: 0.99987355779, observedAt: now - 120, observedAtMode: "upstream" },
        { id: usdu.id, source: "defillama-contract", price: 0.99987355779, observedAt: now - 120, observedAtMode: "upstream" },
        { id: ausd.id, source: "defillama-contract", price: 0.999746, observedAt: now - 120, observedAtMode: "upstream" },
        { id: iusd.id, source: "defillama-contract", price: 0.999746, observedAt: now - 120, observedAtMode: "upstream" },
      ], now - 10);
      const fillResult = await runPostEnrichmentPricePipeline({
        ...pipelineInput(nusd, db), assets: [nusd, usdu, ausd, iusd], priceCache: new Map(),
      }, "");
      if (isAbortResult(fillResult)) throw new Error("unexpected abort");
      expect(nusd.price).toBeNull();
      expect(usdu.price).toBeNull();
      expect(ausd.price).toBe(0.999746);
      expect(iusd.price).toBe(0.999746);
      expect(fillResult.priceObservationEffectiveness?.publication).toEqual({
        alreadyPriced: 0, assetAbsent: 0, policyRejected: 2, selected: 2, notNeededAfterSelection: 0,
      });
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });

  it.each([
    [null, 1000, "missing"],
    ["[]", 1002, "future"],
    ["[]", 1001 - 4500, "expired"],
    ["not-json", 1000, "invalid"],
    ['[{"id":"bad"}]', 1000, "invalid"],
    ["[]", 1000, "ok"],
  ] as const)("reports staging state for %s at %s", async (value, slot, status) => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    if (value !== null) sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run("price:corroboration-observations:v1", value, slot);
    try {
      const result = await loadPriceCorroborationObservations(createSqliteD1(sqlite), 1001);
      expect(result.byId.size).toBe(0);
      expect(result.summary.stagingStatus).toBe(status);
      expect(result.summary.loadedObservationCount).toBe(status === "ok" ? 0 : null);
    } finally {
      sqlite.close();
    }
  });

  it("reports cache read errors but propagates cancellation", async () => {
    const db = { prepare: () => { throw new Error("private database error"); } } as unknown as D1Database;
    expect((await loadPriceCorroborationObservations(db, 1001)).summary).toMatchObject({
      stagingStatus: "read-error", loadedObservationCount: null,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(loadPriceCorroborationObservations(db, 1001, controller.signal)).rejects.toThrow();
  });

  it("clears an empty hourly collection and rejects an older stage writer", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const rows = [{ id: "usdt-tether", source: "coinmarketcap", price: 1, observedAt: 1000, observedAtMode: "upstream" as const }];
    try {
      await writePriceCorroborationObservations(db, rows, 1000);
      expect((await loadPriceCorroborationObservations(db, 1001)).byId.size).toBe(1);
      await writePriceCorroborationObservations(db, [], 1002);
      await writePriceCorroborationObservations(db, rows, 1001);
      expect((await loadPriceCorroborationObservations(db, 1003)).byId.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it.each([true, false])("publishes BRZ pool-backed premiums when upstreams are independent (%s)", async (independent) => {
    const asset = makeAsset({ id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", price: null });
    const premium = 0.2 * 1.23, syncStartSec = Math.floor(Date.now() / 1000), sources = ["curve-dex", "uniswap-v3-dex"], observedAt = syncStartSec - 60;
    const consensus = computePriceConsensus(sources.map((source) => ({ source, price: premium, observedAt, observedAtMode: "upstream", weight: 1 })), 0.2, 50)!;
    const input = {
      ...pipelineInput(asset),
      syncStartSec,
      validationReferences: { rates: { peggedREAL: 0.2 }, type: "fresh" as const, updatedAt: observedAt },
      primaryPriceResults: new Map<string, PrimaryPriceWithFiatPremiumEvidence>([[asset.id, {
        ...consensus, dlPrice: null, cgPrice: null, candidateSources: sources,
        fiatPremiumEvidence: {
          "curve-dex": { priceUsd: premium, observedAtSec: observedAt, upstreamKeys: ["ethereum:pool-a"] },
          "uniswap-v3-dex": { priceUsd: premium, observedAtSec: observedAt, upstreamKeys: [independent ? "ethereum:pool-b" : "ethereum:pool-a"] },
        },
      }]]),
    };
    applyConsensusResults({ ...input, reason: "primary" });
    expect(asset.price).toBe(independent ? premium : null);
    prevalidatePrices({ ...input, logLabel: "premium test" });
    const result = await runPostEnrichmentPricePipeline(input, "");

    expect(result).toMatchObject({ rejectedCount: 0 });
    expect(asset.price).toBe(independent ? premium : null);
  });

  it("stages replay-safe prices without writing price_cache before canonical publication", async () => {
    const asset = makeAsset({
      id: "usdc-circle", symbol: "USDC", price: 0.9998, pegType: "peggedUSD",
      priceSyncedAt: 1_700_000_050, agreeSources: ["coingecko"], consensusSources: ["coingecko"],
    });
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO price_cache (asset_id, price, updated_at) VALUES ('usdc-circle', 1.01, 100)");
    const stored = () => sqlite.prepare("SELECT * FROM price_cache").all();
    const incumbent = stored();

    const result = await runPostEnrichmentPricePipeline({
      ...pipelineInput(asset, db),
      validationReferences: undefined,
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) throw new Error("unexpected abort result");
    expect(result.priceCacheEntries).toEqual([{
      id: "usdc-circle", price: 0.9998, source: "coingecko", confidence: "single-source",
      observedAt: 1_700_000_000, observedAtMode: "upstream", syncedAt: 1_700_000_050,
      agreeSources: ["coingecko"], consensusSources: ["coingecko"],
    }]);
    expect(stored()).toEqual(incumbent);
  });

  it("keeps a severe USX fallback when same-run CoinGecko and DexScreener quotes corroborate it", async () => {
    const asset = makeAsset({
      id: "usx-dforce",
      name: "dForce USD",
      symbol: "USX",
      geckoId: "token-dforce-usd",
      pegType: "peggedUSD",
      price: 0.3904,
      priceSource: "dexscreener-exact",
      priceConfidence: "fallback",
      consensusSources: ["dexscreener-exact"],
      agreeSources: ["dexscreener-exact"],
    });
    const primaryPriceResults = new Map<string, PrimaryPriceResult>([
      ["usx-dforce", {
        price: 0.390247,
        source: "coingecko",
        selectedSource: "coingecko",
        confidence: "single-source",
        dlPrice: null,
        cgPrice: 0.390247,
        candidateSources: ["coingecko"],
        agreeSources: ["coingecko"],
        allPrices: { coingecko: 0.390247 },
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
      }],
    ]);

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      db: mockD1(),
      syncStartSec: 1_700_000_050,
      validationContexts: { get: makeValidationContext },
      primaryPriceResults,
      previousTrustedPrices: new Map(),
      priceCache: new Map(), authoritativeOverrides: new Map(),
      authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.rejectedCount).toBe(0);
    expect(asset.price).toBe(0.3904);
    expect(asset.priceSource).toBe("dexscreener-exact");
  });

  // CR-43 / m6: pre-6.38 par rows (`protocol-redeem`) are never rewritten once a route
  // publishes nominal references, so the cached-fallback lane must age them out on the
  // source's own 15-minute registry budget, measured from the row's write clock.
  it.each([
    [899, 1.27],
    [900, null],
    [84 * 86_400, null],
  ] as const)("republishes a legacy protocol-redeem par row aged %ss only inside its budget", async (ageSec, expected) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const asset = makeAsset({
      id: "chfau-allunity", symbol: "CHFAU", geckoId: undefined, pegType: "peggedCHF", circulating: { peggedCHF: 6_300_000 },
      price: null, priceSource: undefined, priceConfidence: null, priceObservedAt: null, priceObservedAtMode: null,
    });
    const legacyParRow = {
      price: 1.27, updatedAt: now - ageSec, source: "protocol-redeem", confidence: "high" as const,
      observedAt: now - ageSec, observedAtMode: "local_fetch" as const, syncedAt: now - ageSec,
      agreeSources: ["protocol-redeem"], consensusSources: ["protocol-redeem"],
    };
    try {
      const result = await runPostEnrichmentPricePipeline({
        assets: [asset], db: createSqliteD1(sqlite), syncStartSec: now,
        priceCache: new Map([[asset.id, legacyParRow]]), validationContexts: { get: makeValidationContext },
        validationReferences: { rates: { peggedCHF: 1.27 }, type: "fresh", updatedAt: now, typeByPeg: { peggedCHF: "fresh" } },
        previousTrustedPrices: new Map(),
        authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
      }, "");
      if (isAbortResult(result)) throw new Error("unexpected abort");
      expect(asset.price ?? null).toBe(expected);
      if (expected != null) expect(asset).toMatchObject({ priceSource: "cached", priceConfidence: "fallback" });
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });

  it.each([
    [1.13, null],
    [0.96, 0.96],
  ] as const)("applies HBD Hive veto to cached/staged CoinGecko fallbacks ($%s -> %s)", async (cgPrice, expected) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    await writePriceCorroborationObservations(db, [{
      id: "hbd-hive", source: "coingecko-low-volume", price: cgPrice, observedAt: now - 60, observedAtMode: "upstream",
    }], now);
    const asset = makeAsset({ id: "hbd-hive", symbol: "HBD", geckoId: "hive_dollar", pegType: "peggedUSD",
      circulating: { peggedUSD: 9_800_000 }, price: null, priceSource: undefined, priceConfidence: null, priceObservedAt: null, priceObservedAtMode: null });
    try {
      const result = await runPostEnrichmentPricePipeline({
        assets: [asset], db, syncStartSec: now, hiveVetoPrice: 0.93,
        priceCache: new Map([["hbd-hive", { price: cgPrice, updatedAt: now - 60, source: "coingecko", confidence: "single-source",
          observedAt: now - 60, observedAtMode: "upstream", syncedAt: now - 60, agreeSources: ["coingecko"], consensusSources: ["coingecko"] }]]),
        validationContexts: { get: makeValidationContext }, previousTrustedPrices: new Map(),
        authoritativeOverrides: new Map(), authoritativeOverrideStats: createAuthoritativeLivePriceOverrideStats(),
      }, "");
      if (isAbortResult(result)) throw new Error("unexpected abort");
      expect(asset.price ?? null).toBe(expected);
      if (expected == null) expect(result.priceObservationEffectiveness?.publication.policyRejected).toBe(1);
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });
});
