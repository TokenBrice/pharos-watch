import { describe, it, expect, vi } from "vitest";
import {
  cleanupStaging,
  hasValidStagedPoolTvl,
  incrementRunSeq,
  isValidStagedPoolId,
  readDiscoveryMeta,
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

  it("retries staging cleanup batches on transient D1 overload", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Requests queued for too long");
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
        ];
      },
    } as unknown as D1Database;

    await cleanupStaging(db, 1_710_000_000);

    expect(attempts).toBe(2);
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
});
