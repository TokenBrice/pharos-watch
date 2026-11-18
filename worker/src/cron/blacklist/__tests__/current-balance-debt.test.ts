import { includeActiveTrackedIds } from "../../shared/exclude-frozen";
import { publishBlacklistEventCoverage } from "../coverage";
import { collectWeeklyBlacklistPeriods } from "../../weekly-recap/blacklist";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeBlacklistTrackedSummaryStats } from "@shared/lib/blacklist-active-records";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { loadBlacklistCurrentBalanceMap } from "../../../lib/blacklist-current-balances";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../../../lib/blacklist-summary-service";
import { BLACKLIST_POST_WIPE_BALANCE_PREFIX, BLACKLIST_POST_WIPE_MAX_AGE_SEC, BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY } from "../../../lib/blacklist-cache-keys";
import { CURRENT_BALANCE_DEBT_PREFIX, syncCurrentBalanceCacheForRows } from "../../../lib/blacklist/current-balance-cache";
import { reconcileCurrentBalanceDebt } from "../../../lib/blacklist/current-balance-debt";
import { resolveTronBlacklistOrder } from "../../../lib/blacklist/tron-order-recovery";
import { createBlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import { insertBlacklistRows } from "../persistence";
import { makeCacheRow, ethereumConfig } from "./balance.test-support";

vi.mock("../../../lib/blacklist/balance-providers", () => ({
  fetchEvmTokenBalance: vi.fn(async () => 125),
  fetchTronTokenCurrentBalance: vi.fn(async () => 250),
}));
vi.mock("../../../lib/blacklist/tron-replay-provider", () => ({
  fetchTronBlockTransactionPositions: vi.fn(),
}));
vi.mock("../../../lib/evm-rpc", async (original) => ({
  ...await original<object>(), fetchEvmBlockHeader: vi.fn(),
}));
import { fetchTronBlockTransactionPositions } from "../../../lib/blacklist/tron-replay-provider";
import { fetchEvmTokenBalance, fetchTronTokenCurrentBalance } from "../../../lib/blacklist/balance-providers";
import { fetchEvmBlockHeader } from "../../../lib/evm-rpc";

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
afterEach(() => { fixtures.closeAll(); vi.clearAllMocks(); vi.useRealTimers(); });

const blockHash = `0x${"a".repeat(64)}` as const;

describe("durable current snapshot reconciliation", () => {
  it.each([["tron", 0], ["evm", 0], ["tron", 101]] as const)("passes 24 blocked %s debts with %i extra configs", async (blockedType, extraConfigs) => {
    const { sqlite, db } = fixtures.open();
    const tron = CONTRACT_CONFIGS.find((config) => config.chain.type === "tron" && config.stablecoin === "USDT")!;
    const [blocked, eligible] = blockedType === "tron" ? [tron, ethereumConfig] : [ethereumConfig, tron];
    const rows = Array.from({ length: 49 }, (_, i) => {
      const config = i < 24 ? blocked : eligible;
      return makeCacheRow({ id: `debt-${i}`, address: `address-${i}`, config_key: config.configKey,
        chain_id: config.chain.chainId, contract_address: config.contractAddress });
    });
    await insertBlacklistRows(db, rows);
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    rows.forEach((row, i) => insert.run(`${CURRENT_BALANCE_DEBT_PREFIX}${row.id}`, row.id, i));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        if (values.length > 100) throw new Error("D1 bound parameter limit exceeded");
        return bind(...values);
      };
      return statement;
    });
    const registrySize = CONTRACT_CONFIGS.length;
    CONTRACT_CONFIGS.push(...Array.from({ length: extraConfigs }, (_, i) => ({ ...ethereumConfig, configKey: `extra-${i}` })));
    try {
      await reconcileCurrentBalanceDebt(db, context(), {
        etherscanAllowed: blockedType !== "evm", tronGridAllowed: blockedType !== "tron",
      });
    } finally { CONTRACT_CONFIGS.splice(registrySize); }
    expect(fetchEvmTokenBalance).toHaveBeenCalledTimes(blockedType === "evm" ? 0 : 24);
    expect(fetchTronTokenCurrentBalance).toHaveBeenCalledTimes(blockedType === "tron" ? 0 : 24);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache WHERE key GLOB ?").get(`${CURRENT_BALANCE_DEBT_PREFIX}*`))
      .toEqual({ n: 25 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache WHERE key GLOB ? AND updated_at < 24")
      .get(`${CURRENT_BALANCE_DEBT_PREFIX}*`)).toEqual({ n: 24 });
  });

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

  it("keeps an emitted destroy snapshot when a deferred replay folds a later release", async () => {
    const { sqlite, db } = fixtures.open();
    const address = "0xfeed";
    const freeze = makeCacheRow({
      id: "ethereum-0xfee1-0",
      address,
      event_type: "blacklist",
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      tx_hash: "0xfee1",
      block_number: 24_000_001,
      timestamp: 1_760_000_000,
      event_signature: "AddedBlackList(address)",
    });
    const destroy = {
      ...freeze,
      id: "ethereum-0xfee2-0",
      event_type: "destroy" as const,
      amount_native: 500,
      amount_usd_at_event: 500,
      amount_source: "event" as const,
      amount_status: "resolved" as const,
      tx_hash: "0xfee2",
      block_number: 24_000_002,
      timestamp: 1_760_000_100,
      event_signature: "DestroyedBlackFunds(address,uint256)",
    };
    const release = {
      ...freeze,
      id: "ethereum-0xfee3-0",
      event_type: "unblacklist" as const,
      tx_hash: "0xfee3",
      block_number: 24_000_003,
      timestamp: 1_760_000_200,
      event_signature: "RemovedBlackList(address)",
    };
    await insertBlacklistRows(db, [freeze, destroy, release]);

    // The freeze capture for the blacklist row is budget-skipped, retaining its
    // debt key; a later scan writes the emitted destroy snapshot, then the
    // release arrives, and the maintenance tail replays the whole history.
    const exhausted = context();
    exhausted.runBudget.subrequestBudget.count = 100;
    expect(await syncCurrentBalanceCacheForRows(db, ethereumConfig, [freeze], exhausted))
      .toMatchObject({ skippedDueBudget: 1, budgetExhausted: true });
    await syncCurrentBalanceCacheForRows(db, ethereumConfig, [destroy], context());
    await syncCurrentBalanceCacheForRows(db, ethereumConfig, [release], context());
    await reconcileCurrentBalanceDebt(db, context(), circuits);

    // The release must not downgrade the newer destroy snapshot to the older
    // blacklist row and overwrite its value with a post-wipe live balance.
    expect(sqlite.prepare(
      `SELECT amount_native, amount_usd, source, status, observed_at FROM blacklist_current_balances`,
    ).get()).toMatchObject({
      amount_native: 500,
      amount_usd: 500,
      source: "destroy_event",
      status: "resolved",
      observed_at: destroy.timestamp,
    });
    expect(vi.mocked(fetchEvmTokenBalance)).not.toHaveBeenCalled();
    expect(computeBlacklistTrackedSummaryStats(await loadBlacklistCurrentBalanceMap(db)).trackedFrozenTotal).toBe(500);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache WHERE key GLOB ?").get(`${CURRENT_BALANCE_DEBT_PREFIX}*`))
      .toEqual({ n: 0 });
  });

  it.each([[0, null], [100_000, ethereumConfig.configKey]])("refreshes an open Ethereum USDT wipe at %s with config %s", async (amount, configKey) => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const freeze = makeCacheRow({
      id: "ethereum-0xfee1-0", tx_hash: "0xfee1", block_number: 24_000_001, timestamp: now - 3,
      address: "0x1111111111111111111111111111111111111111", config_key: ethereumConfig.configKey,
    });
    const wipe = makeCacheRow({ ...freeze, id: "ethereum-0xfee2-0", tx_hash: "0xfee2", block_number: 24_000_002,
      timestamp: now - 2, event_type: "destroy", amount_native: 500, amount_usd_at_event: 500,
      amount_source: "event", amount_status: "resolved" });
    await insertBlacklistRows(db, [freeze, { ...wipe, config_key: configKey }]);
    await syncCurrentBalanceCacheForRows(db, ethereumConfig, [wipe], context());
    sqlite.prepare("INSERT INTO blacklist_sync_state (config_key, last_block, cursor_value, cursor_kind) VALUES (?, ?, ?, 'evm_block')")
      .run(ethereumConfig.configKey, wipe.block_number, wipe.block_number);
    vi.mocked(fetchEvmBlockHeader).mockResolvedValue({ number: wipe.block_number, hash: blockHash, timestamp: now - 2 });
    async function stats() {
      const at = Math.floor(Date.now() / 1000);
      await materializeBlacklistSummarySnapshot(db, at, at);
      return ((await (await handleBlacklistSummary(db)).json()) as { stats: unknown }).stats;
    }
    vi.mocked(fetchEvmTokenBalance).mockResolvedValueOnce(null).mockResolvedValueOnce(amount).mockResolvedValueOnce(null);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(await stats()).toMatchObject({ activeAddressCount: 1, activeAmountGapCount: 1, trackedFrozenTotal: 500 });
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(await stats()).toMatchObject({ activeAddressCount: 1, activeFrozenTotal: amount, activeAmountGapCount: 0,
      destroyedTotal: 500, trackedFrozenTotal: 500 });
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(await stats()).toMatchObject({ activeFrozenTotal: amount, activeAmountGapCount: 0 });
    const newerWipe = makeCacheRow({ ...wipe, id: "ethereum-0xfee3-0", tx_hash: "0xfee3",
      block_number: 24_000_003, timestamp: now - 1, amount_native: 5, amount_usd_at_event: 5 });
    await insertBlacklistRows(db, [newerWipe]);
    expect(await stats()).toMatchObject({ activeFrozenTotal: 0, activeAmountGapCount: 1, destroyedTotal: 505 });
    await insertBlacklistRows(db, [makeCacheRow({ ...freeze, id: "ethereum-0xfee4-0", tx_hash: "0xfee4",
      block_number: 24_000_004, timestamp: now - 1, event_type: "unblacklist" })]);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(fetchEvmTokenBalance).toHaveBeenCalledTimes(3);
    expect(await stats()).toMatchObject({ activeAddressCount: 0, activeFrozenTotal: 0, trackedFrozenTotal: 500 });
  });

  it("rejects a lagging finalized head and expires an earlier balance after failed retries", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now * 1000);
    const wipe = makeCacheRow({ id: "ethereum-0xfee1-0", config_key: ethereumConfig.configKey,
      address: `0x${"1".repeat(40)}`, event_type: "destroy", block_number: 101, timestamp: now - 2 });
    await insertBlacklistRows(db, [wipe]);
    await syncCurrentBalanceCacheForRows(db, ethereumConfig, [wipe], context());
    sqlite.prepare("INSERT INTO blacklist_sync_state (config_key, last_block, cursor_value, cursor_kind) VALUES (?, ?, ?, 'evm_block')")
      .run(ethereumConfig.configKey, wipe.block_number, wipe.block_number);
    const header = { number: 101, hash: blockHash, timestamp: now - 1 };
    vi.mocked(fetchEvmBlockHeader).mockResolvedValueOnce({ ...header, number: 100 }).mockResolvedValueOnce(header);
    const amount = vi.mocked(fetchEvmTokenBalance);
    const snapshot = () => sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(`${BLACKLIST_POST_WIPE_BALANCE_PREFIX}${wipe.id}`);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(amount).not.toHaveBeenCalled();
    expect(snapshot()).toMatchObject({ value: "null" });

    amount.mockResolvedValueOnce(125);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(amount.mock.calls[0]?.[2]).toBe(101);
    expect(amount.mock.calls[0]?.[9]?.finalizedPin?.header).toEqual(header);
    const value = JSON.stringify({ amountUsd: 125, blockNumber: header.number, blockHash, observedAt: header.timestamp });
    expect(snapshot()).toEqual({ value, updated_at: now });
    await materializeBlacklistSummarySnapshot(db, now, now);
    const summary = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY);
    expect(JSON.parse(String(summary?.value))).toMatchObject({ version: 6,
      postWipeValidThrough: header.timestamp + BLACKLIST_POST_WIPE_MAX_AGE_SEC });
    expect((await (await handleBlacklistSummary(db)).json<{ stats: unknown }>()).stats)
      .toMatchObject({ activeFrozenTotal: 125, activeAmountGapCount: 0 });

    const expired = now + BLACKLIST_POST_WIPE_MAX_AGE_SEC;
    vi.setSystemTime(expired * 1000);
    sqlite.prepare("UPDATE blacklist_sync_state SET last_block = 102, cursor_value = 102 WHERE config_key = ?").run(ethereumConfig.configKey);
    vi.mocked(fetchEvmBlockHeader).mockResolvedValueOnce({ ...header, number: 102, timestamp: expired - 1 });
    amount.mockResolvedValueOnce(null);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(snapshot()).toEqual({ value, updated_at: expired });
    expect((await (await handleBlacklistSummary(db)).json<{ stats: unknown }>()).stats)
      .toMatchObject({ activeAddressCount: 1, activeFrozenTotal: 0, activeAmountGapCount: 1 });
  });

  it("withholds a post-wipe read above its committed cursor and folds the subsequently ingested release", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const wipe = makeCacheRow({ id: "wipe-before-release", tx_hash: "0x123", address: `0x${"1".repeat(40)}`,
      config_key: ethereumConfig.configKey, event_type: "destroy", block_number: 100, timestamp: now - 2 });
    await insertBlacklistRows(db, [wipe]);
    sqlite.prepare("INSERT INTO blacklist_sync_state (config_key, last_block, cursor_value, cursor_kind) VALUES (?, 100, 100, 'evm_block')")
      .run(ethereumConfig.configKey);
    vi.mocked(fetchEvmBlockHeader).mockImplementation(async (_, selector) =>
      selector === "finalized" ? { number: 110, hash: blockHash, timestamp: now - 1 } : null);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(fetchEvmBlockHeader).toHaveBeenCalledWith("ethereum", 100, expect.anything());
    expect(fetchEvmTokenBalance).not.toHaveBeenCalled();
    const stats = async () => {
      await materializeBlacklistSummarySnapshot(db, now, now);
      return (await (await handleBlacklistSummary(db)).json<{ stats: unknown }>()).stats;
    };
    expect(await stats()).toMatchObject({ activeAddressCount: 1, activeFrozenTotal: 0, activeAmountGapCount: 1 });
    await insertBlacklistRows(db, [makeCacheRow({ ...wipe, id: "release-on-ledger", tx_hash: "0x456",
      event_type: "unblacklist", block_number: 105, timestamp: now - 1 })]);
    sqlite.prepare("UPDATE blacklist_sync_state SET last_block = 110, cursor_value = 110 WHERE config_key = ?").run(ethereumConfig.configKey);
    await reconcileCurrentBalanceDebt(db, context(), circuits);
    expect(fetchEvmTokenBalance).not.toHaveBeenCalled();
    expect(await stats()).toMatchObject({ activeAddressCount: 0, activeFrozenTotal: 0, activeAmountGapCount: 0 });
  });

  it("certifies a quiet finalized roster and withholds it after repair rotates the generation", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const configStates = includeActiveTrackedIds(CONTRACT_CONFIGS, (config) => config.stablecoinId).map((config) => ({
      config, configKey: config.configKey, cursorKind: config.chain.type === "tron" ? "tron_timestamp_ms" as const : "evm_block" as const,
      cursorValue: config.chain.type === "tron" ? (now - 20) * 1000 : 110, attemptGeneration: 1,
      lastAttemptedAt: now, lastSucceededAt: now, lastSkippedAt: null, lastFailedAt: null,
      consecutiveSkips: 0, consecutiveFailures: 0, lastOutcome: "quiet",
    }));
    const save = sqlite.prepare(`INSERT INTO blacklist_sync_state (config_key, last_block, cursor_value, attempt_generation, cursor_kind)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT(config_key) DO UPDATE SET last_block = excluded.last_block,
        cursor_value = excluded.cursor_value, attempt_generation = 1, cursor_kind = excluded.cursor_kind`);
    const committedScans = Object.fromEntries(configStates.map((state) => {
      save.run(state.configKey, state.cursorValue, state.cursorValue, state.cursorKind);
      return [state.configKey, { fromCursor: state.cursorKind === "tron_timestamp_ms" ? (now - 180) * 1000 : 100, toCursor: state.cursorValue }];
    }));
    vi.mocked(fetchEvmBlockHeader).mockImplementation(async (_, selector) => {
      const number = selector === "finalized" ? 108 : selector;
      return { number, hash: blockHash, timestamp: now - 100 + (number - 100) * 10 };
    });
    const periods = { current: { start: now - 60, end: now - 25 }, prior: { start: now - 78, end: now - 60 } };
    const resultBefore = await collectWeeklyBlacklistPeriods(db, periods);
    expect(resultBefore.current?.coverage.reason).toBe("weekly-blacklist-coverage-missing");
    await publishBlacklistEventCoverage(db, { configStates, committedScans }, null, context().runBudget);
    expect(await collectWeeklyBlacklistPeriods(db, periods)).toMatchObject({
      current: { eventCount: 0, coverage: { reason: null } },
      prior: { eventCount: 0, coverage: { reason: null } },
    });
    const extending = configStates.find((state) => state.cursorKind === "evm_block")!;
    const fromCursor = extending.cursorValue++;
    save.run(extending.configKey, extending.cursorValue, extending.cursorValue, extending.cursorKind);
    vi.mocked(fetchEvmBlockHeader).mockResolvedValue(null);
    await publishBlacklistEventCoverage(db, { configStates, committedScans: {
      [extending.configKey]: { fromCursor, toCursor: extending.cursorValue },
    } }, null, context().runBudget);
    const extended = await collectWeeklyBlacklistPeriods(db, {
      prior: periods.current, current: { start: now - 20, end: now - 10 },
    });
    expect(extended.prior?.coverage.reason).toBeNull();
    expect(extended.current?.coverage.reason).toBeTruthy();
    sqlite.prepare("INSERT INTO cache VALUES ('blacklist:derived-generation', 'repaired', ?)").run(now);
    // A delayed producer cannot republish the pre-repair receipt.
    await publishBlacklistEventCoverage(db, { configStates, committedScans }, null, context().runBudget);
    expect((await collectWeeklyBlacklistPeriods(db, periods)).current?.coverage.reason)
      .toBe("weekly-blacklist-coverage-invalid");
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
