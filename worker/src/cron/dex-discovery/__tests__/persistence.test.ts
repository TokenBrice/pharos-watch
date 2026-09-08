import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanupStaging,
  hasValidStagedPoolTvl,
  incrementRunSeq,
  isValidStagedPoolId,
  readDiscoveryCensusSummaries,
  readDiscoveryMeta,
  readDiscoveryTargetCursors,
  recordDiscoveryAttemptFence,
  updateDiscoveryMeta,
  upsertStagedPools,
  writeDiscoveryTargetCursors,
} from "../persistence";
import { STAGED_POOL_MAX_TVL_USD } from "../types";
import { makeNoopD1, makeRunCountingNoopD1 } from "../../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { stagedPool } from "./discovery.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("isValidStagedPoolId", () => {
  it("accepts EVM chain:address lowercased form", () => {
    expect(isValidStagedPoolId("ethereum:0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(isValidStagedPoolId("base:0xabcdef")).toBe(true);
  });

  it("accepts Solana mixed-case base58 addresses", () => {
    expect(isValidStagedPoolId("solana:HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR")).toBe(true);
  });

  it("accepts orderbook synthetic form with extra coin segment", () => {
    expect(isValidStagedPoolId("orderbook:kinesis:usdc-circle")).toBe(true);
  });

  it("rejects poolIds missing the colon separator", () => {
    expect(isValidStagedPoolId("eth0x1234")).toBe(false);
  });

  it("rejects uppercase chain slug", () => {
    expect(isValidStagedPoolId("ETHEREUM:0x123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidStagedPoolId("")).toBe(false);
  });
});

describe("hasValidStagedPoolTvl", () => {
  it("accepts null and finite TVL values inside the staging cap", () => {
    expect(hasValidStagedPoolTvl({ tvlUsd: null })).toBe(true);
    expect(hasValidStagedPoolTvl({ tvlUsd: 0 })).toBe(true);
    expect(hasValidStagedPoolTvl({ tvlUsd: STAGED_POOL_MAX_TVL_USD })).toBe(true);
  });

  it("rejects non-finite, negative, and over-cap TVL values", () => {
    expect(hasValidStagedPoolTvl({ tvlUsd: Number.NaN })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: -1 })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: STAGED_POOL_MAX_TVL_USD + 1 })).toBe(false);
  });
});

describe("upsertStagedPools", () => {
  it("deletes the same-coin legacy exchange-only orderbook row before upserting suffixed ids", async () => {
    const { sqlite, db } = fixtures.open();

    const nowSec = 1710000000;
    const pool = stagedPool({
      poolId: "orderbook:kinesis:usdc-circle", stablecoinId: "usdc-circle", source: "cg_tickers",
      chain: "orderbook", protocol: "kinesis", dexId: "kinesis", symbol: "USDC / USD",
      tvlUsd: 60_000, volume24h: 30_000, qualityMultiplier: 0.6, poolType: "orderbook",
      quoteToken: null, quoteSymbol: "USD", discoveredAt: nowSec, refreshedAt: nowSec,
    });

    await upsertStagedPools(db, [{ ...pool, discoveredAt: nowSec - 100, refreshedAt: nowSec - 100 }]);
    await upsertStagedPools(db, [
      { ...pool, poolId: "orderbook:kinesis" },
      { ...pool, poolId: "orderbook:kinesis", stablecoinId: "other-coin" },
    ]);
    await upsertStagedPools(db, [pool]);

    expect(sqlite.prepare("SELECT pool_id, stablecoin_id, discovered_at, refreshed_at FROM dex_pool_staging ORDER BY stablecoin_id").all()).toEqual([
      { pool_id: "orderbook:kinesis", stablecoin_id: "other-coin", discovered_at: nowSec, refreshed_at: nowSec },
      { pool_id: pool.poolId, stablecoin_id: pool.stablecoinId, discovered_at: nowSec - 100, refreshed_at: nowSec },
    ]);
  });
});

describe("discovery persistence D1 retry coverage", () => {
  it("retries discovery meta writes on transient D1 overload", async () => {
    vi.useFakeTimers();
    const db = makeRunCountingNoopD1((attempt) =>
      attempt === 1 ? new Error("D1 DB is overloaded") : null,
    );

    const pending = updateDiscoveryMeta(db, "usdc-circle", 2, 1_710_000_000);
    await vi.runAllTimersAsync();
    await pending;

    expect(db.getRunCount()).toBe(2);
  });

  it("does not retry miss-counter arithmetic after an ambiguous D1 overload", async () => {
    const db = makeRunCountingNoopD1(() => new Error("D1 DB storage operation exceeded timeout"));

    await expect(updateDiscoveryMeta(db, "usdc-circle", 0, 1_710_000_000)).rejects.toThrow(
      "D1 DB storage operation exceeded timeout",
    );

    expect(db.getRunCount()).toBe(1);
  });

  it("uses bounded oldest-first 30h/4h staging cleanup and retries transient D1 overload", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeNoopD1({
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            prepared.push({ sql, binds });
            attempts++;
            if (attempts === 1) throw new Error("Requests queued for too long");
            return { meta: { changes: sql.includes("DELETE FROM") ? 12 : 7 } };
          },
        }),
        first: async () => ({
          oldest_remaining_at: 1_709_900_000,
          oldest_raw_json_remaining_at: 1_709_990_000,
        }),
      }),
    });

    const pending = cleanupStaging(db, 1_710_000_000);
    await vi.runAllTimersAsync();
    const cleanup = await pending;

    expect(attempts).toBe(3);
    expect(prepared[0]?.sql).toContain("ORDER BY refreshed_at ASC, rowid ASC");
    expect(prepared[0]?.binds).toEqual([1_710_000_000 - 30 * 60 * 60, 1_000]);
    expect(prepared[2]?.sql).toContain("SET raw_json = NULL");
    expect(prepared[2]?.binds).toEqual([1_710_000_000 - 4 * 60 * 60, 1_000]);
    expect(cleanup).toMatchObject({
      deletedRows: 12,
      rawJsonClearedRows: 7,
      oldestRemainingAt: 1_709_900_000,
      oldestRawJsonRemainingAt: 1_709_990_000,
      error: null,
    });
  });

  it("reports staging cleanup errors without throwing", async () => {
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("staging retention unavailable");
          },
        }),
      }),
    });

    const cleanup = await cleanupStaging(db, 1_710_000_000);

    expect(cleanup.deletedRows).toBe(0);
    expect(cleanup.rawJsonClearedRows).toBe(0);
    expect(cleanup.error).toBe("staging retention unavailable");
  });

  it("retries discovery meta reads and maps rows", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const db = makeNoopD1({
      prepare: () => ({
        all: async () => {
          attempts++;
          if (attempts === 1) throw new Error("D1 DB storage operation exceeded timeout");
          return {
            results: [{
              stablecoin_id: "usdc-circle",
              consecutive_misses: 3,
              last_crawl_at: 1_710_000_000,
              last_hit_at: 1_709_900_000,
            }],
          };
        },
      }),
    });

    const pending = readDiscoveryMeta(db);
    await vi.runAllTimersAsync();
    const rows = await pending;

    expect(attempts).toBe(2);
    expect(rows.get("usdc-circle")).toEqual({
      stablecoinId: "usdc-circle",
      consecutiveMisses: 3,
      lastCrawlAt: 1_710_000_000,
      lastHitAt: 1_709_900_000,
    });
  });

  it("aggregates the deployment census per coin and excludes unsupported chains", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO dex_deployment_outcomes
      (stablecoin_id, chain, contract_address, outcome, provider_set_json, reason, observed_at)
      VALUES (?, 'ethereum', ?, ?, ?, 'fixture', 100)`);
    insert.run("coin-a", "0xa", "verified_no_pools", '["curve"]');
    insert.run("coin-a", "0xb", "observed_pools", '["curve"]');
    insert.run("coin-a", "0xc", "provider_inaccessible", '["curve"]');
    insert.run("coin-a", "0xd", "provider_inaccessible", "[]");
    insert.run("coin-b", "0xa", "provider_inaccessible", "[]");
    expect(await readDiscoveryCensusSummaries(db)).toEqual(new Map([
      ["coin-a", { verifiedNoPoolsCount: 1, observedPoolsCount: 1, providerSupportedInaccessibleCount: 1 }],
      ["coin-b", { verifiedNoPoolsCount: 0, observedPoolsCount: 0, providerSupportedInaccessibleCount: 0 }],
    ]));
  });

  it("round-trips the per-coin target cursor as one durable map", async () => {
    let storedValue: string | undefined;
    const db = makeNoopD1({
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT")) {
          return {
            bind: () => ({ first: async () => ({ value: storedValue }) }),
          };
        }
        return {
          bind: (...values: unknown[]) => ({
            run: async () => {
              storedValue = values[1] as string;
              return { success: true, meta: { changes: 1 } };
            },
          }),
        };
      },
    });
    const cursors = new Map([
      ["coin-a", "ethereum:0xaaa"],
      ["coin-b", "osmosis:ibc/BBB"],
    ]);

    await writeDiscoveryTargetCursors(db, cursors);

    expect(storedValue).toBe(JSON.stringify(Object.fromEntries(cursors)));
    expect(await readDiscoveryTargetCursors(db)).toEqual(cursors);
  });

  it("records an attempt fence without changing existing backoff counters", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO dex_discovery_meta
      (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at, deployment_fence_attribution_at)
      VALUES ('coin-a', 7, 100, 80, 100), ('coin-b', 9, 90, 70, 90);
      INSERT INTO dex_deployment_outcomes
      (stablecoin_id, chain, contract_address, outcome, reason, observed_at, last_attempt_at)
      VALUES ('coin-a', 'ethereum', '0xabc', 'verified_no_pools', 'fixture', 100, 100),
        ('coin-a', 'ethereum', '0xdef', 'verified_no_pools', 'fixture', 100, 100),
        ('coin-b', 'ethereum', '0xabc', 'verified_no_pools', 'fixture', 90, 90)`);
    await recordDiscoveryAttemptFence(db, "coin-a", [{ chain: "ethereum", address: "0xABC", decimals: 18 }], 200);
    expect(sqlite.prepare("SELECT stablecoin_id, contract_address, last_attempt_at FROM dex_deployment_outcomes ORDER BY stablecoin_id, contract_address").all()).toEqual([
      { stablecoin_id: "coin-a", contract_address: "0xabc", last_attempt_at: 200 },
      { stablecoin_id: "coin-a", contract_address: "0xdef", last_attempt_at: 100 },
      { stablecoin_id: "coin-b", contract_address: "0xabc", last_attempt_at: 90 },
    ]);
    expect(await readDiscoveryMeta(db)).toEqual(new Map([
      ["coin-a", { stablecoinId: "coin-a", consecutiveMisses: 7, lastCrawlAt: 200, lastHitAt: 80 }],
      ["coin-b", { stablecoinId: "coin-b", consecutiveMisses: 9, lastCrawlAt: 90, lastHitAt: 70 }],
    ]));
  });

  it("honors abort signals before incrementing the run sequence", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-discovery"));
    const prepare = vi.fn();
    const db = makeNoopD1({
      prepare,
      batch: async () => [],
    });

    await expect(incrementRunSeq(db, controller.signal)).rejects.toThrow("stop-discovery");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry the discovery run sequence increment after an ambiguous D1 overload", async () => {
    let attempts = 0;
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        throw new Error("Requests queued for too long");
      },
    });

    await expect(incrementRunSeq(db)).rejects.toThrow("Requests queued for too long");
    expect(attempts).toBe(1);
  });
});
