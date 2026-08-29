import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

const alchemyMockHelpers = vi.hoisted(() => ({
  makeAlchemyContext: (txHash: string) => ({
    tx: {
      hash: txHash,
      to: "0xrouter",
      input: "0x96f4e9f9",
    },
    receipt: {
      transactionHash: txHash,
      to: "0xrouter",
      logs: [],
    },
  }),
}));

vi.mock("../alchemy-logs", () => ({
  getAlchemyTransactionContextBatchMany: vi.fn(async (_url: string, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, alchemyMockHelpers.makeAlchemyContext(txHash)])),
  ),
}));

vi.mock("../mint-burn-bridge-classifier", () => ({
  classifyBridgeAwareBurnRows: vi.fn((rows: Array<{ direction: string; tx_hash: string; burn_type: string | null; burn_review_reason: string | null }>) => {
    for (const row of rows) {
      if (row.direction !== "burn") continue;
      if (row.tx_hash.includes("bridge")) {
        row.burn_type = "bridge_burn";
        row.burn_review_reason = null;
      } else if (row.tx_hash.includes("review")) {
        row.burn_type = "review_required";
        row.burn_review_reason = "test-review";
      } else {
        row.burn_type = "effective_burn";
        row.burn_review_reason = null;
      }
    }
  }),
}));

import { getAlchemyTransactionContextBatchMany } from "../alchemy-logs";
import { classifyBridgeAwareBurnRows } from "../mint-burn-bridge-classifier";
import { batchExecute } from "../db";
import { classifyBridgeBurnRows } from "../mint-burn-pipeline/classification";
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import {
  collectAffectedHours,
  insertMintBurnRows,
  persistMintBurnRows,
  recalcAffectedHours,
  rebuildHourlyForStablecoinIds,
  updateEventClassifications,
} from "../mint-burn-pipeline/persistence";
import {
  readMintBurnSyncStateBatch,
  upsertMintBurnSyncState,
} from "../mint-burn-pipeline/sync-state";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import type { AlchemyLogEntry } from "../alchemy-logs";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn";

function makeDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
}

type HourlyRow = {
  stablecoin_id: string;
  chain_id: string;
  hour_ts: number;
  mint_count: number;
  burn_count: number;
  mint_volume_usd: number;
  burn_volume_usd: number;
  net_flow_usd: number;
};

function makeAggregationDb(): D1Database & { hourlyRows: Map<string, HourlyRow>; events: MintBurnRow[] } {
  const events: MintBurnRow[] = [];
  const hourlyRows = new Map<string, HourlyRow>();

  return {
    events,
    hourlyRows,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT OR IGNORE INTO mint_burn_events")) {
            const row: MintBurnRow = {
              id: args[0] as string,
              stablecoin_id: args[1] as string,
              symbol: args[2] as string,
              chain_id: args[3] as string,
              direction: args[4] as MintBurnRow["direction"],
              amount: args[5] as number,
              amount_usd: args[6] as number | null,
              price_used: args[7] as number | null,
              price_timestamp: args[8] as number | null,
              price_source: args[9] as string | null,
              burn_type: args[10] as MintBurnRow["burn_type"],
              burn_review_reason: args[11] as string | null,
              counterparty: args[12] as string | null,
              tx_hash: args[13] as string,
              block_number: args[14] as number,
              timestamp: args[15] as number,
              explorer_tx_url: args[16] as string,
              flow_type: args[17] as MintBurnRow["flow_type"],
            };
            events.push(row);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("UPDATE mint_burn_events")) {
            const [burnType, burnReviewReason, id] = args as [
              MintBurnRow["burn_type"],
              string | null,
              string,
            ];
            const existing = events.find((row) => row.id === id);
            if (existing) {
              existing.burn_type = burnType;
              existing.burn_review_reason = burnReviewReason;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }

          if (sql.includes("DELETE FROM mint_burn_hourly")) {
            if (args.length === 1) {
              const [stablecoinId] = args as [string];
              for (const key of [...hourlyRows.keys()]) {
                if (key.startsWith(`${stablecoinId}-`)) {
                  hourlyRows.delete(key);
                }
              }
              return { success: true, meta: { changes: 1 } };
            }

            const [stablecoinId, chainId, hourTs] = args as [string, string, number];
            hourlyRows.delete(`${stablecoinId}-${chainId}-${hourTs}`);
            return { success: true, meta: { changes: 1 } };
          }

          if (sql.includes("INSERT OR REPLACE INTO mint_burn_hourly")) {
            if (args.length === 1) {
              const [stablecoinId] = args as [string];
              const grouped = new Map<string, MintBurnRow[]>();
              for (const row of events.filter((event) => event.stablecoin_id === stablecoinId)) {
                const hourTs = Math.floor(row.timestamp / 3600) * 3600;
                grouped.set(`${row.chain_id}-${hourTs}`, [...(grouped.get(`${row.chain_id}-${hourTs}`) ?? []), row]);
              }

              for (const [groupKey, relevant] of grouped) {
                const [chainId, hourTsRaw] = groupKey.split("-");
                const hourTs = Number(hourTsRaw);
                hourlyRows.set(`${stablecoinId}-${chainId}-${hourTs}`, {
                  stablecoin_id: stablecoinId,
                  chain_id: chainId!,
                  hour_ts: hourTs,
                  mint_count: relevant.filter((row) => row.direction === "mint" && row.flow_type === "standard").length,
                  burn_count: relevant.filter((row) =>
                    row.direction === "burn" &&
                    (row.burn_type ?? "effective_burn") === "effective_burn" &&
                    row.flow_type === "standard",
                  ).length,
                  mint_volume_usd: relevant.reduce((sum, row) =>
                    row.direction === "mint" && row.flow_type === "standard"
                      ? sum + (row.amount_usd ?? 0)
                      : sum,
                  0),
                  burn_volume_usd: relevant.reduce((sum, row) =>
                    row.direction === "burn" &&
                    (row.burn_type ?? "effective_burn") === "effective_burn" &&
                    row.flow_type === "standard"
                      ? sum + (row.amount_usd ?? 0)
                      : sum,
                  0),
                  net_flow_usd: relevant.reduce((sum, row) => {
                    if (row.flow_type !== "standard") return sum;
                    if (row.direction === "mint") return sum + (row.amount_usd ?? 0);
                    if (row.direction === "burn" && (row.burn_type ?? "effective_burn") === "effective_burn") {
                      return sum - (row.amount_usd ?? 0);
                    }
                    return sum;
                  }, 0),
                });
              }

              return { success: true, meta: { changes: grouped.size } };
            }

            const [stablecoinId, chainId, startTs, endTs] = args as [string, string, number, number];
            const relevant = events.filter((row) =>
              row.stablecoin_id === stablecoinId &&
              row.chain_id === chainId &&
              row.timestamp >= startTs &&
              row.timestamp < endTs,
            );

            if (relevant.length === 0) {
              return { success: true, meta: { changes: 0 } };
            }

            hourlyRows.set(`${stablecoinId}-${chainId}-${startTs}`, {
              stablecoin_id: stablecoinId,
              chain_id: chainId,
              hour_ts: startTs,
              mint_count: relevant.filter((row) => row.direction === "mint" && row.flow_type === "standard").length,
              burn_count: relevant.filter((row) =>
                row.direction === "burn" &&
                row.burn_type === "effective_burn" &&
                row.flow_type === "standard",
              ).length,
              mint_volume_usd: relevant.reduce((sum, row) =>
                row.direction === "mint" && row.flow_type === "standard"
                  ? sum + (row.amount_usd ?? 0)
                  : sum,
              0),
              burn_volume_usd: relevant.reduce((sum, row) =>
                row.direction === "burn" &&
                row.burn_type === "effective_burn" &&
                row.flow_type === "standard"
                  ? sum + (row.amount_usd ?? 0)
                  : sum,
              0),
              net_flow_usd: relevant.reduce((sum, row) => {
                if (row.flow_type !== "standard") return sum;
                if (row.direction === "mint") return sum + (row.amount_usd ?? 0);
                if (row.direction === "burn" && row.burn_type === "effective_burn") {
                  return sum - (row.amount_usd ?? 0);
                }
                return sum;
              }, 0),
            });
            return { success: true, meta: { changes: 1 } };
          }

          return { success: true, meta: {} };
        },
      }),
    }),
  } as unknown as D1Database & { hourlyRows: Map<string, HourlyRow>; events: MintBurnRow[] };
}

function makeRow(overrides?: Partial<MintBurnRow>): MintBurnRow {
  return {
    id: overrides?.id ?? "id-1",
    stablecoin_id: overrides?.stablecoin_id ?? "usdt-tether",
    symbol: overrides?.symbol ?? "USDT",
    chain_id: overrides?.chain_id ?? "ethereum",
    direction: overrides?.direction ?? "mint",
    amount: overrides?.amount ?? 100,
    amount_usd: overrides?.amount_usd ?? 100,
    price_used: overrides?.price_used ?? 1,
    price_timestamp: overrides?.price_timestamp ?? 1_700_000_000,
    price_source: overrides?.price_source ?? "price-cache-current",
    burn_type: overrides?.burn_type ?? null,
    burn_review_reason: overrides?.burn_review_reason ?? null,
    flow_type: overrides?.flow_type ?? "standard",
    counterparty: overrides?.counterparty ?? null,
    tx_hash: overrides?.tx_hash ?? "0xtx-1",
    block_number: overrides?.block_number ?? 22_000_000,
    timestamp: overrides?.timestamp ?? 1_718_650_752,
    explorer_tx_url: overrides?.explorer_tx_url ?? "https://etherscan.io/tx/0xtx-1",
  };
}

describe("mint-burn shared pipeline modules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tracks inserted vs ignored rows in insertMintBurnRows", async () => {
    const db = makeDb();
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

    const result = await insertMintBurnRows(db, [makeRow({ id: "id-1" }), makeRow({ id: "id-2" })]);

    expect(result.inserted).toBe(1);
    expect(result.ignored).toBe(1);
  });

  it("skips affected-hour aggregation work when persistence is a pure no-op", async () => {
    const db = makeDb();
    vi.mocked(batchExecute).mockReset();
    vi.mocked(batchExecute)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
    const result = await persistMintBurnRows(
      db,
      [makeRow({ id: "id-1", direction: "mint", flow_type: "standard" })],
      affectedHours,
    );

    expect(result.inserted).toBe(0);
    expect(result.flowTypeChanges).toBe(0);
    expect(result.burnTypeChanges).toBe(0);
    expect(affectedHours.size).toBe(0);
  });

  it("tracks affected hours when inserts land even if the batch includes duplicates", async () => {
    const db = makeDb();
    vi.mocked(batchExecute).mockReset();
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

    const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
    const result = await persistMintBurnRows(
      db,
      [
        makeRow({ id: "id-1", direction: "mint", timestamp: 3_605, flow_type: "standard" }),
        makeRow({ id: "id-2", direction: "mint", timestamp: 7_205, flow_type: "standard" }),
      ],
      affectedHours,
    );

    expect(result.inserted).toBe(1);
    expect(affectedHours.size).toBe(2);
  });

  it("chunks event inserts below the D1 bind-variable ceiling", async () => {
    const db = makeDb();

    await insertMintBurnRows(
      db,
      Array.from({ length: 56 }, (_, index) => makeRow({ id: `id-${index + 1}`, tx_hash: `0xtx-${index + 1}` })),
    );

    expect(vi.mocked(batchExecute)).toHaveBeenCalledWith(db, expect.any(Array), {
      chunkSize: 50,
      signal: undefined,
    });
  });

  it("passes abort signals into mint/burn insert batches", async () => {
    const db = makeDb();
    const controller = new AbortController();

    await insertMintBurnRows(db, [makeRow({ id: "id-1" })], { signal: controller.signal });

    expect(vi.mocked(batchExecute)).toHaveBeenCalledWith(db, expect.any(Array), {
      chunkSize: 50,
      signal: controller.signal,
    });
  });

  it("does not start mint/burn insert batches after cancellation", async () => {
    const db = makeDb();
    const controller = new AbortController();
    controller.abort(new Error("stop mint/burn persistence"));

    await expect(insertMintBurnRows(db, [makeRow({ id: "id-1" })], { signal: controller.signal })).rejects.toThrow(
      "stop mint/burn persistence",
    );

    expect(vi.mocked(batchExecute)).not.toHaveBeenCalled();
  });

  it("returns bridge/review/effective burn counters", async () => {
    const db = makeDb();
    const rows: MintBurnRow[] = [
      makeRow({ id: "mint-1", direction: "mint", tx_hash: "0xmint" }),
      makeRow({ id: "burn-bridge", direction: "burn", tx_hash: "0xbridge" }),
      makeRow({ id: "burn-review", direction: "burn", tx_hash: "0xreview" }),
      makeRow({ id: "burn-effective", direction: "burn", tx_hash: "0xeffective" }),
    ];

    const counters = await classifyBridgeBurnRows(
      rows,
      makeMintBurnConfig({
        asset: { contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
        adapter: "transfer-zero-address",
        bridgeDetection: {
          protocol: "ccip",
          knownBridgePoolAddresses: ["0xpool"],
          knownBridgeRouterAddresses: ["0xrouter"],
          bridgeSignalTopics: ["0xtopic"],
          bridgeSignalSelectors: ["0x96f4e9f9"],
        },
      }),
      "https://eth-mainnet.g.alchemy.com/v2/",
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters).toEqual({
      effectiveBurns: 1,
      bridgeBurns: 1,
      reviewBurns: 1,
      txContextShortfalls: 0,
      deferredTxHashes: [],
    });
    expect(vi.mocked(getAlchemyTransactionContextBatchMany)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(classifyBridgeAwareBurnRows)).toHaveBeenCalledTimes(1);
    expect(db).toBeDefined();
  });

  it("fetches tx contexts with bounded concurrency", async () => {
    let inflight = 0;
    let peak = 0;
    vi.mocked(getAlchemyTransactionContextBatchMany).mockImplementation(async (_url: string, txHashes: string[]) => {
      inflight++;
      peak = Math.max(peak, inflight);
      // Yield across two microtask ticks so the scheduler can start more workers
      // up to the concurrency limit before any of them complete.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      inflight--;
      return new Map(txHashes.map((txHash) => [txHash, alchemyMockHelpers.makeAlchemyContext(txHash)]));
    });

    const rows: MintBurnRow[] = Array.from({ length: 80 }, (_, index) =>
      makeRow({ id: `burn-${index}`, direction: "burn", tx_hash: `0xtx-${index}` }),
    );

    await classifyBridgeBurnRows(
      rows,
      makeMintBurnConfig({
        asset: { contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
        adapter: "transfer-zero-address",
        bridgeDetection: {
          protocol: "ccip",
          knownBridgePoolAddresses: ["0xpool"],
          knownBridgeRouterAddresses: ["0xrouter"],
          bridgeSignalTopics: ["0xtopic"],
          bridgeSignalSelectors: ["0x96f4e9f9"],
        },
      }),
      "https://eth-mainnet.g.alchemy.com/v2/",
      { count: 0, limit: 200 },
      new Map(),
    );

    // Four 20-tx batches, bounded by TX_CONTEXT_BATCH_CONCURRENCY in classification.ts.
    expect(peak).toBe(3);
    expect(vi.mocked(getAlchemyTransactionContextBatchMany)).toHaveBeenCalledTimes(4);
  });

  it("reports tx-context shortfalls without fabricating classifications for deferred rows", async () => {
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValue(new Map());

    const rows: MintBurnRow[] = [
      makeRow({ id: "mint-bridge", direction: "mint", tx_hash: "0xbridge-mint" }),
      makeRow({ id: "burn-bridge", direction: "burn", tx_hash: "0xbridge-burn" }),
    ];

    const counters = await classifyBridgeBurnRows(
      rows,
      makeMintBurnConfig({
        asset: { contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
        adapter: "transfer-zero-address",
        bridgeDetection: {
          protocol: "ccip",
          knownBridgePoolAddresses: ["0xpool"],
          knownBridgeRouterAddresses: ["0xrouter"],
          bridgeSignalTopics: ["0xtopic"],
          bridgeSignalSelectors: ["0x96f4e9f9"],
        },
      }),
      "https://eth-mainnet.g.alchemy.com/v2/",
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters.txContextShortfalls).toBe(2);
    expect(counters.deferredTxHashes).toEqual(["0xbridge-mint", "0xbridge-burn"]);
    expect(counters.effectiveBurns).toBe(0);
    expect(counters.bridgeBurns).toBe(0);
    expect(counters.reviewBurns).toBe(0);
    expect(rows).toMatchObject([
      { id: "mint-bridge", flow_type: "standard", burn_type: null, burn_review_reason: null },
      { id: "burn-bridge", flow_type: "standard", burn_type: "bridge_burn", burn_review_reason: null },
    ]);
    expect(vi.mocked(classifyBridgeAwareBurnRows)).toHaveBeenCalledTimes(1);
  });

  it("recomputes only affected hourly buckets", async () => {
    const db = makeDb();
    const rows = [
      makeRow({ id: "id-1", direction: "mint", timestamp: 3_605 }),
      makeRow({ id: "id-2", direction: "burn", timestamp: 3_610 }),
      makeRow({ id: "id-3", direction: "mint", timestamp: 7_205 }),
    ];

    const affected = collectAffectedHours(rows);
    expect(affected.size).toBe(2);

    await recalcAffectedHours(db, affected);
    // Interleaved: 2 hours × 2 stmts (delete + insert) = 4 statements in one call
    expect(vi.mocked(batchExecute)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0]?.[1]).toHaveLength(4);
  });

  it("rebuilds hourly buckets for whole coins after valuation repair", async () => {
    const db = makeAggregationDb();
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => {
      for (const stmt of stmts) {
        await stmt.run();
      }
      return stmts.length;
    });

    const rows = [
      makeRow({
        id: "mint-1",
        stablecoin_id: "usdt-tether",
        chain_id: "ethereum",
        direction: "mint",
        amount_usd: 100,
        timestamp: 3_605,
        tx_hash: "0xmint-1",
      }),
      makeRow({
        id: "burn-1",
        stablecoin_id: "usdt-tether",
        chain_id: "ethereum",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 20,
        timestamp: 3_610,
        tx_hash: "0xburn-1",
      }),
      makeRow({
        id: "mint-2",
        stablecoin_id: "usdc-circle",
        symbol: "USDC",
        chain_id: "ethereum",
        direction: "mint",
        amount_usd: 55,
        timestamp: 7_205,
        tx_hash: "0xmint-2",
      }),
    ];

    await insertMintBurnRows(db, rows);
    await rebuildHourlyForStablecoinIds(db, ["usdt-tether", "usdc-circle"]);

    const usdtHourTs = Math.floor(rows[0]!.timestamp / 3600) * 3600;
    const usdcHourTs = Math.floor(rows[2]!.timestamp / 3600) * 3600;
    const usdtHour = db.hourlyRows.get(`usdt-tether-ethereum-${usdtHourTs}`);
    expect(usdtHour?.mint_count).toBe(1);
    expect(usdtHour?.burn_count).toBe(1);
    expect(usdtHour?.net_flow_usd).toBe(80);

    const usdcHour = db.hourlyRows.get(`usdc-circle-ethereum-${usdcHourTs}`);
    expect(usdcHour?.mint_count).toBe(1);
    expect(usdcHour?.burn_count).toBe(0);
    expect(usdcHour?.net_flow_usd).toBe(55);
  });

  it("excludes atomic roundtrip rows from hourly aggregation", async () => {
    const db = makeAggregationDb();
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => {
      for (const stmt of stmts) {
        await stmt.run();
      }
      return stmts.length;
    });

    const rows = [
      makeRow({ id: "mint-standard", direction: "mint", amount_usd: 100, timestamp: 3_605, tx_hash: "0xmint-standard" }),
      makeRow({
        id: "burn-standard",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 25,
        timestamp: 3_610,
        tx_hash: "0xburn-standard",
      }),
      makeRow({
        id: "mint-roundtrip",
        direction: "mint",
        amount_usd: 999,
        timestamp: 3_615,
        tx_hash: "0xroundtrip",
        flow_type: "atomic_roundtrip",
      }),
      makeRow({
        id: "burn-roundtrip",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 777,
        timestamp: 3_620,
        tx_hash: "0xroundtrip",
        flow_type: "atomic_roundtrip",
      }),
    ];

    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));

    expect(db.hourlyRows.get("usdt-tether-ethereum-3600")).toEqual({
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      hour_ts: 3600,
      mint_count: 1,
      burn_count: 1,
      mint_volume_usd: 100,
      burn_volume_usd: 25,
      net_flow_usd: 75,
    });
  });

  it("excludes bridge-transfer rows from hourly aggregation", async () => {
    const db = makeAggregationDb();
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => {
      for (const stmt of stmts) {
        await stmt.run();
      }
      return stmts.length;
    });

    const rows = [
      makeRow({ id: "mint-standard", direction: "mint", amount_usd: 100, timestamp: 3_605, tx_hash: "0xmint-standard" }),
      makeRow({
        id: "burn-standard",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 25,
        timestamp: 3_610,
        tx_hash: "0xburn-standard",
      }),
      makeRow({
        id: "mint-bridge",
        direction: "mint",
        amount_usd: 999,
        timestamp: 3_615,
        tx_hash: "0xbridge-mint",
        flow_type: "bridge_transfer",
      }),
      makeRow({
        id: "burn-bridge",
        direction: "burn",
        burn_type: "bridge_burn",
        amount_usd: 777,
        timestamp: 3_620,
        tx_hash: "0xbridge-burn",
        flow_type: "bridge_transfer",
      }),
    ];

    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));

    expect(db.hourlyRows.get("usdt-tether-ethereum-3600")).toEqual({
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      hour_ts: 3600,
      mint_count: 1,
      burn_count: 1,
      mint_volume_usd: 100,
      burn_volume_usd: 25,
      net_flow_usd: 75,
    });
  });

  it("removes stale hourly rows when an affected bucket has no rows left after recompute", async () => {
    const db = makeAggregationDb();
    vi.mocked(batchExecute).mockImplementation(async (_db, stmts) => {
      for (const stmt of stmts) {
        await stmt.run();
      }
      return stmts.length;
    });

    const burnRow = makeRow({
      id: "burn-effective",
      direction: "burn",
      burn_type: "effective_burn",
      amount_usd: 125,
      timestamp: 3_610,
    });

    await insertMintBurnRows(db, [burnRow]);
    await recalcAffectedHours(db, collectAffectedHours([burnRow]));
    expect(db.hourlyRows.get("usdt-tether-ethereum-3600")).toEqual({
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      hour_ts: 3600,
      mint_count: 0,
      burn_count: 1,
      mint_volume_usd: 0,
      burn_volume_usd: 125,
      net_flow_usd: -125,
    });

    db.events.length = 0;
    await recalcAffectedHours(db, collectAffectedHours([burnRow]));

    expect(db.hourlyRows.has("usdt-tether-ethereum-3600")).toBe(false);
  });

  it("updates classification rows for burns and non-standard mints", async () => {
    const db = makeDb();
    // Single batchExecute call: 3 rows (2 burns + 1 non-standard mint).
    // The standard-flow mint row is filtered out (no classification change needed).
    vi.mocked(batchExecute).mockResolvedValueOnce(3);

    const rows = [
      makeRow({ id: "mint-1", direction: "mint" }),
      makeRow({ id: "mint-bridge", direction: "mint", flow_type: "bridge_transfer" }),
      makeRow({ id: "burn-1", direction: "burn", burn_type: "effective_burn" }),
      makeRow({ id: "burn-2", direction: "burn", burn_type: "bridge_burn" }),
    ];

    const { flowTypeChanges, burnTypeChanges, rowsUpdated } = await updateEventClassifications(db, rows);
    expect(burnTypeChanges).toBe(2);
    expect(flowTypeChanges).toBe(1);
    expect(rowsUpdated).toBe(3);
    expect(vi.mocked(batchExecute)).toHaveBeenCalledTimes(1);
    const [[, stmts]] = vi.mocked(batchExecute).mock.calls;
    expect(stmts).toHaveLength(3);
  });

  it("uses monotonic sync-state upsert mode for backfill semantics", async () => {
    const prepareCalls: string[] = [];
    const bindArgs: unknown[][] = [];
    const db = {
      prepare: (sql: string) => {
        prepareCalls.push(sql);
        return {
          bind: (...args: unknown[]) => {
            bindArgs.push(args);
            return {
              run: async () => ({ success: true, meta: {} }),
            };
          },
        };
      },
    } as unknown as D1Database;

    await upsertMintBurnSyncState(db, "ethereum-0xabc", 123, "replace");
    await upsertMintBurnSyncState(db, "ethereum-0xabc", 456, "monotonic-max");

    expect(prepareCalls[0]).toContain("last_block = excluded.last_block");
    expect(prepareCalls[1]).toContain("CASE");
    expect(bindArgs).toEqual([
      ["ethereum-0xabc", 123],
      ["ethereum-0xabc", 456],
    ]);
  });

  it("reads sync state in chunked IN-clause queries instead of one select per config", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          all: async <T>() => {
            history.push({ sql, binds });
            return {
              results: [{
                config_key: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                last_block: 22_345_678,
              }] as T[],
              success: true,
              meta: {},
            };
          },
        }),
      }),
    } as unknown as D1Database;

    const makeConfig = (stablecoinId: string, symbol: string, contractAddress: string) => ({
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm" as const,
      },
      stablecoinId,
      symbol,
      contractAddress,
      decimals: 6,
      dustThreshold: 10_000,
      startBlock: 21_900_000,
      adapterKind: "transfer-zero-address" as const,
      startBlockSource: "reviewed-contract-specific" as const,
      startBlockConfidence: "high" as const,
      events: [],
    });

    const configs = [
      makeConfig("usdc-circle", "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
      ...Array.from({ length: 99 }, (_, index) =>
        makeConfig(
          `synthetic-${index + 1}`,
          `S${index + 1}`,
          `0x${(index + 1).toString(16).padStart(40, "0")}`,
        )
      ),
      makeConfig("usdt-tether", "USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7"),
    ];

    const results = await readMintBurnSyncStateBatch(db, configs);

    expect(history).toHaveLength(2);
    expect(history[0]?.sql).toContain("WHERE config_key IN");
    expect(history[0]?.binds).toHaveLength(90);
    expect(history[1]?.binds).toHaveLength(11);
    expect(history[0]?.binds?.[0]).toBe("ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(history.flatMap((entry) => entry.binds)).not.toContain(
      "usdc-circle:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    expect(history[1]?.binds?.[history[1].binds.length - 1]).toBe(
      "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
    );
    expect(results.get("ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(22_345_678);
    expect(results.get("ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe(21_899_999);
  });
});

// Fake topic hash: parseMintBurnLogs does not validate log.topics[0] against
// eventDef.topicHash (topic filtering happens upstream in the fetch layer), so the
// value is inert for this test. Using a visibly-fake placeholder to avoid seeding
// a wrong-but-real-looking constant.
const FAKE_TOPIC = "0x" + "0".repeat(64);
const USER_DATA = "000000000000000000000000aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
const TOKEN_DATA = "000000000000000000000000bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
const AMOUNT_DATA = "0000000000000000000000000000000000000000000000000de0b6b3a7640000"; // 1e18

describe("parseMintBurnLogs — custom counterparty encoding", () => {
  it("extracts counterparty from data slot when counterpartyEncoding is set", () => {
    const config: MintBurnContractConfig = {
      chain: { chainId: "ethereum", explorerUrl: "https://etherscan.io" } as MintBurnContractConfig["chain"],
      stablecoinId: "test",
      symbol: "TEST",
      contractAddress: "0xc0",
      decimals: 18,
      dustThreshold: 0,
      startBlock: 1,
      events: [],
      adapterKind: "custom-events",
      startBlockSource: "test-fixture",
      startBlockConfidence: "high",
    };
    const eventDef: MintBurnEventDef = {
      signature: "Deposited(address,address,uint256)",
      topicHash: FAKE_TOPIC,
      direction: "mint",
      amountEncoding: "nth-data-uint256",
      dataSlot: 2,
      counterpartyEncoding: { source: "data", slot: 0 },
    };
    const logs: AlchemyLogEntry[] = [{
      address: "0xc0",
      topics: [FAKE_TOPIC],
      data: "0x" + USER_DATA + TOKEN_DATA + AMOUNT_DATA,
      blockNumber: "0x64",
      transactionHash: "0xtx",
      logIndex: "0x0",
      blockHash: "0xhash",
      transactionIndex: "0x0",
      removed: false,
    }];
    const { rows } = parseMintBurnLogs(
      config,
      eventDef,
      logs,
      new Map([[100, 1700000000]]),
      new Map(),
      new Map(),
      1700000100,
    );
    expect(rows[0].counterparty).toBe("0xaaaa1111aaaa2222aaaa3333aaaa4444aaaa5555");
  });
});
