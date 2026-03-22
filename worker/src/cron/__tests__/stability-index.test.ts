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

function makeDb(opts: { dewsUnavailable?: boolean } = {}): D1Database {
  const stmt = (sql: string) => {
    const all = async <T>() => {
      if (sql.includes("FROM depeg_events")) {
        return {
          results: [
            {
              stablecoin_id: "usdt-tether",
              peg_reference: 1,
              started_at: Math.floor(Date.now() / 1000) - 3600,
            },
          ] as T[],
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
    const run = async () => ({ success: true, meta: { changes: 1 } });

    return {
      bind: () => ({ all, first, run }),
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
  } as unknown as D1Database;
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
