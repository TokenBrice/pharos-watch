import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    {
      id: "1",
      symbol: "USDT",
      flags: { navToken: false },
    },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    [
      "1",
      {
        id: "1",
        symbol: "USDT",
        flags: { navToken: false },
      },
    ],
  ]),
}));

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: () => ({ rates: { peggedUSD: 1 } }),
  getPegReference: () => 1,
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getCache: vi.fn(async () => ({
      value: JSON.stringify({
        peggedAssets: [
          {
            id: "1",
            symbol: "USDT",
            pegType: "peggedUSD",
            price: 1,
            priceConfidence: "high",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevDay: { peggedUSD: 99_000_000 },
            circulatingPrevWeek: { peggedUSD: 98_000_000 },
          },
        ],
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    })),
    batchExecute: vi.fn(async () => {}),
  };
});

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 12,
    band: "CALM",
    signals: {},
  })),
}));

import { getCache } from "../../lib/db";
import { computeDEWS } from "../../lib/dews";
import { computeAndStoreDEWS } from "../compute-dews";

function makeDb(sqlSeen: string[], opts: { failDexLiquidity?: boolean } = {}): D1Database {
  const stmt = (sql: string) => {
    sqlSeen.push(sql);
    const all = async <T>() => {
      if (/FROM dex_liquidity(?!_history)/.test(sql)) {
        if (opts.failDexLiquidity) {
          throw new Error("dex-liquidity unavailable");
        }
        return {
          results: [
            {
              stablecoin_id: "1",
              weighted_balance_ratio: 0.95,
              avg_pool_stress: 0.05,
              top_pools_json: "[]",
              liquidity_score: 80,
              total_tvl_usd: 1_500_000,
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM dex_liquidity_history")) {
        return {
          results: [
            {
              stablecoin_id: "1",
              snapshot_date: Math.floor(Date.now() / 1000) - 7 * 86400,
              liquidity_score: 73,
              total_tvl_usd: 1_200_000,
            },
          ] as T[],
        };
      }
      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.includes("stress_signal_history")) return null as T | null;
      if (sql.includes("stability_index_samples")) return null as T | null;
      return null as T | null;
    };

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

describe("computeAndStoreDEWS", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:00:00Z"));
    vi.mocked(computeDEWS).mockClear();
    vi.mocked(getCache).mockResolvedValue({
      value: JSON.stringify({
        peggedAssets: [
          {
            id: "1",
            symbol: "USDT",
            pegType: "peggedUSD",
            price: 1,
            priceConfidence: "high",
            circulating: { peggedUSD: 100_000_000 },
            circulatingPrevDay: { peggedUSD: 99_000_000 },
            circulatingPrevWeek: { peggedUSD: 98_000_000 },
          },
        ],
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    });
  });

  it("loads 7d liquidity history from snapshot_date/liquidity_score/total_tvl_usd", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    const result = await computeAndStoreDEWS(db);

    expect(result.itemCount).toBe(1);
    expect(sqlSeen.some((sql) => sql.includes("snapshot_date, liquidity_score, total_tvl_usd"))).toBe(true);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "1",
        liquidityScore7dAgo: 73,
        tvl7dAgo: 1_200_000,
      }),
    );
  });

  it("marks run degraded when dex_liquidity is unavailable", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, { failDexLiquidity: true });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceFailures: Array<{ source: string; bootstrapAllowed: boolean }>;
    };
    expect(metadata.sourceFailures.some((failure) => failure.source === "dex-liquidity")).toBe(true);
  });

  it("purges orphan stress rows for IDs outside the current eligible set", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    await computeAndStoreDEWS(db);

    expect(
      sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signals WHERE stablecoin_id NOT IN")),
    ).toBe(true);
    expect(
      sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id NOT IN")),
    ).toBe(true);
  });
});
