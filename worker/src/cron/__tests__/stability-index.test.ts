import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({
    kind: "ok",
    payload: {
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether USD",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "defillama",
          priceConfidence: "high",
          priceUpdatedAt: Math.floor(Date.now() / 1000),
          supplySource: "defillama",
          circulating: { peggedUSD: 100_000_000 },
          circulatingPrevDay: { peggedUSD: 99_000_000 },
          circulatingPrevWeek: { peggedUSD: 98_000_000 },
          circulatingPrevMonth: { peggedUSD: 97_000_000 },
          chainCirculating: {},
          chains: [],
        },
      ],
    },
    updatedAt: Math.floor(Date.now() / 1000),
  })),
}));

import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { computeAndStoreStabilityIndex } from "../stability-index";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

interface TestDb extends D1Database {
  runHistory: Array<{ sql: string; binds: unknown[] }>;
}

function makeDb(opts: {
  dewsUnavailable?: boolean;
  dewsPublishedAt?: number | null;
  dewsRows?: Array<{ stablecoin_id: string; score: number; band: string; computed_at: number }>;
  depegQueryFails?: boolean;
  depegRows?: Array<{ stablecoin_id: string; peg_reference: number; started_at: number }>;
  priceCacheRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
} = {}): TestDb {
  const runHistory: Array<{ sql: string; binds: unknown[] }> = [];
  const defaultDewsRows = [{
    stablecoin_id: "usdt-tether",
    score: 72,
    band: "WARNING",
    computed_at: Math.floor(Date.now() / 1000) - 300,
  }];
  const configuredDewsRows = opts.dewsRows ?? defaultDewsRows;
  const hasExplicitPublishedAt = Object.prototype.hasOwnProperty.call(opts, "dewsPublishedAt");
  const dewsPublishedAt = hasExplicitPublishedAt
    ? opts.dewsPublishedAt ?? null
    : configuredDewsRows[0]?.computed_at ?? Math.floor(Date.now() / 1000) - 300;

  const stmt = (sql: string, binds: unknown[] = []) => {
    const all = async <T>() => {
      if (sql.includes("FROM depeg_events")) {
        if (opts.depegQueryFails) {
          throw new Error("no such table: depeg_events");
        }
        return {
          results: (opts.depegRows ?? [
            {
              stablecoin_id: "usdt-tether",
              peg_reference: 1,
              started_at: Math.floor(Date.now() / 1000) - 3600,
            },
          ]) as T[],
        };
      }
      if (sql.includes("source, confidence, observed_at")) {
        return {
          results: (opts.priceCacheRows ?? []).map((r) => ({
            ...r,
            source: null,
            confidence: null,
            observed_at: null,
            observed_at_mode: null,
            synced_at: null,
            agree_sources_json: null,
            consensus_sources_json: null,
          })) as T[],
        };
      }
      if (sql.includes("SELECT asset_id, price, updated_at FROM price_cache")) {
        return {
          results: (opts.priceCacheRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM stress_signal_publication_rows") || sql.includes("FROM stress_signals")) {
        if (opts.dewsUnavailable) {
          throw new Error("no such table: stress_signal_publication_rows");
        }
        const bound = typeof binds[0] === "number" ? binds[0] : null;
        let filtered = configuredDewsRows;
        if (bound != null) {
          if (sql.includes("computed_at = ?")) {
            filtered = configuredDewsRows.filter((row) => row.computed_at === bound);
          } else {
            filtered = configuredDewsRows.filter((row) => row.computed_at <= bound);
          }
        }
        return { results: filtered as T[] };
      }
      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.includes("FROM cache WHERE key = ?") && binds[0] === "dews:published-generation" && dewsPublishedAt != null) {
        const publishedRows = configuredDewsRows.filter((row) => row.computed_at === dewsPublishedAt);
        return {
          value: JSON.stringify({
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
          updated_at: dewsPublishedAt,
        } as T;
      }
      return null as T | null;
    };
    const run = async () => {
      runHistory.push({ sql, binds: [...binds] });
      return { success: true, meta: { changes: 1 } };
    };

    return {
      bind: (...args: unknown[]) => stmt(sql, args),
      all,
      first,
      run,
    };
  };

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    runHistory,
  } as unknown as TestDb;
}

function readInsertedInputSnapshot(db: TestDb): Record<string, unknown> {
  const insertCall = [...db.runHistory].reverse().find((entry) =>
    entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples"),
  );
  if (!insertCall) {
    throw new Error("Expected stability_index_samples insert");
  }
  return JSON.parse(String(insertCall.binds[4] ?? "{}")) as Record<string, unknown>;
}

describe("computeAndStoreStabilityIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
    vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue({
      kind: "ok",
      payload: {
        peggedAssets: [
          {
            id: "usdt-tether",
            name: "Tether USD",
            symbol: "USDT",
            geckoId: "tether",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: Math.floor(Date.now() / 1000),
            priceObservedAt: Math.floor(Date.now() / 1000),
            priceObservedAtMode: "upstream",
            priceSyncedAt: Math.floor(Date.now() / 1000),
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevDay: { peggedUSD: 99_000_000 },
            circulatingPrevWeek: { peggedUSD: 98_000_000 },
            circulatingPrevMonth: { peggedUSD: 97_000_000 },
            chainCirculating: {},
            chains: [],
          },
        ],
      },
      updatedAt: Math.floor(Date.now() / 1000),
    });
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
    expect(
      db.runHistory.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples")),
    ).toBe(false);
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
    expect(
      db.runHistory.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples")),
    ).toBe(false);
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
    expect(
      db.runHistory.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples")),
    ).toBe(false);
  });

  it("uses only the stale published generation while a fresher generation is staging", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleComputedAt = nowSec - CRON_INTERVALS["compute-dews"] * 2 - 1;
    const freshComputedAt = nowSec - 60;
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          {
            id: "usdt-tether",
            name: "Tether USD",
            symbol: "USDT",
            geckoId: "tether",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: nowSec,
            priceObservedAt: nowSec,
            priceObservedAtMode: "upstream",
            priceSyncedAt: nowSec,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevDay: { peggedUSD: 99_000_000 },
            circulatingPrevWeek: { peggedUSD: 98_000_000 },
            circulatingPrevMonth: { peggedUSD: 97_000_000 },
            chainCirculating: {},
            chains: [],
          },
          {
            id: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            geckoId: "usd-coin",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: nowSec,
            priceObservedAt: nowSec,
            priceObservedAtMode: "upstream",
            priceSyncedAt: nowSec,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 200_000_000 },
            circulatingPrevDay: { peggedUSD: 199_000_000 },
            circulatingPrevWeek: { peggedUSD: 198_000_000 },
            circulatingPrevMonth: { peggedUSD: 197_000_000 },
            chainCirculating: {},
            chains: [],
          },
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
    expect(
      db.runHistory.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples")),
    ).toBe(false);
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
    expect(
      db.runHistory.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO stability_index_samples")),
    ).toBe(false);
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
          {
            id: "usdt-tether",
            name: "Tether USD",
            symbol: "USDT",
            geckoId: "tether",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: nowSec,
            priceObservedAt: nowSec,
            priceObservedAtMode: "upstream",
            priceSyncedAt: nowSec,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevDay: { peggedUSD: 99_000_000 },
            circulatingPrevWeek: { peggedUSD: 98_000_000 },
            circulatingPrevMonth: { peggedUSD: 97_000_000 },
            chainCirculating: {},
            chains: [],
          },
          {
            id: "xaut-tether",
            name: "Tether Gold",
            symbol: "XAUT",
            geckoId: "tether-gold",
            pegType: "peggedGOLD",
            pegMechanism: "commodity-backed",
            price: 2_500,
            priceSource: "coingecko",
            priceConfidence: "single-source",
            priceUpdatedAt: nowSec,
            priceObservedAt: nowSec,
            priceObservedAtMode: "upstream",
            priceSyncedAt: nowSec,
            consensusSources: [],
            agreeSources: [],
            supplySource: "coingecko",
            circulating: { peggedGOLD: 50_000_000 },
            circulatingPrevDay: {},
            circulatingPrevWeek: {},
            circulatingPrevMonth: {},
            chainCirculating: {},
            chains: [],
          },
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
          {
            id: "usdf-falcon",
            name: "Falcon USD",
            symbol: "USDf",
            geckoId: "falcon-finance",
            pegType: "peggedUSD",
            pegMechanism: "crypto-backed",
            price: null,
            priceSource: "defillama",
            priceConfidence: null,
            priceUpdatedAt: null,
            priceObservedAt: null,
            priceObservedAtMode: null,
            priceSyncedAt: null,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 93_500_000 },
            circulatingPrevDay: { peggedUSD: 92_000_000 },
            circulatingPrevWeek: { peggedUSD: 90_000_000 },
            circulatingPrevMonth: { peggedUSD: 88_000_000 },
            chainCirculating: {},
            chains: [],
          },
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
          {
            id: "ust-terra",
            name: "TerraUSD",
            symbol: "UST",
            geckoId: "terrausd",
            pegType: "peggedUSD",
            pegMechanism: "algorithmic",
            price: 0.12,
            priceSource: "defillama",
            priceConfidence: "single-source",
            priceUpdatedAt: nowSec,
            priceObservedAt: nowSec,
            priceObservedAtMode: "upstream",
            priceSyncedAt: nowSec,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 15_000_000_000 },
            circulatingPrevDay: { peggedUSD: 17_000_000_000 },
            circulatingPrevWeek: { peggedUSD: 18_500_000_000 },
            circulatingPrevMonth: { peggedUSD: 18_500_000_000 },
            chainCirculating: {},
            chains: [],
          },
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

  it("does not use stale replay-safe cached prices for open depegs", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          {
            id: "usdf-falcon",
            name: "Falcon USD",
            symbol: "USDf",
            geckoId: "falcon-finance",
            pegType: "peggedUSD",
            pegMechanism: "crypto-backed",
            price: null,
            priceSource: "defillama",
            priceConfidence: null,
            priceUpdatedAt: null,
            priceObservedAt: null,
            priceObservedAtMode: null,
            priceSyncedAt: null,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 93_500_000 },
            circulatingPrevDay: { peggedUSD: 92_000_000 },
            circulatingPrevWeek: { peggedUSD: 90_000_000 },
            circulatingPrevMonth: { peggedUSD: 88_000_000 },
            chainCirculating: {},
            chains: [],
          },
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

    await computeAndStoreStabilityIndex(db);
    const snapshot = readInsertedInputSnapshot(db);
    const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors as Array<Record<string, unknown>> : [];

    expect(snapshot.replayPriceFallbackCount).toBe(0);
    expect(snapshot.depegCount).toBe(0);
    expect(contributors).toHaveLength(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
