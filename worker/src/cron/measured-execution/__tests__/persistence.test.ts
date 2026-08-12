import { describe, expect, it, vi } from "vitest";

import { buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import {
  buildSolanaMeasuredQuoteGenerationId,
  buildTronMeasuredQuoteGenerationId,
  DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE,
  getDexMeasuredHistoryFreshnessSec,
  isOperationalDexMeasuredFailure,
  loadLatestPublishedDexMeasuredQuoteEvidence,
  loadLatestPublishedSolanaMeasuredQuoteEvidence,
  materializeDexMeasuredQuoteProfile,
  publishDexMeasuredQuoteGeneration,
  publishDexMeasuredTargetInventory,
  publishSolanaMeasuredQuoteGeneration,
  publishSolanaMeasuredTargetInventory,
  publishTronMeasuredQuoteGeneration,
  publishTronMeasuredTargetInventory,
  pruneDexMeasuredExecutionGenerations,
} from "../persistence";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { buildSolanaMeasuredExecutionProfile } from "../solana-profiles";
import { buildSolanaMeasuredQuotePoint } from "../solana-quotes";

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

function fixtureProfile(
  target: DexMeasuredExecutionTarget,
  identity: { targetGenerationId?: string; quoteGenerationId?: string; quotedAt?: number } = {},
) {
  return buildDexMeasuredExecutionProfile({
    target,
    targetGenerationId: identity.targetGenerationId ?? "target-generation",
    quoteGenerationId: identity.quoteGenerationId ?? "quote-generation",
    quotedAt: identity.quotedAt ?? 1_060,
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

function solanaFixtureTarget(): SolanaMeasuredExecutionTarget {
  const input = {
    schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    stablecoinId: "usdc-circle",
    adapterProfileId: "orca-whirlpool-jupiter-v1" as const,
    protocol: "orca" as const,
    chain: "solana" as const,
    poolId: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    poolType: "orca-whirlpool" as const,
    tokenIn: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked" as const,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "Es9vMFrzaCERmJfrF4H2FYDgK5KJY8PYdG7yM7pTz1C",
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      referencePriceSource: "tracked" as const,
      trackedAssetId: "usdt-tether",
    },
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
  return {
    ...input,
    targetId: buildSolanaMeasuredExecutionTargetId({
      stablecoinId: input.stablecoinId,
      adapterProfileId: input.adapterProfileId,
      protocol: input.protocol,
      poolId: input.poolId,
      tokenInAddress: input.tokenIn.address,
      tokenOutAddress: input.tokenOut.address,
    }),
  };
}

function solanaFixtureProfile(
  target: SolanaMeasuredExecutionTarget,
  identity: { targetGenerationId: string; quoteGenerationId: string; quotedAt?: number },
) {
  const route = {
    provider: "jupiter-swap-api" as const,
    label: "Whirlpool" as const,
    poolId: target.poolId,
    inputMint: target.tokenIn.address,
    outputMint: target.tokenOut.address,
    inputAmount: "1000000000",
    outputAmount: "995000000",
    contextSlot: 1_005,
  };
  return buildSolanaMeasuredExecutionProfile({
    target,
    targetGenerationId: identity.targetGenerationId,
    quoteGenerationId: identity.quoteGenerationId,
    quotedAt: identity.quotedAt ?? 1_900,
    slotBefore: 1_000,
    slotAfter: 1_010,
    points: [
      buildSolanaMeasuredQuotePoint(target, route)!,
      buildSolanaMeasuredQuotePoint(target, {
        ...route,
        inputAmount: "100000000000",
        outputAmount: "98000000000",
        contextSlot: 1_006,
      })!,
    ],
  });
}

function solanaEvidenceDb(input: {
  target: SolanaMeasuredExecutionTarget;
  latestFailureReason: string;
  historical?: { profile?: ReturnType<typeof solanaFixtureProfile>; failureReason?: string };
}) {
  const makeStmt = (sql: string, _binds: unknown[] = []): Record<string, unknown> => ({
    bind: (...nextBinds: unknown[]) => makeStmt(sql, nextBinds),
    first: async () => {
      if (sql.includes("COUNT(*) AS row_count")) {
        return {
          row_count: 1,
          min_target_generation_id: "solana-targets-latest",
          max_target_generation_id: "solana-targets-latest",
        };
      }
      if (sql.includes("state IN ('published', 'superseded')")) {
        return {
          generation_id: "solana-targets-latest",
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
          generation_id: "solana-quotes-latest",
          state: "published",
          started_at: 2_000,
          published_at: 2_010,
          expected_rows: 1,
          published_rows: 1,
          dependency_snapshot_json: JSON.stringify({ targetGenerationId: "solana-targets-latest" }),
        };
      }
      return null;
    },
    all: async () => {
      if (sql.includes("SELECT history_generation.generation_id")) {
        return { results: input.historical ? [{ generation_id: "solana-quotes-lkg" }] : [] };
      }
      if (sql.includes("q.generation_id IN")) {
        const profile = input.historical?.profile ?? null;
        return {
          results: input.historical
            ? [{
                generation_id: profile?.quoteGenerationId ?? "solana-quotes-semantic",
                target_generation_id: profile?.targetGenerationId ?? "solana-targets-semantic",
                target_id: input.target.targetId,
                status: profile ? "measured" : "failed",
                failure_reason: profile ? null : input.historical.failureReason ?? "exact-route-mismatch",
                quote_profile_json: profile ? JSON.stringify(profile) : null,
                quote_published_at: 1_900,
                target_json: JSON.stringify(input.target),
              }]
            : [],
        };
      }
      if (sql.includes("JOIN dex_measured_execution_targets")) {
        return {
          results: [{
            generation_id: "solana-quotes-latest",
            target_generation_id: "solana-targets-latest",
            target_id: input.target.targetId,
            status: "failed",
            failure_reason: input.latestFailureReason,
            quote_profile_json: null,
            target_json: JSON.stringify(input.target),
          }],
        };
      }
      return { results: [] };
    },
  });
  return { db: { prepare: (sql: string) => makeStmt(sql) } as unknown as D1Database };
}

function evidenceDb(input: {
  target: DexMeasuredExecutionTarget;
  latest: {
    status: "measured" | "failed";
    failureReason: string | null;
    profile: ReturnType<typeof fixtureProfile> | null;
  };
  historical?: Array<{
    target: DexMeasuredExecutionTarget;
    profile?: ReturnType<typeof fixtureProfile> | null;
    status?: "measured" | "failed";
    failureReason?: string | null;
    generationId?: string;
    targetGenerationId?: string;
    publishedAt?: number;
  }>;
}) {
  const preparedSql: string[] = [];
  const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
    bind: (...nextBinds: unknown[]) => makeStmt(sql, nextBinds),
    first: async () => {
      if (sql.includes("COUNT(*) AS row_count")) {
        return {
          row_count: 1,
          min_target_generation_id: "target-generation-latest",
          max_target_generation_id: "target-generation-latest",
        };
      }
      if (sql.includes("state IN ('published', 'superseded')")) {
        return {
          generation_id: "target-generation-latest",
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
          generation_id: "quote-generation-latest",
          state: "published",
          started_at: 2_000,
          published_at: 2_010,
          expected_rows: 1,
          published_rows: 1,
          dependency_snapshot_json: JSON.stringify({ targetGenerationId: "target-generation-latest" }),
        };
      }
      return null;
    },
    all: async () => {
      if (sql.includes("SELECT history_generation.generation_id")) {
        return {
          results: (input.historical ?? []).length > 0
            ? [{ generation_id: "historical-generation" }]
            : [],
        };
      }
      if (sql.includes("SELECT DISTINCT target_id")) {
        return {
          results: [
            ...new Set((input.historical ?? []).map((entry) => entry.target.targetId)),
          ].map((target_id) => ({ target_id })),
        };
      }
      if (sql.includes("q.generation_id IN")) {
        const selectedTargetIds = new Set(JSON.parse(String(binds[2] ?? "[]")) as string[]);
        return {
          results: (input.historical ?? [])
            .filter((entry) => selectedTargetIds.has(entry.target.targetId))
            .map((entry, index) => {
              const profile = entry.profile ?? null;
              return {
                generation_id: entry.generationId ?? profile?.quoteGenerationId ?? `quote-generation-failed-${index}`,
                target_generation_id:
                  entry.targetGenerationId ?? profile?.targetGenerationId ?? `target-generation-failed-${index}`,
                target_id: entry.target.targetId,
                status: entry.status ?? "measured",
                failure_reason: entry.failureReason ?? null,
                quote_profile_json: profile ? JSON.stringify(profile) : null,
                quote_published_at: entry.publishedAt ?? 1_900 - index,
                target_json: JSON.stringify(entry.target),
              };
          }),
        };
      }
      if (sql.includes("JOIN dex_measured_execution_targets")) {
        return {
          results: [
            {
              generation_id: "quote-generation-latest",
              target_generation_id: "target-generation-latest",
              target_id: input.target.targetId,
              status: input.latest.status,
              failure_reason: input.latest.failureReason,
              quote_profile_json: input.latest.profile ? JSON.stringify(input.latest.profile) : null,
              target_json: JSON.stringify(input.target),
            },
          ],
        };
      }
      if (sql.includes("FROM dex_measured_execution_quotes")) {
        return {
          results: [
            {
              generation_id: "quote-generation-latest",
              target_generation_id: "target-generation-latest",
              target_id: input.target.targetId,
              status: input.latest.status,
              failure_reason: input.latest.failureReason,
              quote_profile_json: input.latest.profile ? JSON.stringify(input.latest.profile) : null,
            },
          ],
        };
      }
      if (sql.includes("FROM dex_measured_execution_targets")) {
        return {
          results: [
            {
              generation_id: "target-generation-latest",
              target_id: input.target.targetId,
              target_json: JSON.stringify(input.target),
            },
          ],
        };
      }
      return { results: [] };
    },
  });
  return {
    preparedSql,
    db: {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return makeStmt(sql);
      },
    } as unknown as D1Database,
  };
}

describe("measured execution publication", () => {
  it("retains a two-hour history window for every measured adapter", () => {
    expect(getDexMeasuredHistoryFreshnessSec("curve-stableswap-main-registry-get-dy-v1")).toBe(7_200);
    expect(getDexMeasuredHistoryFreshnessSec("curve-stableswap-ng-factory-get-dy-v2")).toBe(7_200);
    expect(getDexMeasuredHistoryFreshnessSec("uniswap-v3-quoter-v2")).toBe(7_200);
  });

  it("classifies StableSwap transport outages as operational but not semantic drift", () => {
    expect(isOperationalDexMeasuredFailure("rpc-failure")).toBe(true);
    expect(isOperationalDexMeasuredFailure("block-timestamp-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("runtime-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("registry-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("block-header-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("factory-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("runtime-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("registry-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("block-header-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("block-hash-invalid")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-code-hash-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-membership-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("runtime-code-hash-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("registry-membership-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("pool-revert")).toBe(false);
  });

  it("rejects an empty target generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredTargetInventory({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targets: [],
        capturedAt: 1_700_000_000,
      }),
    ).rejects.toThrow("empty DEX measured target generation");
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
    ).rejects.toThrow("empty DEX measured quote generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects empty native measured generations before touching shared storage", async () => {
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

  it("omits budget-deferred rows and records a complete sparse manifest", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const deferredTarget = fixtureTarget("base");
    const profile = fixtureProfile(measuredTarget);
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const batched: Array<{ sql: string; binds: unknown[] }> = [];
    const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
      sql,
      binds,
      bind: (...next: unknown[]) => {
        const statement = makeStmt(sql, next) as { sql: string; binds: unknown[] };
        prepared.push(statement);
        return statement;
      },
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => sql.includes("COUNT(*) AS count") ? { count: 1 } : null,
      all: async () => ({ results: [] }),
    });
    const db = {
      prepare: (sql: string) => {
        return makeStmt(sql);
      },
      batch: async (statements: Array<{ sql: string; binds: unknown[] }>) => {
        batched.push(...statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const result = await publishDexMeasuredQuoteGeneration({
      db,
      generationId: "quote-generation",
      targetGeneration: {
        generationId: "target-generation",
        targets: [measuredTarget, deferredTarget],
        publishedAt: 1_000,
      },
      outcomes: [
        { target: measuredTarget, status: "measured", profile },
        { target: deferredTarget, status: "failed", failureReason: "budget-deferred" },
      ],
      quotedAt: 1_060,
    });

    expect(result).toEqual({ generationId: "quote-generation", measuredCount: 1, failedCount: 1 });
    const candidate = prepared.find((statement) => statement.sql.includes("INSERT INTO surface_publication_generations"));
    expect(candidate?.binds[3]).toBe(1);
    const manifest = JSON.parse(String(candidate?.binds[5]));
    expect(manifest).toMatchObject({
      targetGenerationId: "target-generation",
      targetCount: 2,
      persistedOutcomeCount: 1,
      omittedBudgetDeferredCount: 1,
    });
    expect(manifest.targetIdsSha256).toMatch(/^[0-9a-f]{64}$/);
    const quoteInsert = batched.find((statement) => statement.sql.includes("INSERT INTO dex_measured_execution_quotes"));
    expect(quoteInsert?.binds).toHaveLength(14);
    expect(quoteInsert?.binds[2]).toBe(measuredTarget.targetId);
  });

  it("publishes an all-deferred generation without quote-row writes", async () => {
    const deferredTarget = fixtureTarget("base");
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
      sql,
      binds,
      bind: (...next: unknown[]) => {
        const statement = makeStmt(sql, next) as { sql: string; binds: unknown[] };
        prepared.push(statement);
        return statement;
      },
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => sql.includes("COUNT(*) AS count") ? { count: 0 } : null,
      all: async () => ({ results: [] }),
    });
    const batch = vi.fn(async (statements: D1PreparedStatement[]) =>
      statements.map(() => ({ meta: { changes: 1 } })),
    );
    const db = { prepare: (sql: string) => makeStmt(sql), batch } as unknown as D1Database;

    const result = await publishDexMeasuredQuoteGeneration({
      db,
      generationId: "all-deferred-generation",
      targetGeneration: {
        generationId: "target-generation",
        targets: [deferredTarget],
        publishedAt: 1_000,
      },
      outcomes: [{ target: deferredTarget, status: "failed", failureReason: "budget-deferred" }],
      quotedAt: 1_060,
    });

    expect(result).toEqual({ generationId: "all-deferred-generation", measuredCount: 0, failedCount: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(prepared.some((statement) => statement.sql.includes("INSERT INTO dex_measured_execution_quotes"))).toBe(false);
    const candidate = prepared.find((statement) => statement.sql.includes("INSERT INTO surface_publication_generations"));
    expect(candidate?.binds[3]).toBe(0);
    expect(JSON.parse(String(candidate?.binds[5]))).toMatchObject({
      targetCount: 1,
      persistedOutcomeCount: 0,
      omittedBudgetDeferredCount: 1,
    });
  });

  it("reconstructs only manifest-proven sparse deferrals and rejects a digest mismatch", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const deferredTarget = fixtureTarget("base");
    const profile = fixtureProfile(measuredTarget);
    const targets = [measuredTarget, deferredTarget].sort((left, right) => left.targetId.localeCompare(right.targetId));
    const targetIdsSha256 = [...new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(targets.map((target) => target.targetId))),
    ))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const buildDb = (manifestDigest = targetIdsSha256, includeMeasured = true) => {
      const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
        bind: (...next: unknown[]) => makeStmt(sql, next),
        first: async () => {
          if (sql.includes("COUNT(*) AS row_count")) {
            return includeMeasured
              ? { row_count: 1, min_target_generation_id: "target-generation", max_target_generation_id: "target-generation" }
              : { row_count: 0, min_target_generation_id: null, max_target_generation_id: null };
          }
          if (sql.includes("state IN ('published', 'superseded')")) {
            return { generation_id: "target-generation", state: "superseded", started_at: 1_000,
              published_at: 1_010, expected_rows: 2, published_rows: 2, dependency_snapshot_json: null };
          }
          if (sql.includes("WHERE surface = ? AND state = 'published'")) {
            return { generation_id: "quote-generation", state: "published", started_at: 1_050,
              published_at: 1_060, expected_rows: includeMeasured ? 1 : 0, published_rows: includeMeasured ? 1 : 0,
              dependency_snapshot_json: JSON.stringify({ targetGenerationId: "target-generation", targetCount: 2,
                persistedOutcomeCount: includeMeasured ? 1 : 0, omittedBudgetDeferredCount: includeMeasured ? 1 : 2,
                targetIdsSha256: manifestDigest }) };
          }
          return null;
        },
        all: async () => {
          if (sql.includes("JOIN dex_measured_execution_targets")) {
            const afterTargetId = String(binds[2]);
            return { results: targets.filter((target) => target.targetId > afterTargetId).map((target) =>
              includeMeasured && target.targetId === measuredTarget.targetId
                ? { generation_id: "quote-generation", target_generation_id: "target-generation",
                    target_id: target.targetId, status: "measured", failure_reason: null,
                    quote_profile_json: JSON.stringify(profile), target_json: JSON.stringify(target) }
                : { generation_id: null, target_generation_id: null, target_id: target.targetId,
                    status: null, failure_reason: null, quote_profile_json: null, target_json: JSON.stringify(target) }) };
          }
          if (sql.includes("SELECT history_generation.generation_id")) return { results: [] };
          return { results: [] };
        },
      });
      return { prepare: (sql: string) => makeStmt(sql) } as unknown as D1Database;
    };

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(buildDb());
    expect(evidence?.byTargetId.get(deferredTarget.targetId)).toMatchObject({
      status: "failed",
      failureReason: "budget-deferred",
      profile: null,
    });
    const allDeferredEvidence = await loadLatestPublishedDexMeasuredQuoteEvidence(
      buildDb(targetIdsSha256, false),
    );
    expect([...allDeferredEvidence!.byTargetId.values()]).toHaveLength(2);
    expect([...allDeferredEvidence!.byTargetId.values()].every(
      (entry) => entry.status === "failed" && entry.failureReason === "budget-deferred",
    )).toBe(true);
    await expect(loadLatestPublishedDexMeasuredQuoteEvidence(buildDb("0".repeat(64)))).rejects.toThrow("incomplete");
  });

  it("loads published evidence without selecting or exposing the raw payload column", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const profile = fixtureProfile(measuredTarget);
    const preparedSql: string[] = [];
    const makeStmt = (sql: string): Record<string, unknown> => ({
      bind: () => makeStmt(sql),
      first: async () => {
        if (sql.includes("COUNT(*) AS row_count")) {
          return {
            row_count: 1,
            min_target_generation_id: "target-generation",
            max_target_generation_id: "target-generation",
          };
        }
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
        if (sql.includes("SELECT history_generation.generation_id")) {
          return { results: [] };
        }
        if (sql.includes("JOIN dex_measured_execution_targets")) {
          return {
            results: [
              {
                generation_id: "quote-generation",
                target_generation_id: "target-generation",
                target_id: measuredTarget.targetId,
                status: "measured",
                failure_reason: null,
                quote_profile_json: JSON.stringify(profile),
                target_json: JSON.stringify(measuredTarget),
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
    const quoteSelect = preparedSql.find((sql) => sql.includes("JOIN dex_measured_execution_targets"));
    expect(quoteSelect).toBeDefined();
    expect(quoteSelect).not.toContain("raw_quote_payload_json");
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);
    expect(entry?.status).toBe("measured");
    expect(entry?.profile).toBeTruthy();
    expect(entry).not.toHaveProperty("rawPayload");
  });

  it("loads current target and profile JSON in bounded keyset pages", async () => {
    const targets = Array.from({ length: 65 }, (_, index) => fixtureTarget(`test-chain-${index}`)).sort((a, b) =>
      a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0,
    );
    const profiles = new Map(
      targets.map((target) => [
        target.targetId,
        fixtureProfile(target, {
          targetGenerationId: "target-generation",
          quoteGenerationId: "quote-generation",
        }),
      ]),
    );
    const preparedSql: string[] = [];
    const makeStmt = (sql: string, binds: unknown[] = []): Record<string, unknown> => ({
      bind: (...nextBinds: unknown[]) => makeStmt(sql, nextBinds),
      first: async () => {
        if (sql.includes("COUNT(*) AS row_count")) {
          return {
            row_count: targets.length,
            min_target_generation_id: "target-generation",
            max_target_generation_id: "target-generation",
          };
        }
        if (sql.includes("state IN ('published', 'superseded')")) {
          return {
            generation_id: "target-generation",
            state: "superseded",
            started_at: 1_000,
            published_at: 1_010,
            expected_rows: targets.length,
            published_rows: targets.length,
            dependency_snapshot_json: null,
          };
        }
        if (sql.includes("WHERE surface = ? AND state = 'published'")) {
          return {
            generation_id: "quote-generation",
            state: "published",
            started_at: 1_050,
            published_at: 1_060,
            expected_rows: targets.length,
            published_rows: targets.length,
            dependency_snapshot_json: JSON.stringify({ targetGenerationId: "target-generation" }),
          };
        }
        return null;
      },
      all: async () => {
        if (sql.includes("JOIN dex_measured_execution_targets")) {
          const afterTargetId = String(binds[2]);
          const pageSize = Number(binds[3]);
          return {
            results: targets
              .filter((target) => target.targetId > afterTargetId)
              .slice(0, pageSize)
              .map((target) => ({
                generation_id: "quote-generation",
                target_generation_id: "target-generation",
                target_id: target.targetId,
                status: "measured",
                failure_reason: null,
                quote_profile_json: JSON.stringify(profiles.get(target.targetId)),
                target_json: JSON.stringify(target),
              })),
          };
        }
        if (sql.includes("SELECT history_generation.generation_id")) {
          return { results: [] };
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

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      deferProfiles: true,
    });

    expect(evidence?.byTargetId.size).toBe(targets.length);
    expect([...evidence!.byTargetId.values()].every((entry) => entry.profile === null)).toBe(true);
    expect(
      [...evidence!.byTargetId.values()].every((entry) => typeof entry.deferredProfileJson === "string"),
    ).toBe(true);
    expect(materializeDexMeasuredQuoteProfile(evidence!.byTargetId.get(targets[0]!.targetId)!)).toEqual(
      profiles.get(targets[0]!.targetId),
    );
    expect(
      preparedSql.filter((sql) => sql.includes("JOIN dex_measured_execution_targets")),
    ).toHaveLength(Math.ceil(targets.length / DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE));
  });
});

describe("measured execution last-known-good selection", () => {
  it("uses a prior measured row when the latest outcome is an operational failure", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db, preparedSql } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "request-budget-exhausted",
        profile: null,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      deferProfiles: true,
    });
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "measured",
      failureReason: null,
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
      resolution: "last-known-good",
      latestFailureReason: "request-budget-exhausted",
    });
    expect(entry?.profile).toBeNull();
    expect(materializeDexMeasuredQuoteProfile(entry!)?.quotedAt).toBe(1_900);
    expect(materializeDexMeasuredQuoteProfile(entry!)?.quoteGenerationId).toBe("quote-generation-lkg");
    expect(entry?.observationHistory).toMatchObject({
      completeProducerCycleCount: 2,
      successfulObservationCount: 1,
      consecutiveSuccessCount: 0,
      latestOperationalFailureAt: 2_010,
    });
    const historicalSql = preparedSql.find((sql) => sql.includes("SELECT history_generation.generation_id"));
    expect(historicalSql).toContain("state = 'superseded'");
    expect(historicalSql).toContain("published_rows = history_generation.expected_rows");
    expect(historicalSql).toContain("SELECT COUNT(*)");
    const historicalRowsSql = preparedSql.find((sql) => sql.includes("q.generation_id IN"));
    expect(historicalRowsSql).not.toContain("q.status = 'measured'");
  });

  it("preserves mature conservative history across a latest operational failure", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const newerProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g2",
      quoteGenerationId: "quote-generation-g2",
      quotedAt: 1_900,
    });
    const olderProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g1",
      quoteGenerationId: "quote-generation-g1",
      quotedAt: 1_800,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "quoter-rpc-unavailable",
        profile: null,
      },
      historical: [
        { target: measuredTarget, profile: newerProfile },
        { target: measuredTarget, profile: olderProfile },
      ],
    });

    const entry = (await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      resolution: "last-known-good",
      quoteGenerationId: "quote-generation-g2",
      observationHistory: {
        completeProducerCycleCount: 3,
        successfulObservationCount: 2,
        consecutiveSuccessCount: 0,
        latestOperationalFailureAt: 2_010,
        conservativeStatistic: "pointwise-minimum",
      },
    });
  });

  it("does not mask a deterministic or semantic failure with older evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "failed",
      failureReason: "pool-revert",
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      resolution: "latest",
    });
    expect(entry?.profile).toBeNull();
  });

  it("does not search past a historical deterministic failure for LKG evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const olderProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g1",
      quoteGenerationId: "quote-generation-g1",
      quotedAt: 1_800,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "request-budget-exhausted",
        profile: null,
      },
      historical: [
        {
          target: measuredTarget,
          status: "failed",
          failureReason: "pool-revert",
          generationId: "quote-generation-g2",
          targetGenerationId: "target-generation-g2",
          publishedAt: 1_900,
        },
        { target: measuredTarget, profile: olderProfile, publishedAt: 1_800 },
      ],
    });

    const entry = (await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "failed",
      failureReason: "request-budget-exhausted",
      resolution: "latest",
      quoteGenerationId: "quote-generation-latest",
    });
    expect(entry?.profile).toBeNull();
    expect(entry?.observationHistory).toBeUndefined();
  });

  it("keeps a latest measured-zero profile instead of substituting older evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const latestProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-latest",
      quoteGenerationId: "quote-generation-latest",
      quotedAt: 2_000,
    });
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "measured",
        failureReason: null,
        profile: latestProfile,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "measured",
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      resolution: "latest",
      latestFailureReason: null,
    });
    expect(entry?.profile?.capacityCurve.every((point) => point.executableUsd === 0)).toBe(true);
    expect(
      entry?.observationHistory?.conservativeCapacityCurve.every((point) => point.executableUsd === 0),
    ).toBe(true);
  });

  it("exposes exact-identity historical evidence for a target absent from the latest quote generation", async () => {
    const latestTarget = fixtureTarget("ethereum");
    const historicalTarget = fixtureTarget("base");
    const historicalProfile = fixtureProfile(historicalTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: latestTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical: [{ target: historicalTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const latestEntry = evidence?.byTargetId.get(latestTarget.targetId);
    const historicalEntry = evidence?.byTargetId.get(historicalTarget.targetId);

    expect(latestEntry).toMatchObject({ status: "failed", failureReason: "pool-revert", resolution: "latest" });
    expect(historicalEntry).toMatchObject({
      status: "measured",
      resolution: "last-known-good",
      latestFailureReason: "quote-missing",
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
    });
  });

  it("loads and summarizes large historical target sets in bounded batches", async () => {
    const latestTarget = fixtureTarget("ethereum");
    const historical = Array.from({ length: 65 }, (_, index) => {
      const target = fixtureTarget(`history-${index}`);
      return {
        target,
        profile: fixtureProfile(target, {
          targetGenerationId: `target-generation-${index}`,
          quoteGenerationId: `quote-generation-${index}`,
          quotedAt: 1_900,
        }),
        publishedAt: 1_900,
      };
    });
    const { db, preparedSql } = evidenceDb({
      target: latestTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical,
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);

    expect(evidence?.byTargetId).toHaveLength(66);
    expect(preparedSql.filter((sql) => sql.includes("q.generation_id IN"))).toHaveLength(5);
    expect(evidence?.byTargetId.get(historical[64]!.target.targetId)).toMatchObject({
      status: "measured",
      resolution: "last-known-good",
      quoteGenerationId: "quote-generation-64",
    });
  });
});

describe("Solana measured execution last-known-good selection", () => {
  it("retains a fresh exact profile after a budget-deferred rotation row", async () => {
    const target = solanaFixtureTarget();
    const profile = solanaFixtureProfile(target, {
      targetGenerationId: "solana-targets-lkg",
      quoteGenerationId: "solana-quotes-lkg",
    });
    const { db } = solanaEvidenceDb({
      target,
      latestFailureReason: "budget-deferred",
      historical: { profile },
    });

    const entry = (await loadLatestPublishedSolanaMeasuredQuoteEvidence(db))?.byTargetId.get(target.targetId);

    expect(entry).toMatchObject({
      status: "measured",
      quoteGenerationId: "solana-quotes-lkg",
      targetGenerationId: "solana-targets-lkg",
      resolution: "last-known-good",
      latestFailureReason: "budget-deferred",
    });
  });

  it("does not mask a semantic latest failure with prior Solana evidence", async () => {
    const target = solanaFixtureTarget();
    const profile = solanaFixtureProfile(target, {
      targetGenerationId: "solana-targets-lkg",
      quoteGenerationId: "solana-quotes-lkg",
    });
    const { db } = solanaEvidenceDb({
      target,
      latestFailureReason: "exact-route-mismatch",
      historical: { profile },
    });

    const entry = (await loadLatestPublishedSolanaMeasuredQuoteEvidence(db))?.byTargetId.get(target.targetId);

    expect(entry).toMatchObject({
      status: "failed",
      failureReason: "exact-route-mismatch",
      resolution: "latest",
      quoteGenerationId: "solana-quotes-latest",
    });
  });
});

describe("measured execution generation prune", () => {
  it("deletes only terminal generations before the 3-hour cutoff in bounded oldest-first batches", async () => {
    const executed: Array<{ kind: "run" | "first"; sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            executed.push({ kind: "run", sql, binds });
            return {
              meta: {
                changes: sql.includes("DELETE FROM dex_measured_execution_quotes") ? 12 : 2,
              },
            };
          },
          first: async () => {
            executed.push({ kind: "first", sql, binds });
            return { oldest_remaining_at: 1_699_990_000 };
          },
        }),
      }),
    } as unknown as D1Database;

    const nowSec = 1_700_000_000;
    const retention = await pruneDexMeasuredExecutionGenerations(db, nowSec);

    expect(executed).toHaveLength(4);
    const cutoff = nowSec - 3 * 60 * 60;
    const [quotes, targets, ledger, oldest] = executed;

    expect(quotes.sql).toContain("DELETE FROM dex_measured_execution_quotes");
    expect(quotes.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(quotes.sql).toContain("started_at < ?");
    expect(quotes.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(quotes.binds).toEqual([
      "dex-measured-execution-quotes",
      "dex-shadow-measured-execution-quotes",
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
      "dex-shadow-measured-execution-targets",
      "dex-solana-measured-execution-targets",
      "dex-tron-measured-execution-targets",
      cutoff,
      16,
    ]);

    expect(ledger.sql).toContain("DELETE FROM surface_publication_generations");
    expect(ledger.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(ledger.sql).toContain("q.target_generation_id = candidate.generation_id");
    expect(ledger.sql).toContain("FROM dex_measured_execution_targets t");
    expect(ledger.sql).toContain("ORDER BY candidate.started_at ASC");
    expect(ledger.sql).toContain("LIMIT ?");
    expect(ledger.binds).toEqual([
      "dex-measured-execution-targets",
      "dex-measured-execution-quotes",
      "dex-shadow-measured-execution-targets",
      "dex-shadow-measured-execution-quotes",
      "dex-solana-measured-execution-targets",
      "dex-solana-measured-execution-quotes",
      "dex-tron-measured-execution-targets",
      "dex-tron-measured-execution-quotes",
      cutoff,
      16,
    ]);
    expect(oldest.kind).toBe("first");
    expect(retention).toMatchObject({
      cutoff,
      deletedQuoteRows: 12,
      deletedTargetRows: 2,
      deletedGenerationRows: 2,
      deletedRows: 16,
      oldestRemainingAt: 1_699_990_000,
      error: null,
    });
  });

  it("reports cleanup errors without throwing after publication", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("retention unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    const retention = await pruneDexMeasuredExecutionGenerations(db, 1_700_000_000);

    expect(retention.deletedRows).toBe(0);
    expect(retention.error).toBe("retention unavailable");
  });
});
