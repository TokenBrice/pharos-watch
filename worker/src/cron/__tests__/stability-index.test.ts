import type { StablecoinData } from "@shared/types/market";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(),
}));

import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { computeAndStoreStabilityIndex } from "../stability-index";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import { persistActiveNativeEventQuotes, NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";

const fixtures = createLatestSchemaFixtureTracker();

interface TestDb extends D1Database {
  sqlite: DatabaseSync;
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
  depegRows?: Array<{ stablecoin_id: string; peg_reference: number; started_at: number }>;
  priceCacheRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
} = {}): TestDb {
  const { sqlite, db } = fixtures.open();
  const nowSec = Math.floor(Date.now() / 1000);
  const configuredDewsRows = opts.dewsRows ?? [{
    stablecoin_id: "usdt-tether",
    score: 72,
    band: "WARNING",
    computed_at: nowSec - 300,
  }];
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
  for (const row of opts.depegRows ?? [{
    stablecoin_id: "usdt-tether",
    peg_reference: 1,
    started_at: nowSec - 3600,
  }]) {
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

function readInsertedInputSnapshot(db: TestDb): Record<string, unknown> {
  const row = db.sqlite.prepare(
    "SELECT input_snapshot FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1",
  ).get() as { input_snapshot: string } | undefined;
  if (!row) throw new Error("Expected stability_index_samples insert");
  return JSON.parse(row.input_snapshot) as Record<string, unknown>;
}

function persistedSampleCount(db: TestDb): number {
  const row = db.sqlite.prepare("SELECT COUNT(*) AS count FROM stability_index_samples").get() as { count: number };
  return Number(row.count);
}

describe("computeAndStoreStabilityIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
    vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeStabilityAsset(),
        ],
      },
      updatedAt: Math.floor(Date.now() / 1000),
    });
  });


  it.each([
    ["eurc-circle", "peggedEUR", 1.08],
    ["jpyc-jpyc", "peggedJPY", 0.0067],
    ["usdt-tether", "peggedUSD", 0.98],
  ])("keeps %s event evidence in its quote domain", async (id, pegType, usdPrice) => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({ depegRows: [{ stablecoin_id: id, peg_reference: 1, started_at: now - 60 }] });
    db.sqlite.prepare("UPDATE depeg_events SET peg_type = ?, start_price = 0.98").run(pegType);
    vi.mocked(loadStablecoinsCache).mockResolvedValue({
      kind: "ok", updatedAt: now,
      payload: { peggedAssets: [makeStabilityAsset({ id, pegType, price: usdPrice })] },
    });
    await computeAndStoreStabilityIndex(db);
    const first = readInsertedInputSnapshot(db);
    expect(first.contributors).toEqual([expect.objectContaining({ id, bps: -200 })]);
    if (pegType !== "peggedUSD") {
      vi.mocked(loadStablecoinsCache).mockResolvedValue({
        kind: "ok", updatedAt: now,
        payload: { peggedAssets: [makeStabilityAsset({ id, pegType, price: usdPrice * 1.2 })] },
      });
      await computeAndStoreStabilityIndex(db);
      expect(readInsertedInputSnapshot(db).contributors).toEqual(first.contributors);
      db.sqlite.prepare("UPDATE depeg_events SET started_at = ?").run(now - 6 * 3600);
      await computeAndStoreStabilityIndex(db);
      const missing = readInsertedInputSnapshot(db);
      expect(missing.contributors).toEqual([]);
      expect(missing.degradedComponents).toEqual(["open-depeg-no-price"]);
      expect(missing.openDepegsWithoutPrice).toBe(1);
    }
  });

  it("computes cNGN's long-open native event from the producer's persisted upstream quote", async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = "cngn-compliant-naira";
    const db = makeDb({ depegRows: [{ stablecoin_id: id, peg_reference: 1, started_at: now - 77 * 86400 }] });
    db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN', start_price = 0.95").run();
    vi.mocked(loadStablecoinsCache).mockResolvedValue({
      kind: "ok", updatedAt: now,
      payload: { peggedAssets: [makeStabilityAsset({ id, symbol: "cNGN", pegType: "peggedNGN", price: 0.0007 })] },
    });
    await persistActiveNativeEventQuotes(db, new Map([[id, {
      stablecoinId: id, geckoId: "compliant-naira", pegCurrency: "NGN",
      vsCurrency: "ngn", price: 0.98, updatedAt: now - 60,
    }]]));
    const retained = db.sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`) as { value: string; updated_at: number };
    expect(JSON.parse(retained.value)).toEqual({ value: 0.98, observedAt: now - 60, source: "coingecko" });
    expect(retained.updated_at).toBe(now - 60);
    const result = await computeAndStoreStabilityIndex(db);
    expect(result.status).toBeUndefined(); // Cron success is implicit unless degraded.
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata ?? "{}").reason).toBe("psi-sample-published");
    expect(readInsertedInputSnapshot(db).contributors).toEqual([expect.objectContaining({ id, bps: -200 })]);
    expect(readInsertedInputSnapshot(db).degradedComponents).toEqual([]);

    await persistActiveNativeEventQuotes(db, new Map([[id, {
      stablecoinId: id, geckoId: "compliant-naira", pegCurrency: "NGN",
      vsCurrency: "ngn", price: 0.9, updatedAt: now - 120,
    }]]));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toEqual({ value: retained.value });
    db.sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 90738").run(now);
    await persistActiveNativeEventQuotes(db, new Map([[id, {
      stablecoinId: id, geckoId: "compliant-naira", pegCurrency: "NGN",
      vsCurrency: "ngn", price: 0.98, updatedAt: now - 60,
    }]]));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toBeUndefined();
  });

  it.each(["absent", "stale", "future", "invalid"] as const)(
    "keeps open-depeg-no-price for %s persisted native evidence",
    async (kind) => {
      const now = Math.floor(Date.now() / 1000);
      const id = "cngn-compliant-naira";
      const db = makeDb({ depegRows: [{ stablecoin_id: id, peg_reference: 1, started_at: now - 77 * 86400 }] });
      db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN', start_price = 0.95").run();
      vi.mocked(loadStablecoinsCache).mockResolvedValue({
        kind: "ok", updatedAt: now,
        payload: { peggedAssets: [makeStabilityAsset({ id, symbol: "cNGN", pegType: "peggedNGN", price: 0.0007 })] },
      });
      if (kind !== "absent") {
        const observedAt = kind === "stale" ? now - PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : now + 1;
        db.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
          `${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`,
          kind === "invalid" ? "{invalid" : JSON.stringify({ value: 0.98, observedAt, source: "coingecko" }),
          observedAt,
        );
      }
      const result = await computeAndStoreStabilityIndex(db);
      expect(result.status).toBe("degraded");
      expect(JSON.parse(result.metadata ?? "{}").reason).toBe("open-depeg-no-price");
      const snapshot = readInsertedInputSnapshot(db);
      expect(snapshot.contributors).toEqual([]);
      expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price"]);
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
    const id = "cngn-compliant-naira";
    const db = makeDb({ depegRows: [{ stablecoin_id: id, peg_reference: 1, started_at: now - 86400 }] });
    db.sqlite.prepare("UPDATE depeg_events SET id = 90738, peg_type = 'peggedNGN'").run();
    await persistActiveNativeEventQuotes(db, new Map([[id, {
      stablecoinId: id, geckoId: "compliant-naira", pegCurrency: currency,
      price, updatedAt: now - age,
    }]]));
    expect(db.sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}90738`)).toBeUndefined();
  });
  it("returns degraded when DEWS dependency is unavailable", async () => {
    const db = makeDb({ dewsUnavailable: true });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string;
      dewsUnavailable: boolean;
      dewsFailureReason: string | null;
      preservedCurrentSample: boolean;
    };
    expect(metadata.fallbackMode).toBe("dews-unavailable");
    expect(metadata.dewsUnavailable).toBe(true);
    expect(metadata.dewsFailureReason).toContain("stress_signal_publication_rows");
    expect(metadata.preservedCurrentSample).toBe(true);
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("returns degraded when DEWS has no latest rows", async () => {
    const db = makeDb({ dewsRows: [] });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string;
      dewsUnavailable: boolean;
      dewsFailureReason: string | null;
      dewsRowsRead: number;
      preservedCurrentSample: boolean;
    };
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
      dewsRows: [
        {
          stablecoin_id: "usdt-tether",
          score: 72,
          band: "WARNING",
          computed_at: staleComputedAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string;
      dewsUnavailable: boolean;
      dewsFailureReason: string | null;
      dewsLatestComputedAt: number | null;
      dewsRowsRead: number;
      dewsMaxAgeSec: number;
    };
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
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeStabilityAsset(),
          makeStabilityAsset({
            id: "usdc-circle", name: "USD Coin", symbol: "USDC", geckoId: "usd-coin",
            circulating: { peggedUSD: 200_000_000 }, circulatingPrevDay: { peggedUSD: 199_000_000 },
            circulatingPrevWeek: { peggedUSD: 198_000_000 }, circulatingPrevMonth: { peggedUSD: 197_000_000 },
          }),
        ],
      },
      updatedAt: nowSec,
    });
    const db = makeDb({
      dewsRows: [
        {
          stablecoin_id: "usdt-tether",
          score: 72,
          band: "WARNING",
          computed_at: staleComputedAt,
        },
        {
          stablecoin_id: "usdc-circle",
          score: 12,
          band: "NORMAL",
          computed_at: freshComputedAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string;
      dewsUnavailable: boolean;
      dewsFailureReason: string | null;
      dewsLatestComputedAt: number | null;
      dewsRowsRead: number;
    };
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
        {
          stablecoin_id: "usdt-tether",
          score: 72,
          band: "WARNING",
          computed_at: beyondWindowAt,
        },
        {
          stablecoin_id: "usdt-tether",
          score: 60,
          band: "WARNING",
          computed_at: freshAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsRowsRead: number;
      dewsLatestComputedAt: number | null;
    };
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
        {
          stablecoin_id: "usdt-tether",
          score: 72,
          band: "WARNING",
          computed_at: publishedAt + 120,
        },
        {
          stablecoin_id: "usdt-tether",
          score: 12,
          band: "CALM",
          computed_at: publishedAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsStressBreadth: number;
      dewsRowsRead: number;
      dewsLatestComputedAt: number | null;
    };
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
        {
          stablecoin_id: "usdt-tether",
          score: 72,
          band: "WARNING",
          computed_at: publishedAt,
        },
        {
          stablecoin_id: "benji-franklin-templeton",
          score: 95,
          band: "DANGER",
          computed_at: staleComputedAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsRowsRead: number;
      dewsLatestComputedAt: number | null;
    };
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsLatestComputedAt).toBe(publishedAt);
  });

  it("keeps variant DEWS rows monitored but outside PSI stress breadth", async () => {
    const publishedAt = Math.floor(Date.now() / 1000) - 300;
    const db = makeDb({
      dewsPublishedAt: publishedAt,
      dewsRows: [
        {
          stablecoin_id: "usdt-tether",
          score: 12,
          band: "CALM",
          computed_at: publishedAt,
        },
        {
          stablecoin_id: "susds-sky",
          score: 95,
          band: "DANGER",
          computed_at: publishedAt,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsRowsRead: number;
      dewsStressBreadth: number;
    };
    expect(metadata.dewsRowsRead).toBe(1);
    expect(metadata.dewsStressBreadth).toBe(0);
  });

  it("fails closed when the active depeg query is unavailable", async () => {
    const db = makeDb({ depegQueryFails: true });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string;
      depegEventsUnavailable: boolean;
      depegEventsFailureReason: string | null;
    };
    expect(metadata.fallbackMode).toBe("depeg-events-unavailable");
    expect(metadata.depegEventsUnavailable).toBe(true);
    expect(metadata.depegEventsFailureReason).toContain("depeg_events");
    expect(persistedSampleCount(db)).toBe(0);
  });

  it("keeps run ok when DEWS dependency query succeeds", async () => {
    const db = makeDb({ dewsUnavailable: false });

    const result = await computeAndStoreStabilityIndex(db);

    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsUnavailable: boolean;
      dewsStressBreadth: number;
    };
    expect(metadata.dewsUnavailable).toBe(false);
    expect(metadata.dewsStressBreadth).toBeGreaterThan(0);
  });

  it("excludes current market cap without observed prev-week supply from the trend ratio", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeStabilityAsset(),
          makeStabilityAsset({
            id: "xaut-tether", name: "Tether Gold", symbol: "XAUT", geckoId: "tether-gold",
            pegType: "peggedGOLD", pegMechanism: "commodity-backed", price: 2_500,
            priceSource: "coingecko", priceConfidence: "single-source", supplySource: "coingecko",
            circulating: { peggedGOLD: 50_000_000 },
            circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
          }),
        ],
      },
      updatedAt: nowSec,
    });

    const db = makeDb({ dewsUnavailable: false });
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);

    expect(result.status).toBeUndefined();
    expect(snapshot.totalMcapUsd).toBe(150_000_000);
    expect(snapshot.mcap7dChangePct).toBeCloseTo(
      ((100_000_000 - 98_000_000) / 98_000_000) * 100,
    );
    expect(snapshot.mcap7dChangePct).toBeLessThan(3);
  });

  it("falls back to recent replay-safe cached prices for open depegs missing current snapshot prices", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeUnpricedFalconAsset(),
        ],
      },
      updatedAt: nowSec,
    });

    const db = makeDb({
      depegRows: [
        {
          stablecoin_id: "usdf-falcon",
          peg_reference: 1,
          started_at: nowSec - 3_600,
        },
      ],
      priceCacheRows: [
        {
          asset_id: "usdf-falcon",
          price: 0.5413,
          updated_at: nowSec - 300,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors as Array<Record<string, unknown>> : [];

    expect(result.status).toBeUndefined();
    expect(snapshot.replayPriceFallbackCount).toBe(1);
    expect(snapshot.depegCount).toBe(1);
    expect(contributors).toHaveLength(1);
    expect(contributors[0]?.id).toBe("usdf-falcon");
    expect(contributors[0]?.bps).toBe(-4587);
  });

  it("maps legacy PSI depeg ids onto the canonical live cache asset", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeStabilityAsset({
            id: "ust-terra", name: "TerraUSD", symbol: "UST", geckoId: "terrausd",
            pegMechanism: "algorithmic", price: 0.12, priceConfidence: "single-source",
            circulating: { peggedUSD: 15_000_000_000 }, circulatingPrevDay: { peggedUSD: 17_000_000_000 },
            circulatingPrevWeek: { peggedUSD: 18_500_000_000 }, circulatingPrevMonth: { peggedUSD: 18_500_000_000 },
          }),
        ],
      },
      updatedAt: nowSec,
    });

    const db = makeDb({
      depegRows: [
        {
          stablecoin_id: "ust-terra-classic",
          peg_reference: 1,
          started_at: nowSec - 3_600,
        },
      ],
    });

    await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors as Array<Record<string, unknown>> : [];

    expect(snapshot.depegCount).toBe(1);
    expect(contributors).toHaveLength(1);
    expect(contributors[0]?.id).toBe("ust-terra");
    expect(contributors[0]?.bps).toBe(-8800);
  });

  it("does not turn a nominal par reference into observed calm for an open depeg", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: { peggedAssets: [makeStabilityAsset({
        price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
        priceObservedAt: null,
      })] },
      updatedAt: Math.floor(Date.now() / 1000),
    });
    const db = makeDb();
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}").reason).toBe("open-depeg-no-price");
    expect(snapshot.openDepegsWithoutPrice).toBe(1);
    expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price"]);
    expect(snapshot.contributors).toEqual([]);
  });

  it.each([
    ["usbd-bima", "protocol-redeem", false],
    ["usbd-bima", "coingecko", true],
    ["usdf-falcon", "protocol-redeem", true],
  ] as const)("admits replay price for %s from %s only when it is observed", async (id, source, observed) => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: { peggedAssets: [makeStabilityAsset({ id, price: null })] },
      updatedAt: nowSec,
    });
    const db = makeDb({
      depegRows: [{ stablecoin_id: id, peg_reference: 1, started_at: nowSec - 3600 }],
      priceCacheRows: [{ asset_id: id, price: 0.98, updated_at: nowSec - 60 }],
    });
    db.sqlite.prepare("UPDATE price_cache SET source = ? WHERE asset_id = ?").run(source, id);
    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    if (observed) {
      expect(snapshot.contributors).toEqual([expect.objectContaining({ id, bps: -200 })]);
      expect(snapshot.replayPriceFallbackCount).toBe(1);
    } else {
      expect(result.status).toBe("degraded");
      expect(snapshot.contributors).toEqual([]);
      expect(snapshot.openDepegsWithoutPrice).toBe(1);
      expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price"]);
    }
  });

  it("publishes with an explicit degraded component when an open depeg has no usable price", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          makeUnpricedFalconAsset(),
        ],
      },
      updatedAt: nowSec,
    });

    const db = makeDb({
      depegRows: [
        {
          stablecoin_id: "usdf-falcon",
          peg_reference: 1,
          started_at: nowSec - 3_600,
        },
      ],
      priceCacheRows: [
        {
          asset_id: "usdf-falcon",
          price: 0.5413,
          updated_at: nowSec - (6 * 60 * 60) - 1,
        },
      ],
    });

    const result = await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason?: string;
      openDepegsWithoutPrice: number;
      degradedComponents: string[];
    };

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(metadata.reason).toBe("open-depeg-no-price");
    expect(metadata.openDepegsWithoutPrice).toBe(1);
    expect(metadata.degradedComponents).toEqual(["open-depeg-no-price"]);
    expect(snapshot.degradedComponents).toEqual(["open-depeg-no-price"]);
    expect(persistedSampleCount(db)).toBe(1);
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
