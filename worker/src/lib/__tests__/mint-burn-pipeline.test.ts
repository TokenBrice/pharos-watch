import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
}));

vi.mock("../alchemy-logs", () => ({
  getAlchemyTransactionByHash: vi.fn(async (_url: string, txHash: string) => ({
    hash: txHash,
    to: "0xrouter",
    input: "0x96f4e9f9",
  })),
  getAlchemyTransactionReceipt: vi.fn(async (_url: string, txHash: string) => ({
    transactionHash: txHash,
    to: "0xrouter",
    logs: [],
  })),
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

import { getAlchemyTransactionByHash, getAlchemyTransactionReceipt } from "../alchemy-logs";
import { classifyBridgeAwareBurnRows } from "../mint-burn-bridge-classifier";
import { batchExecute } from "../db";
import { classifyBridgeBurnRows } from "../mint-burn-pipeline/classification";
import {
  collectAffectedHours,
  insertMintBurnRows,
  recalcAffectedHours,
  updateBurnClassifications,
} from "../mint-burn-pipeline/persistence";
import { upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import type { MintBurnRow } from "../mint-burn-pipeline/types";

function makeDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
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
      {
        chain: {
          chainId: "ethereum",
          chainName: "Ethereum",
          evmChainId: 1,
          explorerUrl: "https://etherscan.io",
          type: "evm",
        },
        stablecoinId: "usdt-tether",
        symbol: "USDT",
        contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        decimals: 6,
        dustThreshold: 10_000,
        startBlock: 21_900_000,
        events: [],
        bridgeDetection: {
          protocol: "ccip",
          knownBridgePoolAddresses: ["0xpool"],
          knownBridgeRouterAddresses: ["0xrouter"],
          bridgeSignalTopics: ["0xtopic"],
          bridgeSignalSelectors: ["0x96f4e9f9"],
        },
      },
      "https://eth-mainnet.g.alchemy.com/v2/test-key",
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters).toEqual({
      effectiveBurns: 1,
      bridgeBurns: 1,
      reviewBurns: 1,
    });
    expect(vi.mocked(getAlchemyTransactionByHash)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getAlchemyTransactionReceipt)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(classifyBridgeAwareBurnRows)).toHaveBeenCalledTimes(1);
    expect(db).toBeDefined();
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
    expect(vi.mocked(batchExecute)).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(batchExecute).mock.calls[0];
    expect(firstCall[1]).toHaveLength(2);
  });

  it("updates burn classification rows only for burn events", async () => {
    const db = makeDb();
    vi.mocked(batchExecute).mockResolvedValueOnce(2);

    const rows = [
      makeRow({ id: "mint-1", direction: "mint" }),
      makeRow({ id: "burn-1", direction: "burn", burn_type: "effective_burn" }),
      makeRow({ id: "burn-2", direction: "burn", burn_type: "bridge_burn" }),
    ];

    const updated = await updateBurnClassifications(db, rows);
    expect(updated).toBe(2);
    expect(vi.mocked(batchExecute)).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(batchExecute).mock.calls[0];
    expect(firstCall[1]).toHaveLength(2);
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
});
