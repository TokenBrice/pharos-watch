import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
}));

import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";
import { batchExecute } from "../../lib/db";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import { persistScores, writeHistoricalSnapshots } from "../dex-liquidity/persistence";

interface PreparedStatementWithMeta extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

function makeDb(options: { historyRow?: { cnt: number; scored: number | null }; historyError?: unknown } = {}): D1Database {
  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => {
        if (sql.includes("FROM dex_liquidity_history")) {
          if (options.historyError != null) {
            throw (options.historyError instanceof Error ? options.historyError : new Error(String(options.historyError)));
          }
          return (options.historyRow ?? null) as T | null;
        }
        return null as T | null;
      },
      run: async () => ({ success: true, meta: { changes: 1 } }),
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("dex-liquidity persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("persists scored rows, placeholders, and the global sentinel row", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    metrics.totalTvlUsd = 123_456;
    metrics.totalVolume24hUsd = 22_222;
    metrics.totalVolume7dUsd = 155_555;
    metrics.poolCount = 2;
    metrics.pairs = new Set(["USDT-USDC", "USDT-DAI"]);
    metrics.chains = new Set(["Ethereum", "Base"]);
    metrics.protocolTvl = { curve: 100_000, "uniswap-v3": 23_456 };
    metrics.chainTvl = { Ethereum: 100_000, Base: 23_456 };
    metrics.topPools = [
      {
        poolId: "ethereum:curve",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 10_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];
    metrics.effectiveTvl = 100_111.7;

    await persistScores(
      makeDb(),
      new Map([["usdt-tether", metrics]]),
      new Map([
        [
          "usdt-tether",
          {
            tvl: 123_456,
            vol24h: 22_222,
            score: 78,
            hhi: 0.2222,
            durability: 81,
            components: {
              tvlDepth: 70,
              volumeActivity: 60,
              poolQuality: 80,
              durability: 81,
              pairDiversity: 10,
            },
            weightedBalanceRatio: 0.91,
            organicFrac: 0.67,
            avgStress: 12.34,
            lockedLiqPct: 0.55,
          },
        ],
      ]),
      {
        totalTvl: 456_789,
        totalVol24h: 99_999,
        totalVol7d: 700_000,
        poolCount: 12,
        chainCount: 4,
        protocolTvl: { curve: 200_000 },
        chainTvl: { ethereum: 300_000 },
      },
      1_700_000_000,
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    expect(prepared).toHaveLength(TRACKED_STABLECOINS.length + 1);

    const usdtRow = prepared.find((stmt) => stmt.boundValues[0] === "usdt-tether");
    const usdcPlaceholder = prepared.find((stmt) => stmt.boundValues[0] === "usdc-circle");
    const globalRow = prepared.find((stmt) => stmt.boundValues[0] === "__global__");

    expect(usdtRow?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      123_456,
      22_222,
      155_555,
      2,
      2,
      2,
      JSON.stringify({ curve: 100_000, "uniswap-v3": 23_456 }),
      JSON.stringify({ Ethereum: 100_000, Base: 23_456 }),
      JSON.stringify(metrics.topPools),
      78,
      0.2222,
      12.34,
      0.91,
      0.67,
      100_112,
      81,
      JSON.stringify({
        tvlDepth: 70,
        volumeActivity: 60,
        poolQuality: 80,
        durability: 81,
        pairDiversity: 10,
      }),
      0.55,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);
    expect(usdcPlaceholder?.boundValues).toEqual([
      "usdc-circle",
      "USDC",
      0,
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);
    expect(globalRow?.boundValues).toEqual([
      "__global__",
      "__global__",
      456_789,
      99_999,
      700_000,
      12,
      0,
      4,
      JSON.stringify({ curve: 200_000 }),
      JSON.stringify({ ethereum: 300_000 }),
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);
  });

  it("skips historical snapshot writes when today's snapshot is already complete enough", async () => {
    await writeHistoricalSnapshots(
      makeDb({
        historyRow: {
          cnt: TRACKED_STABLECOINS.length,
          scored: 2,
        },
      }),
      new Map([
        ["usdt-tether", { tvl: 1, vol24h: 1, score: 1 }],
        ["usdc-circle", { tvl: 1, vol24h: 1, score: 1 }],
      ]),
    );

    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("reconciles missing historical snapshots and backfills placeholder rows", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 12);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await writeHistoricalSnapshots(
      makeDb({
        historyRow: {
          cnt: 10,
          scored: 1,
        },
      }),
      new Map([
        ["usdt-tether", { tvl: 10, vol24h: 11, score: 12 }],
        ["usdc-circle", { tvl: 20, vol24h: 21, score: 22 }],
      ]),
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    expect(prepared).toHaveLength(TRACKED_STABLECOINS.length);

    const todayMidnight = Math.floor(nowMs / 86_400_000) * 86_400;
    const usdtSnapshot = prepared.find((stmt) => stmt.boundValues[0] === "usdt-tether");
    const daiPlaceholder = prepared.find((stmt) => stmt.boundValues[0] === "dai-makerdao");

    expect(usdtSnapshot?.boundValues).toEqual([
      "usdt-tether",
      10,
      11,
      12,
      todayMidnight,
      LIQUIDITY_METHODOLOGY_VERSION,
    ]);
    expect(daiPlaceholder?.boundValues).toEqual([
      "dai-makerdao",
      todayMidnight,
      LIQUIDITY_METHODOLOGY_VERSION,
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dex-liquidity] Reconciled daily snapshot (10/1 ->"),
    );
  });

  it("logs and swallows snapshot query failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      writeHistoricalSnapshots(
        makeDb({ historyError: new Error("snapshot unavailable") }),
        new Map([["usdt-tether", { tvl: 1, vol24h: 1, score: 1 }]]),
      ),
    ).resolves.toBeUndefined();

    expect(batchExecute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[dex-liquidity] Daily snapshot failed:", expect.any(Error));
  });
});
