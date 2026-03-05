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

interface MakeDbOptions {
  failDexLiquidity?: boolean;
  signalIds?: string[];
  historyIds?: string[];
  onBind?: (sql: string, args: unknown[]) => void;
}

function makeDb(sqlSeen: string[], opts: MakeDbOptions = {}): D1Database {
  const stmt = (sql: string) => {
    sqlSeen.push(sql);
    const all = async <T>() => {
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signals")) {
        return {
          results: (opts.signalIds ?? ["1"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signal_history")) {
        return {
          results: (opts.historyIds ?? ["1"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
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
      bind: (...args: unknown[]) => {
        opts.onBind?.(sql, args);
        return { all, first, run };
      },
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
    const db = makeDb(sqlSeen, {
      signalIds: ["1", "999"],
      historyIds: ["1", "999"],
    });

    await computeAndStoreDEWS(db);

    expect(
      sqlSeen.some((sql) => sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signals")),
    ).toBe(true);
    expect(
      sqlSeen.some((sql) => sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signal_history")),
    ).toBe(true);
    expect(
      sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signals WHERE stablecoin_id IN")),
    ).toBe(true);
    expect(
      sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN")),
    ).toBe(true);
    expect(
      sqlSeen.some((sql) => sql.includes("NOT IN")),
    ).toBe(false);
  });

  it("chunks orphan deletes to avoid D1 bind-variable overflow", async () => {
    const sqlSeen: string[] = [];
    const deleteBindCounts: number[] = [];
    const orphanIds = Array.from({ length: 145 }, (_, i) => `orphan-${i}`);
    const db = makeDb(sqlSeen, {
      signalIds: ["1", ...orphanIds],
      historyIds: ["1", ...orphanIds],
      onBind: (sql, args) => {
        if (
          sql.includes("DELETE FROM stress_signals WHERE stablecoin_id IN")
          || sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN")
        ) {
          deleteBindCounts.push(args.length);
        }
      },
    });

    await computeAndStoreDEWS(db);

    expect(deleteBindCounts.length).toBeGreaterThan(2);
    expect(Math.max(...deleteBindCounts)).toBeLessThanOrEqual(90);
    expect(sqlSeen.some((sql) => sql.includes("NOT IN"))).toBe(false);
  });
});
