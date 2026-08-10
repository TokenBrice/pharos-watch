import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins/registry", async () => {
  const actual = await vi.importActual<typeof import("@shared/lib/stablecoins/registry")>(
    "@shared/lib/stablecoins/registry",
  );
  return { ...actual, FROZEN_IDS: new Set<string>() };
});

vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    {
      id: "usdt-tether",
      symbol: "USDT",
      flags: { navToken: false, pegCurrency: "USD" },
    },
    {
      id: "pyusd-paypal",
      symbol: "PYUSD",
      flags: { navToken: false, pegCurrency: "USD" },
    },
    {
      id: "usd1-world-liberty-financial",
      symbol: "USD1",
      flags: { navToken: false, pegCurrency: "USD" },
    },
    {
      id: "eurc-euro-coin",
      symbol: "EURC",
      flags: { navToken: false, pegCurrency: "EUR" },
    },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    [
      "usdt-tether",
      {
        id: "usdt-tether",
        symbol: "USDT",
        flags: { navToken: false, pegCurrency: "USD" },
      },
    ],
    [
      "pyusd-paypal",
      {
        id: "pyusd-paypal",
        symbol: "PYUSD",
        flags: { navToken: false, pegCurrency: "USD" },
      },
    ],
    [
      "usd1-world-liberty-financial",
      {
        id: "usd1-world-liberty-financial",
        symbol: "USD1",
        flags: { navToken: false, pegCurrency: "USD" },
      },
    ],
    [
      "eurc-euro-coin",
      {
        id: "eurc-euro-coin",
        symbol: "EURC",
        flags: { navToken: false, pegCurrency: "EUR" },
      },
    ],
  ]),
}));

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({
    rates: { peggedUSD: 1 },
    sources: { peggedUSD: "median" },
    counts: { peggedUSD: 1 },
  })),
  getPegReference: vi.fn((pegType: string, rates: Record<string, number>) => rates[pegType] ?? 1),
  normalizePegType: vi.fn((pegType: string | undefined) =>
    pegType === "peggedBRL" ? "peggedREAL" : pegType,
  ),
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
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
  writeFreshnessSentinel: vi.fn(async () => {}),
}));

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 12,
    band: "CALM",
    signals: {},
    amplifiers: { psi: 1, contagion: 1 },
  })),
}));

import { getCache, writeFreshnessSentinel } from "../../lib/db-cache";
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
  dexLiqRows?: Array<{
    stablecoin_id: string;
    weighted_balance_ratio: number | null;
    avg_pool_stress: number | null;
    top_pools_json?: string | null;
    liquidity_score: number | null;
    total_tvl_usd: number | null;
    updated_at?: number | null;
  }>;
  mintBurn24hRows?: Array<{
    stablecoin_id: string;
    chain_id?: string;
    total_burn: number;
    total_mint: number;
    latest_hour_ts?: number | null;
  }>;
  mintBurn30dRows?: Array<{
    stablecoin_id: string;
    chain_id?: string;
    total_burn: number;
    total_mint: number;
    days_with_data: number;
    latest_hour_ts?: number | null;
  }>;
  blacklistRows?: Array<{
    stablecoin: string;
    chain_id?: string;
    config_key?: string | null;
    contract_address?: string | null;
    timestamp: number;
  }>;
  prevSignalRows?: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }>;
  yieldWarningRows?: Array<{
    stablecoin_id: string;
    warning_signals: string;
    is_best?: number | null;
    publication_state?: string | null;
  }>;
  yieldRankingsPayload?: unknown;
  signalIds?: string[];
  historyIds?: string[];
  historySnapshotIds?: string[];
  currentGenerationRows?: number;
  latestGenerationRows?: number;
  dexPublicationLatest?: {
    generation_id: string;
    state: string;
    started_at: number | null;
    published_at: number | null;
    failed_at: number | null;
    failure_reason: string | null;
  };
  dexPublicationLatestPublished?: {
    generation_id: string;
    state: string;
    started_at: number | null;
    published_at: number | null;
    failed_at: number | null;
    failure_reason: string | null;
  };
  failDexPublicationDiagnostics?: boolean;
  onBind?: (sql: string, args: unknown[]) => void;
}

function makeDb(sqlSeen: string[], opts: MakeDbOptions = {}): D1Database {
  const computedSnapshotIds = new Set<string>();
  const stmt = (sql: string) => {
    sqlSeen.push(sql);
    const all = async <T>() => {
      if (sql.includes("pharos:dews:stress-history-daily-ids")) {
        return {
          results: (opts.historySnapshotIds ?? [...computedSnapshotIds])
            .map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
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
          results: (opts.dexLiqRows ?? [
            {
              stablecoin_id: "usdt-tether",
              weighted_balance_ratio: 0.95,
              avg_pool_stress: 0.05,
              top_pools_json: "[]",
              liquidity_score: 80,
              total_tvl_usd: 1_500_000,
              updated_at: Math.floor(Date.now() / 1000),
            },
          ]) as T[],
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
        return {
          results: (opts.blacklistRows ?? []).map((row) => ({
            chain_id: "ethereum",
            config_key: null,
            contract_address: null,
            ...row,
          })) as T[],
        };
      }
      if (sql.includes("FROM yield_data")) {
        const rows = opts.yieldWarningRows ?? [];
        const bestRows = sql.includes("is_best = 1")
          ? rows.filter((row) => row.is_best == null || row.is_best === 1)
          : rows;
        if (sql.includes("publication_state")) {
          return {
            results: bestRows.filter(
              (row) => row.publication_state == null || row.publication_state === "published",
            ) as T[],
          };
        }
        return { results: bestRows as T[] };
      }
      if (sql.includes("FROM mint_burn_hourly")) {
        const freshHourTs = Math.floor(Date.now() / 1000) - 3600;
        if (sql.includes("days_with_data")) {
          return {
            results: (opts.mintBurn30dRows ?? []).map((row) => ({
              chain_id: "ethereum",
              latest_hour_ts: row.latest_hour_ts ?? freshHourTs,
              ...row,
            })) as T[],
          };
        }
        return {
          results: (opts.mintBurn24hRows ?? []).map((row) => ({
            chain_id: "ethereum",
            latest_hour_ts: row.latest_hour_ts ?? freshHourTs,
            ...row,
          })) as T[],
        };
      }
      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.includes("FROM dex_liquidity_publication_generations")) {
        if (opts.failDexPublicationDiagnostics) {
          throw new Error("publication diagnostics unavailable");
        }
        if (sql.includes("WHERE state = 'published'")) {
          return (opts.dexPublicationLatestPublished ?? null) as T | null;
        }
        return (opts.dexPublicationLatest ?? null) as T | null;
      }
      if (sql.includes("FROM cache WHERE key = ?")) {
        if (opts.yieldRankingsPayload === undefined) return null as T | null;
        return {
          value: JSON.stringify(opts.yieldRankingsPayload),
          updated_at: Math.floor(Date.now() / 1000),
        } as T;
      }
      if (sql.includes("pharos:dews:publication-generation-count")) {
        return { cnt: opts.currentGenerationRows ?? 1 } as T;
      }
      if (sql.includes("pharos:dews:stress-latest-generation-count")) {
        return { cnt: opts.latestGenerationRows ?? opts.currentGenerationRows ?? 1 } as T;
      }
      if (sql.includes("stress_signal_history")) return null as T | null;
      if (sql.includes("stability_index_samples")) return null as T | null;
      return null as T | null;
    };

    const run = async () => ({ success: true, meta: { changes: 1 } });

    return {
      bind: (...args: unknown[]) => {
        if (
          sql.includes("pharos:dews:stress-history-sparse-insert")
          && typeof args[0] === "string"
        ) {
          computedSnapshotIds.add(args[0]);
        }
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
    batch: async (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((statement) => statement.run()),
    ),
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
    vi.mocked(writeFreshnessSentinel).mockClear();
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      if (key === "dews:published-generation") return null;
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

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("dews aborted"));

    await expect(computeAndStoreDEWS(makeDb([]), controller.signal)).rejects.toThrow("dews aborted");
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

  it("excludes delisted and quarantined cache rows from DEWS coverage", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete" || key === "dews:published-generation") return null;
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
              id: "bfusd-binance",
              symbol: "BFUSD",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 1_000_000 },
              circulatingPrevDay: { peggedUSD: 1_000_000 },
              circulatingPrevWeek: { peggedUSD: 1_000_000 },
            },
            {
              id: "benji-franklin-templeton",
              symbol: "BENJI",
              pegType: "peggedUSD",
              price: 1,
              priceConfidence: "high",
              circulating: { peggedUSD: 1_000_000 },
              circulatingPrevDay: { peggedUSD: 1_000_000 },
              circulatingPrevWeek: { peggedUSD: 1_000_000 },
            },
          ],
          fxFallbackRates: { peggedEUR: 1.08 },
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });

    const result = await computeAndStoreDEWS(makeDb([]));
    const metadata = JSON.parse(result.metadata ?? "{}") as { sourceCoverage: Record<string, number> };
    const derivePegRateCalls = vi.mocked(derivePegRates).mock.calls;
    const pegAssets = derivePegRateCalls[derivePegRateCalls.length - 1]?.[0] ?? [];

    expect(pegAssets.map((asset) => asset.id)).toEqual(["usdt-tether"]);
    expect(metadata.sourceCoverage.stablecoins).toBe(1);
  });

  it("publishes the DEWS freshness sentinel after healthy non-empty persistence", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);
    expect(writeFreshnessSentinel).toHaveBeenCalledTimes(1);
    expect(writeFreshnessSentinel).toHaveBeenCalledWith(db, "dews", Math.floor(Date.now() / 1000), undefined);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      freshnessSentinelPublished: boolean;
      publicationPointerWritten: boolean;
      publishedGeneration: number | null;
      currentGenerationRows: number;
      latestGenerationRows: number | null;
    };
    expect(metadata.freshnessSentinelPublished).toBe(true);
    expect(metadata.publicationPointerWritten).toBe(true);
    expect(metadata.publishedGeneration).toBe(Math.floor(Date.now() / 1000));
    expect(metadata.currentGenerationRows).toBe(1);
    expect(metadata.latestGenerationRows).toBe(1);
  });

  it("does not publish the DEWS freshness sentinel for zero-result runs", async () => {
    vi.mocked(computeDEWS).mockReturnValueOnce(null as never);
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    const result = await computeAndStoreDEWS(db);

    expect(result.itemCount).toBe(0);
    expect(writeFreshnessSentinel).not.toHaveBeenCalled();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rowsWritten: number;
      freshnessSentinelPublished: boolean;
    };
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.freshnessSentinelPublished).toBe(false);
  });

  it("passes cached fxFallbackRates into peg-rate derivation", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    await computeAndStoreDEWS(db);

    expect(derivePegRates).toHaveBeenCalledWith(expect.any(Array), expect.any(Map), { peggedEUR: 1.08 });
  });

  it("preserves explicit zero supply-history anchors for DEWS scoring", async () => {
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
              circulatingPrevDay: { peggedUSD: 0 },
              circulatingPrevWeek: { peggedUSD: 0 },
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        circulatingCurrent: 100_000_000,
        circulatingPrevDay: 0,
        circulatingPrevWeek: 0,
        circulatingPrevDayAvailable: true,
        circulatingPrevWeekAvailable: true,
      }),
    );
  });

  it("marks supply-history anchors unavailable when both previous buckets are absent", async () => {
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
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen);

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        circulatingCurrent: 100_000_000,
        circulatingPrevDay: 100_000_000,
        circulatingPrevWeek: 100_000_000,
        circulatingPrevDayAvailable: false,
        circulatingPrevWeekAvailable: false,
      }),
    );
  });

  it("keeps a mature mint/burn baseline when a fresh 24h row is quiet", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      mintBurn24hRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 0,
          total_mint: 0,
          latest_hour_ts: nowSec - 3600,
        },
      ],
      mintBurn30dRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 3_500_000,
          total_mint: 2_100_000,
          days_with_data: 14,
          latest_hour_ts: nowSec - 3600,
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
        flowDataAgeDays: expect.any(Number),
        flowBaselineDays: 14,
        sourceAges: expect.objectContaining({ mintBurn: 3600 }),
        staleFlags: expect.objectContaining({ mintBurn: false }),
      }),
    );
    const calls = vi.mocked(computeDEWS).mock.calls;
    const input = calls[calls.length - 1]?.[0];
    expect(input?.flowDataAgeDays).toBeCloseTo(1 / 24, 5);
  });

  it("marks mature mint/burn baselines stale when no fresh 24h data exists", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      mintBurn30dRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 3_500_000,
          total_mint: 2_100_000,
          days_with_data: 14,
          latest_hour_ts: nowSec - 2 * 86400,
        },
      ],
    });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        burnVolume24hUsd: 0,
        mintVolume24hUsd: 0,
        burnBaseline30dUsd: 250_000,
        flowDataAgeDays: 2,
        flowBaselineDays: 14,
        sourceAges: expect.objectContaining({ mintBurn: 2 * 86400 }),
        staleFlags: expect.objectContaining({ mintBurn: true }),
      }),
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceFailures: Array<{ source: string; bootstrapAllowed: boolean }>;
      sourceCoverage: Record<string, number>;
    };
    expect(metadata.sourceFailures).toContainEqual(
      expect.objectContaining({ source: "mint-burn-hourly-freshness", bootstrapAllowed: false }),
    );
    expect(metadata.sourceCoverage.mintBurnHourlyStaleRows).toBe(1);
    expect(metadata.sourceCoverage.mintBurnHourlyFreshRows).toBe(0);
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

  it("does not publish the DEWS freshness sentinel for degraded runs", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, { failDexLiquidity: true });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(writeFreshnessSentinel).not.toHaveBeenCalled();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      freshnessSentinelPublished: boolean;
    };
    expect(metadata.freshnessSentinelPublished).toBe(false);
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
          warning_signals: '{"not":"an-array"}',
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

  it("excludes staged and failed yield warnings while retaining published and legacy rows", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      yieldWarningRows: [
        {
          stablecoin_id: "usdt-tether",
          warning_signals: JSON.stringify(["yield-spike"]),
          is_best: 1,
          publication_state: "published",
        },
        {
          stablecoin_id: "usdt-tether",
          warning_signals: JSON.stringify(["reward-heavy"]),
          is_best: 1,
          publication_state: "failed",
        },
        {
          stablecoin_id: "usdt-tether",
          warning_signals: JSON.stringify(["tvl-outflow"]),
          is_best: 1,
          publication_state: "staged",
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(sqlSeen.some((sql) => sql.includes("publication_state IS NULL OR publication_state = 'published'"))).toBe(
      true,
    );
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        yieldWarnings: ["yield-spike"],
      }),
    );
  });

  it("uses only selected best-row yield warnings", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      yieldWarningRows: [
        {
          stablecoin_id: "usdt-tether",
          warning_signals: JSON.stringify(["yield-spike"]),
          is_best: 0,
          publication_state: "published",
        },
        {
          stablecoin_id: "usdt-tether",
          warning_signals: JSON.stringify(["reward-heavy"]),
          is_best: 1,
          publication_state: "published",
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(sqlSeen.some((sql) => sql.includes("is_best = 1"))).toBe(true);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        yieldWarnings: ["reward-heavy"],
      }),
    );
  });

  it("passes structured yield source-risk and rank attribution from rankings cache into DEWS", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      yieldRankingsPayload: {
        rankings: [
          {
            id: "usdt-tether",
            sourceRisk: {
              sourceRiskPenalty: 1.5,
              rewardShare: 0.9,
              sourceAgeSeconds: 30_000,
              venueRiskTier: "unknown",
            },
            rankChangeAttribution: {
              rankDelta: -5,
              primaryDriver: "source-risk",
            },
          },
        ],
      },
    });

    await computeAndStoreDEWS(db);

    expect(sqlSeen.some((sql) => sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        yieldSourceRisk: expect.objectContaining({
          sourceRiskPenalty: 1.5,
          rewardShare: 0.9,
        }),
        yieldRankChangeAttribution: expect.objectContaining({
          rankDelta: -5,
          primaryDriver: "source-risk",
        }),
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
    expect(metadata.sourceFailures.find((failure) => failure.source === "dex-prices")?.bootstrapAllowed).toBe(false);
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

  it("does not feed stale per-coin dex_liquidity rows into DEWS pool or liquidity inputs", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      dexLiqRows: [
        {
          stablecoin_id: "usdt-tether",
          weighted_balance_ratio: 0.4,
          avg_pool_stress: 90,
          top_pools_json: "[]",
          liquidity_score: 25,
          total_tvl_usd: 1_000_000,
          updated_at: nowSec - 3 * 3600,
        },
      ],
      dexPublicationLatest: {
        generation_id: "dex-liquidity-1772546400",
        state: "failed",
        started_at: nowSec - 300,
        published_at: null,
        failed_at: nowSec - 240,
        failure_reason: "current generation incomplete: active=368 expected=369",
      },
      dexPublicationLatestPublished: {
        generation_id: "dex-liquidity-1772539200",
        state: "published",
        started_at: nowSec - 7_500,
        published_at: nowSec - 7_400,
        failed_at: null,
        failure_reason: null,
      },
    });

    const result = await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        weightedBalanceRatio: null,
        avgPoolStress: null,
        liquidityScore: null,
        tvlCurrent: null,
        staleFlags: expect.objectContaining({ dexLiquidity: true }),
      }),
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage: Record<string, number>;
      dependencies: {
        dexLiquidity?: {
          latestGenerationId?: string | null;
          latestGenerationState?: string | null;
          latestGenerationFailureReason?: string | null;
          latestPublishedGenerationId?: string | null;
          latestPublishedAgeSec?: number | null;
        };
      };
    };
    expect(metadata.sourceCoverage.dexLiquidityStaleRows).toBe(1);
    expect(metadata.sourceCoverage.dexLiquidityFreshRows).toBe(0);
    expect(metadata.dependencies.dexLiquidity).toMatchObject({
      latestGenerationId: "dex-liquidity-1772546400",
      latestGenerationState: "failed",
      latestGenerationFailureReason: "current generation incomplete: active=368 expected=369",
      latestPublishedGenerationId: "dex-liquidity-1772539200",
      latestPublishedAgeSec: 7_400,
    });
  });

  it("keeps stale dex_liquidity failures visible when publication diagnostics fail", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      failDexPublicationDiagnostics: true,
      dexLiqRows: [
        {
          stablecoin_id: "usdt-tether",
          weighted_balance_ratio: 0.4,
          avg_pool_stress: 90,
          top_pools_json: "[]",
          liquidity_score: 25,
          total_tvl_usd: 1_000_000,
          updated_at: nowSec - 3 * 3600,
        },
      ],
    });

    const result = await computeAndStoreDEWS(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceFailures: Array<{ source: string; bootstrapAllowed: boolean }>;
      sourceCoverage: Record<string, number>;
      dependencies: {
        dexLiquidity?: {
          diagnosticsError?: string;
          latestGenerationId?: string | null;
          latestPublishedAgeSec?: number | null;
        };
      };
    };
    expect(metadata.sourceFailures).toContainEqual(
      expect.objectContaining({ source: "dex-liquidity-freshness", bootstrapAllowed: false }),
    );
    expect(metadata.sourceCoverage.dexLiquidityStaleRows).toBe(1);
    expect(metadata.sourceCoverage.dexLiquidityFreshRows).toBe(0);
    expect(metadata.dependencies.dexLiquidity).toMatchObject({
      diagnosticsError: "publication diagnostics unavailable",
      latestGenerationId: null,
      latestPublishedAgeSec: null,
    });
  });

  it("does not smooth with stale previous stress-signal rows", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      prevSignalRows: [
        {
          stablecoin_id: "usdt-tether",
          signals_json: JSON.stringify({
            signals: {
              pool: { value: 90, available: true },
              diverg: { value: 80, available: true },
            },
            amplifiers: { psi: 1, contagion: 1 },
          }),
          band: "WARNING",
          computed_at: nowSec - 3 * 3600,
        },
      ],
    });

    const result = await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        prevPoolValue: undefined,
        prevDivergValue: undefined,
        staleFlags: expect.objectContaining({ previousSignals: true }),
      }),
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage: Record<string, number>;
    };
    expect(metadata.sourceCoverage.previousStressSignalsStaleRows).toBe(1);
  });

  it("scales partial mint/burn baseline by observed baseline days", async () => {
    const sqlSeen: string[] = [];
    const db = makeDb(sqlSeen, {
      mintBurn24hRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 250_000,
          total_mint: 0,
        },
      ],
      mintBurn30dRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 700_000,
          total_mint: 70_000,
          days_with_data: 7,
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        burnBaseline30dUsd: 100_000,
        flowDataAgeDays: expect.any(Number),
        flowBaselineDays: 7,
        staleFlags: expect.objectContaining({ mintBurn: false }),
      }),
    );
    const calls = vi.mocked(computeDEWS).mock.calls;
    const input = calls[calls.length - 1]?.[0];
    expect(input?.flowDataAgeDays).toBeCloseTo(1 / 24, 5);
  });

  it("leaves complete 30-day mint/burn baselines unchanged", async () => {
    const sqlSeen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      mintBurn24hRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 0,
          total_mint: 0,
          latest_hour_ts: nowSec - 3600,
        },
      ],
      mintBurn30dRows: [
        {
          stablecoin_id: "usdt-tether",
          total_burn: 3_000_000,
          total_mint: 1_500_000,
          days_with_data: 30,
          latest_hour_ts: nowSec - 3600,
        },
      ],
    });

    await computeAndStoreDEWS(db);

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        burnBaseline30dUsd: 100_000,
        flowDataAgeDays: expect.any(Number),
        flowBaselineDays: 30,
        staleFlags: expect.objectContaining({ mintBurn: false }),
      }),
    );
    const calls = vi.mocked(computeDEWS).mock.calls;
    const input = calls[calls.length - 1]?.[0];
    expect(input?.flowDataAgeDays).toBeCloseTo(1 / 24, 5);
  });

  it("marks thin non-USD peg references unavailable for DEWS divergence", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "eurc-euro-coin",
              symbol: "EURC",
              pegType: "peggedEUR",
              price: 1.05,
              priceConfidence: "high",
              circulating: { peggedEUR: 100_000_000 },
              circulatingPrevDay: { peggedEUR: 100_000_000 },
              circulatingPrevWeek: { peggedEUR: 100_000_000 },
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    vi.mocked(derivePegRates).mockReturnValueOnce({
      rates: { peggedUSD: 1, peggedEUR: 1.08 },
      sources: { peggedUSD: "median", peggedEUR: "median" },
      counts: { peggedUSD: 1, peggedEUR: 1 },
    });
    const sqlSeen: string[] = [];

    await computeAndStoreDEWS(makeDb(sqlSeen, { dexLiqRows: [] }));

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "eurc-euro-coin",
        pegType: "peggedEUR",
        pegRef: 0,
        pegReferenceAvailable: false,
        pegReferenceUnavailableReason: "peg-reference-untrusted",
        pegRateSource: "median",
        pegRateContributorCount: 1,
      }),
    );
  });

  it("keeps trusted fallback non-USD peg references available", async () => {
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dews:bootstrap-complete") return null;
      return {
        value: JSON.stringify({
          peggedAssets: [
            {
              id: "eurc-euro-coin",
              symbol: "EURC",
              pegType: "peggedEUR",
              price: 1.05,
              priceConfidence: "high",
              circulating: { peggedEUR: 100_000_000 },
              circulatingPrevDay: { peggedEUR: 100_000_000 },
              circulatingPrevWeek: { peggedEUR: 100_000_000 },
            },
          ],
        }),
        updatedAt: Math.floor(Date.now() / 1000),
      } as never;
    });
    vi.mocked(derivePegRates).mockReturnValueOnce({
      rates: { peggedUSD: 1, peggedEUR: 1.08 },
      sources: { peggedUSD: "median", peggedEUR: "fallback" },
      counts: { peggedUSD: 1, peggedEUR: 1 },
    });
    const sqlSeen: string[] = [];

    await computeAndStoreDEWS(makeDb(sqlSeen, { dexLiqRows: [] }));

    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "eurc-euro-coin",
        pegType: "peggedEUR",
        pegRef: 1.08,
        pegReferenceAvailable: true,
        pegReferenceUnavailableReason: null,
        pegRateSource: "fallback",
        pegRateContributorCount: 1,
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
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDb(sqlSeen, {
      blacklistRows: [
        {
          stablecoin: "PYUSD",
          config_key: "ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8",
          timestamp: nowSec - 1_000,
        },
        {
          stablecoin: "PYUSD",
          config_key: "ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8",
          timestamp: nowSec - 2_000,
        },
        {
          stablecoin: "PYUSD",
          config_key: "ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8",
          timestamp: nowSec - 2 * 86400,
        },
        {
          stablecoin: "PYUSD",
          config_key: "ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8",
          timestamp: nowSec - 3 * 86400,
        },
        {
          stablecoin: "PYUSD",
          config_key: "ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8",
          timestamp: nowSec - 4 * 86400,
        },
        {
          stablecoin: "USD1",
          config_key: "ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
          timestamp: nowSec - 1_000,
        },
        {
          stablecoin: "USD1",
          config_key: "ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
          timestamp: nowSec - 2 * 86400,
        },
        {
          stablecoin: "USD1",
          config_key: "ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
          timestamp: nowSec - 3 * 86400,
        },
      ],
      currentGenerationRows: 2,
      latestGenerationRows: 2,
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

    expect(sqlSeen.some((sql) => sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signals"))).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes("SELECT DISTINCT stablecoin_id FROM stress_signal_history"))).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signals WHERE stablecoin_id IN"))).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN"))).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes("NOT IN"))).toBe(false);
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
    expect(sqlSeen.some((sql) => sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN"))).toBe(false);
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
          sql.includes("DELETE FROM stress_signals WHERE stablecoin_id IN") ||
          sql.includes("DELETE FROM stress_signal_history WHERE stablecoin_id IN")
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
