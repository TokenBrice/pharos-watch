import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_CONFIGS } from "../../blacklist-contracts";
import type { EtherscanLogEntry } from "../../evm-logs";
import { fetchJsonWithRetry } from "../../fetch-retry";
import { enrichRowBalances, recoverBlacklistAmountForRow } from "../amount-recovery";
import { reconcileEvmEventBalance, type EvmBracketRow } from "../evm-amount-recovery";
import { createBlacklistRunBudget } from "../run-budget";
import { buildBlacklistRow, shouldSuppressAsMirrorZero, type BlacklistRow } from "../shared";

vi.mock("../../fetch-retry", () => ({ fetchJsonWithRetry: vi.fn() }));

const config = CONTRACT_CONFIGS.find((candidate) =>
  candidate.stablecoin === "USDC" && candidate.chain.chainId === "ethereum")!;
const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const txHash = "0x" + "ab".repeat(32);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (value: string) => "0x" + value.slice(2).padStart(64, "0");
const rawWord = (value: bigint) => "0x" + value.toString(16).padStart(64, "0");
const row: EvmBracketRow = {
  id: `ethereum-${txHash}-0x5`, address, block_number: 100, tx_hash: txHash,
};

function pendingRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return { ...buildBlacklistRow({
    id: row.id, stablecoin: config.stablecoin, chain: config.chain, eventType: "blacklist",
    address, amount: null, txHash, blockNumber: row.block_number, timestamp: 1_700_000_000,
    contractAddress: config.contractAddress, configKey: config.configKey, eventSignature: null, eventTopic0: null,
  }), ...overrides };
}

function transfer(index: number, raw: bigint, from = other, to = address): EtherscanLogEntry {
  return {
    address: config.contractAddress, blockNumber: "0x64", transactionHash: txHash,
    logIndex: "0x" + index.toString(16), topics: [transferTopic, word(from), word(to)],
    data: rawWord(raw), timeStamp: "0x65000000",
  };
}

function mockBracket(before: bigint, after: bigint, logs: EtherscanLogEntry[] = []) {
  vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
    const params = new URL(String(url)).searchParams;
    const result = params.get("action") === "eth_call"
      ? rawWord(params.get("tag") === "0x63" ? before : after)
      : logs.filter((log) => params.has("topic1")
        ? log.topics[1] === params.get("topic1") : log.topics[2] === params.get("topic2"));
    return { response: new Response(null, { status: 200 }), body: { status: "1", message: "OK", result } };
  });
}

function recoveryOptions(subrequestLimit = 20) {
  return {
    etherscanApiKey: "test-key", etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
    runBudget: createBlacklistRunBudget({ subrequestLimit, runtimeBudgetMs: 10_000 }),
  };
}

beforeEach(() => { vi.mocked(fetchJsonWithRetry).mockReset(); });

describe("reconcileEvmEventBalance", () => {
  it("proves an unchanged balance, including measured zero", () => {
    expect(reconcileEvmEventBalance(row, config, 12n, 12n, [])).toBe(12n);
    expect(reconcileEvmEventBalance(row, config, 0n, 0n, [])).toBe(0n);
  });

  it("attributes only inbound and outbound transfers preceding the freeze", () => {
    const logs = [transfer(8, 7n), transfer(2, 20n, address, other),
      transfer(7, 30n, address, other), transfer(1, 10n)];
    expect(reconcileEvmEventBalance(row, config, 100n, 67n, logs)).toBe(90n);
  });

  it("deduplicates by transaction and log index and nets self-transfers to zero", () => {
    const inbound = transfer(1, 10n);
    const self = transfer(2, 999n, address, address);
    expect(reconcileEvmEventBalance(row, config, 20n, 30n, [inbound, self, inbound, self])).toBe(30n);
  });

  it("requires exact raw-unit reconciliation above floating-point precision", () => {
    const raw = 2n ** 100n;
    expect(reconcileEvmEventBalance(row, config, raw, raw + 1n, [])).toBeNull();
    expect(reconcileEvmEventBalance(row, config, raw, raw + 1n, [transfer(1, 1n)])).toBe(raw + 1n);
  });

  it("rejects a negative intermediate even when the final bracket reconciles", () => {
    expect(reconcileEvmEventBalance(row, config, 10n, 19n,
      [transfer(1, 11n, address, other), transfer(8, 20n)])).toBeNull();
  });

  it.each([`ethereum-${txHash}-0x05`, `ethereum-${txHash}-0xA`, `ethereum-${txHash}-5`,
    `ethereum-${txHash}-0x5-01`, `ethereum-${txHash}-0x5-extra`, `ethereum-${txHash}-0x20000000000000`,
    `ethereum-0x${"cd".repeat(32)}-0x5`, `arbitrum-${txHash}-0x5`])("rejects ambiguous event identity %s", (id) => {
    expect(reconcileEvmEventBalance({ ...row, id }, config, 10n, 10n, [])).toBeNull();
  });

  it("accepts canonical array-element suffixes", () => {
    expect(reconcileEvmEventBalance({ ...row, id: row.id + "-12" }, config, 10n, 10n, [])).toBe(10n);
  });

  it("rejects inconsistent duplicate data, shared log positions, and transfer/freeze collisions", () => {
    expect(reconcileEvmEventBalance(row, config, 10n, 11n,
      [transfer(1, 1n), transfer(1, 2n)])).toBeNull();
    expect(reconcileEvmEventBalance(row, config, 10n, 12n,
      [transfer(1, 1n), { ...transfer(1, 1n), transactionHash: "0x" + "cd".repeat(32) }])).toBeNull();
    expect(reconcileEvmEventBalance(row, config, 10n, 11n, [transfer(5, 1n)])).toBeNull();
  });

  it.each([
    { address: other }, { blockNumber: "0x65" }, { data: "0x1" }, { removed: true },
    { topics: [transferTopic, "0x" + "f".repeat(64), word(address)] },
  ])("rejects malformed or unrelated transfer evidence %j", (overrides) => {
    expect(reconcileEvmEventBalance(row, config, 10n, 11n, [{ ...transfer(1, 1n), ...overrides }])).toBeNull();
  });

  it("rejects transfer evidence from conflicting block hashes", () => {
    expect(reconcileEvmEventBalance(row, config, 10n, 12n, [
      { ...transfer(1, 1n), blockHash: "0x" + "11".repeat(32) },
      { ...transfer(2, 1n), blockHash: "0x" + "22".repeat(32) },
    ])).toBeNull();
  });
});

describe("EVM bracket recovery", () => {
  it.each(["blacklist", "unblacklist"])("resolves a no-transfer %s with four sequential numbered reads", async (event_type) => {
    mockBracket(12_500000n, 12_500000n);
    const mock = vi.mocked(fetchJsonWithRetry);
    const respond = mock.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    mock.mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      try { return await respond(...args); } finally { active--; }
    });
    const options = recoveryOptions();
    expect(await recoverBlacklistAmountForRow({ ...row, event_type }, config, options)).toEqual({
      amount: 12.5, amountUsd: 12.5, amountSource: "historical_balance", amountStatus: "resolved",
      lastErrorClass: null, lastProvider: "etherscan",
    });
    const queries = vi.mocked(fetchJsonWithRetry).mock.calls.map(([url]) => new URL(String(url)).searchParams);
    expect(queries.map((query) => query.get("action"))).toEqual(["eth_call", "eth_call", "getLogs", "getLogs"]);
    expect(queries.slice(0, 2).map((query) => query.get("tag"))).toEqual(["0x63", "0x64"]);
    expect(queries.slice(2).map((query) => [query.get("fromBlock"), query.get("toBlock")]))
      .toEqual([["100", "100"], ["100", "100"]]);
    expect(queries[2].get("topic1")).toBe(word(address));
    expect(queries[3].get("topic2")).toBe(word(address));
    expect(options.runBudget.subrequestBudget.count).toBe(4);
    expect(peak).toBe(1);
    expect(mock.mock.calls.map(([, , retries]) => retries)).toEqual([0, 0, 0, 0]);
  });

  it("resolves the prefix of a reconciled block rather than either endpoint balance", async () => {
    mockBracket(100_000000n, 67_000000n, [transfer(1, 10_000000n), transfer(2, 20_000000n, address, other),
      transfer(7, 30_000000n, address, other), transfer(8, 7_000000n)]);
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, recoveryOptions()))
      .toMatchObject({ amount: 90, amountUsd: 90, amountSource: "historical_balance", amountStatus: "resolved" });
  });

  it.each(["mismatch", "negative", "identity"])("makes %s proof failure terminal", async (reason) => {
    mockBracket(10n, reason === "mismatch" ? 11n : 10n,
      reason === "negative" ? [transfer(1, 11n, address, other), transfer(8, 11n)] : []);
    const candidate = { ...row, event_type: "blacklist", ...(reason === "identity" ? { id: "ambiguous" } : {}) };
    expect(await recoverBlacklistAmountForRow(candidate, config, recoveryOptions())).toMatchObject({
      amount: null, amountUsd: null, amountSource: "unavailable", amountStatus: "permanently_unavailable",
      lastErrorClass: "event_time_unreconciled",
    });
    if (reason === "identity") expect(fetchJsonWithRetry).not.toHaveBeenCalled();
  });

  it("keeps a provider failure retryable without treating missing logs as an empty block", async () => {
    mockBracket(10n, 10n);
    const mock = vi.mocked(fetchJsonWithRetry);
    const success = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => new URL(String(args[0])).searchParams.get("action") === "getLogs"
      ? { response: new Response(null, { status: 503 }), body: null } : success(...args));
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, recoveryOptions()))
      .toMatchObject({ amount: null, amountStatus: "provider_failed", lastErrorClass: "provider_null" });
  });

  it("treats a provider that ignored the address filter as a retryable fault", async () => {
    mockBracket(10n, 10n);
    const mock = vi.mocked(fetchJsonWithRetry);
    const success = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => new URL(String(args[0])).searchParams.get("action") === "getLogs"
      ? { response: new Response(null, { status: 200 }), body: {
        status: "1", message: "OK", result: [transfer(1, 1n, other, "0x3333333333333333333333333333333333333333")],
      } } : success(...args));
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, recoveryOptions()))
      .toMatchObject({ amount: null, amountStatus: "provider_failed", lastErrorClass: "provider_null" });
  });

  it.each(["error-string", "nonempty", "empty"])("admits only a coherent empty-log claim (%s)", async (claim) => {
    mockBracket(10n, 10n);
    const mock = vi.mocked(fetchJsonWithRetry);
    const success = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => new URL(String(args[0])).searchParams.get("action") === "getLogs"
      ? { response: new Response(null, { status: 200 }), body: {
        status: "0", message: "No records found",
        result: claim === "error-string" ? "rate limit exceeded" : claim === "nonempty" ? [transfer(1, 1n)] : [],
      } } : success(...args));
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, recoveryOptions()))
      .toMatchObject(claim === "empty"
        ? { amountStatus: "resolved", amount: 0.00001, lastErrorClass: null }
        : { amountStatus: "provider_failed", amount: null, lastErrorClass: "provider_null" });
  });

  it("preserves a proven EURC zero and its unavailable historical USD quote without suppression", async () => {
    const eurc = CONTRACT_CONFIGS.find((candidate) =>
      candidate.stablecoin === "EURC" && candidate.chain.chainId === "ethereum")!;
    mockBracket(0n, 0n);
    const candidate = pendingRow({ stablecoin: "EURC", amount_native: null,
      amount_usd_at_event: null, amount_status: "recoverable_pending", amount_source: "unavailable",
      suppression_reason: null });
    expect(await enrichRowBalances({ rows: [candidate], config: eurc, ...recoveryOptions() }))
      .toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(candidate).toMatchObject({ amount_native: 0, amount_usd_at_event: null,
      amount_status: "resolved", amount_source: "historical_balance", suppression_reason: null });
    expect(shouldSuppressAsMirrorZero("EURC", candidate.event_type, candidate.amount_native, candidate.amount_source)).toBe(false);
  });

  it("stops new-row enrichment at the subrequest budget and leaves later rows pending", async () => {
    mockBracket(10_000000n, 10_000000n);
    const rows = [0, 1].map((index) => pendingRow({ id: row.id + `-${index}`,
      amount_native: null, amount_status: "recoverable_pending", amount_source: "unavailable", amount_attempt_count: 0 }));
    const options = recoveryOptions(4);
    expect(await enrichRowBalances({ rows, config, ...options })).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(options.runBudget.subrequestBudget.count).toBe(4);
    expect(rows[1]).toMatchObject({ amount_native: null, amount_status: "recoverable_pending", amount_attempt_count: 0 });
  });

  it("stops a partial bracket before exceeding its subrequest budget", async () => {
    mockBracket(10n, 10n);
    const options = recoveryOptions(3);
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, options))
      .toMatchObject({ amount: null, amountStatus: "provider_failed", lastErrorClass: "budget_exhausted" });
    expect(options.runBudget.subrequestBudget.count).toBe(3);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(3);
  });

  it("does not fetch logs when the deadline expires while waiting for the limiter", async () => {
    mockBracket(10n, 10n);
    const options = recoveryOptions();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let admitted = 0;
    options.etherscanLimiter = async <T>(fn: () => Promise<T>) => {
      if (++admitted === 3) now = options.runBudget.deadlineMs;
      return fn();
    };
    try {
      expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, options))
        .toMatchObject({ amount: null, amountStatus: "provider_failed", lastErrorClass: "runtime_budget" });
      expect(fetchJsonWithRetry).toHaveBeenCalledTimes(2);
      expect(options.runBudget.subrequestBudget.count).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});
