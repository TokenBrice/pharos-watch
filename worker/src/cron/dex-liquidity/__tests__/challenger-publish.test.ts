import { describe, expect, it } from "vitest";
import {
  buildDexPriceChallengerPublicationPlan,
  DEX_PRICE_CHALLENGER_BATCH_SIZE,
  getDexPriceChallengerPublicationStatements,
  publishDexPriceChallengerSnapshots,
  selectDexPriceChallengerRowsFromPools,
} from "../challenger-publish";
import type { PoolEntry } from "../types";

interface TestStatement extends D1PreparedStatement {
  sql: string;
  binds: unknown[];
}

function makePublishDb(onBatch?: (batchIndex: number) => void): {
  db: D1Database;
  batches: TestStatement[][];
  maxConstructedStatements: () => number;
} {
  const batches: TestStatement[][] = [];
  let liveConstructedStatements = 0;
  let maxConstructedStatements = 0;

  const createStatement = (sql: string, binds: unknown[] = []): TestStatement => ({
    sql,
    binds,
    bind: (...values: unknown[]) => {
      if (/dex_price_challengers|dex_price_challenger_snapshots/.test(sql)) {
        liveConstructedStatements++;
        maxConstructedStatements = Math.max(maxConstructedStatements, liveConstructedStatements);
      }
      return createStatement(sql, values);
    },
    all: async <T>() => ({
      results: [
        { name: "dex_price_challengers" },
        { name: "dex_price_challenger_snapshots" },
      ] as T[],
      success: true,
      meta: {},
    }),
  } as unknown as TestStatement);

  const db = {
    prepare: (sql: string) => createStatement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const batch = statements as TestStatement[];
      batches.push([...batch]);
      onBatch?.(batches.length - 1);
      liveConstructedStatements -= batch.length;
      return batch.map(() => ({ success: true, meta: { changes: 1 }, results: [] }));
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, batches, maxConstructedStatements: () => maxConstructedStatements };
}

function challengerPools(count: number): PoolEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    poolId: `pool-${String(index).padStart(2, "0")}`,
    project: "curve",
    chain: "Ethereum",
    tvlUsd: 100_000,
    symbol: "USDT-USDC",
    volumeUsd1d: 10_000,
    volumeUsd7d: 70_000,
    poolType: "curve-stableswap",
    source: "dl",
    price: 1 + index / 100_000,
  }));
}

describe("challenger publish", () => {
  it("builds payload statements before snapshot metadata and suppresses incomplete coverage snapshots", () => {
    const completePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "USDT-TETHER",
      snapshotAt: 1_700_000_000.9,
      publishedAt: 1_700_000_111.2,
      sourceCoverageComplete: true,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
        {
          stablecoinId: "USDT-TETHER",
          poolId: "pool-b",
          chain: "Base",
          protocol: "aerodrome",
          sourceFamily: "gecko-terminal",
          priceUsd: 1.001,
          tvlUsd: 15_000,
        },
      ],
    });

    expect(completePlan.skipReason).toBeNull();
    expect(completePlan.shouldPublishSnapshot).toBe(true);
    expect(completePlan.payloadStatements).toHaveLength(2);
    expect(completePlan.snapshotStatement).not.toBeNull();

    const ordered = getDexPriceChallengerPublicationStatements(completePlan);
    expect(ordered.map((stmt) => stmt.sql)).toEqual([
      completePlan.payloadStatements[0]!.sql,
      completePlan.payloadStatements[1]!.sql,
      completePlan.snapshotStatement!.sql,
    ]);

    const incompletePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "usdt-tether",
      snapshotAt: 1_700_000_000,
      sourceCoverageComplete: false,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
      ],
    });

    expect(incompletePlan.skipReason).toBe("incomplete-coverage");
    expect(incompletePlan.shouldPublishSnapshot).toBe(false);
    expect(incompletePlan.snapshotStatement).toBeNull();
    expect(incompletePlan.payloadStatements).toHaveLength(1);
  });

  it("excludes blocked dead DEX pools from challenger selection", () => {
    const rows = selectDexPriceChallengerRowsFromPools(
      "usr-resolv",
      [
        {
          poolId: "ethereum:bunni-1",
          project: "bunni-ethereum",
          chain: "Ethereum",
          tvlUsd: 1_451_774,
          symbol: "USR-USDC",
          volumeUsd1d: 12_000,
          volumeUsd7d: 84_000,
          poolType: "generic",
          source: "gecko_terminal",
          price: 0.9993,
        },
        {
          poolId: "ethereum:curve-1",
          project: "curve",
          chain: "Ethereum",
          tvlUsd: 64_711,
          symbol: "USR-USDC",
          volumeUsd1d: 8_000,
          volumeUsd7d: 56_000,
          poolType: "curve-stableswap",
          source: "dl",
          price: 0.1152,
        },
      ],
      20_000,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        poolId: "ethereum:curve-1",
        protocol: "curve",
        priceUsd: 0.1152,
        tvlUsd: 64_711,
      }),
    ]);
  });

  it("constructs and executes challenger rows in bounded publication order", async () => {
    const { db, batches, maxConstructedStatements } = makePublishDb();

    const result = await publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map([["usdt-tether", challengerPools(60)]]),
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
    });

    expect(result.publishedStablecoins).toBe(1);
    expect(batches.map((batch) => batch.length)).toEqual([25, 25, 2]);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(DEX_PRICE_CHALLENGER_BATCH_SIZE);
    expect(maxConstructedStatements()).toBeLessThanOrEqual(DEX_PRICE_CHALLENGER_BATCH_SIZE);

    const statements = batches.flat();
    expect(statements).toHaveLength(52);
    expect(statements.slice(0, 50).every((statement) => statement.sql.includes("INSERT INTO dex_price_challengers")))
      .toBe(true);
    expect(statements[50]?.sql).toContain("INSERT INTO dex_price_challenger_snapshots");
    expect(statements[51]?.sql).toContain("DELETE FROM dex_price_challengers");
    expect(statements.slice(0, 50).map((statement) => statement.binds[2])).toEqual(
      Array.from({ length: 50 }, (_, index) => `pool-${String(index).padStart(2, "0")}`),
    );
  });

  it("stops before snapshot publication when a bounded batch aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("challenger publication timed out");
    const { db, batches } = makePublishDb(() => controller.abort(abortReason));

    await expect(publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map([["usdt-tether", challengerPools(60)]]),
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
    }, controller.signal)).rejects.toThrow("challenger publication timed out");

    expect(batches).toHaveLength(1);
    expect(batches.flat().some((statement) => statement.sql.includes("dex_price_challenger_snapshots"))).toBe(false);
  });

  it("does not publish snapshot metadata after a later payload batch fails", async () => {
    const { db, batches } = makePublishDb((batchIndex) => {
      if (batchIndex === 1) throw new Error("challenger payload batch failed");
    });

    await expect(publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map([["usdt-tether", challengerPools(60)]]),
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
    })).rejects.toThrow("challenger payload batch failed");

    expect(batches).toHaveLength(2);
    expect(batches.flat().some((statement) => statement.sql.includes("dex_price_challenger_snapshots"))).toBe(false);
  });
});
