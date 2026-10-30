import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { insertBlacklistRows } from "../persistence";
import { makePendingBlacklistRow } from "./blacklist.test-support";


vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import {
  backfillAmounts,
  enrichRowBalances,
  extractDestroyAmountFromReceiptLogs,
} from "../../../lib/blacklist/amount-recovery";
import { fetchJsonWithRetry } from "../../../lib/fetch-retry";
import { parseEvmLogsWithCoverage } from "../evm-source";
import { shouldSuppressAsMirrorZero } from "../../../lib/blacklist/shared";
import {
  mockD1 as createMockD1,
  type MockD1Options,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../../lib/blacklist-contracts";
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";

const DEFAULT_BLACKLIST_AMOUNT_D1_TABLES: MockTableConfig[] = [
  { match: "blacklist-amount-repair-queue-enqueue", rows: [] },
  { match: "blacklist-amount-repair-queue-reconcile-resolved", rows: [] },
  { match: "amount_attempt_count = COALESCE", rows: [], runMeta: { changes: 1 } },
  { match: "amount_native = ?, amount_usd_at_event", rows: [], runMeta: { changes: 1 } },
  { match: "blacklist-amount-repair-queue-finish", rows: [] },
];

function mockD1(tables: MockTableConfig[] = [], options: MockD1Options = {}) {
  return createMockD1([...tables, ...DEFAULT_BLACKLIST_AMOUNT_D1_TABLES], options);
}

function configChain(chainId: string) {
  const config = CONTRACT_CONFIGS.find((candidate) => candidate.chain.chainId === chainId);
  if (!config) throw new Error(`Missing test chain config: ${chainId}`);
  return config.chain;
}

function makeConfig(): ContractEventConfig {
  return {
    stablecoin: "USDC",
    stablecoinId: "usdc-circle",
    chain: configChain("ethereum"),
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    events: [{ signature: "Blacklisted(address)", eventType: "blacklist", topicHash: "0x00", hasAmount: false, addressTopicIndex: 1 }],
    configKey: "USDC:ethereum",
  };
}

function makeDestroyConfig(): ContractEventConfig {
  return {
    ...makeConfig(),
    events: [{
      signature: "DestroyedBlackFunds(address,uint256)",
      eventType: "destroy",
      topicHash: "0xdestroy",
      hasAmount: true,
    }],
  };
}

function word(value: string): string {
  return value.replace(/^0x/, "").padStart(64, "0");
}

function amountWord(raw: bigint): string {
  return raw.toString(16).padStart(64, "0");
}

function makeRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return {
    id: "row-1",
    stablecoin: "USDC",
    chain: "Ethereum",
    chain_id: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    event_type: "blacklist",
    block_number: 100,
    tx_hash: "0xabc",
    log_index: 0,
    timestamp: 1_700_000_000,
    amount_native: null,
    amount_usd_at_event: null,
    amount_source: null,
    amount_status: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    ...overrides,
  } as BlacklistRow;
}

function makeRunBudget(overrides: Partial<BlacklistRunBudget> = {}): BlacklistRunBudget {
  return {
    subrequestBudget: { count: 0, limit: 1 },
    deadlineMs: Date.now() + 10_000,
    minimumConfigWindowMs: 0,
    ...overrides,
  };
}

const recoveryConfig = CONTRACT_CONFIGS.find((candidate) =>
  candidate.stablecoin === "USDT" && candidate.chain.chainId === "ethereum")!;

function receiptResponse(amount: number | null) {
  return {
    response: new Response(null, { status: 200 }),
    body: { result: { logs: amount == null ? [] : [{
      address: recoveryConfig.contractAddress,
      topics: [recoveryConfig.events.find((event) => event.eventType === "destroy")!.topicHash],
      data: "0x" + word("0x1111111111111111111111111111111111111111")
        + amountWord(BigInt(amount) * 1_000_000n),
      blockNumber: "0x64", transactionHash: "0xabc", logIndex: "0x1", timeStamp: "0x65000000",
    }] } },
  };
}

const sqliteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => sqliteFixtures.closeAll());

describe("enrichRowBalances", () => {
  it.each([
    { rows: 10, count: 751, limit: 900, attempted: 0 },
    { rows: 520, count: 0, limit: 10_000, attempted: 500 },
  ])("keeps destroy repair inside the shared reserve and total row ceiling: $attempted", async ({ rows, count, limit, attempted }) => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, Array.from({ length: rows }, (_, index) => makePendingBlacklistRow({
      id: `destroy-${index}`, stablecoin: "USDT", chain_id: "ethereum", event_type: "destroy",
      config_key: recoveryConfig.configKey, contract_address: recoveryConfig.contractAddress,
      address: "0x1111111111111111111111111111111111111111",
    })));
    vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(receiptResponse(25));

    const result = await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count, limit } }));
    expect(result).toMatchObject({ runtimeBudgetReached: false, attempted, resolved: attempted });
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(attempted);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls.every(([, , retries]) => retries === 0)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: rows - attempted });
  });

  it.each([
    [10, "resolved"], [null, "resolved"], [10, "suppressed"], [null, "suppressed"],
  ] as const)("rejects stale recovery %s after an operator %s generation", async (providerAmount, mutation) => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "raced", stablecoin: "USDT", chain_id: "ethereum", event_type: "destroy",
      config_key: recoveryConfig.configKey, contract_address: recoveryConfig.contractAddress,
      address: "0x1111111111111111111111111111111111111111",
    })]);
    let resume!: (value: number | null) => void;
    let selected!: () => void;
    const providerStarted = new Promise<void>((resolve) => { selected = resolve; });
    vi.mocked(fetchJsonWithRetry).mockImplementationOnce(async () => {
      selected();
      const amount = await new Promise<number | null>((resolve) => { resume = resolve; });
      return receiptResponse(amount);
    });
    const pending = backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget());
    await providerStarted;
    if (mutation === "suppressed") {
      sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'operator-suppressed' WHERE id = 'raced'").run();
    } else {
      sqlite.prepare(`UPDATE blacklist_events SET amount_native = 777, amount_usd_at_event = 777,
        amount_status = 'resolved', provenance_source = 'operator-verified',
        provenance_observed_at = 123, amount_attempt_count = 8 WHERE id = 'raced'`).run();
    }
    const operatorRow = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'raced'").get();
    const queueRow = sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = 'raced'").get();
    resume(providerAmount);
    expect(await pending).toMatchObject({ attempted: 0, resolved: 0, retried: 0, unrecoverable: 0 });
    expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'raced'").get()).toEqual(operatorRow);
    expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = 'raced'").get()).toEqual(queueRow);
  });

  it.each([false, true])("repairs an unchanged null or legacy-zero generation (legacy=%s)", async (legacy) => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "eligible", stablecoin: "USDT", chain_id: "ethereum", event_type: "destroy",
      config_key: recoveryConfig.configKey, contract_address: recoveryConfig.contractAddress,
      address: "0x1111111111111111111111111111111111111111",
      amount_native: legacy ? 0 : null, amount_source: legacy ? "derived" : "unavailable",
      amount_status: legacy ? "resolved" : "recoverable_pending",
    })]);
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(receiptResponse(25));
    expect(await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget()))
      .toMatchObject({ attempted: 1, resolved: 1, retried: 0 });
    expect(sqlite.prepare("SELECT amount_native, amount_status FROM blacklist_events WHERE id = 'eligible'").get())
      .toEqual({ amount_native: 25, amount_status: "resolved" });
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue WHERE event_id = 'eligible'").get())
      .toEqual({ status: "resolved", attempt_count: 1 });
  });

  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(null);
  });

  it("keeps EURC mirror-zero suppression explicit", () => {
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0, "event")).toBe(true);
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0, "historical_balance")).toBe(false);
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0, "derived")).toBe(false);
    expect(shouldSuppressAsMirrorZero("EURC", "destroy", 0, "event")).toBe(false);
    expect(shouldSuppressAsMirrorZero("USDC", "blacklist", 0, "event")).toBe(false);
  });

  it.each([
    [0, "incoming"], [100, "outgoing"],
  ] as const)("proves EURC freeze amounts after same-block %s balance / %s transfer", async (priorBalance, direction) => {
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.stablecoin === "EURC" && candidate.chain.chainId === "ethereum")!;
    const address = "0x1111111111111111111111111111111111111111";
    const other = "0x2222222222222222222222222222222222222222";
    const identity = { blockNumber: "0x64", transactionHash: "0x" + "ab".repeat(32), timeStamp: "0x65000000" };
    const transfer = {
      ...identity, address: config.contractAddress, logIndex: "0x0",
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x" + word(direction === "incoming" ? other : address),
        "0x" + word(direction === "incoming" ? address : other)],
      data: "0x" + amountWord(50_000000n),
    };
    const rows = parseEvmLogsWithCoverage(config, [transfer, {
      ...identity, address: config.contractAddress, logIndex: "0x1",
      topics: [config.events.find((event) => event.eventType === "blacklist")!.topicHash, "0x" + word(address)],
      data: "0x",
    }]).rows;
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
      const params = new URL(String(url)).searchParams;
      const balance = params.get("tag") === "0x63" ? priorBalance : 50;
      const result = params.get("action") === "eth_call"
        ? "0x" + amountWord(BigInt(balance) * 1_000_000n)
        : (params.has("topic1") ? transfer.topics[1] === params.get("topic1")
          : transfer.topics[2] === params.get("topic2")) ? [transfer] : [];
      return { response: new Response(null, { status: 200 }), body: { status: "1", message: "OK", result } };
    });
    expect(await enrichRowBalances({
      rows, config, etherscanApiKey: "test-key",
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget({ subrequestBudget: { count: 0, limit: 4 } }),
    })).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount_native: 50, amount_usd_at_event: null, amount_source: "historical_balance",
      amount_status: "resolved", amount_last_error_class: null, suppression_reason: null,
    });
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(4);
  });

  it.each([[0, "incoming"], [100, "outgoing"]] as const)("does not attribute same-block transfers to an amountless wipe (prior balance %s, %s)", async (priorBalance, direction) => {
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.stablecoin === "PYUSD" && candidate.chain.chainId === "ethereum")!;
    const address = "0x1111111111111111111111111111111111111111";
    const identity = { blockNumber: "0x64", transactionHash: "0x" + "ab".repeat(32), timeStamp: "0x65000000" };
    const logs = [{
      ...identity, address: config.contractAddress, logIndex: "0x0",
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x" + word(direction === "incoming" ? "0x2222222222222222222222222222222222222222" : address),
        direction === "incoming" ? "0x" + word(address) : "0x" + "0".repeat(64)],
      data: "0x" + amountWord(50_000000n),
    }, {
      ...identity, address: config.contractAddress, logIndex: "0x1",
      topics: [config.events.find((event) => event.eventType === "destroy")!.topicHash, "0x" + word(address)],
      data: "0x",
    }];
    const rows = parseEvmLogsWithCoverage(config, logs).rows;
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => ({
      response: new Response(null, { status: 200 }),
      body: { result: String(url).includes("eth_getTransactionReceipt")
        ? { logs } : "0x" + (BigInt(priorBalance) * 1_000_000n).toString(16).padStart(64, "0") },
    }));
    await enrichRowBalances({
      rows, config, etherscanApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(), runBudget: makeRunBudget(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "destroy", amount_native: null, amount_source: "unavailable",
      amount_last_error_class: "event_time_unproven",
    });
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
  });

  it("excludes Tron rows from the EVM recovery query", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [],
      },
    ]);
    const limiter = async <T>(fn: () => Promise<T>) => fn();

    await backfillAmounts(db, null, limiter, makeRunBudget());

    const candidates = db
      .getHistory()
      .find((entry) => entry.sql.includes("blacklist-amount-recovery-evm-candidates"));
    expect(candidates?.sql).toContain("chain_id != 'tron'");
  });

  it("leaves historical Tron event amounts unresolved", async () => {
    const row = makeRow({
      chain_id: "tron",
      address: "TBlacklisted",
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
    });
    const config: ContractEventConfig = {
      ...makeConfig(),
      stablecoin: "USDT",
      stablecoinId: "usdt-tether",
      chain: configChain("tron"),
      contractAddress: "TRONCONTRACT",
      configKey: "USDT:tron",
    };

    const result = await enrichRowBalances({
      rows: [row],
      config,
      etherscanApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget(),
    });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(row).toMatchObject({
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
    });
  });

  it("values rows that already have native amounts without provider calls", async () => {
    const rows = [makeRow({ amount_native: 12.5 })];
    const limiter = async () => {
      throw new Error("provider should not be called");
    };
    const result = await enrichRowBalances({
      rows,
      config: makeConfig(),
      etherscanApiKey: null,
      etherscanLimiter: limiter,
      runBudget: makeRunBudget(),
    });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_usd_at_event).toBe(12.5);
  });

  it("leaves rows retryable when the runtime budget is exhausted without provider calls", async () => {
    const rows = [makeRow()];
    const limiter = async () => {
      throw new Error("provider should not be called");
    };
    const result = await enrichRowBalances({
      rows,
      config: makeConfig(),
      etherscanApiKey: null,
      etherscanLimiter: limiter,
      runBudget: makeRunBudget({ deadlineMs: Date.now() - 1 }),
    });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_attempt_count).toBe(0);
    expect(rows[0].amount_last_error_class).toBeNull();
    expect(rows[0].amount_last_provider).toBeNull();
  });

  it("rethrows provider aborts instead of marking amount recovery as failed", async () => {
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(enrichRowBalances({
      rows: [makeRow({ event_type: "destroy" })],
      config: makeDestroyConfig(),
      etherscanApiKey: null,
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps EURC native/USD amounts unavailable with ambiguous event identity, regardless of current quotes", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.stablecoin === "EURC" && candidate.chain.chainId === "ethereum")!;
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "eurc-unproved", stablecoin: "EURC", chain_id: "ethereum",
      config_key: config.configKey, contract_address: config.contractAddress,
    })]);
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      response: new Response(null, { status: 200 }), body: { result: "0x989680" },
    });
    const result = await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget());
    expect(result).toMatchObject({ attempted: 1, resolved: 0, retried: 0, unrecoverable: 1 });
    expect(sqlite.prepare(`SELECT amount_native, amount_usd_at_event, amount_status, suppression_reason,
      amount_last_error_class FROM blacklist_events WHERE id = 'eurc-unproved'`).get()).toEqual({
      amount_native: null, amount_usd_at_event: null, amount_status: "permanently_unavailable",
      suppression_reason: null, amount_last_error_class: "event_time_unreconciled",
    });
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status FROM blacklist_amount_repair_queue WHERE event_id = 'eurc-unproved'").get())
      .toEqual({ status: "unrecoverable" });
    expect(await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget()))
      .toMatchObject({ attempted: 0 });
  });

  it("keeps a transient destroy receipt failure retryable", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "destroy-transient", stablecoin: "USDT", chain_id: "ethereum", event_type: "destroy",
      config_key: recoveryConfig.configKey, contract_address: recoveryConfig.contractAddress,
    })]);
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(receiptResponse(null));
    expect(await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget()))
      .toMatchObject({ attempted: 1, retried: 1, unrecoverable: 0 });
    expect(sqlite.prepare("SELECT amount_status FROM blacklist_events WHERE id = 'destroy-transient'").get())
      .toEqual({ amount_status: "provider_failed" });
    expect(sqlite.prepare("SELECT status FROM blacklist_amount_repair_queue WHERE event_id = 'destroy-transient'").get())
      .toEqual({ status: "retry" });
  });

  it("honors a smaller repair limit for the post-scan maintenance tail", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `row-${i}`,
      chain_id: "ethereum",
      event_type: "blacklist",
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      block_number: 100,
      stablecoin: "USDC",
      tx_hash: `0x${i}`,
      config_key: null,
      contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      amount_attempt_count: 0,
      amount_last_attempted_at: null,
      amount_last_error_class: null,
      amount_last_provider: null,
      amount_source: "unavailable",
      queue_attempt_count: 0,
    }));
    const db = mockD1([
      {
        match: "blacklist-amount-recovery-evm-candidates",
        rows: candidates,
      },
    ]);

    const result = await backfillAmounts(
      db,
      null,
      async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count: 0, limit: 100 } }),
      undefined,
      { maxRows: 10 },
    );

    expect(result).toEqual({
      runtimeBudgetReached: false,
      attempted: 10,
      resolved: 0,
      retried: 0,
      unrecoverable: 10,
    });
    const candidateQuery = db.getHistory().find((entry) =>
      entry.sql.includes("blacklist-amount-recovery-evm-candidates"),
    );
    expect(candidateQuery?.binds).toEqual([3, "[]", 10]);
  });

  it("marks exhausted legacy derived-zero rows permanently unavailable when config cannot be resolved", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "missing-config", stablecoin: "USDC", chain_id: "ethereum",
      config_key: "missing", contract_address: null, amount_native: 0,
      amount_source: "derived", amount_status: "resolved", amount_attempt_count: 2,
    })]);
    const result = await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget());
    expect(result).toMatchObject({ attempted: 1, unrecoverable: 1, resolved: 0 });
    expect(sqlite.prepare(`SELECT amount_native, amount_status, amount_attempt_count, amount_last_error_class
      FROM blacklist_events WHERE id = 'missing-config'`).get()).toEqual({
      amount_native: 0, amount_status: "permanently_unavailable", amount_attempt_count: 3,
      amount_last_error_class: "ambiguous_config",
    });
  });

  it("stops retrying exhausted legacy derived-zero rows after the final failed recovery attempt", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "exhausted", stablecoin: "USDC", chain_id: "ethereum", config_key: null,
      contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      amount_native: 0, amount_source: "derived", amount_status: "resolved", amount_attempt_count: 2,
    })]);
    expect(await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget()))
      .toMatchObject({ attempted: 1, unrecoverable: 1 });
    expect(sqlite.prepare(`SELECT amount_native, amount_status, amount_attempt_count, amount_last_error_class
      FROM blacklist_events WHERE id = 'exhausted'`).get()).toEqual({
      amount_native: 0, amount_status: "permanently_unavailable", amount_attempt_count: 3,
      amount_last_error_class: "event_time_unreconciled",
    });
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue WHERE event_id = 'exhausted'").get())
      .toEqual({ status: "unrecoverable", attempt_count: 1 });
    expect(await backfillAmounts(db, null, async <T>(fn: () => Promise<T>) => fn(), makeRunBudget()))
      .toMatchObject({ attempted: 0, unrecoverable: 0 });
  });

  it("selects destroy receipt amounts for the intended affected address", () => {
    const config = makeDestroyConfig();
    const wanted = "0x1111111111111111111111111111111111111111";
    const other = "0x2222222222222222222222222222222222222222";

    const amount = extractDestroyAmountFromReceiptLogs(config, [
      {
        address: config.contractAddress,
        topics: ["0xdestroy"],
        data: "0x" + word(other) + amountWord(999_000000n),
        blockNumber: "0x1",
        timeStamp: "0x1",
        transactionHash: "0xtx",
        logIndex: "0x0",
      },
      {
        address: config.contractAddress,
        topics: ["0xdestroy"],
        data: "0x" + word(wanted) + amountWord(123_000000n),
        blockNumber: "0x1",
        timeStamp: "0x1",
        transactionHash: "0xtx",
        logIndex: "0x1",
      },
    ], wanted);

    expect(amount).toBe(123);
  });

  it("uses an explicit destroy quantity after a transfer, not the transfer quantity", () => {
    const config = makeDestroyConfig();
    const address = "0x1111111111111111111111111111111111111111";
    const identity = { blockNumber: "0x64", transactionHash: "0xabc", timeStamp: "0x65000000" };
    const logs = [{
      ...identity, address: config.contractAddress, logIndex: "0x0",
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x" + word(address), "0x" + "0".repeat(64)],
      data: "0x" + amountWord(20_000000n),
    }, {
      ...identity, address: config.contractAddress, logIndex: "0x1",
      topics: ["0xdestroy"], data: "0x" + word(address) + amountWord(30_000000n),
    }];
    expect(extractDestroyAmountFromReceiptLogs(config, logs, address)).toBe(30);
    expect(extractDestroyAmountFromReceiptLogs(config, [logs[0]], address)).toBeNull();
    expect(extractDestroyAmountFromReceiptLogs(config, [
      ...logs, { ...logs[1], logIndex: "0x2", data: "0x" + word(address) + amountWord(40_000000n) },
    ], address)).toBeNull();
  });

  it.each([false, true])("rejects malformed destroy address padding with indexed=%s", (indexed) => {
    const config = makeDestroyConfig();
    const wanted = "0x1111111111111111111111111111111111111111";
    const malformed = "f".repeat(24) + wanted.slice(2);
    expect(extractDestroyAmountFromReceiptLogs(config, [{
      address: config.contractAddress, topics: indexed ? ["0xdestroy", "0x" + malformed] : ["0xdestroy"],
      data: "0x" + (indexed ? "" : malformed) + amountWord(123_000000n),
      blockNumber: "0x1", timeStamp: "0x1", transactionHash: "0xtx", logIndex: "0x0",
    }], wanted)).toBeNull();
  });

  it("treats short destroy amount data as unresolved instead of zero", () => {
    const config = makeDestroyConfig();
    const wanted = "0x1111111111111111111111111111111111111111";

    const amount = extractDestroyAmountFromReceiptLogs(config, [
      {
        address: config.contractAddress,
        topics: ["0xdestroy"],
        data: "0x" + word(wanted),
        blockNumber: "0x1",
        timeStamp: "0x1",
        transactionHash: "0xtx",
        logIndex: "0x0",
      },
    ], wanted);

    expect(amount).toBeNull();
  });
});
