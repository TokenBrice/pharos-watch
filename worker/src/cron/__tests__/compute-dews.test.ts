import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    {
      id: "usdt-tether",
      symbol: "USDT",
      flags: { navToken: false },
    },
    {
      id: "pyusd-paypal",
      symbol: "PYUSD",
      flags: { navToken: false },
    },
    {
      id: "usd1-world-liberty-financial",
      symbol: "USD1",
      flags: { navToken: false },
    },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    [
      "usdt-tether",
      {
        id: "usdt-tether",
        symbol: "USDT",
        flags: { navToken: false },
      },
    ],
    [
      "pyusd-paypal",
      {
        id: "pyusd-paypal",
        symbol: "PYUSD",
        flags: { navToken: false },
      },
    ],
    [
      "usd1-world-liberty-financial",
      {
        id: "usd1-world-liberty-financial",
        symbol: "USD1",
        flags: { navToken: false },
      },
    ],
  ]),
}));

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({ rates: { peggedUSD: 1 } })),
  getPegReference: vi.fn(() => 1),
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async () => {}),
  };
});

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async () => ({
    value: JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
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
  setCache: vi.fn(async () => {}),
  writeFreshnessSentinel: vi.fn(async () => {}),
}));

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 12,
    band: "CALM",
    signals: {},
  })),
}));

import { getCache } from "../../lib/db-cache";
import { computeDEWS } from "../../lib/dews";
import { derivePegRates } from "@shared/lib/peg-rates";
import { computeAndStoreDEWS } from "../compute-dews";

interface MakeDbOptions {
  failDexLiquidity?: boolean;
  failDexPricesMissingTable?: boolean;
  dexPriceRows?: Array<{
    stablecoin_id: string;
    dex_price_usd: number;
    source_total_tvl?: number;
    updated_at: number;
  }>;
  mintBurn24hRows?: Array<{ stablecoin_id: string; chain_id?: string; total_burn: number; total_mint: number }>;
  mintBurn30dRows?: Array<{
    stablecoin_id: string;
    chain_id?: string;
    avg_burn: number;
    avg_mint: number;
    days_with_data: number;
  }>;
  blacklist24hRows?: Array<{ stablecoin: string; cnt: number }>;
  blacklist7dRows?: Array<{ stablecoin: string; cnt: number }>;
  prevSignalRows?: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }>;
  yieldWarningRows?: Array<{
    stablecoin_id: string;
    warning_signals: string;
  }>;
  signalIds?: string[];
  historyIds?: string[];
  onBind?: (sql: string, args: unknown[]) => void;
}

function makeDb(sqlSeen: string[], opts: MakeDbOptions = {}): D1Database {
  const stmt = (sql: string) => {
    sqlSeen.push(sql);
    let boundArgs: unknown[] = [];
    const all = async <T>() => {
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signals")) {
        return {
          results: (opts.signalIds ?? ["usdt-tether"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signal_history")) {
        return {
          results: (opts.historyIds ?? ["usdt-tether"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (/FROM dex_liquidity(?!_history)/.test(sql)) {
        if (opts.failDexLiquidity) {
          throw new Error("dex-liquidity unavailable");
        }
        return {
          results: [
            {
              stablecoin_id: "usdt-tether",
              weighted_balance_ratio: 0.95,
              avg_pool_stress: 0.05,
              top_pools_json: "[]",
              liquidity_score: 80,
              total_tvl_usd: 1_500_000,
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM dex_prices")) {
        if (opts.failDexPricesMissingTable) {
          throw new Error("no such table: dex_prices");
        }
        return {
          results: (opts.dexPriceRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM stress_signals s")) {
        return {
          results: (opts.prevSignalRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM dex_liquidity_history")) {
        return {
          results: [
            {
              stablecoin_id: "usdt-tether",
              snapshot_date: Math.floor(Date.now() / 1000) - 7 * 86400,
              liquidity_score: 73,
              total_tvl_usd: 1_200_000,
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM blacklist_events")) {
        const cutoff = typeof boundArgs[0] === "number" ? boundArgs[0] : null;
        const nowSec = Math.floor(Date.now() / 1000);
        const sevenDayCutoff = nowSec - 7 * 86400;
        return {
          results: (cutoff === sevenDayCutoff ? (opts.blacklist7dRows ?? []) : (opts.blacklist24hRows ?? [])) as T[],
        };
      }
      if (sql.includes("FROM yield_data")) {
        return {
          results: (opts.yieldWarningRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM mint_burn_hourly")) {
        if (sql.includes("days_with_data")) {
          return {
            results: (opts.mintBurn30dRows ?? []).map((row) => ({ chain_id: "ethereum", ...row })) as T[],
          };
        }
        return {
          results: (opts.mintBurn24hRows ?? []).map((row) => ({ chain_id: "ethereum", ...row })) as T[],
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
        boundArgs = args;
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
    vi.mocked(derivePegRates).mockClear();
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "usdt-tether",
              symbol: "USDT",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 100_000_000 },
              circulatingPrevDay: { peggedUSD: 99_000_000 },
              circulatingPrevWeek: { peggedUSD: 98_000_000 },
            },
          ],
          fxFallbackRates: { peggedEUR: 1.08 },
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
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
        stablecoinId: "usdt-tether",
        liquidityScore7dAgo: 73,
        tvl7dAgo: 1_200_000,
      }),
    );
  });

  it("passes cached fxFallbackRates into peg-rate derivation", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    await computeAndStoreDEWS(db);

    expect(derivePegRates).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Map),
      { peggedEUR: 1.08 },
    );
  });

  it("keeps a mature mint/burn baseline when the latest 24h window is quiet", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      mintBurn30dRows: [
        {
          stablecoin_id: "usdt-tether",
          avg_burn: 250_000,
          avg_mint: 150_000,
          days_with_data: 14,
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        burnVolume24hUsd: 0,
        mintVolume24hUsd: 0,
        burnBaseline30dUsd: 250_000,
        flowDataAgeDays: 14,
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

  it("marks run degraded when previous stress_signals JSON is malformed", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      prevSignalRows: [
        {
          stablecoin_id: "usdt-tether",
          signals_json: "{bad-json",
          band: "CALM",
          computed_at: nowSec - 900,
        },
      ],
    });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
      malformedCoreInputRows: number;
      malformedPersistedInputs: Array<{ source: string; stablecoinId: string; context: string }>;
    };
    expect(metadata.fallbackMode).toBe("malformed-persisted-inputs");
    expect(metadata.malformedCoreInputRows).toBe(1);
    expect(metadata.malformedPersistedInputs).toContainEqual(
      expect.objectContaining({
        source: "stress_signals",
        stablecoinId: "usdt-tether",
        context: "stress_signals.signals_json",
      }),
    );
  });

  it("marks run degraded when yield warning JSON is malformed", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      yieldWarningRows: [
        {
          stablecoin_id: "usdt-tether",
          warning_signals: "{\"not\":\"an-array\"}",
        },
      ],
    });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      malformedCoreInputRows: number;
      malformedPersistedInputs: Array<{ source: string; stablecoinId: string; context: string }>;
    };
    expect(metadata.malformedCoreInputRows).toBe(1);
    expect(metadata.malformedPersistedInputs).toContainEqual(
      expect.objectContaining({
        source: "yield_data",
        stablecoinId: "usdt-tether",
        context: "yield_data.warning_signals",
      }),
    );
  });

  it("stops bootstrap-allowing missing optional tables after the DEWS bootstrap sentinel exists", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") {
        return {
          value: JSON.stringify({ completedAt: Math.floor(Date.now() / 1000) - 3600 }),
          updatedAt: Math.floor(Date.now() / 1000) - 3600,
        } as never;
      }
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "usdt-tether",
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
      } as never;
    });
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, { failDexPricesMissingTable: true });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      bootstrapPending: boolean;
      sourceFailures: Array<{ source: string; bootstrapAllowed: boolean }>;
    };
    expect(metadata.bootstrapPending).toBe(false);
    expect(
      metadata.sourceFailures.find((failure) => failure.source === "dex-prices")?.bootstrapAllowed,
    ).toBe(false);
  });

  it("ignores stale dex price rows when building the DEWS divergence input", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      dexPriceRows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.97,
          source_total_tvl: 2_000_000,
          updated_at: nowSec - 7200,
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        dexPriceUsd: null,
      }),
    );
  });

  it("ignores fresh dex price rows that do not satisfy the live depeg trust floor", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      dexPriceRows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.97,
          source_total_tvl: 250_000,
          updated_at: nowSec - 60,
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        dexPriceUsd: null,
      }),
    );
  });

  it("includes blacklist counts for PYUSD and USD1 when those tracker rows exist", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "pyusd-paypal",
              symbol: "PYUSD",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 50_000_000 },
              circulatingPrevDay: { peggedUSD: 49_000_000 },
              circulatingPrevWeek: { peggedUSD: 48_000_000 },
            },
            {
              id: "usd1-world-liberty-financial",
              symbol: "USD1",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 75_000_000 },
              circulatingPrevDay: { peggedUSD: 74_000_000 },
              circulatingPrevWeek: { peggedUSD: 73_000_000 },
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      blacklist24hRows: [
        { stablecoin: "PYUSD", cnt: 2 },
        { stablecoin: "USD1", cnt: 1 },
      ],
      blacklist7dRows: [
        { stablecoin: "PYUSD", cnt: 5 },
        { stablecoin: "USD1", cnt: 3 },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "pyusd-paypal",
        blacklistEvents24h: 2,
        blacklistEvents7d: 5,
        hasBlacklistTracking: true,
      }),
    );
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usd1-world-liberty-financial",
        blacklistEvents24h: 1,
        blacklistEvents7d: 3,
        hasBlacklistTracking: true,
      }),
    );
  });

  it("purges orphan stress rows for IDs outside the current eligible set", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      signalIds: ["usdt-tether", "999"],
      historyIds: ["usdt-tether", "999"],
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

  it("retires current stress rows for eligible assets with no current supply", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "usdt-tether",
              symbol: "USDT",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 100_000_000 },
              circulatingPrevDay: { peggedUSD: 99_000_000 },
              circulatingPrevWeek: { peggedUSD: 98_000_000 },
            },
            {
              id: "pyusd-paypal",
              symbol: "PYUSD",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 0 },
              circulatingPrevDay: { peggedUSD: 0 },
              circulatingPrevWeek: { peggedUSD: 0 },
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    const sqlSeen: string[] = [];
    const currentRetireBinds: unknown[][] = [];
    const db = makeDb(sqlSeen, {
      signalIds: ["usdt-tether", "pyusd-paypal"],
      historyIds: ["usdt-tether", "pyusd-paypal"],
      onBind: (sql, args) => {
        if (sql.includes("DELETE FROM stress_signals WHERE stablecoin_id IN")) {
          currentRetireBinds.push(args);
        }
      },
    });

    const result = await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledTimes(1);
    expect(computeDEWS).toHaveBeenCalledWith(expect.objectContaining({ stablecoinId: "usdt-tether" }));
    expect(currentRetireBinds).toContainEqual(["pyusd-paypal"]);
    expect(
      sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN")),
    ).toBe(false);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rowsRetiredCurrent: number;
      rowsSkippedNoCurrentSupply: number;
      sourceCoverage: Record<string, number>;
    };
    expect(metadata.rowsRetiredCurrent).toBe(1);
    expect(metadata.rowsSkippedNoCurrentSupply).toBe(1);
    expect(metadata.sourceCoverage.coinsSkippedNoCurrentSupply).toBe(1);
  });

  it("chunks orphan deletes to avoid D1 bind-variable overflow", async () => {
    const sqlSeen: string[] = [];
    const deleteBindCounts: number[] = [];
    const orphanIds = Array.from({ length: 145 }, (_, i) => `orphan-${i}`);
    const db = makeDb(sqlSeen, {
      signalIds: ["usdt-tether", ...orphanIds],
      historyIds: ["usdt-tether", ...orphanIds],
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
