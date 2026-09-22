import { vi } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";

export const MINT_BURN_ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const MINT_BURN_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const USDT_CONTRACT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

/** `INSERT OR IGNORE INTO mint_burn_events` bind tuples seen by `batchExecute`. */
export const mintBurnEventInsertBinds: unknown[][] = [];

// --- Module-level mocks shared by every syncMintBurn suite ---
// `MINT_BURN_CONFIGS` stays per-suite: each suite pins its own config fixture.

vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn((chainId: string) => `https://${chainId}.g.alchemy.example/v2/`),
  getAlchemyBlockNumber: vi.fn(async (url: string) => (url.includes("ethereum") ? 22_000_000 : 250_000_000)),
  getAlchemyTransactionContextBatchMany: vi.fn(async (_url: string, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, {
      tx: { hash: txHash, to: "0xrouter", input: "0x96f4e9f9" },
      receipt: { transactionHash: txHash, to: "0xrouter", logs: [] },
    }])),
  ),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 200) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((budget: { count: number; limit: number }) => budget.count >= budget.limit),
  decodeUint256AtSlotOrNull: vi.fn(() => 50_000),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return { ...orig, batchExecute: vi.fn(recordMintBurnBatch) };
});

vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/mint-burn-pipeline/persistence")>();
  return { ...orig, recalcAffectedHours: vi.fn(async () => undefined) };
});

vi.mock("../../lib/mint-burn-pipeline/price-heal", () => ({
  getNullPriceBacklog: vi.fn(async () => ({ recent: 0, historical: 0 })),
  healNullPrices: vi.fn(async () => ({ healed: 0, affectedHours: new Map() })),
}));

vi.mock("../../lib/mint-burn-pipeline/roundtrip-sweep", () => ({
  sweepRecentRoundtrips: vi.fn(async () => ({ reclassified: 0, affectedHours: new Map(), saturated: false })),
}));

import { batchExecute } from "../../lib/db";
import {
  buildAlchemyUrl,
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  getAlchemyTransactionContextBatchMany,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";
import { createBudget, decodeUint256AtSlotOrNull } from "../../lib/evm-logs";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";

async function recordMintBurnBatch(_db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  for (const statement of statements) {
    const { sql = "", boundValues = [] } = statement as unknown as { sql?: string; boundValues?: unknown[] };
    if (sql.includes("INSERT OR IGNORE INTO mint_burn_events")) mintBurnEventInsertBinds.push([...boundValues]);
  }
  return statements.length;
}

/** Restores every shared boundary mock to its neutral default. */
export function resetMintBurnMocks(): void {
  mintBurnEventInsertBinds.length = 0;
  vi.mocked(buildAlchemyUrl).mockClear();
  vi.mocked(createBudget).mockReset().mockImplementation((limit = 200) => ({ count: 0, limit }));
  vi.mocked(decodeUint256AtSlotOrNull).mockReset().mockReturnValue(50_000);
  vi.mocked(getAlchemyBlockNumber)
    .mockReset()
    .mockImplementation(async (url: string) => (url.includes("ethereum") ? 22_000_000 : 250_000_000));
  vi.mocked(getAlchemyTransactionContextBatchMany).mockReset().mockImplementation(async (_url, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, {
      tx: { hash: txHash, to: "0xrouter", input: "0x96f4e9f9" },
      receipt: { transactionHash: txHash, to: "0xrouter", logs: [] },
    }])),
  );
  vi.mocked(fetchAlchemyLogs).mockReset().mockResolvedValue({
    logs: [],
    complete: true,
    scannedToBlock: 22_000_000,
    calls: 1,
    maxDepth: 0,
  });
  vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
  vi.mocked(batchExecute).mockReset().mockImplementation(recordMintBurnBatch);
  vi.mocked(recalcAffectedHours).mockReset().mockResolvedValue(undefined);
  vi.mocked(getNullPriceBacklog).mockReset().mockResolvedValue({ recent: 0, historical: 0 });
  vi.mocked(healNullPrices).mockReset().mockResolvedValue({ healed: 0, affectedHours: new Map() });
  vi.mocked(sweepRecentRoundtrips)
    .mockReset()
    .mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
}

export interface MintBurnDbOptions {
  runState?: { degradedStreak: number; lastConfigKey?: string | null } | null;
  syncRows?: Array<{ last_block: number; config_key?: string }>;
  cacheRows?: Array<{ key: string; value: string; updated_at: number }>;
  priceRows?: Array<{ asset_id: string; price: number }>;
}

/** The table set every syncMintBurn run touches, with per-suite price rows. */
export function makeMintBurnDb(options: MintBurnDbOptions = {}): D1Database {
  const runState = options.runState === undefined ? { degradedStreak: 0, lastConfigKey: null } : options.runState;
  const runStateRow = runState
    ? { degraded_streak: runState.degradedStreak, last_config_key: runState.lastConfigKey ?? null }
    : null;
  return mockD1([
    { match: "mint_burn_run_state", rows: runStateRow ? [runStateRow] : [], first: runStateRow },
    { match: "mint_burn_sync_state", rows: options.syncRows ?? [] },
    {
      match: "price_cache",
      rows: options.priceRows ?? [
        { asset_id: "usdt-tether", price: 1.0 },
        { asset_id: "usdc-circle", price: 0.999 },
      ],
    },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: options.cacheRows ?? [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "DELETE FROM cache WHERE key >= ? AND key < ?", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "mint_burn_hourly", rows: [] },
    { match: "mint_burn_events", rows: [] },
    { match: "SELECT config_key, deferred_until FROM mint_burn_config_deferral", rows: [] },
    { match: "INSERT OR REPLACE INTO mint_burn_config_deferral", rows: [] },
    ...(options.cacheRows ? ([{ match: "cache", rows: options.cacheRows }] satisfies MockTableConfig[]) : []),
  ]);
}

/** A zero-address `Transfer` log (a mint) for `contract`. */
export function makeMintBurnMintLog(
  options: { contract?: string; blockNumber?: number; txHash?: string; logIndex?: number } = {},
) {
  const block = options.blockNumber ?? 22_000_000;
  return {
    address: options.contract ?? USDT_CONTRACT,
    topics: [
      MINT_BURN_TRANSFER_TOPIC,
      MINT_BURN_ZERO_TOPIC,
      "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000002540be400",
    blockNumber: "0x" + block.toString(16),
    transactionHash: options.txHash ?? "0xabc123",
    transactionIndex: "0x0",
    blockHash: "0x0",
    logIndex: "0x" + (options.logIndex ?? 0).toString(16),
    removed: false,
  };
}
