import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/blacklist/tron-replay-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/blacklist/tron-replay-provider")>()),
  fetchTronHeadBlock: vi.fn(),
  fetchTronRawTokenBalance: vi.fn(),
  fetchTronTransactionInfo: vi.fn(),
  fetchTronTransferWindow: vi.fn(),
}));
vi.mock("../../../lib/circuit-breaker", () => ({
  recordOutcomeSafe: vi.fn().mockResolvedValue(null),
}));

import {
  backfillTronBlacklistAmounts,
  recoverTronFreezeAmountForRow,
  resolveQueueOutcomeForFailure,
  sumSignedTransfers,
  type TronReplayRow,
} from "../../../lib/blacklist/tron-amount-recovery";
import {
  TronReplayProviderError,
  fetchTronHeadBlock,
  fetchTronRawTokenBalance,
  fetchTronTransactionInfo,
  fetchTronTransferWindow,
  type TronTransferWindow,
} from "../../../lib/blacklist/tron-replay-provider";
import { recordOutcomeSafe } from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { createBudget, createRateLimiter } from "../../../lib/evm-logs";
import { getBlacklistConfigByKey } from "../../../lib/blacklist-contracts";
import { tronBase58ToHex, tronHexAddressToBase58 } from "../../../lib/tron-address";
import { mockD1 } from "@shared/test-utils/mock-d1";

const TRON_USDT_CONFIG_ID = "tron-tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t";
const FREEZE_ADDRESS = "0x6f566c6d608550fb50c9365bdb6665e1c8e53caa";
const FREEZE_TX = "0f5dc79bc6b27530e8bd50f89d256146d3186b13f053cc6fb52791eaac3335e6";
const FREEZE_BLOCK = 86_476_871;
const FREEZE_SECONDS = 1_790_102_928;
const FREEZE_MS = FREEZE_SECONDS * 1000;
const ANCHOR_MS = FREEZE_MS + 20 * 60_000;
const SETTLE_HEAD_MS = ANCHOR_MS + 3_000;

const resolvedConfig = getBlacklistConfigByKey(TRON_USDT_CONFIG_ID);
if (!resolvedConfig) throw new Error("Tron USDT config missing from the registry");
const config = resolvedConfig;
const resolvedFreezeTopic = config.events.find((event) => event.eventType === "blacklist" && !event.hasAmount)?.topicHash;
if (!resolvedFreezeTopic) throw new Error("Tron USDT blacklist topic missing from the registry");
const freezeTopic = resolvedFreezeTopic;

type Flow = { timestampMs: number; value: bigint; direction: "in" | "out" };

async function makeRow(overrides: Partial<TronReplayRow> = {}): Promise<TronReplayRow> {
  return {
    id: `tron-${FREEZE_TX}-1`,
    stablecoin: "USDT",
    event_type: "blacklist",
    address: FREEZE_ADDRESS,
    tx_hash: FREEZE_TX,
    block_number: FREEZE_BLOCK,
    timestamp: FREEZE_SECONDS,
    config_key: TRON_USDT_CONFIG_ID,
    contract_address: config.contractAddress,
    queue_attempt_count: 0,
    ...overrides,
  };
}

function provider() {
  return {
    apiKey: "tron-key",
    limiter: <T,>(fn: () => Promise<T>) => fn(),
    budget: createBudget(1000),
    pagesFetched: { count: 0 },
  };
}

interface StubOptions {
  settleFlows?: Flow[];
  balance?: bigint;
  ledgerComplete?: boolean;
  ledgerStopped?: boolean;
  settleComplete?: boolean;
  settleStopped?: boolean;
  receiptTimestampMs?: number;
  captureMaxPages?: number[];
  consumeLedgerPages?: number;
}

async function stubEvidence(flows: Flow[], overrides: StubOptions = {}) {
  const account = await tronHexAddressToBase58(FREEZE_ADDRESS);
  const tokenHex = await tronBase58ToHex(config.contractAddress);
  if (!account || !tokenHex) throw new Error("address encoding unavailable");
  const counterparty = "T-Counterparty";
  const toTransfers = (source: Flow[]) =>
    source.map((flow) => ({
      // Identity keyed on flow content, so repeating a flow repeats its identity
      // exactly the way a duplicated provider record does.
      transactionId: `tx-${flow.direction}-${flow.timestampMs}-${flow.value}`,
      timestampMs: flow.timestampMs,
      from: flow.direction === "in" ? counterparty : account,
      to: flow.direction === "in" ? account : counterparty,
      value: flow.value,
    }));
  const net = (source: Flow[]) =>
    source.reduce((total, flow) => total + (flow.direction === "in" ? flow.value : -flow.value), BigInt(0));

  vi.mocked(fetchTronTransactionInfo).mockResolvedValue({
    blockNumber: FREEZE_BLOCK,
    timestampMs: overrides.receiptTimestampMs ?? FREEZE_MS,
    succeeded: true,
    logs: [{
      address: tokenHex.toLowerCase(),
      topics: [freezeTopic, `0x${FREEZE_ADDRESS.slice(2).padStart(64, "0")}`],
    }],
  });
  let headCalls = 0;
  vi.mocked(fetchTronHeadBlock).mockImplementation(async () => {
    const isAnchor = headCalls++ % 2 === 0;
    return isAnchor
      ? { blockId: "a".repeat(64), blockNumber: FREEZE_BLOCK + 400, timestampMs: ANCHOR_MS }
      : { blockId: "b".repeat(64), blockNumber: FREEZE_BLOCK + 401, timestampMs: SETTLE_HEAD_MS };
  });
  let ledgerReads = 0;
  vi.mocked(fetchTronTransferWindow).mockImplementation(
    async (_ctx, _account, _contract, minTimestampMs, maxTimestampMs, maxPages): Promise<TronTransferWindow> => {
      overrides.captureMaxPages?.push(maxPages);
      if (minTimestampMs === 0 && maxTimestampMs === ANCHOR_MS) {
        ledgerReads++;
        if (ledgerReads === 1) _ctx.pagesFetched.count += overrides.consumeLedgerPages ?? 0;
        return {
          transfers: toTransfers(flows),
          watermarkMs: maxTimestampMs + 60_000,
          complete: overrides.ledgerComplete ?? true,
          stopped: overrides.ledgerStopped ?? false,
        };
      }
      const settleFlows = overrides.settleFlows ?? [];
      return {
        transfers: toTransfers(settleFlows),
        watermarkMs: overrides.settleComplete === false ? SETTLE_HEAD_MS - 1 : maxTimestampMs + 60_000,
        complete: overrides.settleComplete ?? true,
        stopped: overrides.settleStopped ?? false,
      };
    },
  );
  vi.mocked(fetchTronRawTokenBalance).mockResolvedValue(overrides.balance ?? net(flows));
}

function makeRunBudget(overrides: { subrequestLimit?: number; deadlineMs?: number } = {}) {
  return {
    subrequestBudget: createBudget(overrides.subrequestLimit ?? 1000),
    deadlineMs: overrides.deadlineMs ?? Date.now() + 60_000,
    minimumConfigWindowMs: 0,
  };
}

const QUEUE_TABLES = [
  { match: "blacklist-amount-repair-queue-enqueue", rows: [] },
  { match: "blacklist-amount-repair-queue-reconcile-resolved", rows: [] },
  { match: "blacklist-amount-repair-queue-finish", rows: [] },
  { match: "price_cache", rows: [], first: null, allowUnused: true },
];

beforeEach(() => {
  vi.mocked(fetchTronTransactionInfo).mockReset();
  vi.mocked(fetchTronHeadBlock).mockReset();
  vi.mocked(fetchTronTransferWindow).mockReset();
  vi.mocked(fetchTronRawTokenBalance).mockReset();
  vi.mocked(recordOutcomeSafe).mockClear().mockResolvedValue(null);
});

describe("sumSignedTransfers", () => {
  it("nets only transfers at or before the bound and flags boundary ambiguity", () => {
    const ledger = [
      { transactionId: "a", timestampMs: 1_000, from: "T1", to: "account", value: BigInt(500) },
      { transactionId: "b", timestampMs: 2_000, from: "account", to: "T1", value: BigInt(200) },
      { transactionId: "c", timestampMs: 3_000, from: "account", to: "T1", value: BigInt(100) },
      { transactionId: "d", timestampMs: 3_000, from: "T1", to: "T2", value: BigInt(7) },
    ];
    const sum = sumSignedTransfers(ledger, "account", 3_000);
    expect(sum.net).toBe(BigInt(200));
    expect(sum.atBoundaryTransfers).toBe(1);
    expect(sum.unrelatedTransfers).toBe(1);
  });
});

describe("resolveQueueOutcomeForFailure", () => {
  it("parks deterministic classes and retries transient ones", () => {
    expect(resolveQueueOutcomeForFailure("history_over_cap", 0)).toBe("park");
    expect(resolveQueueOutcomeForFailure("ambiguous", 0)).toBe("park");
    expect(resolveQueueOutcomeForFailure("provider_unsupported", 0)).toBe("park");
    expect(resolveQueueOutcomeForFailure("provider_http_error", 3)).toBe("retry");
    expect(resolveQueueOutcomeForFailure("evidence_mismatch", 0)).toBe("retry");
    expect(resolveQueueOutcomeForFailure("evidence_mismatch", 1)).toBe("park");
  });
});

describe("recoverTronFreezeAmountForRow", () => {
  it("derives the balance held at the freeze and excludes later receipts", async () => {
    await stubEvidence([
      { timestampMs: FREEZE_MS - 60_000, value: BigInt(3_000_000), direction: "in" },
      { timestampMs: FREEZE_MS + 30_000, value: BigInt(1_000_000), direction: "in" },
    ]);
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBe(3);
    expect(recovery.lastErrorClass).toBeNull();
  });

  it("refuses to resolve when the ledger does not reconcile with the confirmed balance", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      balance: BigInt(2_500_000),
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("evidence_mismatch");
  });

  it("refuses duplicated transfer records even when the net flow reconciles", async () => {
    const base = { timestampMs: FREEZE_MS - 120_000, value: BigInt(3_000_000), direction: "in" as const };
    const matchedIn = { timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" as const };
    const matchedOut = { timestampMs: FREEZE_MS + 30_000, value: BigInt(2_000_000), direction: "out" as const };
    // The provider repeats the ±2M pair with identical identities. The doubled
    // flows still cancel at the current-balance checkpoint (net 3M), but the
    // duplicated pre-freeze inflow would inflate the derived freeze balance.
    await stubEvidence([base, matchedIn, matchedOut, matchedIn, matchedOut]);
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("evidence_mismatch");
  });

  it("classifies a landing transfer between the ledger and the balance read as a state race", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      settleFlows: [{ timestampMs: ANCHOR_MS + 1_000, value: BigInt(5), direction: "in" }],
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("state_raced");
  });

  it("reports an unprovable settle window as a state race", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      settleComplete: false,
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.lastErrorClass).toBe("state_raced");
  });

  it("treats a transfer inside the freeze millisecond as ambiguous", async () => {
    await stubEvidence([
      { timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" },
      { timestampMs: FREEZE_MS, value: BigInt(10), direction: "in" },
    ]);
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("ambiguous");
  });

  it("separates a ledger over the page cap from a run-window stop", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      ledgerComplete: false,
    });
    const truncated = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(truncated.lastErrorClass).toBe("history_over_cap");

    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      ledgerComplete: false,
      ledgerStopped: true,
    });
    const stopped = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(stopped.lastErrorClass).toBe("runtime_budget");
  });

  it("refuses when the receipt does not match the stored event", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      receiptTimestampMs: FREEZE_MS + 1000,
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("evidence_mismatch");
  });

  it("waits for index runway before trusting a fresh freeze", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }]);
    vi.mocked(fetchTronHeadBlock).mockReset().mockResolvedValue({
      blockId: "b".repeat(64),
      blockNumber: FREEZE_BLOCK + 2,
      timestampMs: FREEZE_MS + 60_000,
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("evidence_mismatch");
  });

  it("classifies provider failures without writing an amount", async () => {
    vi.mocked(fetchTronTransactionInfo).mockRejectedValue(
      new TronReplayProviderError("provider_http_error", "HTTP 503"),
    );
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("provider_http_error");
  });

  it("meters pages consumed before a failing read", async () => {
    const ctx = provider();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }]);
    vi.mocked(fetchTronTransferWindow).mockImplementation(async () => {
      // Simulate two pages already fetched, then a provider failure.
      ctx.pagesFetched.count += 2;
      throw new TronReplayProviderError("provider_http_error", "HTTP 429");
    });

    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, ctx);
    expect(recovery.lastErrorClass).toBe("provider_http_error");
    expect(recovery.pagesUsed).toBe(2);
    expect(ctx.pagesFetched.count).toBe(2);
  });
});

describe("backfillTronBlacklistAmounts", () => {
  it("persists a derived replay with provenance, closes the queue row, and reports the circuit outcome", async () => {
    const row = await makeRow();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }]);
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      ...QUEUE_TABLES,
      { match: "amount_native = ?", rows: [] },
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    expect(result).toMatchObject({ attempted: 1, resolved: 1, retried: 0, parked: 0 });
    const persistence = db.getHistory().find((entry) => entry.sql.includes("amount_native = ?"));
    expect(persistence?.binds[0]).toBe(4.5);
    expect(persistence?.binds[2]).toBe("derived");
    expect(persistence?.binds).toContain("trongrid-transfer-replay");
    // The write must not clobber a row resolved by another writer (operator CLI).
    expect(persistence?.sql).toContain("amount_native IS NULL");
    expect(persistence?.sql).toContain("suppression_reason IS NULL");
    const queueFinish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(queueFinish?.binds[0]).toBe("resolved");
    expect(vi.mocked(recordOutcomeSafe)).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.TRONGRID, true);
  });

  it("refreshes the repair queue before selecting candidates", async () => {
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [] },
      ...QUEUE_TABLES,
    ]);
    await backfillTronBlacklistAmounts(db, {
      trongridApiKey: null,
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-amount-repair-queue-enqueue"))).toBe(true);
  });

  it("records attempt bookkeeping, a bounded retry, and a provider failure outcome", async () => {
    const row = await makeRow();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      balance: BigInt(9_000_000),
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      ...QUEUE_TABLES,
      { match: "amount_attempt_count = COALESCE", rows: [] },
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    expect(result).toMatchObject({ attempted: 1, resolved: 0, retried: 1, parked: 0 });
    expect(db.getHistory().some((entry) => entry.sql.includes("amount_native = ?"))).toBe(false);
    const attempt = db.getHistory().find((entry) => entry.sql.includes("amount_attempt_count = COALESCE"));
    expect(attempt?.binds[1]).toBe("evidence_mismatch");
    expect(attempt?.binds[2]).toBe("trongrid");
    expect(attempt?.binds[3]).toBe("provider_failed");
    expect(attempt?.sql).toContain("amount_native IS NULL");
    const queueFinish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(queueFinish?.binds[0]).toBe("retry");
  });

  it("parks deterministic failures instead of retrying them every run", async () => {
    const row = await makeRow({ queue_attempt_count: 2 });
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      ledgerComplete: false,
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      ...QUEUE_TABLES,
      { match: "amount_attempt_count = COALESCE", rows: [] },
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    expect(result).toMatchObject({ attempted: 1, resolved: 0, retried: 0, parked: 1 });
    const queueFinish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(queueFinish?.binds[0]).toBe("retry");
    const attempt = db.getHistory().find((entry) => entry.sql.includes("amount_attempt_count = COALESCE"));
    expect(attempt?.binds[1]).toBe("history_over_cap");
    // Parked rows keep a far-future due time so they stop consuming the page budget.
    expect(Number(queueFinish?.binds[1])).toBeGreaterThan(Date.now() / 1000 + 6 * 24 * 3600);
  });

  it("does not book an attempt when the chain races the proof window", async () => {
    const row = await makeRow();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      settleFlows: [{ timestampMs: ANCHOR_MS + 1_000, value: BigInt(5), direction: "in" }],
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      ...QUEUE_TABLES,
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    expect(result).toMatchObject({ attempted: 0, resolved: 0, retried: 0, parked: 0 });
    expect(db.getHistory().some((entry) => entry.sql.includes("amount_attempt_count = COALESCE"))).toBe(false);
    expect(vi.mocked(recordOutcomeSafe)).not.toHaveBeenCalled();
  });

  it("clamps each row's page cap to the remaining run page budget", async () => {
    const rows = [await makeRow(), await makeRow({ id: `tron-${FREEZE_TX}-2` })];
    const captureMaxPages: number[] = [];
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      captureMaxPages,
      consumeLedgerPages: 100,
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: rows as unknown as Array<Record<string, unknown>> },
      ...QUEUE_TABLES,
      { match: "amount_native = ?", rows: [] },
    ]);

    await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    // Two window reads per row: the ledger (clamped to the remaining budget) and the settle window.
    // The first ledger read consumes 100 of the 120-page run budget, so the second
    // row's ledger and settle caps must shrink to the 20 pages left.
    expect(captureMaxPages[0]).toBe(40);
    expect(captureMaxPages[2]).toBe(20);
    expect(captureMaxPages[3]).toBe(20);
  });

  it("shrinks the settle window's page cap to the pages left in the run", async () => {
    const captureMaxPages: number[] = [];
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      captureMaxPages,
      consumeLedgerPages: 110,
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [await makeRow() as unknown as Record<string, unknown>] },
      ...QUEUE_TABLES,
      { match: "amount_native = ?", rows: [] },
    ]);

    await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });

    // 120-page run budget: the ledger read is capped at 40 and consumes 110, so the
    // settle read that follows may only spend the 10 pages still left.
    expect(captureMaxPages).toEqual([40, 10]);
  });

  it("does nothing when no Tron freeze row is outstanding", async () => {
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [] },
      ...QUEUE_TABLES,
    ]);
    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: null,
      limiter: createRateLimiter(1000),
      runBudget: makeRunBudget(),
    });
    expect(result).toMatchObject({ attempted: 0, resolved: 0, retried: 0, parked: 0 });
    expect(vi.mocked(fetchTronTransactionInfo)).not.toHaveBeenCalled();
  });
});
