import { afterEach, describe, expect, it, vi } from "vitest";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import {
  buildStoredChallengerPoolsJson,
  publishDexPriceChallengerSnapshots,
  selectDexPriceChallengerRowsFromPools,
} from "../challenger-publish";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { loadDexPoolChallengers } from "../../../lib/depeg-helpers";
import { POOL_CHALLENGE_MIN_TVL } from "../../../lib/price-depeg-voting-policy";
import { filterRetainedPools } from "../scoring-helpers";
import { seedPublishedDexGeneration } from "./scoring-test-support";
import { loaderFixtures, loaderScenario } from "./challenger-load.test-support";
import { scorePoolGraph } from "./scoring-test-builders";
import type { PoolEntry } from "../types";

afterEach(() => loaderFixtures.closeAll());

const SNAPSHOT = 1_700_000_000;
const COIN = ACTIVE_STABLECOINS[0]!.id;
const publicationInput = (generationId: string, pools = challengerPools(1), snapshotAt = SNAPSHOT) => ({
  generationId,
  snapshotAt,
  retainedPoolsByStablecoin: new Map([[COIN, pools]]),
  minPoolTvlUsd: 20_000,
});

async function loadedPools(db: D1Database) {
  return (await loadPublishedDexPoolChallengers(db, 20_000, 1_000, SNAPSHOT + 100))
    .challengersByStablecoin.get(COIN)?.map((row) => row.poolId);
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
    priceObservedAt: SNAPSHOT - 60,
  }));
}

describe("challenger publish", () => {
  it("bounds cross-source quote support before admission, dedupe, ranking and storage", () => {
    const crossSource = {
      ...challengerPools(1)[0]!, tvlUsd: 1_000_000, priceEvidenceTvlUsd: 10_000,
      priceSource: "cg_onchain" as const,
    };
    expect(selectDexPriceChallengerRowsFromPools(COIN, [crossSource], 20_000)).toEqual([]);
    expect(selectDexPriceChallengerRowsFromPools(COIN, [crossSource], 5_000)).toEqual([
      expect.objectContaining({ sourceFamily: "cg_onchain", tvlUsd: 10_000, priceObservedAt: SNAPSHOT - 60 }),
    ]);
    const sameSource = { ...crossSource, tvlUsd: 30_000, priceEvidenceTvlUsd: undefined, priceSource: undefined };
    expect(selectDexPriceChallengerRowsFromPools(COIN, [crossSource, sameSource], 5_000)).toEqual([
      expect.objectContaining({ sourceFamily: "dl", tvlUsd: 30_000 }),
    ]);
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

  it("stores the actual cross-source support and original quote clock, not retained inventory value", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    const cross = [{ ...challengerPools(1)[0]!, tvlUsd: 1_000_000, priceEvidenceTvlUsd: 10_000, priceSource: "cg_onchain" as const }];
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, cross));
      expect(await loadedPools(db)).toEqual([]);
      await publishDexPriceChallengerSnapshots(db, { ...publicationInput(generationId, cross), minPoolTvlUsd: 5_000 });
      const loaded = await loadPublishedDexPoolChallengers(db, 5_000, 1_000, SNAPSHOT + 100);
      expect(loaded.challengersByStablecoin.get(COIN)).toEqual([
        expect.objectContaining({ sourceFamily: "cg_onchain", tvlUsd: 10_000, priceObservedAt: SNAPSHOT - 60 }),
      ]);
    } finally { sqlite.close(); }
  });

  it("publishes exact shrinking and empty replacements at an unchanged source clock", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, challengerPools(3)));
      expect(await loadedPools(db)).toEqual(["pool-00", "pool-01", "pool-02"]);
      const first = sqlite.prepare("SELECT publication_id FROM dex_price_challenger_heads_v2 WHERE stablecoin_id = ?").get(COIN);
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      expect(await loadedPools(db)).toEqual(["pool-00"]);
      const second = sqlite.prepare("SELECT publication_id FROM dex_price_challenger_heads_v2 WHERE stablecoin_id = ?").get(COIN);
      expect(Number(second?.publication_id)).toBeGreaterThan(Number(first?.publication_id));
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, []));
      expect(await loadedPools(db)).toEqual([]);
      expect(sqlite.prepare("SELECT has_rows FROM dex_price_challenger_heads_v2 WHERE stablecoin_id = ?").get(COIN))
        .toEqual({ has_rows: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_challenger_payloads_v2").get()).toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("publishes the complete active inventory, bounded payloads and authoritative empty members", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    const pools = challengerPools(60);
    const input = { ...publicationInput(generationId, pools), consumeRetainedPools: true };
    try {
      const result = await publishDexPriceChallengerSnapshots(db, input);
      expect(result).toEqual({ publishedStablecoins: ACTIVE_STABLECOINS.length, skippedStablecoins: 0 });
      expect(await loadedPools(db)).toHaveLength(50);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_challenger_heads_v2 WHERE has_rows = 0").get())
        .toEqual({ count: ACTIVE_STABLECOINS.length - 1 });
      expect(input.retainedPoolsByStablecoin.size).toBe(0);
      expect(pools).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("keeps interrupted and failed later staging private", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      const controller = new AbortController();
      let stagedBatches = 0;
      const interrupted = {
        ...db,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          const result = await db.batch<T>(statements);
          if (++stagedBatches === 1) controller.abort(new Error("interrupted staging"));
          return result;
        },
      };
      await expect(publishDexPriceChallengerSnapshots(interrupted, {
        ...publicationInput(generationId),
        retainedPoolsByStablecoin: new Map(ACTIVE_STABLECOINS.slice(0, 8).map((coin) => [coin.id, challengerPools(60)])),
      }, controller.signal)).rejects.toThrow("interrupted staging");
      expect(await loadedPools(db)).toEqual(["pool-00"]);
      let batches = 0;
      const failed = {
        ...db,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          if (++batches === 2) throw new Error("later payload failed");
          return db.batch<T>(statements);
        },
      };
      await expect(publishDexPriceChallengerSnapshots(failed, {
        ...publicationInput(generationId),
        retainedPoolsByStablecoin: new Map(ACTIVE_STABLECOINS.slice(0, 8).map((coin) => [coin.id, challengerPools(60)])),
      })).rejects.toThrow("later payload failed");
      expect(await loadedPools(db)).toEqual(["pool-00"]);
    } finally { sqlite.close(); }
  });

  it.each([false, true])("rejects interleaved same-clock losers without exposing a payload union (empty winner: %s)", async (emptyWinner) => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      let interposed = false;
      const racing = {
        ...db,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          const result = await db.batch<T>(statements);
          if (!interposed) {
            interposed = true;
            expect(await loadedPools(db)).toEqual(["pool-00"]);
            await publishDexPriceChallengerSnapshots(db, publicationInput(generationId,
              emptyWinner ? [] : [{ ...challengerPools(1)[0]!, poolId: "winner" }]));
          }
          return result;
        },
      };
      const result = await publishDexPriceChallengerSnapshots(racing,
        publicationInput(generationId, [{ ...challengerPools(1)[0]!, poolId: "loser" }]));
      expect(result).toEqual({ publishedStablecoins: 0, skippedStablecoins: ACTIVE_STABLECOINS.length });
      expect(await loadedPools(db)).toEqual(emptyWinner ? [] : ["winner"]);
    } finally { sqlite.close(); }
  });

  it("preserves newer old-Worker snapshots until a nonregressing first v2 publication", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      sqlite.prepare(`INSERT INTO dex_price_challenger_snapshots
        (stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete)
        VALUES (?, ?, ?, 0, 1)`).run(COIN, SNAPSHOT + 1, SNAPSHOT + 1);
      const refused = await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      expect(refused.skippedStablecoins).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_challenger_heads_v2 WHERE stablecoin_id = ?").get(COIN))
        .toEqual({ count: 0 });
      expect(await loadedPools(db)).toEqual([]);
      sqlite.prepare("UPDATE dex_liquidity SET updated_at = ?").run(SNAPSHOT + 1);
      const accepted = await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, challengerPools(1), SNAPSHOT + 1));
      expect(accepted.skippedStablecoins).toBe(0);
      expect(await loadedPools(db)).toEqual(["pool-00"]);
    } finally { sqlite.close(); }
  });

  it("refuses superseded liquidity generations and lower source clocks", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      const wrongGeneration = await publishDexPriceChallengerSnapshots(db, publicationInput("not-current", []));
      expect(wrongGeneration.publishedStablecoins).toBe(0);
      // Even when an older liquidity generation is again current, source clocks cannot regress.
      sqlite.prepare("UPDATE dex_liquidity SET updated_at = ?").run(SNAPSHOT - 1);
      const oldSource = await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, [], SNAPSHOT - 1));
      expect(oldSource).toEqual({ publishedStablecoins: 0, skippedStablecoins: ACTIVE_STABLECOINS.length });
      expect(await loadedPools(db)).toEqual(["pool-00"]);
    } finally { sqlite.close(); }
  });

  it("rolls back pointer acceptance and retries without changing the allocated payload", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      let attempts = 0;
      const retrying = {
        ...db,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          if (statements.length === 4 && ++attempts === 1) {
            await expect(db.batch([...statements, db.prepare("SELECT * FROM missing_pointer_retry_fixture")]))
              .rejects.toThrow();
            expect(await loadedPools(db)).toEqual(["pool-00"]);
            throw new Error("D1 DB is overloaded during pointer batch");
          }
          return db.batch<T>(statements);
        },
      };
      await publishDexPriceChallengerSnapshots(retrying,
        publicationInput(generationId, [{ ...challengerPools(1)[0]!, poolId: "replacement" }]));
      expect(attempts).toBe(2);
      expect(await loadedPools(db)).toEqual(["replacement"]);
    } finally { sqlite.close(); }
  });

  it("reclaims interrupted staging in bounded passes after the writer-age bound while protecting heads and live writers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SNAPSHOT * 1000);
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, []));
      sqlite.exec(`INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
        VALUES ('outside-active', 1, 1);
        INSERT INTO dex_price_challenger_payloads_v2
        (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
        VALUES (1, 'outside-active', 'protected', 'Ethereum', 'curve', 'dl', 1, 100000);`);
      const failed = {
        ...db,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          await db.batch<T>(statements);
          throw new Error("interrupted after durable staging");
        },
      };
      await expect(publishDexPriceChallengerSnapshots(failed, {
        ...publicationInput(generationId),
        retainedPoolsByStablecoin: new Map(ACTIVE_STABLECOINS.slice(0, 8).map((coin) => [coin.id, challengerPools(60)])),
      })).rejects.toThrow("interrupted after durable staging");
      const staged = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_challenger_payloads_v2 WHERE publication_id = 2").get()?.count);
      expect(staged).toBeGreaterThan(0);
      sqlite.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
        INSERT INTO dex_price_challenger_payloads_v2
        (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
        SELECT 2, 'bulk', 'pool-' || n, 'Ethereum', 'curve', 'dl', 1, 100000 FROM seq`).run(1301 - staged);
      sqlite.prepare(`INSERT INTO dex_price_challenger_publications_v2
        (publication_id, generation_id, snapshot_at, published_at)
        VALUES (3, ?, 1, ?), (4, ?, 1, ?)`)
        .run(generationId, SNAPSHOT + 1, generationId, SNAPSHOT + 1801);
      sqlite.exec(`INSERT INTO dex_price_challenger_payloads_v2
        (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
        VALUES (3, 'boundary', 'boundary', 'Ethereum', 'curve', 'dl', 1, 100000),
               (4, 'live', 'live', 'Ethereum', 'curve', 'dl', 1, 100000);`);
      vi.setSystemTime((SNAPSHOT + 1801) * 1000);
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, []));
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_challenger_payloads_v2 WHERE publication_id = 2").get())
        .toEqual({ count: 51 });
      expect(sqlite.prepare("SELECT sealed FROM dex_price_challenger_publications_v2 WHERE publication_id = 2").get())
        .toEqual({ sealed: 0 }); // Parent survives until every child drains.
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, []));
      expect(sqlite.prepare("SELECT publication_id FROM dex_price_challenger_publications_v2 WHERE publication_id = 2").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT pool_id FROM dex_price_challenger_payloads_v2 WHERE publication_id IN (1, 3, 4) ORDER BY publication_id").all())
        .toEqual([{ pool_id: "protected" }, { pool_id: "boundary" }, { pool_id: "live" }]);
      vi.setSystemTime((SNAPSHOT + 1802) * 1000);
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId, []));
      expect(sqlite.prepare("SELECT pool_id FROM dex_price_challenger_payloads_v2 WHERE publication_id IN (1, 3, 4) ORDER BY publication_id").all())
        .toEqual([{ pool_id: "protected" }, { pool_id: "live" }]);
    } finally {
      sqlite.close();
      vi.useRealTimers();
    }
  });

  it("rolls back pointer acceptance if its associated cleanup fails", async () => {
    const { db, sqlite, generationId } = seedPublishedDexGeneration();
    try {
      await publishDexPriceChallengerSnapshots(db, publicationInput(generationId));
      sqlite.exec(`CREATE TEMP TRIGGER fail_challenger_cleanup BEFORE DELETE ON dex_price_challenger_payloads_v2
        BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`);
      await expect(publishDexPriceChallengerSnapshots(db, publicationInput(generationId, [])))
        .rejects.toThrow("cleanup failed");
      expect(await loadedPools(db)).toEqual(["pool-00"]);
    } finally { sqlite.close(); }
  });
});

describe("challenger load", () => {
  it("reads v2 head and exact payload coherently despite same-clock replacement and old-writer skew", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old-worker");
    sqlite.exec(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at, sealed)
      VALUES (1, 'liquidity', 100, 110, 1), (2, 'liquidity', 100, 120, 1);
      INSERT INTO dex_price_challenger_payloads_v2
      (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd, price_observed_at)
      VALUES (1, 'coin-a', 'accepted', 'Ethereum', 'curve', 'cg_onchain', 1, 20000, 90),
             (2, 'coin-a', 'staged', 'Base', 'balancer', 'dl', 0.9, 30000, 95);
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('coin-a', 1, 1);`);
    let switched = false;
    const reader = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("SELECT heads.stablecoin_id")) return statement;
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<T>();
          if (!switched) {
            sqlite.exec(`UPDATE dex_price_challenger_heads_v2 SET publication_id = 2;
              DELETE FROM dex_price_challenger_payloads_v2 WHERE publication_id = 1;
              UPDATE dex_price_challenger_snapshots SET snapshot_at = 200;`);
            payload(200, "new-old-worker");
            switched = true;
          }
          return result;
        };
        return statement;
      },
    } as D1Database;
    const first = await loadPublishedDexPoolChallengers(reader, 20_000, 1_000, 220);
    expect(first.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({ poolId: "accepted", sourceFamily: "cg_onchain", priceObservedAt: 90, snapshotAt: 100 }),
    ]);
    const next = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 220);
    expect(next.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["staged"]);
    expect((await loadDexPoolChallengers(db, 20_000, 1_000, 220)).get("coin-a")?.[0]?.observedAt).toBe(95);
    sqlite.exec("UPDATE dex_price_challenger_payloads_v2 SET price_observed_at = NULL WHERE publication_id = 2");
    expect((await loadDexPoolChallengers(db, 20_000, 1_000, 220)).get("coin-a")?.[0]?.observedAt).toBeUndefined();
    expect(next.diagnostics.legacyFallbackCoins).toEqual([]);
  });

  it("keeps v2 empty authoritative over old-writer rows, while missing, stale and incomplete v2 use explicit legacy fallback", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old-worker");
    sqlite.exec(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at, sealed)
      VALUES (1, 'liquidity', 100, 110, 1);
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('coin-a', 1, 0);`);
    const empty = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(empty.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(empty.diagnostics.emptyPublishedCoins).toEqual(["coin-a"]);
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET has_rows = 1");
    const missing = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(missing.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET has_rows = 0, source_coverage_complete = 0");
    const incomplete = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(incomplete.diagnostics.incompletePublishedCoins).toEqual(["coin-a"]);
    expect(incomplete.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    const stale = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_101);
    expect(stale.diagnostics.staleSnapshotCoins).toEqual(["coin-a"]);
    expect(stale.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
  });

  it("keeps a coherent generation when publication switches pointers and cleans old payloads", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "old");
    let published = false;
    const reader = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("FROM dex_price_challenger_snapshots")) return statement;
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<T>();
          if (!published) {
            payload(200, "new");
            sqlite.exec("UPDATE dex_price_challenger_snapshots SET snapshot_at = 200, published_at = 210; DELETE FROM dex_price_challengers WHERE snapshot_at = 100");
            published = true;
          }
          return result;
        };
        return statement;
      },
    } as D1Database;
    const result = await loadPublishedDexPoolChallengers(reader, 20_000, 1_000, 220);
    expect(published).toBe(true);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["old"]);
    expect(result.diagnostics).toMatchObject({ mode: "published", legacyFallbackCoins: [] });
    expect((await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 220))
      .challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["new"]);
  });

  it("serves the exact freshness boundary but falls back one second later", async () => {
    const { db, payload } = loaderScenario();
    payload(100, "current");
    const fresh = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    const stale = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_101);
    expect(fresh.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["current"]);
    expect(fresh.diagnostics.staleSnapshotCoins).toEqual([]);
    expect(stale.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    expect(stale.diagnostics.staleSnapshotCoins).toEqual(["coin-a"]);
  });

  it("serves only the generation selected by the published pointer", async () => {
    const { db, payload } = loaderScenario();
    payload(99, "old", 0.5, 90_000);
    payload(100, "current");
    payload(101, "unpublished", 1.5, 100_000);
    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["current"]);
  });

  it("falls back for a missing payload generation but keeps an empty pointer authoritative", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(99, "old");
    const missing = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(missing.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["coin-a:legacy:Base"]);
    sqlite.prepare("UPDATE dex_price_challenger_snapshots SET has_rows = 0").run();
    const empty = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(empty.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(empty.diagnostics.legacyFallbackCoins).toEqual([]);
  });

  it("filters invalid economics without replacing a complete generation with legacy data", async () => {
    const { db, sqlite, payload } = loaderScenario();
    payload(100, "zero", 0);
    payload(100, "negative", -1);
    payload(100, "nonfinite", Infinity);
    payload(100, "below-minimum", 1, 19_999);
    payload(100, "at-minimum", 1, 20_000);
    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(result.challengersByStablecoin.get("coin-a")?.map((row) => row.poolId)).toEqual(["at-minimum"]);
    sqlite.prepare("DELETE FROM dex_price_challengers WHERE pool_id = 'at-minimum'").run();
    const filtered = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 1_100);
    expect(filtered.challengersByStablecoin.get("coin-a")).toEqual([]);
    expect(filtered.diagnostics.legacyFallbackCoins).toEqual([]);
    expect(filtered.diagnostics.mode).toBe("published");
  });

  it("does not run the full legacy JSON load when published snapshots cover", async () => {
    const db = mockD1(
      [
        {
          match: "SELECT stablecoin_id\n     FROM dex_liquidity",
          rows: [],
        },
        {
          match: "SELECT stablecoin_id\n     FROM dex_prices",
          rows: [],
        },
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
          ],
        },
      ],
      { assertMatchesUsed: true },
    ) as MockD1Database;

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("published");
    expect(result.diagnostics.legacyFallbackCoins).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
      }),
    ]);
    expect(
      db.getHistory().some((entry) =>
        entry.sql.includes("SELECT stablecoin_id, top_pools_json")
        || entry.sql.includes("SELECT stablecoin_id, price_sources_json"),
      ),
    ).toBe(false);
  });

  it("loads published challenger snapshots when present, falls back per coin, and keeps empty snapshots authoritative", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
            {
              stablecoin_id: "coin-b",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 0,
              source_coverage_complete: 1,
              pool_id: null,
            },
            {
              stablecoin_id: "coin-c",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 0,
              pool_id: "coin-c:published",
              chain: "Solana",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.996,
              tvl_usd: 30_000,
            },
          ],
        },
        {
          match: "FROM dex_liquidity",
          rows: [
            {
              stablecoin_id: "coin-b",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-b:legacy-top",
                  chain: "Base",
                  project: "legacy-top",
                  tvlUsd: 45_000,
                  price: 0.991,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-c",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-c:legacy-top",
                  chain: "Solana",
                  project: "legacy-top",
                  tvlUsd: 35_000,
                  price: 0.988,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-d",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-d:legacy-top",
                  chain: "Ethereum",
                  project: "legacy-top",
                  tvlUsd: 25_000,
                  price: 0.985,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
        {
          match: "FROM dex_prices",
          rows: [
            {
              stablecoin_id: "coin-e",
              price_sources_json: JSON.stringify([
                {
                  protocol: "legacy-source",
                  chain: "Arbitrum",
                  price: 0.982,
                  tvl: 60_000,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
      ],
      { assertMatchesUsed: true },
    );

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("mixed");
    expect(result.diagnostics.emptyPublishedCoins).toEqual(["coin-b"]);
    expect(result.diagnostics.incompletePublishedCoins).toEqual(["coin-c"]);
    expect(new Set(result.diagnostics.legacyFallbackCoins)).toEqual(new Set(["coin-c", "coin-d", "coin-e"]));

    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
        snapshotAt: 100,
        publishedAt: 110,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-b")).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-c")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-c",
        poolId: "coin-c:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.988,
        tvlUsd: 35_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-d")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-d",
        poolId: "coin-d:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.985,
        tvlUsd: 25_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-e")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-e",
        poolId: "coin-e:legacy-source:Arbitrum",
        sourceFamily: "legacy-price-sources",
        priceUsd: 0.982,
        tvlUsd: 60_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
  });

  it("keeps a qualifying large pool with no observed 24h flow when the published challenger snapshot is stale", async () => {
    const { sqlite, db } = loaderFixtures.open();
    const nowSec = 1_700_000_000;
    const staleSnapshotAt = nowSec - DEX_FRESHNESS_SEC - 60;
    const pool = (
      overrides: Partial<PoolEntry> & Pick<PoolEntry, "poolId" | "project" | "chain" | "tvlUsd">,
    ): PoolEntry => ({
      symbol: "USDC/USDT",
      volumeUsd1d: 500_000,
      volumeUsd7d: 3_500_000,
      poolType: "balancer-stable",
      source: "dl",
      price: 1,
      priceObservedAt: nowSec - 60,
      priceSource: "dl",
      ...overrides,
    });

    // Ten live pools with measured 24h flow outrank the dormant pool in the
    // display projection's volume ordering.
    const livePools = Array.from({ length: 10 }, (_, index) => pool({
      poolId: `base:0xlive${index}`,
      project: `live-dex-${index}`,
      chain: "Base",
      tvlUsd: 300_000,
      volumeUsd1d: 600_000 - index * 10_000,
      price: 0.9995,
    }));
    // Direct Aero state carries no trailing volume: null (unobserved), never a
    // measured zero. This is the largest retained pool and its quote is
    // depegged, so the >= $5M pool-challenger rule must still see it.
    const dormantPool = pool({
      poolId: "base:0xaero-dormant",
      project: "aerodrome-slipstream",
      chain: "Base",
      tvlUsd: 50_000_000,
      volumeUsd1d: null,
      volumeUsd7d: null,
      poolType: "aerodrome-slipstream",
      source: "direct_api",
      price: 0.9,
      priceSource: "direct_api",
    });

    // Retention, scoring and persistence projections are the production path:
    // scoring keeps filterRetainedPools -> rebuildMetricsFromPools and persists
    // the uncapped TVL-bounded challenger projection, not the display slice.
    const retainedPools = filterRetainedPools([...livePools, dormantPool]);
    expect(retainedPools.map((entry) => entry.poolId)).toContain(dormantPool.poolId);
    const metrics = scorePoolGraph({
      stablecoinId: "coin-a",
      symbol: "COINA",
      pools: retainedPools,
    });

    sqlite.prepare(
      `INSERT INTO dex_liquidity
         (stablecoin_id, symbol, total_tvl_usd, pool_count, top_pools_json,
          challenger_pools_json, updated_at)
       VALUES ('coin-a', 'COINA', ?, ?, ?, ?, ?)`,
    ).run(
      53_000_000,
      11,
      JSON.stringify(metrics.topPools.map(({ volumeReading: _volumeReading, ...entry }) => entry)),
      buildStoredChallengerPoolsJson("coin-a", retainedPools, POOL_CHALLENGE_MIN_TVL),
      nowSec - 60,
    );
    sqlite.prepare(
      `INSERT INTO dex_price_challenger_publications_v2
         (publication_id, generation_id, snapshot_at, published_at, sealed)
       VALUES (1, 'liquidity', ?, ?, 1)`,
    ).run(staleSnapshotAt, staleSnapshotAt + 30);
    sqlite.prepare(
      `INSERT INTO dex_price_challenger_heads_v2
         (stablecoin_id, publication_id, has_rows, source_coverage_complete)
       VALUES ('coin-a', 1, 1, 1)`,
    ).run();

    const challengers = await loadDexPoolChallengers(
      db,
      POOL_CHALLENGE_MIN_TVL,
      DEX_FRESHNESS_SEC,
      nowSec,
    );

    expect(challengers.get("coin-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        protocol: "aerodrome-slipstream",
        chain: "Base",
        price: 0.9,
        tvlUsd: 50_000_000,
      }),
    ]));
  });

  it("surfaces a missing mandatory challenger snapshot table", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [{
            stablecoin_id: "coin-z",
            snapshot_at: 100,
            published_at: 100,
            has_rows: 0,
            source_coverage_complete: 0,
          }],
          throwError: new Error("no such table: dex_price_challenger_snapshots"),
        },
      ],
      { assertMatchesUsed: true },
    );

    await expect(
      loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120),
    ).rejects.toThrow("no such table: dex_price_challenger_snapshots");
  });

  it("skips malformed legacy challenger JSON payloads", async () => {
    const db = mockD1([
      { match: "SELECT stablecoin_id\n     FROM dex_liquidity", rows: [{ stablecoin_id: "coin-z" }] },
      { match: "FROM dex_price_challenger_snapshots", rows: [] },
      { match: "SELECT stablecoin_id, top_pools_json", rows: [
        { stablecoin_id: "coin-z", top_pools_json: "{bad-json", updated_at: 100 },
      ] },
      { match: "SELECT stablecoin_id, price_sources_json", rows: [
        { stablecoin_id: "coin-y", price_sources_json: "{bad-json", updated_at: 100 },
        { stablecoin_id: "clock-only", price_sources_json: JSON.stringify({ aggregateObservedAt: 100, sources: [] }), updated_at: 100 },
      ] },
    ], { assertMatchesUsed: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);
      expect(result.diagnostics.mode).toBe("absent");
      expect(result.challengersByStablecoin.size).toBe(0);
      const history = db.getHistory();
      const topPoolRead = history.find((entry) => entry.sql.includes("SELECT stablecoin_id, top_pools_json"));
      const priceSourceRead = history.find((entry) => entry.sql.includes("SELECT stablecoin_id, price_sources_json"));
      expect(topPoolRead?.binds).toEqual([-880]);
      expect(priceSourceRead?.binds).toEqual([-880]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
