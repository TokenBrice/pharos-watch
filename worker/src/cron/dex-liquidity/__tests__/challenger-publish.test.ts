import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import {
  buildDexPriceChallengerPublicationPlan,
  DEX_PRICE_CHALLENGER_BATCH_SIZE,
  getDexPriceChallengerPublicationStatements,
  publishDexPriceChallengerSnapshots,
  selectDexPriceChallengerRowsFromPools,
} from "../challenger-publish";
import type { PoolEntry } from "../types";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

interface TestStatement extends D1PreparedStatement {
  sql: string;
  binds: unknown[];
}

function makePublishDb(
  onBatch?: (batchIndex: number) => void,
  onRun?: (runIndex: number, statement: TestStatement) => void | number,
): {
  db: D1Database;
  batches: TestStatement[][];
  runs: TestStatement[];
  maxConstructedStatements: () => number;
} {
  const batches: TestStatement[][] = [];
  const runs: TestStatement[] = [];
  let liveConstructedStatements = 0;
  let maxConstructedStatements = 0;

  const createStatement = (sql: string, binds: unknown[] = []): TestStatement => {
    let released = false;
    const statement = {
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
      run: async () => {
        runs.push(statement as unknown as TestStatement);
        try {
          const override = onRun?.(runs.length - 1, statement as unknown as TestStatement);
          const ids = typeof binds[3] === "string"
            ? JSON.parse(binds[3] as string) as unknown[]
            : [];
          return {
            success: true,
            meta: {
              changes: typeof override === "number" ? override : ids.length,
            },
            results: [],
          };
        } finally {
          if (!released) {
            liveConstructedStatements--;
            released = true;
          }
        }
      },
    } as unknown as TestStatement;
    return statement;
  };

  const db = makeNoopD1({
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
  });

  return { db, batches, runs, maxConstructedStatements: () => maxConstructedStatements };
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

  it("retains a qualifying minority protocol before applying the TVL coverage cutoff", () => {
    const makePool = (poolId: string, project: string, tvlUsd: number, price: number): PoolEntry => ({
      poolId,
      project,
      chain: "MegaETH",
      tvlUsd,
      symbol: "USDm-pair",
      volumeUsd1d: 10_000,
      volumeUsd7d: 70_000,
      poolType: "generic",
      source: "gecko_terminal",
      price,
    });
    const rows = selectDexPriceChallengerRowsFromPools(
      "usdm-mega",
      [
        makePool("megaeth:kumbaya-btc", "kumbaya", 2_737_890, 0.99911),
        makePool("megaeth:kumbaya-mega", "kumbaya", 665_442, 1.00165),
        makePool("megaeth:kumbaya-stcusd", "kumbaya", 431_793, 1.00091),
        makePool("megaeth:kumbaya-usdt0", "kumbaya", 194_442, 1.0013),
        makePool("megaeth:prism-usdt0", "prism-megaeth", 173_064, 1.0013),
      ],
      100_000,
    );

    expect(rows.map((row) => row.poolId)).toContain("megaeth:prism-usdt0");
    expect(new Set(rows.map((row) => row.protocol))).toEqual(new Set(["kumbaya", "prism-megaeth"]));
  });

  it("caps protocol representatives deterministically when more than 50 protocols qualify", () => {
    const pools = Array.from({ length: 55 }, (_, index): PoolEntry => ({
      poolId: `pool-${String(index).padStart(2, "0")}`,
      project: `protocol-${String(index).padStart(2, "0")}`,
      chain: "Ethereum",
      tvlUsd: 1_000_000 - index * 1_000,
      symbol: "TEST-USDC",
      volumeUsd1d: 10_000,
      volumeUsd7d: 70_000,
      poolType: "generic",
      source: "gecko_terminal",
      price: 1,
    }));

    const rows = selectDexPriceChallengerRowsFromPools("test-coin", pools, 100_000);

    expect(rows).toHaveLength(50);
    expect(rows.map((row) => row.protocol)).toEqual(
      Array.from({ length: 50 }, (_, index) => `protocol-${String(index).padStart(2, "0")}`),
    );
  });

  it("constructs and executes challenger rows in bounded publication order", async () => {
    const retainedPools = challengerPools(60);
    const retainedPoolsByStablecoin = new Map([["usdt-tether", retainedPools]]);
    let retainedMapSizeAtPointerRun: number | null = null;
    const { db, batches, runs, maxConstructedStatements } = makePublishDb(
      undefined,
      (_runIndex, statement) => {
        if (statement.sql.includes("FROM json_each(?)")) {
          retainedMapSizeAtPointerRun = retainedPoolsByStablecoin.size;
        }
      },
    );

    const result = await publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000.9,
      retainedPoolsByStablecoin,
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
      consumeRetainedPools: true,
    });

    expect(result.publishedStablecoins).toBe(1);
    expect(batches.map((batch) => batch.length)).toEqual([5, 1]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sql).toContain("FROM json_each(?)");
    expect(JSON.parse(runs[0]?.binds[3] as string)).toEqual(["usdt-tether"]);
    expect(retainedMapSizeAtPointerRun).toBe(0);
    expect(retainedPoolsByStablecoin.size).toBe(0);
    expect(retainedPools).toHaveLength(0);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(DEX_PRICE_CHALLENGER_BATCH_SIZE);
    expect(maxConstructedStatements()).toBeLessThanOrEqual(DEX_PRICE_CHALLENGER_BATCH_SIZE);

    const statements = batches.flat();
    expect(statements).toHaveLength(6);
    expect(statements.slice(0, 5).every((statement) => statement.sql.includes("INSERT INTO dex_price_challengers")))
      .toBe(true);
    expect(statements[5]?.sql).toContain("DELETE FROM dex_price_challengers");
    expect(statements.slice(0, 5).every((statement) => statement.binds[1] === 1_700_000_000)).toBe(true);
    expect(runs[0]?.binds.slice(0, 3)).toEqual([
      1_700_000_000,
      1_700_000_000,
      1_700_000_000,
    ]);
    expect(statements[5]?.binds[0]).toBe(1_700_000_000);
    expect(
      statements.slice(0, 5).flatMap((statement) =>
        statement.binds.filter((_, bindIndex) => bindIndex % 8 === 2)
      ),
    ).toEqual(
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
    const stablecoinIds = ACTIVE_STABLECOINS.slice(0, 6).map((meta) => meta.id);

    await expect(publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map(
        stablecoinIds.map((stablecoinId) => [stablecoinId, challengerPools(60)]),
      ),
      sourceCoverageCompleteByStablecoin: new Map(
        stablecoinIds.map((stablecoinId) => [stablecoinId, true]),
      ),
      minPoolTvlUsd: 20_000,
    })).rejects.toThrow("challenger payload batch failed");

    expect(batches).toHaveLength(2);
    expect(batches.flat().some((statement) => statement.sql.includes("dex_price_challenger_snapshots"))).toBe(false);
  });

  it("publishes the complete active inventory through one compact pointer statement", async () => {
    const retainedPoolsByStablecoin = new Map(
      ACTIVE_STABLECOINS.map((meta) => [meta.id, [] as PoolEntry[]]),
    );
    const { db, batches, runs } = makePublishDb();

    const result = await publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin,
      sourceCoverageCompleteByStablecoin: new Map(
        ACTIVE_STABLECOINS.map((meta) => [meta.id, true]),
      ),
      minPoolTvlUsd: 20_000,
      consumeRetainedPools: true,
    });

    expect(result.publishedStablecoins).toBe(ACTIVE_STABLECOINS.length);
    expect(runs).toHaveLength(1);
    const publishedIdsJson = runs[0]?.binds[3] as string;
    expect(JSON.parse(publishedIdsJson)).toEqual(ACTIVE_STABLECOINS.map((meta) => meta.id));
    expect(new TextEncoder().encode(publishedIdsJson).byteLength).toBeLessThan(16 * 1024);
    expect(batches.flat().some((statement) =>
      statement.sql.includes("INSERT INTO dex_price_challenger_snapshots")
    )).toBe(false);
    expect(retainedPoolsByStablecoin.size).toBe(0);
  });

  it("publishes exactly complete IDs and derives has_rows from durable payloads", async () => {
    const harness = createLatestSchemaSqlite();
    const withRows = ACTIVE_STABLECOINS[0]!.id;
    const withoutRows = ACTIVE_STABLECOINS[1]!.id;
    const incomplete = ACTIVE_STABLECOINS[2]!.id;
    try {
      harness.sqlite.prepare(
        `INSERT INTO dex_price_challenger_snapshots (
           stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete
         ) VALUES (?, 1699999000, 1699999000, 1, 1)`,
      ).run(incomplete);

      await publishDexPriceChallengerSnapshots(harness.db, {
        snapshotAt: 1_700_000_000,
        retainedPoolsByStablecoin: new Map([
          [withRows, challengerPools(1)],
          [withoutRows, []],
          [incomplete, challengerPools(1)],
        ]),
        sourceCoverageCompleteByStablecoin: new Map([
          [withRows, true],
          [withoutRows, true],
          [incomplete, false],
        ]),
        minPoolTvlUsd: 20_000,
      });

      expect(harness.sqlite.prepare(
        `SELECT stablecoin_id, snapshot_at, has_rows
           FROM dex_price_challenger_snapshots
          WHERE stablecoin_id IN (?, ?, ?)
          ORDER BY stablecoin_id`,
      ).all(withRows, withoutRows, incomplete)).toEqual(
        [
          { stablecoin_id: withRows, snapshot_at: 1_700_000_000, has_rows: 1 },
          { stablecoin_id: withoutRows, snapshot_at: 1_700_000_000, has_rows: 0 },
          { stablecoin_id: incomplete, snapshot_at: 1_699_999_000, has_rows: 1 },
        ].sort((a, b) => a.stablecoin_id.localeCompare(b.stablecoin_id)),
      );
    } finally {
      harness.sqlite.close();
    }
  });

  it("retries an ambiguous pointer commit idempotently before cleanup", async () => {
    const { db, batches, runs } = makePublishDb(
      undefined,
      (runIndex) => {
        if (runIndex === 0) {
          throw new Error("D1 DB is overloaded after committed challenger pointer publication");
        }
      },
    );

    await publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map([["usdt-tether", challengerPools(1)]]),
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
    });

    expect(runs).toHaveLength(2);
    expect(runs[0]?.sql).toBe(runs[1]?.sql);
    expect(runs[0]?.binds).toEqual(runs[1]?.binds);
    expect(batches.flat().some((statement) =>
      statement.sql.includes("DELETE FROM dex_price_challengers")
    )).toBe(true);
  });

  it("fails closed on pointer count mismatch and does not run cleanup", async () => {
    const { db, batches } = makePublishDb(undefined, () => 0);

    await expect(publishDexPriceChallengerSnapshots(db, {
      snapshotAt: 1_700_000_000,
      retainedPoolsByStablecoin: new Map([["usdt-tether", challengerPools(1)]]),
      sourceCoverageCompleteByStablecoin: new Map([["usdt-tether", true]]),
      minPoolTvlUsd: 20_000,
    })).rejects.toThrow("wrote 0/1 pointers");

    expect(batches.flat().some((statement) =>
      statement.sql.includes("DELETE FROM dex_price_challengers")
    )).toBe(false);
  });
});
