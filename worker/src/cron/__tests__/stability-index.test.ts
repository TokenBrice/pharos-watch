import type { StablecoinData } from "@shared/types/supply";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stablecoins-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/stablecoins-cache")>(),
  loadStablecoinsCache: vi.fn(),
}));

import { loadStablecoinsCache, type StablecoinsCacheLoadOk } from "../../lib/stablecoins-cache";
import { validateAndWriteStablecoinsCache } from "../sync-stablecoins/cache-publication";
import { computeAndStoreStabilityIndex } from "../stability-index";
import * as fxRateState from "../../lib/fx-rate-state";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import { persistActiveNativeEventQuotes, NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import type { NativePegQuote } from "../../lib/native-peg-quotes";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";
import { computeStabilityIndex, getDepreciationFactor } from "../../lib/stability-index";
import { computePsiDepegContribution } from "@shared/lib/psi-contribution";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { PSI_HISTORICAL_IDS } from "@shared/lib/psi-historical-assets";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";

const fixtures = createLatestSchemaFixtureTracker();
const CNGN_ID = "cngn-compliant-naira";

interface TestDb extends D1Database {
  sqlite: DatabaseSync;
}

interface PsiSnapshot {
  contributors: Array<{ id: string; bps: number; mcapUsd: number; factor: number; ageDays: number }>;
  referenceScoringMode: "legacy" | "per-observation";
  referenceAdmissions: Record<string, { status: string }>;
  totalMcapUsd: number;
  mcap7dChangePct: number;
  dewsStressBreadth: number;
  degradedComponents: string[];
  openDepegsWithoutPrice: number;
  replayPriceFallbackCount: number;
  depegCount: number;
  carriedSupplyIds: string[];
  supplyUnavailableIds: string[];
  trendUnavailableIds: string[];
  universeCoverage: {
    expected: number; present: number; admittedSupply: number;
    status: string; missingFromCacheIds: string[];
  };
}

interface PsiMetadata {
  reason?: string;
  fallbackMode?: string;
  dewsUnavailable?: boolean;
  dewsFailureReason?: string;
  dewsRowsRead?: number;
  dewsLatestComputedAt?: number | null;
  dewsMaxAgeSec?: number;
  dewsStressBreadth?: number;
  preservedCurrentSample?: boolean;
  depegEventsUnavailable?: boolean;
  depegEventsFailureReason?: string;
  carriedSupplyIds?: string[];
  carriedSupplyCount?: number;
  supplyUnavailableIds?: string[];
  trendUnavailableIds?: string[];
  openDepegsWithoutPrice?: number;
  degradedComponents?: string[];
  quality: { reasons: string[] };
  universeCoverage?: { expected: number; admittedSupply: number; status: string };
}

function makeStabilityAsset(overrides: Partial<StablecoinData> = {}): StablecoinData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: "usdt-tether", name: "Tether USD", symbol: "USDT", geckoId: "tether",
    pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1,
    priceSource: "defillama", priceConfidence: "high", priceUpdatedAt: nowSec,
    priceObservedAt: nowSec, priceObservedAtMode: "upstream", priceSyncedAt: nowSec,
    consensusSources: [], agreeSources: [], supplySource: "defillama",
    circulating: { peggedUSD: 100_000_000 }, circulatingPrevDay: { peggedUSD: 99_000_000 },
    circulatingPrevWeek: { peggedUSD: 98_000_000 }, circulatingPrevMonth: { peggedUSD: 97_000_000 },
    chainCirculating: {}, chains: [], ...overrides,
  };
}

function makeUnpricedFalconAsset(): StablecoinData {
  return makeStabilityAsset({
    id: "usdf-falcon", name: "Falcon USD", symbol: "USDf", geckoId: "falcon-finance",
    pegMechanism: "crypto-backed", price: null, priceConfidence: null,
    priceUpdatedAt: null, priceObservedAt: null, priceObservedAtMode: null, priceSyncedAt: null,
    circulating: { peggedUSD: 93_500_000 }, circulatingPrevDay: { peggedUSD: 92_000_000 },
    circulatingPrevWeek: { peggedUSD: 90_000_000 }, circulatingPrevMonth: { peggedUSD: 88_000_000 },
  });
}

function cacheOk(
  peggedAssets: StablecoinData[],
  updatedAt = Math.floor(Date.now() / 1000),
): StablecoinsCacheLoadOk {
  return { kind: "ok", payload: { peggedAssets }, updatedAt };
}

function depegRow(stablecoin_id: string, started_at: number) {
  return { stablecoin_id, peg_reference: 1, started_at };
}

function cngnQuotes(price: number, updatedAt: number, pegCurrency = "NGN"): Map<string, NativePegQuote> {
  return new Map([[CNGN_ID, {
    stablecoinId: CNGN_ID, geckoId: "compliant-naira", pegCurrency,
    vsCurrency: "ngn", price, updatedAt,
    derivation: { kind: "traded-pair", lineage: { venue: "fixture-exchange", pair: "cNGN/NGN" } },
  }]]);
}

function metadataOf(result: { metadata?: string }): PsiMetadata {
  return JSON.parse(result.metadata ?? "{}") as PsiMetadata;
}

function failAll(statement: D1PreparedStatement, message: string): D1PreparedStatement {
  return {
    ...statement,
    bind: (...args: unknown[]) => failAll(statement.bind(...args), message),
    all: async () => {
      throw new Error(message);
    },
  } as unknown as D1PreparedStatement;
}

function makeDb(opts: {
  dewsUnavailable?: boolean;
  dewsPublishedAt?: number | null;
  dewsRows?: Array<{ stablecoin_id: string; score: number; band: string; computed_at: number }>;
  depegQueryFails?: boolean;
  depegRows?: Array<ReturnType<typeof depegRow>>;
  priceCacheRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
} = {}): TestDb {
  const { sqlite, db } = fixtures.open();
  const nowSec = Math.floor(Date.now() / 1000);
  const configuredDewsRows = opts.dewsRows ?? [
    { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: nowSec - 300 },
  ];
  const hasExplicitPublishedAt = Object.prototype.hasOwnProperty.call(opts, "dewsPublishedAt");
  const dewsPublishedAt = hasExplicitPublishedAt
    ? opts.dewsPublishedAt ?? null
    : configuredDewsRows[0]?.computed_at ?? nowSec - 300;

  const insertDepeg = sqlite.prepare(
    `INSERT INTO depeg_events
       (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at,
        ended_at, start_price, peak_price, peg_reference, source)
     VALUES (?, ?, 'peggedUSD', 'below', -100, ?, NULL, 1, 0.99, ?, 'live')`,
  );
  for (const row of opts.depegRows ?? [depegRow("usdt-tether", nowSec - 3600)]) {
    insertDepeg.run(row.stablecoin_id, row.stablecoin_id, row.started_at, row.peg_reference);
  }

  const insertDews = sqlite.prepare(
    `INSERT INTO stress_signal_publication_rows
       (stablecoin_id, computed_at, score, band, signals_json)
     VALUES (?, ?, ?, ?, '{}')`,
  );
  for (const row of configuredDewsRows) {
    insertDews.run(row.stablecoin_id, row.computed_at, row.score, row.band);
  }
  if (dewsPublishedAt != null) {
    const publishedRows = configuredDewsRows.filter((row) => row.computed_at === dewsPublishedAt);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      "dews:published-generation",
      JSON.stringify({
        updatedAt: dewsPublishedAt,
        source: "compute-dews",
        publishStatus: "published",
        ...(publishedRows.length > 0
          ? {
              coverageVersion: 2,
              expectedRowCount: publishedRows.length,
              stablecoinIdsDigest: buildDewsStablecoinIdsDigest(
                publishedRows.map((row) => row.stablecoin_id),
              ),
            }
          : {}),
      }),
      dewsPublishedAt,
    );
  }

  const insertPrice = sqlite.prepare(
    "INSERT INTO price_cache (asset_id, price, updated_at) VALUES (?, ?, ?)",
  );
  for (const row of opts.priceCacheRows ?? []) {
    insertPrice.run(row.asset_id, row.price, row.updated_at);
  }

  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (opts.depegQueryFails && sql.includes("FROM depeg_events e")) {
      return failAll(statement, "no such table: depeg_events");
    }
    if (opts.dewsUnavailable && sql.includes("pharos:stress-signals:published-exact")) {
      return failAll(statement, "no such table: stress_signal_publication_rows");
    }
    return statement;
  }) as typeof db.prepare;

  return Object.assign(db, { sqlite }) as TestDb;
}

function readInsertedInputSnapshot(db: TestDb): PsiSnapshot {
  const row = db.sqlite.prepare(
    "SELECT input_snapshot FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1",
  ).get() as { input_snapshot: string } | undefined;
  if (!row) throw new Error("Expected stability_index_samples insert");
  return JSON.parse(row.input_snapshot) as PsiSnapshot;
}

function persistedSampleCount(db: TestDb): number {
  const row = db.sqlite.prepare("SELECT COUNT(*) AS count FROM stability_index_samples").get() as { count: number };
  return Number(row.count);
}

describe("computeAndStoreStabilityIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
    vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue(cacheOk([makeStabilityAsset()]));
  });

  it.each([30 * 86400 + 1, 30 * 86400 + 51839, 30 * 86400 + 51841, 31 * 86400])(
    "persists exact contributor inputs for a %s-second-old chronic depeg",
    async (ageSec) => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({ depegRows: [depegRow("usdt-tether", now - ageSec)] });
      vi.mocked(loadStablecoinsCache).mockResolvedValue(cacheOk([
        makeStabilityAsset({ price: 0.99, circulating: { peggedUSD: 1e9 } }),
        makeStabilityAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 1e9 } }),
      ], now));

      await computeAndStoreStabilityIndex(db);
      const snapshot = readInsertedInputSnapshot(db);
      const [contributor] = snapshot.contributors;
      const exactFactor = getDepreciationFactor(ageSec / 86400);
      expect(contributor.factor).toBe(exactFactor);
      const reproduced = computePsiDepegContribution({ ...contributor, totalMcapUsd: snapshot.totalMcapUsd });
      const scored = computePsiDepegContribution({ bps: -100, mcapUsd: 1e9, totalMcapUsd: 2e9, factor: exactFactor });
      expect(reproduced).toEqual(scored);
      const result = computeStabilityIndex({
        depegs: [{ bps: -100, mcapUsd: 1e9, depegAgeDays: ageSec / 86400 }],
        totalMcapUsd: 2e9, mcap7dChangePct: snapshot.mcap7dChangePct, dewsStressBreadth: snapshot.dewsStressBreadth,
      });
      const row = db.sqlite.prepare("SELECT components FROM stability_index_samples")
        .get() as { components: string };
      expect(JSON.parse(row.components)).toEqual(result!.components);
      if (ageSec === 31 * 86400) {
        expect(reproduced.severity).toBeCloseTo(29.75, 12);
        expect(reproduced.total).toBeCloseTo(32.725, 12);
      }
    },
  );

  it.each([
    ["eurc-circle", "peggedEUR", 1.08],
    ["jpyc-jpyc", "peggedJPY", 0.0067],
    ["usdt-tether", "peggedUSD", 0.98],
  ])("keeps %s event evidence in its quote domain", async (id, pegType, usdPrice) => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({ depegRows: [depegRow(id, now - 60)] });
    db.sqlite.prepare("UPDATE depeg_events SET peg_type = ?, start_price = 0.98").run(pegType);
    vi.mocked(loadStablecoinsCache).mockResolvedValue(cacheOk([makeStabilityAsset({ id, pegType, price: usdPrice })], now));
    await computeAndStoreStabilityIndex(db);
    const first = readInsertedInputSnapshot(db);
    expect(first.contributors).toEqual([expect.objectContaining({ id, bps: -200 })]);
    if (pegType !== "peggedUSD") {
      vi.mocked(loadStablecoinsCache).mockResolvedValue(cacheOk([makeStabilityAsset({ id, pegType, price: usdPrice * 1.2 })], now));
      await computeAndStoreStabilityIndex(db);
      expect(readInsertedInputSnapshot(db).contributors).toEqual(first.contributors);
      db.sqlite.prepare("UPDATE depeg_events SET started_at = ?").run(now - 6 * 3600);
      await computeAndStoreStabilityIndex(db);
      const missing = readInsertedInputSnapshot(db);
      expect(missing.contributors).toEqual([]);
      expect(missing.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
      expect(missing.openDepegsWithoutPrice).toBe(1);
    }
  });

  it("computes cNGN's long-open native event from the producer's persisted upstream quote", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({ depegRows: [depegRow(CNGN_ID, now - 77 * 86400)] });
    db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN', start_price = 0.95").run();
    vi.mocked(loadStablecoinsCache).mockResolvedValue(cacheOk([
      makeStabilityAsset({ id: CNGN_ID, symbol: "cNGN", pegType: "peggedNGN", price: 0.0007 }),
    ], now));
    await persistActiveNativeEventQuotes(db, cngnQuotes(0.98, now - 60));
    const retained = db.sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`) as { value: string; updated_at: number };
    expect(JSON.parse(retained.value)).toMatchObject({
      value: 0.98, observedAt: now - 60, source: "coingecko", derivation: { kind: "traded-pair" },
    });
    expect(retained.updated_at).toBe(now - 60);
    const result = await computeAndStoreStabilityIndex(db);
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(metadataOf(result).reason).toBe("psi-sample-published");
    expect(readInsertedInputSnapshot(db).contributors).toEqual([expect.objectContaining({ id: CNGN_ID, bps: -200 })]);
    expect(readInsertedInputSnapshot(db).degradedComponents).toEqual(["universe-coverage"]);

    await persistActiveNativeEventQuotes(db, cngnQuotes(0.9, now - 120));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toEqual({ value: retained.value });
    db.sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 90738").run(now);
    await persistActiveNativeEventQuotes(db, cngnQuotes(0.98, now - 60));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toBeUndefined();
  });

  it.each(["absent", "stale", "future", "invalid", "legacy", "conversion"] as const)(
    "admits only a fresh compatible quote from %s persisted native evidence",
    async (kind) => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({ depegRows: [depegRow(CNGN_ID, now - 77 * 86400)] });
      db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN', start_price = 0.95").run();
      vi.mocked(loadStablecoinsCache).mockResolvedValue(cacheOk([
        makeStabilityAsset({ id: CNGN_ID, symbol: "cNGN", pegType: "peggedNGN", price: 0.0007,
          circulating: { peggedNGN: 1e7 }, circulatingPrevWeek: { peggedNGN: 1e7 } }),
      ], now));
      if (kind !== "absent") {
        const observedAt = kind === "stale" ? now - PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : kind === "future" ? now + 1 : now - 60;
        db.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
          `${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`,
          kind === "invalid" ? "{invalid" : JSON.stringify({
            value: 0.98, observedAt, source: "coingecko",
            ...(kind === "conversion" ? { derivation: { kind: "conversion", lineage: {} } } : {}),
          }),
          observedAt,
        );
      }
      const result = await computeAndStoreStabilityIndex(db);
      expect(result.status).toBe("ok");
      const snapshot = readInsertedInputSnapshot(db);
      if (kind === "legacy") {
        expect(snapshot.contributors).toEqual([expect.objectContaining({ id: CNGN_ID, bps: -200 })]);
        expect(snapshot.openDepegsWithoutPrice).toBe(0);
        expect(db.sqlite.prepare("SELECT score FROM stability_index_samples").get()).toMatchObject({ score: 98.8 });
        return;
      }
      expect(metadataOf(result).quality.reasons).toEqual(["open-depeg-no-price", "universe-coverage"]);
      expect(snapshot.contributors).toEqual([]);
      expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
      expect(snapshot.openDepegsWithoutPrice).toBe(1);
    },
  );

  it.each([
    { price: 0, age: 60, currency: "NGN" },
    { price: 0.98, age: 86400, currency: "NGN" },
    { price: 0.98, age: -60, currency: "NGN" },
    { price: 0.98, age: 60, currency: "EUR" },
  ])("does not persist invalid, stale, future, or wrong-domain producer quotes: %j", async ({ price, age, currency }) => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({ depegRows: [depegRow(CNGN_ID, now - 86400)] });
    db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN'").run();
    await persistActiveNativeEventQuotes(db, cngnQuotes(price, now - age, currency));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toBeUndefined();
  });
  it.each([
    ["is unavailable", { dewsUnavailable: true }, "", "stress_signal_publication_rows"],
    ["has unverified legacy coverage", {}, "UPDATE cache SET value = json_remove(value, '$.coverageVersion', '$.expectedRowCount', '$.stablecoinIdsDigest') WHERE key = 'dews:published-generation'", "generation-coverage-unverified"],
  ] as const)("returns degraded when the DEWS dependency %s", async (_label, options, sql, reason) => {
    const db = makeDb(options);
    if (sql) db.sqlite.exec(sql);
    const result = await computeAndStoreStabilityIndex(db);
    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(metadataOf(result)).toMatchObject({
      fallbackMode: "dews-unavailable", dewsUnavailable: true,
      dewsFailureReason: expect.stringContaining(reason), preservedCurrentSample: true,
    });
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("returns degraded when DEWS has no latest rows", async () => {
    const db = makeDb({ dewsRows: [] });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = metadataOf(result);
    expect(metadata.fallbackMode).toBe("dews-unavailable");
    expect(metadata.dewsUnavailable).toBe(true);
    expect(metadata.dewsFailureReason).toContain("has no rows");
    expect(metadata.dewsRowsRead).toBe(0);
    expect(metadata.preservedCurrentSample).toBe(true);
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("returns degraded when latest DEWS rows are stale", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleComputedAt = nowSec - CRON_INTERVALS["compute-dews"] * 2 - 1;
    const db = makeDb({
      dewsRows: [{ stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: staleComputedAt }],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    const metadata = metadataOf(result);
    expect(metadata.fallbackMode).toBe("dews-unavailable");
    expect(metadata.dewsUnavailable).toBe(true);
    expect(metadata.dewsFailureReason).toContain("stale");
    expect(metadata.dewsLatestComputedAt).toBe(staleComputedAt);
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsMaxAgeSec).toBe(CRON_INTERVALS["compute-dews"] * 2);
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("uses only the stale published generation while a fresher generation is staging", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleComputedAt = nowSec - CRON_INTERVALS["compute-dews"] * 2 - 1;
    const freshComputedAt = nowSec - 60;
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset(),
      makeStabilityAsset({
        id: "usdc-circle", name: "USD Coin", symbol: "USDC", geckoId: "usd-coin",
        circulating: { peggedUSD: 200_000_000 }, circulatingPrevDay: { peggedUSD: 199_000_000 },
        circulatingPrevWeek: { peggedUSD: 198_000_000 }, circulatingPrevMonth: { peggedUSD: 197_000_000 },
      }),
    ], nowSec));
    const db = makeDb({
      dewsRows: [
        { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: staleComputedAt },
        { stablecoin_id: "usdc-circle", score: 12, band: "NORMAL", computed_at: freshComputedAt },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = metadataOf(result);
    expect(metadata.fallbackMode).toBe("dews-unavailable");
    expect(metadata.dewsUnavailable).toBe(true);
    expect(metadata.dewsFailureReason).toContain("usdt-tether");
    expect(metadata.dewsFailureReason).toContain("stale");
    expect(metadata.dewsLatestComputedAt).toBe(staleComputedAt);
    expect(metadata.dewsRowsRead).toBe(1);
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("fails closed when no DEWS publication pointer is available", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fallbackWindowSec = CRON_INTERVALS["compute-dews"] * 4;
    const beyondWindowAt = nowSec - fallbackWindowSec - 1;
    const freshAt = nowSec - 300;
    const db = makeDb({
      dewsPublishedAt: null,
      dewsRows: [
        { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: beyondWindowAt },
        { stablecoin_id: "usdt-tether", score: 60, band: "WARNING", computed_at: freshAt },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    const metadata = metadataOf(result);
    expect(result.status).toBe("degraded");
    expect(metadata.dewsRowsRead).toBe(0);
    expect(metadata.dewsLatestComputedAt).toBeNull();
  });

  it("ignores DEWS rows newer than the published generation when computing PSI stress breadth", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const publishedAt = nowSec - 300;
    const db = makeDb({
      dewsPublishedAt: publishedAt,
      dewsRows: [
        { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: publishedAt + 120 },
        { stablecoin_id: "usdt-tether", score: 12, band: "CALM", computed_at: publishedAt },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("ok");
    const metadata = metadataOf(result);
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsLatestComputedAt).toBe(publishedAt);
    expect(metadata.dewsStressBreadth).toBe(0);
  });

  it("reads only the exact published DEWS generation instead of stale retained rows", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const publishedAt = nowSec - 300;
    const staleComputedAt = nowSec - CRON_INTERVALS["compute-dews"] * 2 - 1;
    const db = makeDb({
      dewsPublishedAt: publishedAt,
      dewsRows: [
        { stablecoin_id: "usdt-tether", score: 72, band: "WARNING", computed_at: publishedAt },
        { stablecoin_id: "benji-franklin-templeton", score: 95, band: "DANGER", computed_at: staleComputedAt },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("ok");
    const metadata = metadataOf(result);
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsLatestComputedAt).toBe(publishedAt);
  });

  it("keeps variant DEWS rows monitored but outside PSI stress breadth", async () => {
    const publishedAt = Math.floor(Date.now() / 1000) - 300;
    const db = makeDb({
      dewsPublishedAt: publishedAt,
      dewsRows: [
        { stablecoin_id: "usdt-tether", score: 12, band: "CALM", computed_at: publishedAt },
        { stablecoin_id: "susds-sky", score: 95, band: "DANGER", computed_at: publishedAt },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("ok");
    const metadata = metadataOf(result);
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsStressBreadth).toBe(0);
  });

  it("counts DEWS stress while an open event is unpriced and deduplicates it once priced", async () => {
    const now = Date.UTC(2026, 10, 18, 14) / 1000;
    vi.setSystemTime(now * 1000);
    const id = "eurc-circle";
    const db = makeDb({
      depegRows: [depegRow(id, now - 4 * 3600)],
      dewsRows: [{ stablecoin_id: id, score: 90, band: "DANGER", computed_at: now }],
    });
    const update = db.sqlite.prepare(`UPDATE depeg_events SET peg_type = 'peggedEUR', peg_reference = 1.1,
      last_trusted_price_at = ?, admitted_coverage_json = ?`);
    for (const [lastTrusted, price, stress, count, score] of [
      [now - 3 * 3600, null, 1.5 * Math.sqrt(5), 0, 96.6],
      [now, 1.078, 0, 1, 25.3],
    ] as const) {
      update.run(lastTrusted, JSON.stringify([{ fromSec: now - 4 * 3600, toSec: lastTrusted + 1 }]));
      const cache = cacheOk([makeStabilityAsset({ id, pegType: "peggedEUR", price,
        circulating: { peggedEUR: 5e9 }, circulatingPrevWeek: { peggedEUR: 5e9 } })], now);
      cache.payload.fxFallbackRates = { peggedEUR: 1.1 };
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cache);
      expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
      const snapshot = readInsertedInputSnapshot(db);
      expect(snapshot.contributors).toHaveLength(count);
      expect(snapshot.dewsStressBreadth).toBeCloseTo(stress);
      expect(db.sqlite.prepare("SELECT score FROM stability_index_samples").get()).toMatchObject({ score });
    }
  });

  it("fails closed when the active depeg query is unavailable", async () => {
    const db = makeDb({ depegQueryFails: true });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    const metadata = metadataOf(result);
    expect(metadata.fallbackMode).toBe("depeg-events-unavailable");
    expect(metadata.depegEventsUnavailable).toBe(true);
    expect(metadata.depegEventsFailureReason).toContain("depeg_events");
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("excludes active depegs from an accepted DEWS generation", async () => {
    const db = makeDb({ dewsUnavailable: false });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("ok");
    const metadata = metadataOf(result);
    expect(metadata.dewsUnavailable).toBe(false);
    expect(metadata.dewsStressBreadth).toBe(0);
  });

  it("excludes current market cap without observed prev-week supply from the trend ratio", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset(),
      makeStabilityAsset({
        id: "xaut-tether", name: "Tether Gold", symbol: "XAUT", geckoId: "tether-gold",
        pegType: "peggedGOLD", pegMechanism: "commodity-backed", price: 2_500,
        priceSource: "coingecko", priceConfidence: "single-source", supplySource: "coingecko",
        circulating: { peggedGOLD: 50_000_000 },
        circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
      }),
    ]));

    const db = makeDb({ dewsUnavailable: false });
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);

    expect(result.status).toBe("ok");
    expect(snapshot.totalMcapUsd).toBe(150_000_000);
    expect(snapshot.mcap7dChangePct).toBeCloseTo(
      ((100_000_000 - 98_000_000) / 98_000_000) * 100,
    );
    expect(snapshot.mcap7dChangePct).toBeLessThan(3);
  });

  it("carries the last admitted gold observation when later in-closure readings are held", async () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    const closed = at("2026-11-13T22:00:00Z");
    const opened = at("2026-11-15T23:00:00Z");
    const db = makeDb({ depegRows: [] });
    db.sqlite.prepare(`INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, start_price, peg_reference, source, last_trusted_price_at)
      VALUES ('xaut-tether', 'XAUT', 'peggedGOLD', 'below', -3000, ?, 3818, 4051, 'live', ?)`)
      .run(closed - 86400, closed + 600);
    const prepare = db.prepare.bind(db);
    const failedAt = closed + 1200;
    const failedOpenAt = opened + 3600;
    db.prepare = (sql) => {
      const now = Math.floor(Date.now() / 1000);
      if ((now === failedAt || now === failedOpenAt) && sql.includes("SELECT input_snapshot FROM stability_index_samples WHERE stored_at <=")) {
        throw new Error("transient prior-sample read failure");
      }
      return prepare(sql);
    };
    let samplesWritten = 0;
    for (const [now, observedAtSec, price, bps] of [
      [closed + 600, closed - 300, 2_800, -3000],
      [failedAt, closed - 300, 3_920, -3000],
      [closed + 1800, closed - 300, 3_920, -3000],
      [opened + 1800, opened + 600, 4_100, -238],
      [failedOpenAt, opened + 600, 4_179, -238],
      [opened + 5400, opened + 600, 4_179, -238],
    ] as const) {
      vi.setSystemTime(now! * 1000);
      db.sqlite.prepare("UPDATE stress_signal_publication_rows SET computed_at = ?").run(now);
      db.sqlite.prepare("UPDATE cache SET updated_at = ?, value = json_set(value, '$.updatedAt', ?) WHERE key = 'dews:published-generation'")
        .run(now, now);
      const usdPerUnit = now! > opened ? 4_200 : 4_000;
      const observation = { pegKey: "peggedGOLD", usdPerUnit, observedAtSec, source: "gold-api.com", cadence: "intraday" } as const;
      const session = getReferenceSessionState("metal", observedAtSec);
      expect(session.open).toBe(true);
      await fxRateState.persistFxRateState(db, { peggedGOLD: usdPerUnit }, {
        usableSyncAt: now!, mode: "live", consecutiveFallbackRuns: 0,
        sourceUpdatedAtByPeg: { peggedGOLD: observedAtSec }, sourceModeByPeg: { peggedGOLD: "live" },
        sourceCadenceByPeg: { peggedGOLD: "intraday" }, observations: { peggedGOLD: observation },
        referenceSourceSamples: { "peggedGOLD:gold-api.com": {
          observation, evidence: {
            sessionOpenedAtSec: session.sessionOpenedAtSec!,
            firstInSessionObservedAtSec: observedAtSec, preCloseUsdPerUnit: 4_000,
          },
        } },
      }, now!);
      const fx = await fxRateState.loadFxRateState(db);
      const asset = { id: "xaut-tether", name: "Tether Gold", symbol: "XAUT", pegType: "peggedGOLD",
        pegMechanism: "rwa-backed", price, priceSource: "coingecko", priceObservedAtMode: "upstream" as const,
        priceObservedAt: now >= failedOpenAt ? opened + 1200 : now, circulating: { peggedGOLD: 1e8 },
        circulatingPrevWeek: { peggedGOLD: 1e8 }, chainCirculating: {}, chains: [] };
      expect(await validateAndWriteStablecoinsCache({ db, assets: [asset], syncStartSec: now,
        validationContext: "main", publishFxReferenceEvidence: true, fxReferenceObservations: fx?.selectedReferenceEvidence, fxFallbackRates: fx?.rates,
      }, () => ({ itemCount: 0 }))).toMatchObject({ written: true });
      const loader = await vi.importActual<typeof import("../../lib/stablecoins-cache")>("../../lib/stablecoins-cache");
      vi.mocked(loadStablecoinsCache).mockImplementationOnce(loader.loadStablecoinsCache);
      const result = await computeAndStoreStabilityIndex(db);
      if (now === failedAt || now === failedOpenAt) {
        expect(metadataOf(result)).toMatchObject({ reason: "prior-contribution-unavailable", preservedCurrentSample: true });
      } else {
        expect(result.status).toBe("ok");
        samplesWritten++;
      }
      expect(persistedSampleCount(db)).toBe(samplesWritten);
      const snapshot = readInsertedInputSnapshot(db);
      expect(snapshot.contributors).toEqual([
        expect.objectContaining({ id: "xaut-tether", bps: expect.closeTo(bps!, 0) }),
      ]);
      if (now > failedOpenAt) expect(Object.values(snapshot.referenceAdmissions)[0]?.status).toBe("admitted");
    }
  });

  it("scores the peer-relative opening on its persisted basis while benchmark admission is unavailable", async () => {
    const now = Date.parse("2026-11-14T15:00:00Z") / 1000;
    vi.setSystemTime(now * 1000);
    const started = now - 900;
    const db = makeDb({ depegRows: [depegRow("eurc-circle", started)] });
    db.sqlite.prepare(`UPDATE depeg_events SET peg_type = 'peggedEUR', direction = 'below', peg_reference = 1.1,
      start_price = 1.067, pending_reason = 'low-confidence+peer-relative', peer_basis_json = ?`).run(JSON.stringify({
      onset: { basis: "peer-relative", observedAt: started, price: 1.067, pegReference: 1.1, bps: -300, corroboration: {
        basis: "peer-relative", confidence: "low", quoteObservedAt: started - 60,
        contributors: ["a", "b", "c"].map((id) => ({ id, provenanceKey: id, observedAtSec: started - 60 })),
        corroborator: { source: "pool:curve:defillama", observedAtSec: started - 60 },
      } },
    }));
    const cache = cacheOk([makeStabilityAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 1.067 })], now);
    cache.payload.fxFallbackRates = { peggedEUR: 1.067 };
    for (const observations of [undefined, {}]) {
      cache.payload.fxReferenceObservations = observations;
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cache);
      expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
      expect(readInsertedInputSnapshot(db)).toMatchObject({
        contributors: [{ id: "eurc-circle", bps: expect.closeTo(-300, 5) }],
        referenceAdmissions: {}, eventContributions: { 1: { basis: "peer-relative", confidence: "low", observedAt: started - 60 } },
      });
    }
  });

  it("scores a benchmark opening confirmed against peers using the token quote clock", async () => {
    const now = Date.parse("2026-11-13T22:10:00Z") / 1000;
    vi.setSystemTime(now * 1000);
    const started = now - 1000;
    const quoteAt = now - 45;
    const db = makeDb({ depegRows: [depegRow("eurc-circle", started)] });
    db.sqlite.prepare(`UPDATE depeg_events SET peg_type = 'peggedEUR', direction = 'below', peg_reference = 1.1,
      start_price = 1.067, pending_reason = 'low-confidence+peer-relative', peer_basis_json = ?`).run(JSON.stringify({
      onset: { basis: "benchmark", observedAt: started, price: 1.067, pegReference: 1.1, bps: -300 },
      latest: { basis: "peer-relative", observedAt: now - 30, price: 1.02, pegReference: 1.1, bps: -727,
        corroboration: { basis: "peer-relative", confidence: "low", quoteObservedAt: quoteAt,
          contributors: ["a", "b", "c"].map((id) => ({ id, provenanceKey: id, observedAtSec: quoteAt })),
          corroborator: { source: "pool:curve:defillama", observedAtSec: quoteAt },
        } },
    }));
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 1.02 }),
    ], now));
    expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
    expect(readInsertedInputSnapshot(db)).toMatchObject({
      contributors: [{ id: "eurc-circle", bps: expect.closeTo(-727.27, 2) }],
      eventContributions: { 1: { basis: "peer-relative", confidence: "low", observedAt: quoteAt } },
    });
  });

  it("keeps XAGm at parity for both legacy and clocked silver selections", async () => {
    const now = Date.parse("2026-11-17T16:00:00Z") / 1000;
    vi.setSystemTime(now * 1000);
    const id = "xagm-matrixdock";
    const ozPerToken = 0.998380822;
    const observation = { pegKey: "peggedSILVER", usdPerUnit: 30, observedAtSec: now - 60,
      source: "gold-api.com", cadence: "intraday" } as const;
    for (const clocked of [false, true]) {
      const db = makeDb({ depegRows: [depegRow(id, now - 3600)] });
      db.sqlite.exec("UPDATE depeg_events SET peg_type = 'peggedSILVER', peg_reference = 30");
      const cache = cacheOk([makeStabilityAsset({ id, pegType: "peggedSILVER", price: 30 * ozPerToken,
        commodityEntitlement: { source: "matrixdock-frs", generation: "ethereum:123", observedAtSec: now - 60,
          quoteObservedAtSec: now, ozPerToken } })], now);
      cache.payload.fxFallbackRates = { peggedSILVER: 30 };
      if (clocked) {
        cache.payload.fxReferenceObservations = { peggedSILVER: observation };
        cache.payload.selectedPegReferences = { peggedSILVER: {
          kind: "fallback", generation: `stablecoins:${now}`, observation,
          repricing: { source: "gold-api.com", preCloseUsdPerUnit: 29,
            sessionOpenedAtSec: getReferenceSessionState("metal", now).sessionOpenedAtSec! },
        } };
      }
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cache);
      expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
      expect(readInsertedInputSnapshot(db).contributors).toMatchObject([{ id, bps: 0 }]);
      if (!clocked) {
        delete cache.payload.peggedAssets[0]!.commodityEntitlement;
        vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cache);
        await computeAndStoreStabilityIndex(db);
        expect(readInsertedInputSnapshot(db)).toMatchObject({ contributors: [], openDepegsWithoutPrice: 1 });
      }
    }
  });

  it("keeps capitalization change and native momentum on their own dated pairs", async () => {
    const now = Date.parse("2026-11-18T14:00:00Z") / 1000;
    vi.setSystemTime(now * 1000);
    const db = makeDb();
    const week = { observedAt: Date.parse("2026-11-11T00:15:00Z") / 1000,
      circulatingUsd: 100_000_000, circulatingNative: 100_000_000 };
    const asset = makeStabilityAsset({
      id: "eurc-circle", pegType: "peggedEUR", supplyObservedAt: now, circulatingNative: 100_000_000,
      circulating: { peggedEUR: 110_000_000 }, circulatingPrevWeek: { peggedEUR: 110_000_000 },
      valuationPriceUsd: 1.1, valuationObservedAtSec: now - 60, supplyChangeBaselines: { week },
    });
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([asset], now));
    expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
    expect(readInsertedInputSnapshot(db)).toMatchObject({
      mcap7dChangePct: 10, nativeQuantityMomentum: { "eurc-circle": 0 },
    });
    for (const overrides of [{ supplyChangeBaselines: {} }, { supplyChangeBaselines: { day: week, week: null } },
      { supplyObservedAt: undefined }, { valuationObservedAtSec: now - 86400 },
      { supplySource: "onchain-total-supply", valuationPriceUsd: null, valuationObservedAtSec: null }]) {
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([{ ...asset, ...overrides }], now));
      const result = await computeAndStoreStabilityIndex(db);
      expect(result.status).toBe("degraded");
      expect(metadataOf(result)).toMatchObject({ reason: "trend-inputs-unavailable", trendUnavailableIds: ["eurc-circle"] });
    }
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([{ ...asset, supplyChangeBaselines: { day: week } }], now));
    expect((await computeAndStoreStabilityIndex(db)).status).toBe("ok");
    expect(readInsertedInputSnapshot(db).mcap7dChangePct).toBe(0);
  });

  it.each([
    [undefined, null, "psi-sample-published"],
    ["per-observation", null, "selected-reference-unavailable"],
    ["per-observation", "peer-relative", "event-quote-basis-unsupported"],
  ] as const)("uses the legacy FX cache with reference mode %s and quote mode %s", async (referenceMode, quoteMode, reason) => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({ depegRows: [depegRow("xaut-tether", now - 3600)] });
    db.sqlite.prepare("UPDATE depeg_events SET peg_type = 'peggedGOLD', peg_reference = 4051").run();
    if (quoteMode) {
      db.sqlite.prepare(`INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, created_at, updated_at)
        SELECT id, 'live', ?, ?, ? FROM depeg_events`).run(quoteMode, now, now);
    }
    await fxRateState.persistFxRateState(db, { peggedGOLD: 4_000 }, {
      usableSyncAt: now, mode: "live", consecutiveFallbackRuns: 0,
      sourceUpdatedAtByPeg: { peggedGOLD: now - 60 }, sourceModeByPeg: { peggedGOLD: "live" },
    }, now);
    const legacyFx = await fxRateState.loadFxRateState(db);
    expect(legacyFx?.metadataIdentity).toBe("verified");
    db.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({
      peggedAssets: [makeStabilityAsset({ id: "xaut-tether", pegType: "peggedGOLD", price: 3_800 })],
      fxFallbackRates: legacyFx?.rates,
    }), now);
    const loader = await vi.importActual<typeof import("../../lib/stablecoins-cache")>("../../lib/stablecoins-cache");
    vi.mocked(loadStablecoinsCache).mockImplementationOnce(loader.loadStablecoinsCache);
    const result = await computeAndStoreStabilityIndex(db, undefined, { referenceMode });
    expect(metadataOf(result).reason).toBe(reason);
    if (referenceMode) {
      expect(result.status).toBe("degraded");
      expect(metadataOf(result).preservedCurrentSample).toBe(true);
      expect(persistedSampleCount(db)).toBe(0);
    } else {
      expect(result.status).toBe("ok");
      expect(readInsertedInputSnapshot(db)).toMatchObject({
        referenceScoringMode: "legacy", contributors: [{ id: "xaut-tether", bps: -500 }],
      });
    }
  });

  it("falls back to recent replay-safe cached prices for open depegs missing current snapshot prices", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeUnpricedFalconAsset()], nowSec));
    const db = makeDb({
      depegRows: [depegRow("usdf-falcon", nowSec - 3_600)],
      priceCacheRows: [{ asset_id: "usdf-falcon", price: 0.5413, updated_at: nowSec - 300 }],
    });
    db.sqlite.prepare("UPDATE price_cache SET source = 'coingecko' WHERE asset_id = 'usdf-falcon'").run();

    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);

    expect(result.status).toBe("ok");
    expect(snapshot.replayPriceFallbackCount).toBe(1);
    expect(snapshot.depegCount).toBe(1);
    expect(snapshot.contributors).toHaveLength(1);
    expect(snapshot.contributors[0]?.id).toBe("usdf-falcon");
    expect(snapshot.contributors[0]?.bps).toBe(-4587);
  });

  it("maps legacy PSI depeg ids onto the canonical live cache asset", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset({
        id: "ust-terra", name: "TerraUSD", symbol: "UST", geckoId: "terrausd",
        pegMechanism: "algorithmic", price: 0.12, priceConfidence: "single-source",
        circulating: { peggedUSD: 15_000_000_000 }, circulatingPrevDay: { peggedUSD: 17_000_000_000 },
        circulatingPrevWeek: { peggedUSD: 18_500_000_000 }, circulatingPrevMonth: { peggedUSD: 18_500_000_000 },
      }),
    ], nowSec));

    const db = makeDb({ depegRows: [depegRow("ust-terra-classic", nowSec - 3_600)] });

    await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);

    expect(snapshot.depegCount).toBe(1);
    expect(snapshot.contributors).toHaveLength(1);
    expect(snapshot.contributors[0]?.id).toBe("ust-terra");
    expect(snapshot.contributors[0]?.bps).toBe(-8800);
  });

  it("does not turn a nominal par reference into observed calm for an open depeg", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset({
      price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
      priceObservedAt: null,
    })]));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    expect(result.status).toBe("ok");
    expect(metadataOf(result).quality.reasons).toEqual(["open-depeg-no-price", "universe-coverage"]);
    expect(snapshot.openDepegsWithoutPrice).toBe(1);
    expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
    expect(snapshot.contributors).toEqual([]);
  });

  it.each([
    ["usbd-bima", "protocol-redeem", null, false],
    ["usbd-bima", "coingecko", null, true],
    ["usdf-falcon", "protocol-redeem", null, true],
    ["usbd-bima", "protocol-par", "nominal_reference", false],
  ] as const)("admits replay price for %s from %s (%s) only when it is replay-safe", async (id, source, observedAtMode, observed) => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset({ id, price: null })], nowSec));
    const db = makeDb({
      depegRows: [depegRow(id, nowSec - 3600)],
      priceCacheRows: [{ asset_id: id, price: 0.98, updated_at: nowSec - 60 }],
    });
    db.sqlite.prepare("UPDATE price_cache SET source = ?, observed_at_mode = ? WHERE asset_id = ?")
      .run(source, observedAtMode, id);
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    if (observed) {
      expect(snapshot.contributors).toEqual([expect.objectContaining({ id, bps: -200 })]);
      expect(snapshot.replayPriceFallbackCount).toBe(1);
    } else {
      expect(result.status).toBe("ok");
      expect(snapshot.contributors).toEqual([]);
      expect(snapshot.openDepegsWithoutPrice).toBe(1);
      expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
    }
  });

  it("persists the PSI universe coverage and names a shortfall", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset()]));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const expected = snapshot.universeCoverage.expected;
    expect(expected).toBeGreaterThan(1);
    expect(snapshot.universeCoverage).toMatchObject({
      present: 1,
      admittedSupply: 1,
      status: "error",
    });
    expect(snapshot.universeCoverage.missingFromCacheIds).not.toContain("usdt-tether");
    expect(snapshot.universeCoverage.missingFromCacheIds).toHaveLength(expected - 1);
    expect(metadataOf(result).universeCoverage).toMatchObject({
      expected,
      admittedSupply: 1,
      status: "error",
    });
    expect(metadataOf(result).quality.reasons).toContain("universe-coverage");
  });

  it("classifies universe coverage without netting PSI-historical assets against missing core members", async () => {
    const coreIds = [...CORE_AGGREGATE_ACTIVE_IDS];
    const missing = new Set(coreIds.slice(0, 4));
    const peggedAssets = coreIds
      .filter((id) => !missing.has(id))
      .map((id) => makeStabilityAsset({ id, symbol: id.slice(0, 6) }));
    for (const id of PSI_HISTORICAL_IDS) {
      peggedAssets.push(makeStabilityAsset({ id, symbol: id.slice(0, 6) }));
    }
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk(peggedAssets));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    expect(snapshot.universeCoverage.missingFromCacheIds).toHaveLength(4);
    expect(snapshot.universeCoverage).toMatchObject({
      expected: coreIds.length,
      present: coreIds.length - 4,
      status: "degraded",
    });
    expect(metadataOf(result).quality.reasons).toContain("universe-coverage");
  });

  it("keeps an unreadable core supply out of the universe-coverage finding", async () => {
    const coreIds = [...CORE_AGGREGATE_ACTIVE_IDS];
    const noSupply = new Set(coreIds.filter((id) => id !== "usdt-tether").slice(0, 4));
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk(coreIds.map((id) => makeStabilityAsset({
      id,
      symbol: id.slice(0, 6),
      ...(noSupply.has(id) ? { circulating: {} } : {}),
    }))));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    expect(snapshot.universeCoverage).toMatchObject({
      present: coreIds.length,
      admittedSupply: coreIds.length - 4,
      status: "ok",
    });
    const reasons = metadataOf(result).quality.reasons;
    expect(reasons).toContain("supply-unavailable");
    expect(reasons).not.toContain("universe-coverage");
  });

  it("flags an outage-fallback restore without admitting it as an observed core member", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset(),
      makeStabilityAsset({
        id: "usdc-circle", symbol: "USDC", supplyRestored: true,
        supplyRestoreMode: "outage-fallback",
        circulating: { peggedUSD: 50_000_000 },
      }),
    ]));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const metadata = metadataOf(result);

    // The carried weight still sizes the index, but coverage names it instead
    // of counting it among the members this generation observed (R6).
    expect(snapshot).toMatchObject({ totalMcapUsd: 150_000_000, carriedSupplyIds: ["usdc-circle"] });
    expect(snapshot.universeCoverage).toMatchObject({ present: 2, admittedSupply: 1 });
    expect(snapshot.degradedComponents).toContain("carried-supply");
    expect(metadata).toMatchObject({
      carriedSupplyIds: ["usdc-circle"], carriedSupplyCount: 1, supplyUnavailableIds: [],
    });
    expect(metadata.quality.reasons).toContain("carried-supply");
  });

  it("keeps a routine main-path carry as an observed weight", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset(),
      makeStabilityAsset({
        id: "usdc-circle", symbol: "USDC", supplyRestored: true,
        circulating: { peggedUSD: 50_000_000 },
      }),
    ]));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const metadata = metadataOf(result);

    // A chain-dropout repair published on the main path keeps today's treatment:
    // it is a published weight, not an outage restore (issue #1836 scope).
    expect(snapshot).toMatchObject({ totalMcapUsd: 150_000_000, carriedSupplyIds: [] });
    expect(snapshot.universeCoverage).toMatchObject({ present: 2, admittedSupply: 2 });
    expect(snapshot.degradedComponents).not.toContain("carried-supply");
    expect(metadata).toMatchObject({ carriedSupplyIds: [], carriedSupplyCount: 0 });
    expect(metadata.quality.reasons).not.toContain("carried-supply");
  });

  it("publishes ok with explicit input quality when an open depeg has no usable price", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeUnpricedFalconAsset()], nowSec));

    const db = makeDb({
      depegRows: [depegRow("usdf-falcon", nowSec - 3_600)],
      priceCacheRows: [{ asset_id: "usdf-falcon", price: 0.5413, updated_at: nowSec - (6 * 60 * 60) - 1 }],
    });

    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const metadata = metadataOf(result);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(metadata.reason).toBe("psi-sample-published");
    expect(metadata.quality.reasons).toEqual(["open-depeg-no-price", "universe-coverage"]);
    expect(metadata.openDepegsWithoutPrice).toBe(1);
    expect(metadata.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
    expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price", "universe-coverage"]);
    expect(persistedSampleCount(db)).toBe(1);
  });

  it.each([
    ["absent", undefined],
    ["empty", {}],
    ["invalid", { peggedUSD: NaN }],
    ["negative", { peggedUSD: -1 }],
    ["overflow", { peggedUSD: Number.MAX_VALUE, peggedEUR: Number.MAX_VALUE }],
  ])("omits %s current supply from denominators, stressed weights and contributors", async (_label, circulating) => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset({ price: 0.98 }),
      makeStabilityAsset({ id: "usdc-circle", symbol: "USDC", circulating, price: 0.9 }),
    ], now));
    const db = makeDb({
      depegRows: ["usdt-tether", "usdc-circle"].map((stablecoin_id) => depegRow(stablecoin_id, now - 60)),
      dewsRows: ["usdt-tether", "usdc-circle"].map((stablecoin_id) => ({
        stablecoin_id, score: 72, band: "WARNING", computed_at: now - 300,
      })),
    });
    const result = await computeAndStoreStabilityIndex(db);
    expect(result.status).toBe("ok");
    expect(readInsertedInputSnapshot(db)).toMatchObject({
      totalMcapUsd: 100_000_000,
      dewsStressBreadth: 0,
      supplyUnavailableIds: ["usdc-circle"],
      contributors: [expect.objectContaining({ id: "usdt-tether", mcapUsd: 100_000_000 })],
    });
    expect(metadataOf(result).quality.reasons).toContain("supply-unavailable");
  });

  it("admits explicit zero current supply rather than reporting absence", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset(), makeStabilityAsset({
      id: "usdc-circle", circulating: { peggedUSD: 0 }, circulatingPrevWeek: { peggedUSD: 0 },
    })]));
    const result = await computeAndStoreStabilityIndex(makeDb());
    expect(result.status).toBe("ok");
    expect(metadataOf(result).supplyUnavailableIds).toEqual([]);
    expect(metadataOf(result).trendUnavailableIds).toEqual([]);
  });

  it.each<[Record<string, number> | undefined]>([[undefined], [{}], [{ peggedUSD: NaN }], [{ peggedUSD: -1 }]])(
    "excludes unavailable previous-week supply from both trend sides", async (circulatingPrevWeek) => {
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset(), makeStabilityAsset({
        id: "usdc-circle", circulating: { peggedUSD: 900_000_000 }, circulatingPrevWeek,
      })]));
      const db = makeDb();
      const result = await computeAndStoreStabilityIndex(db);
      expect(result.status).toBe("ok");
      expect(readInsertedInputSnapshot(db)).toMatchObject({
        totalMcapUsd: 1_000_000_000,
        mcap7dChangePct: ((100_000_000 - 98_000_000) / 98_000_000) * 100,
        trendUnavailableIds: ["usdc-circle"],
      });
    },
  );

  it.each<[Record<string, number> | undefined]>([[undefined], [{}], [{ peggedUSD: 0 }], [{ peggedUSD: -1 }], [{ peggedUSD: NaN }]])(
    "preserves the previous sample when no positive paired trend denominator exists", async (circulatingPrevWeek) => {
      const db = makeDb();
      await computeAndStoreStabilityIndex(db);
      const priorSnapshot = readInsertedInputSnapshot(db);
      vi.advanceTimersByTime(1_800_000);
      vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([makeStabilityAsset({ circulatingPrevWeek })]));
      const result = await computeAndStoreStabilityIndex(db);
      expect(result.status).toBe("degraded");
      expect(result.itemCount).toBe(0);
      expect(metadataOf(result)).toMatchObject({
        reason: "trend-inputs-unavailable", mcap7dChangePct: null, preservedCurrentSample: true,
      });
      expect(persistedSampleCount(db)).toBe(1);
      expect(readInsertedInputSnapshot(db)).toEqual(priorSnapshot);
    },
  );

  it.each([0, -1, Number.MAX_VALUE])("holds a nonpositive or overflowing aggregate market cap (%s)", async (amount) => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce(cacheOk([
      makeStabilityAsset({ circulating: { peggedUSD: amount } }),
      makeStabilityAsset({ id: "usdc-circle", circulating: { peggedUSD: amount } }),
    ]));
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    expect(result.status).toBe("degraded");
    expect(metadataOf(result).reason).toBe("insufficient-market-cap");
    expect(persistedSampleCount(db)).toBe(0);
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
