import { describe, expect, it, vi } from "vitest";

import { buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import {
  buildSolanaMeasuredQuoteGenerationId,
  buildTronMeasuredQuoteGenerationId,
  loadLatestPublishedDexMeasuredQuoteEvidence,
  publishDexMeasuredQuoteGeneration,
  publishDexMeasuredTargetInventory,
  publishSolanaMeasuredQuoteGeneration,
  publishSolanaMeasuredTargetInventory,
  publishTronMeasuredQuoteGeneration,
  publishTronMeasuredTargetInventory,
  pruneDexMeasuredExecutionGenerations,
} from "../persistence";
import { buildDexMeasuredExecutionProfile } from "../profiles";

function fixtureTarget(chain: string): DexMeasuredExecutionTarget {
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain,
    poolId: `${chain}:0x3333333333333333333333333333333333333333`,
    poolTokenAddresses: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as [`0x${string}`, `0x${string}`],
    tokenIn: {
      address: "0x1111111111111111111111111111111111111111" as const,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x2222222222222222222222222222222222222222" as const,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
  return {
    ...input,
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: input.adapterProfileId,
      stablecoinId: input.stablecoinId,
      chain: input.chain,
      protocol: input.protocol,
      poolId: input.poolId,
      tokenInAddress: input.tokenIn.address,
      tokenOutAddress: input.tokenOut.address,
      poolTokenAddresses: input.poolTokenAddresses,
      feePips: input.feePips,
    }),
  };
}

function fixtureProfile(target: DexMeasuredExecutionTarget) {
  return buildDexMeasuredExecutionProfile({
    target,
    targetGenerationId: "target-generation",
    quoteGenerationId: "quote-generation",
    quotedAt: 1_060,
    blockNumber: 25_536_894,
    endpointAddress: `0x${"44".repeat(20)}`,
    endpointCodeHash: `0x${"55".repeat(32)}`,
    points: [
      {
        amountInRaw: "1000000000",
        amountOutRaw: "970000000",
        callData: "0x01",
        returnData: "0x01",
        inputUsd: 1_000,
        outputUsd: 970,
        costBps: 300,
        passesCostBound: false,
      },
    ],
  });
}

describe("measured execution publication", () => {
  it("rejects an empty target generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredTargetInventory({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targets: [],
        capturedAt: 1_700_000_000,
      }),
    ).rejects.toThrow("empty measured target generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an empty quote generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredQuoteGeneration({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targetGeneration: { generationId: "targets", targets: [], publishedAt: 1_700_000_000 },
        outcomes: [],
        quotedAt: 1_700_000_100,
      }),
    ).rejects.toThrow("empty measured quote generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects empty native shadow generations before touching shared storage", async () => {
    const prepare = vi.fn();
    const db = { prepare } as Pick<D1Database, "prepare"> as D1Database;

    await expect(publishSolanaMeasuredTargetInventory({ db, targets: [], capturedAt: 1_700_000_000 })).rejects.toThrow(
      "empty Solana measured target generation",
    );
    await expect(
      publishSolanaMeasuredQuoteGeneration({
        db,
        targetGeneration: { generationId: "solana-targets", targets: [], publishedAt: 1_700_000_000 },
        outcomes: [],
        quotedAt: 1_700_000_100,
      }),
    ).rejects.toThrow("empty Solana measured quote generation");
    await expect(publishTronMeasuredTargetInventory({ db, targets: [], capturedAt: 1_700_000_000 })).rejects.toThrow(
      "empty Tron measured target generation",
    );
    await expect(
      publishTronMeasuredQuoteGeneration({
        db,
        targetGeneration: { generationId: "tron-targets", targets: [], publishedAt: 1_700_000_000 },
        outcomes: [],
        quotedAt: 1_700_000_100,
      }),
    ).rejects.toThrow("empty Tron measured quote generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses chain-specific native quote generation prefixes", () => {
    expect(buildSolanaMeasuredQuoteGenerationId(1_700_000_000)).toMatch(
      /^dex-solana-measured-quotes-1700000000-[0-9a-f]{12}$/,
    );
    expect(buildTronMeasuredQuoteGenerationId(1_700_000_000)).toMatch(
      /^dex-tron-measured-quotes-1700000000-[0-9a-f]{12}$/,
    );
  });
});

describe("measured execution raw payload policy", () => {
  it("persists the raw producer envelope only for failed outcomes", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const failedTarget = fixtureTarget("base");
    const profile = fixtureProfile(measuredTarget);
    const batched: Array<{ sql: string; binds: unknown[] }> = [];
    const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
      sql,
      binds,
      bind: (...next: unknown[]) => makeStmt(sql, next),
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => {
        if (sql.includes("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes")) return { count: 2 };
        return null;
      },
      all: async () => ({ results: [] }),
    });
    const db = {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
        batched.push(...stmts);
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const result = await publishDexMeasuredQuoteGeneration({
      db,
      generationId: "quote-generation",
      targetGeneration: {
        generationId: "target-generation",
        targets: [measuredTarget, failedTarget],
        publishedAt: 1_000,
      },
      outcomes: [
        {
          target: measuredTarget,
          status: "measured",
          profile,
          rawPayload: { adapterProfileId: measuredTarget.adapterProfileId, targetId: measuredTarget.targetId },
        },
        {
          target: failedTarget,
          status: "failed",
          failureReason: "profile-validation:test",
          rawPayload: { adapterProfileId: failedTarget.adapterProfileId, targetId: failedTarget.targetId },
        },
      ],
      quotedAt: 1_060,
    });

    expect(result).toEqual({ generationId: "quote-generation", measuredCount: 1, failedCount: 1 });
    const insert = batched.find((stmt) => stmt.sql.includes("INSERT INTO dex_measured_execution_quotes"));
    expect(insert).toBeDefined();
    expect(insert?.binds).toHaveLength(28);
    // Measured row (columns 0-13): profile persisted, raw payload dropped even though provided.
    expect(insert?.binds[8]).toBe("measured");
    expect(typeof insert?.binds[12]).toBe("string");
    expect(insert?.binds[13]).toBeNull();
    // Failed row (columns 14-27): no profile, raw payload retained as sole failure evidence.
    expect(insert?.binds[22]).toBe("failed");
    expect(insert?.binds[26]).toBeNull();
    expect(typeof insert?.binds[27]).toBe("string");
    expect(JSON.parse(insert?.binds[27] as string)).toMatchObject({ targetId: failedTarget.targetId });
  });

  it("loads published evidence without selecting or exposing the raw payload column", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const profile = fixtureProfile(measuredTarget);
    const preparedSql: string[] = [];
    const makeStmt = (sql: string): Record<string, unknown> => ({
      bind: () => makeStmt(sql),
      first: async () => {
        if (sql.includes("state IN ('published', 'superseded')")) {
          return {
            generation_id: "target-generation",
            state: "superseded",
            started_at: 1_000,
            published_at: 1_010,
            expected_rows: 1,
            published_rows: 1,
            dependency_snapshot_json: null,
          };
        }
        if (sql.includes("WHERE surface = ? AND state = 'published'")) {
          return {
            generation_id: "quote-generation",
            state: "published",
            started_at: 1_050,
            published_at: 1_060,
            expected_rows: 1,
            published_rows: 1,
            dependency_snapshot_json: JSON.stringify({ targetGenerationId: "target-generation" }),
          };
        }
        return null;
      },
      all: async () => {
        if (sql.includes("FROM dex_measured_execution_quotes")) {
          return {
            results: [
              {
                generation_id: "quote-generation",
                target_generation_id: "target-generation",
                target_id: measuredTarget.targetId,
                status: "measured",
                failure_reason: null,
                quote_profile_json: JSON.stringify(profile),
              },
            ],
          };
        }
        if (sql.includes("FROM dex_measured_execution_targets")) {
          return {
            results: [
              {
                generation_id: "target-generation",
                target_id: measuredTarget.targetId,
                target_json: JSON.stringify(measuredTarget),
              },
            ],
          };
        }
        return { results: [] };
      },
    });
    const db = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return makeStmt(sql);
      },
    } as unknown as D1Database;

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);

    expect(evidence?.quoteGenerationId).toBe("quote-generation");
    const quoteSelect = preparedSql.find((sql) => sql.includes("FROM dex_measured_execution_quotes"));
    expect(quoteSelect).toBeDefined();
    expect(quoteSelect).not.toContain("raw_quote_payload_json");
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);
    expect(entry?.status).toBe("measured");
    expect(entry?.profile).toBeTruthy();
    expect(entry).not.toHaveProperty("rawPayload");
  });
});

describe("measured execution generation prune", () => {
  it("deletes only terminal generations past the 3-day horizon in bounded oldest-first batches", async () => {
    const batched: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds }),
      }),
      batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
        batched.push(...stmts);
        return stmts.map(() => ({ meta: { changes: 0 } }));
      },
    } as unknown as D1Database;

    const nowSec = 1_700_000_000;
    await pruneDexMeasuredExecutionGenerations(db, nowSec);

    expect(batched).toHaveLength(3);
    const cutoff = nowSec - 3 * 24 * 60 * 60;
    const [quotes, targets, ledger] = batched;

    expect(quotes.sql).toContain("DELETE FROM dex_measured_execution_quotes");
    expect(quotes.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(quotes.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(quotes.binds).toEqual([
      "dex-measured-execution-quotes",
      "dex-solana-measured-execution-quotes",
      "dex-tron-measured-execution-quotes",
      cutoff,
      16,
    ]);

    expect(targets.sql).toContain("DELETE FROM dex_measured_execution_targets");
    expect(targets.sql).toContain("NOT IN (SELECT DISTINCT target_generation_id FROM dex_measured_execution_quotes)");
    expect(targets.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(targets.binds).toEqual([
      "dex-measured-execution-targets",
      "dex-solana-measured-execution-targets",
      "dex-tron-measured-execution-targets",
      cutoff,
      16,
    ]);

    expect(ledger.sql).toContain("DELETE FROM surface_publication_generations");
    expect(ledger.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(ledger.sql).toContain("q.target_generation_id = surface_publication_generations.generation_id");
    expect(ledger.sql).toContain("FROM dex_measured_execution_targets t");
    expect(ledger.binds).toEqual([
      "dex-measured-execution-targets",
      "dex-measured-execution-quotes",
      "dex-solana-measured-execution-targets",
      "dex-solana-measured-execution-quotes",
      "dex-tron-measured-execution-targets",
      "dex-tron-measured-execution-quotes",
      cutoff,
    ]);
  });
});
