import { describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import {
  publishDexPriceChallengerSnapshots,
  selectDexPriceChallengerRowsFromPools,
} from "../challenger-publish";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { seedPublishedDexGeneration } from "./scoring-test-support";
import type { PoolEntry } from "../types";

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
