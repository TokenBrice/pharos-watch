import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeBlacklistTrackedSummaryStats } from "@shared/lib/blacklist-active-records";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { loadBlacklistCurrentBalanceMap } from "../../../lib/blacklist-current-balances";
import { CURRENT_BALANCE_DEBT_PREFIX, syncCurrentBalanceCacheForRows } from "../../../lib/blacklist/current-balance-cache";
import { reconcileCurrentBalanceDebt } from "../../../lib/blacklist/current-balance-debt";
import { resolveTronBlacklistOrder } from "../../../lib/blacklist/tron-order-recovery";
import { createBlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import { insertBlacklistRows } from "../persistence";
import { makeCacheRow, ethereumConfig } from "./balance.test-support";

vi.mock("../../../lib/blacklist/balance-providers", () => ({
  fetchEvmTokenCurrentBalance: vi.fn(async () => 125),
  fetchTronTokenCurrentBalance: vi.fn(async () => 250),
}));
vi.mock("../../../lib/blacklist/tron-replay-provider", () => ({
  fetchTronBlockTransactionPositions: vi.fn(),
}));
import { fetchTronBlockTransactionPositions } from "../../../lib/blacklist/tron-replay-provider";

const fixtures = createLatestSchemaFixtureTracker();
const circuits = { etherscanAllowed: true, tronGridAllowed: true };
function context() {
  return {
    etherscanApiKey: null, drpcApiKey: null, trongridApiKey: null,
    etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
    tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
    runBudget: createBlacklistRunBudget({ subrequestLimit: 100, runtimeBudgetMs: 60_000, minimumConfigWindowMs: 0 }),
  };
}
afterEach(() => { fixtures.closeAll(); vi.clearAllMocks(); });

describe("durable current snapshot reconciliation", () => {
  it("recovers budget-skipped freeze capture on quiet maintenance without rewinding the event cursor", async () => {
    const { sqlite, db } = fixtures.open();
    const row = makeCacheRow({ id: "debt-freeze", config_key: ethereumConfig.configKey });
    await insertBlacklistRows(db, [row]);
    const exhausted = context();
    exhausted.runBudget.subrequestBudget.count = 100;
    expect(await syncCurrentBalanceCacheForRows(db, ethereumConfig, [row], exhausted))
      .toMatchObject({ skippedDueBudget: 1, budgetExhausted: true });
    sqlite.prepare("INSERT INTO blacklist_sync_state (config_key, last_block, cursor_value, cursor_kind) VALUES (?, ?, ?, 'evm_block')")
      .run(ethereumConfig.configKey, row.block_number, row.block_number);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache WHERE key GLOB ?").get(`${CURRENT_BALANCE_DEBT_PREFIX}*`)).toEqual({ n: 1 });
    expect((await loadBlacklistCurrentBalanceMap(db)).size).toBe(0);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    const balances = await loadBlacklistCurrentBalanceMap(db);
    expect(computeBlacklistTrackedSummaryStats(balances)).toMatchObject({ trackedAddressCount: 1, trackedFrozenTotal: 125 });
    expect(sqlite.prepare("SELECT cursor_value FROM blacklist_sync_state WHERE config_key = ?").get(ethereumConfig.configKey))
      .toEqual({ cursor_value: row.block_number });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache WHERE key GLOB ?").get(`${CURRENT_BALANCE_DEBT_PREFIX}*`)).toEqual({ n: 0 });
  });

  it("captures a withheld Tron identity after transaction order recovery", async () => {
    const { sqlite, db } = fixtures.open();
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.chain.type === "tron" && candidate.stablecoin === "USDT")!;
    const freeze = makeCacheRow({ id: "tron-freeze-0", stablecoin: "USDT", chain_id: "tron", chain_name: "Tron",
      config_key: config.configKey, contract_address: config.contractAddress, block_number: 100, timestamp: 1000,
      tx_hash: "a".repeat(64), transaction_index: null, address: "T-address" });
    const release = { ...freeze, id: "tron-release-0", event_type: "unblacklist" as const, tx_hash: "b".repeat(64) };
    await insertBlacklistRows(db, [freeze, release]);
    await syncCurrentBalanceCacheForRows(db, config, [freeze, release], context());
    expect((await loadBlacklistCurrentBalanceMap(db)).size).toBe(0);
    // Simulate pre-deploy withheld events too: order repair must enqueue independently.
    sqlite.prepare("DELETE FROM cache WHERE key GLOB ?").run(`${CURRENT_BALANCE_DEBT_PREFIX}*`);
    vi.mocked(fetchTronBlockTransactionPositions).mockResolvedValue({
      timestamp: 1000, positions: new Map([[freeze.tx_hash, 0], [release.tx_hash, 1]]),
    });
    const ctx = context();
    await resolveTronBlacklistOrder(db, { apiKey: null, limiter: ctx.tronLimiter,
      budget: ctx.runBudget.subrequestBudget, pagesFetched: { count: 0 } }, ctx.runBudget);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(computeBlacklistTrackedSummaryStats(await loadBlacklistCurrentBalanceMap(db)))
      .toMatchObject({ trackedAddressCount: 1, trackedFrozenTotal: 250 });
    expect(sqlite.prepare("SELECT transaction_index FROM blacklist_events ORDER BY transaction_index").all())
      .toEqual([{ transaction_index: 0 }, { transaction_index: 1 }]);
  });
});
