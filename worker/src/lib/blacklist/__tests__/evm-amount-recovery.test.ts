import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_CONFIGS } from "../../blacklist-contracts";
import type { EtherscanLogEntry } from "../../evm-logs";
import type { ChainRpcConfig, RpcEndpoint } from "../../chain-registry";
import { fetchJsonWithRetry } from "../../fetch-retry";
import { enrichRowBalances, recoverBlacklistAmountForRow } from "../amount-recovery";
import { reconcileEvmEventBalance, type EvmBracketRow } from "../evm-amount-recovery";
import { createBlacklistRunBudget } from "../run-budget";
import { buildBlacklistRow, shouldSuppressAsMirrorZero, type BlacklistRow } from "../shared";

vi.mock("../../fetch-retry", () => {
  const fetchJsonWithRetry = vi.fn();
  // evm-rpc reads bodies as text first; delegate to the same fixture and
  // stringify its parsed body so the existing Etherscan fixtures keep working.
  const fetchTextWithRetry = vi.fn(async (...args: unknown[]) => {
    const result = await fetchJsonWithRetry(...args) as { body?: unknown } | null;
    if (result && typeof result === "object" && "body" in result) {
      return { ...result, body: typeof result.body === "string" ? result.body : JSON.stringify(result.body) };
    }
    return result;
  });
  return { fetchJsonWithRetry, fetchTextWithRetry };
});

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

const rpcTransfer = (log: EtherscanLogEntry) => ({
  ...log, blockHash: "0x" + "cd".repeat(32), transactionIndex: "0x0", removed: false,
});

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
  function mockRpcBracket(batchResults: unknown[], corrupt?: (rows: Array<{ id: number; result?: unknown; error?: unknown }>) => void) {
    mockBracket(100_000000n, 67_000000n, [transfer(1, 10_000000n), transfer(2, 20_000000n, address, other),
      transfer(7, 30_000000n, address, other), transfer(8, 7_000000n)]);
    const mock = vi.mocked(fetchJsonWithRetry);
    const etherscan = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).hostname === "api.etherscan.io") return etherscan(...args);
      args[3]?.beforeRequest?.();
      const payload = JSON.parse(String(args[1]?.body));
      if (!Array.isArray(payload)) return { response: new Response(null, { status: 503 }), body: null };
      const body = batchResults.map((result, index) => ({ id: index + 1, result }));
      corrupt?.(body);
      return { response: new Response(null, { status: 200 }), body };
    });
  }

  const bracketResults = (): unknown[] => [rawWord(100_000000n), rawWord(67_000000n),
    [rpcTransfer(transfer(2, 20_000000n, address, other)), rpcTransfer(transfer(7, 30_000000n, address, other))],
    [rpcTransfer(transfer(1, 10_000000n)), rpcTransfer(transfer(8, 7_000000n))]];

  it("batches the same event-position proof into one metered request", async () => {
    mockRpcBracket(bracketResults());
    const options = { ...recoveryOptions(), drpcApiKey: "test-drpc" };
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, options))
      .toMatchObject({ amount: 90, amountStatus: "resolved", lastProvider: "drpc" });
    expect(options.runBudget.subrequestBudget.count).toBe(1);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
    const [, init, retries, transport] = vi.mocked(fetchJsonWithRetry).mock.calls[0];
    const calls = JSON.parse(String(init?.body));
    expect(calls.map((call: { method: string }) => call.method)).toEqual(["eth_call", "eth_call", "eth_getLogs", "eth_getLogs"]);
    expect(calls.slice(0, 2).map((call: { params: unknown[] }) => call.params[1])).toEqual(["0x63", "0x64"]);
    expect(calls.slice(2).map((call: { params: unknown[] }) => call.params[0])).toEqual([
      { address: config.contractAddress, fromBlock: "0x64", toBlock: "0x64", topics: [transferTopic, word(address)] },
      { address: config.contractAddress, fromBlock: "0x64", toBlock: "0x64", topics: [transferTopic, null, word(address)] },
    ]);
    expect(retries).toBe(0);
    expect(transport?.deadlineMs).toBe(options.runBudget.deadlineMs);
  });

  it.each(["error", "missing-id", "duplicate-id", "empty-balance", "odd-before-balance", "odd-after-balance", "overflow", "non-array", "malformed", "missing-rpc-fields", "wrong-block", "removed", "unfiltered"])(
    "rejects the whole %s batch and uses fresh sequential Etherscan evidence", async (fault) => {
      const results = bracketResults();
      // Poison valid sibling balances too: a fallback must not retain any batch evidence.
      results[0] = rawWord(999n);
      if (fault === "empty-balance") results[1] = "0x";
      if (fault === "odd-before-balance") results[0] = "0x1";
      if (fault === "odd-after-balance") results[1] = "0x1";
      if (fault === "overflow") results[1] = "0x1" + "0".repeat(64);
      if (fault === "non-array") results[2] = {};
      if (fault === "malformed") results[2] = [{ topics: null }];
      if (fault === "missing-rpc-fields") results[2] = [transfer(1, 1n, address, other)];
      if (fault === "wrong-block") results[2] = [{ ...rpcTransfer(transfer(1, 1n, address, other)), blockNumber: "0x65" }];
      if (fault === "removed") results[2] = [{ ...rpcTransfer(transfer(1, 1n, address, other)), removed: true }];
      if (fault === "unfiltered") results[2] = [rpcTransfer(transfer(1, 1n))];
      mockRpcBracket(results, (rows) => {
        if (fault === "error") rows[2] = { id: 3, error: { code: -1 } };
        if (fault === "missing-id") rows.pop();
        if (fault === "duplicate-id") rows[3].id = 3;
      });
      const options = { ...recoveryOptions(), drpcApiKey: "test-drpc" };
      expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, options))
        .toMatchObject({ amount: 90, amountStatus: "resolved", lastProvider: "etherscan" });
      expect(options.runBudget.subrequestBudget.count).toBe(9); // rejected batch, four rejected RPC reads, four Etherscan reads
    },
  );

  it.each([false, true])("uses shared balance/log endpoints after a rejected dRPC batch (%s)", async (rejectFirst) => {
    let batches = 0;
    mockRpcBracket(bracketResults(), (rows) => { if (rejectFirst && batches++ === 0) rows.pop(); });
    const endpoint = (url: string, overrides: Partial<RpcEndpoint> = {}): RpcEndpoint => ({
      url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full", ...overrides,
    });
    const chainRpcs = new Map<string, ChainRpcConfig>([["ethereum", {
      chainId: "ethereum", chainName: "Ethereum", type: "evm", explorerUrl: "https://etherscan.io",
      endpoints: [endpoint("https://dwellir.test", { operator: "dwellir" }),
        endpoint("https://disabled.test", { routingDisabled: true }),
        endpoint("https://supplemental.test", { position: "supplemental" }),
        endpoint("https://no-batch.test", { noBatch: true }), endpoint("https://shared.test")],
    }]]);
    const options = { ...recoveryOptions(), chainRpcs, drpcApiKey: rejectFirst ? "test-drpc" : null };
    expect(await recoverBlacklistAmountForRow({ ...row, event_type: "blacklist" }, config, options))
      .toMatchObject({ amount: 90, lastProvider: "chain_rpc" });
    expect(vi.mocked(fetchJsonWithRetry).mock.calls.map(([url]) => String(url))).toEqual([
      ...(rejectFirst ? ["https://lb.drpc.org/ogrpc?network=ethereum&dkey=test-drpc"] : []), "https://shared.test",
    ]);
    expect(options.runBudget.subrequestBudget.count).toBe(rejectFirst ? 2 : 1);
  });

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

  it("proves only the ten newest pending EVM rows and leaves deferred attempts untouched", async () => {
    mockRpcBracket(bracketResults());
    const rows = Array.from({ length: 12 }, (_, index) => pendingRow({
      id: row.id + `-${index}`, timestamp: 1_700_000_000 + index,
      amount_attempt_count: 0, amount_last_attempted_at: null,
    }));
    const options = { ...recoveryOptions(100), drpcApiKey: "test-drpc" };
    expect(await enrichRowBalances({ rows, config, ...options })).toEqual({ attempted: 10, succeeded: 10, failed: 0 });
    expect(rows.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount_native: null, amount_status: "recoverable_pending", amount_attempt_count: 0, amount_last_attempted_at: null }),
      expect.objectContaining({ amount_native: null, amount_status: "recoverable_pending", amount_attempt_count: 0, amount_last_attempted_at: null }),
    ]));
    expect(rows.slice(2).every((candidate) => candidate.amount_status === "resolved" && candidate.amount_attempt_count === 1)).toBe(true);
    expect(options.runBudget.subrequestBudget.count).toBe(10);
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
