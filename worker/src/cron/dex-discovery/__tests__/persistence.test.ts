import { describe, it, expect, vi } from "vitest";
import {
  cleanupStaging,
  hasValidStagedPoolTvl,
  incrementRunSeq,
  isValidStagedPoolId,
  readDiscoveryCensusSummaries,
  readDiscoveryMeta,
  recordDiscoveryAttemptFence,
  updateDiscoveryMeta,
  upsertStagedPools,
} from "../persistence";
import { STAGED_POOL_MAX_TVL_USD, type StagedPool } from "../types";

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
    const preparedSql: string[] = [];
    const boundValues: unknown[][] = [];
    const db = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return {
          bind: (...values: unknown[]) => {
            boundValues.push(values);
            return { run: async () => ({ success: true, meta: { changes: 1 } }) };
          },
        };
      },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, meta: { changes: 1 } })),
    } as unknown as D1Database;

    const nowSec = 1710000000;
    const pool: StagedPool = {
      poolId: "orderbook:kinesis:usdc-circle",
      stablecoinId: "usdc-circle",
      source: "cg_tickers",
      chain: "orderbook",
      protocol: "kinesis",
      dexId: "kinesis",
      symbol: "USDC / USD",
      tvlUsd: 60_000,
      volume24h: 30_000,
      qualityMultiplier: 0.6,
      poolType: "orderbook",
      feeTier: null,
      balanceRatio: null,
      isStable: null,
      baseToken: null,
      quoteToken: null,
      quoteSymbol: "USD",
      priceUsd: 1,
      lockedLiqPct: null,
      rawJson: null,
      discoveredAt: nowSec,
      refreshedAt: nowSec,
    };

    await upsertStagedPools(db, [pool]);

    expect(preparedSql[0]).toBe(
      "DELETE FROM dex_pool_staging WHERE stablecoin_id = ? AND source = 'cg_tickers' AND pool_id = ?",
    );
    expect(boundValues[0]).toEqual(["usdc-circle", "orderbook:kinesis"]);
    expect(preparedSql[1]).toContain("INSERT INTO dex_pool_staging");
    expect(boundValues[1]?.[0]).toBe("orderbook:kinesis:usdc-circle");
  });
});

describe("discovery persistence D1 retry coverage", () => {
  it("retries discovery meta writes on transient D1 overload", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            attempts++;
            if (attempts === 1) throw new Error("D1 DB is overloaded");
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    await updateDiscoveryMeta(db, "usdc-circle", 2, 1_710_000_000);

    expect(attempts).toBe(2);
  });

  it("does not retry miss-counter arithmetic after an ambiguous D1 overload", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            attempts++;
            throw new Error("D1 DB storage operation exceeded timeout");
          },
        }),
      }),
    } as unknown as D1Database;

    await expect(updateDiscoveryMeta(db, "usdc-circle", 0, 1_710_000_000)).rejects.toThrow(
      "D1 DB storage operation exceeded timeout",
    );

    expect(attempts).toBe(1);
  });

  it("uses bounded oldest-first 30h/4h staging cleanup and retries transient D1 overload", async () => {
    let attempts = 0;
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
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
    } as unknown as D1Database;

    const cleanup = await cleanupStaging(db, 1_710_000_000);

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
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("staging retention unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    const cleanup = await cleanupStaging(db, 1_710_000_000);

    expect(cleanup.deletedRows).toBe(0);
    expect(cleanup.rawJsonClearedRows).toBe(0);
    expect(cleanup.error).toBe("staging retention unavailable");
  });

  it("retries discovery meta reads and maps rows", async () => {
    let attempts = 0;
    const db = {
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
    } as unknown as D1Database;

    const rows = await readDiscoveryMeta(db);

    expect(attempts).toBe(2);
    expect(rows.get("usdc-circle")).toEqual({
      stablecoinId: "usdc-circle",
      consecutiveMisses: 3,
      lastCrawlAt: 1_710_000_000,
      lastHitAt: 1_709_900_000,
    });
  });

  it("aggregates the deployment census per coin and excludes unsupported chains", async () => {
    let sql = "";
    const db = {
      prepare: (statement: string) => {
        sql = statement;
        return {
          all: async () => ({
            results: [
              {
                stablecoin_id: "buidl-blackrock",
                verified_no_pools: 8,
                observed_pools: 0,
                provider_supported_inaccessible: 0,
              },
              {
                stablecoin_id: "m-m0",
                verified_no_pools: 9,
                observed_pools: 0,
                provider_supported_inaccessible: 7,
              },
              {
                stablecoin_id: "sparse",
                verified_no_pools: null,
                observed_pools: null,
                provider_supported_inaccessible: null,
              },
            ],
          }),
        };
      },
    } as unknown as D1Database;

    const summaries = await readDiscoveryCensusSummaries(db);

    // Unsupported-chain rows must not count as unanswered deployments (R1-D).
    expect(sql).toContain("provider_set_json <> '[]'");
    expect(sql).toContain("GROUP BY stablecoin_id");
    expect(summaries.get("buidl-blackrock")).toEqual({
      verifiedNoPoolsCount: 8,
      observedPoolsCount: 0,
      providerSupportedInaccessibleCount: 0,
    });
    expect(summaries.get("m-m0")?.providerSupportedInaccessibleCount).toBe(7);
    expect(summaries.get("sparse")).toEqual({
      verifiedNoPoolsCount: 0,
      observedPoolsCount: 0,
      providerSupportedInaccessibleCount: 0,
    });
  });

  it("records an attempt fence without changing existing backoff counters", async () => {
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            prepared.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    await recordDiscoveryAttemptFence(db, "coin-a", 1_710_000_000);

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toContain(
      "ON CONFLICT(stablecoin_id) DO UPDATE SET",
    );
    expect(prepared[0]?.sql).toContain(
      "last_crawl_at = excluded.last_crawl_at",
    );
    expect(prepared[0]?.sql).not.toContain(
      "DO UPDATE SET\n             consecutive_misses",
    );
    expect(prepared[0]?.binds).toEqual(["coin-a", 1_710_000_000]);
  });

  it("honors abort signals before incrementing the run sequence", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-discovery"));
    const prepare = vi.fn();
    const db = {
      prepare,
      batch: async () => [],
    } as unknown as D1Database;

    await expect(incrementRunSeq(db, controller.signal)).rejects.toThrow("stop-discovery");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry the discovery run sequence increment after an ambiguous D1 overload", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        throw new Error("Requests queued for too long");
      },
    } as unknown as D1Database;

    await expect(incrementRunSeq(db)).rejects.toThrow("Requests queued for too long");
    expect(attempts).toBe(1);
  });
});
