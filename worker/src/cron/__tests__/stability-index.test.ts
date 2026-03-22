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

interface TestDb extends D1Database {
  runHistory: Array<{ sql: string; binds: unknown[] }>;
}

function makeDb(opts: {
  dewsUnavailable?: boolean;
  depegRows?: Array<{ stablecoin_id: string; peg_reference: number; started_at: number }>;
  priceCacheRows?: Array<{ asset_id: string; price: number; updated_at: number }>;
} = {}): TestDb {
  const runHistory: Array<{ sql: string; binds: unknown[] }> = [];

  const stmt = (sql: string, binds: unknown[] = []) => {
    const all = async <T>() => {
      if (sql.includes("FROM depeg_events")) {
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
      if (sql.includes("SELECT asset_id, price, updated_at FROM price_cache")) {
        return {
          results: (opts.priceCacheRows ?? []) as T[],
        };
      }
      if (sql.includes("SELECT asset_id, source, confidence")) {
        return {
          results: [] as T[],
        };
      }
      if (sql.includes("FROM stress_signals")) {
        if (opts.dewsUnavailable) {
          throw new Error("no such table: stress_signals");
        }
        return {
          results: [{ stablecoin_id: "usdt-tether", score: 72, band: "WARNING" }] as T[],
        };
      }
      return { results: [] as T[] };
    };

    const first = async <T>() => null as T | null;
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
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dewsUnavailable: boolean;
      dewsFailureReason: string | null;
    };
    expect(metadata.dewsUnavailable).toBe(true);
    expect(metadata.dewsFailureReason).toContain("stress_signals");
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

  it("falls back to recent replay-safe cached prices for open depegs missing current snapshot prices", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          {
            id: "usr-resolv",
            name: "Resolv USD",
            symbol: "USR",
            geckoId: "resolv-usr",
            pegType: "peggedUSD",
            pegMechanism: "crypto-backed",
            price: null,
            priceSource: "defillama",
            priceConfidence: null,
            priceUpdatedAt: null,
            priceObservedAt: null,
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
          stablecoin_id: "usr-resolv",
          peg_reference: 1,
          started_at: nowSec - 3_600,
        },
      ],
      priceCacheRows: [
        {
          asset_id: "usr-resolv",
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
    expect(contributors[0]?.id).toBe("usr-resolv");
    expect(contributors[0]?.bps).toBe(-4587);
  });

  it("does not use stale replay-safe cached prices for open depegs", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      payload: {
        peggedAssets: [
          {
            id: "usr-resolv",
            name: "Resolv USD",
            symbol: "USR",
            geckoId: "resolv-usr",
            pegType: "peggedUSD",
            pegMechanism: "crypto-backed",
            price: null,
            priceSource: "defillama",
            priceConfidence: null,
            priceUpdatedAt: null,
            priceObservedAt: null,
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
          stablecoin_id: "usr-resolv",
          peg_reference: 1,
          started_at: nowSec - 3_600,
        },
      ],
      priceCacheRows: [
        {
          asset_id: "usr-resolv",
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
