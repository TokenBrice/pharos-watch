import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/blacklist/tron-replay-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/blacklist/tron-replay-provider")>()),
  fetchTronHeadBlock: vi.fn(),
  fetchTronRawTokenBalance: vi.fn(),
  fetchTronTransactionInfo: vi.fn(),
  fetchTronTransferWindow: vi.fn(),
}));

import {
  backfillTronBlacklistAmounts,
  recoverTronFreezeAmountForRow,
  sumSignedTransfers,
  type TronReplayRow,
} from "../../../lib/blacklist/tron-amount-recovery";
import {
  TronReplayProviderError,
  fetchTronHeadBlock,
  fetchTronRawTokenBalance,
  fetchTronTransactionInfo,
  fetchTronTransferWindow,
} from "../../../lib/blacklist/tron-replay-provider";
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

const resolvedConfig = getBlacklistConfigByKey(TRON_USDT_CONFIG_ID);
if (!resolvedConfig) throw new Error("Tron USDT config missing from the registry");
const config = resolvedConfig;
const resolvedFreezeTopic = config.events.find((event) => event.eventType === "blacklist" && !event.hasAmount)?.topicHash;
if (!resolvedFreezeTopic) throw new Error("Tron USDT blacklist topic missing from the registry");
const freezeTopic = resolvedFreezeTopic;

type Transfer = { timestampMs: number; from: string; to: string; value: bigint };
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
  return { apiKey: "tron-key", limiter: createRateLimiter(1000), budget: createBudget(1000) };
}

async function stubEvidence(
  flows: Flow[],
  overrides: { balance?: bigint; complete?: boolean; receiptTimestampMs?: number } = {},
) {
  const account = await tronHexAddressToBase58(FREEZE_ADDRESS);
  const tokenHex = await tronBase58ToHex(config.contractAddress);
  if (!account || !tokenHex) throw new Error("address encoding unavailable");
  const counterparty = "T-Counterparty";
  const transfers: Transfer[] = flows.map((flow) => ({
    timestampMs: flow.timestampMs,
    from: flow.direction === "in" ? counterparty : account,
    to: flow.direction === "in" ? account : counterparty,
    value: flow.value,
  }));
  vi.mocked(fetchTronTransactionInfo).mockResolvedValue({
    blockNumber: FREEZE_BLOCK,
    timestampMs: overrides.receiptTimestampMs ?? FREEZE_MS,
    succeeded: true,
    logs: [{
      address: tokenHex.toLowerCase(),
      topics: [freezeTopic, `0x${FREEZE_ADDRESS.slice(2).padStart(64, "0")}`],
    }],
  });
  vi.mocked(fetchTronHeadBlock).mockResolvedValue({
    blockId: "a".repeat(64),
    blockNumber: FREEZE_BLOCK + 400,
    timestampMs: FREEZE_MS + 20 * 60_000,
  });
  vi.mocked(fetchTronTransferWindow).mockResolvedValue({
    transfers,
    watermarkMs: FREEZE_MS + 30 * 60_000,
    complete: overrides.complete ?? true,
    pages: 1,
  });
  const net = flows.reduce(
    (total, flow) => total + (flow.direction === "in" ? flow.value : -flow.value),
    BigInt(0),
  );
  vi.mocked(fetchTronRawTokenBalance).mockResolvedValue(overrides.balance ?? net);
}

beforeEach(() => {
  vi.mocked(fetchTronTransactionInfo).mockReset();
  vi.mocked(fetchTronHeadBlock).mockReset();
  vi.mocked(fetchTronTransferWindow).mockReset();
  vi.mocked(fetchTronRawTokenBalance).mockReset();
});

describe("sumSignedTransfers", () => {
  it("nets only transfers at or before the bound and flags boundary ambiguity", () => {
    const ledger = [
      { timestampMs: 1_000, from: "T1", to: "account", value: BigInt(500) },
      { timestampMs: 2_000, from: "account", to: "T1", value: BigInt(200) },
      { timestampMs: 3_000, from: "account", to: "T1", value: BigInt(100) },
      { timestampMs: 3_000, from: "T1", to: "T2", value: BigInt(7) },
    ];
    const sum = sumSignedTransfers(ledger, "account", 3_000);
    expect(sum.net).toBe(BigInt(200));
    expect(sum.atBoundaryTransfers).toBe(1);
    expect(sum.unrelatedTransfers).toBe(1);
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

  it("treats a transfer inside the freeze millisecond as ambiguous", async () => {
    await stubEvidence([
      { timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" },
      { timestampMs: FREEZE_MS, value: BigInt(10), direction: "in" },
    ]);
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("ambiguous");
  });

  it("refuses a truncated confirmed ledger", async () => {
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(2_000_000), direction: "in" }], {
      complete: false,
    });
    const recovery = await recoverTronFreezeAmountForRow(await makeRow(), config, provider());
    expect(recovery.amount).toBeNull();
    expect(recovery.lastErrorClass).toBe("evidence_mismatch");
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
    vi.mocked(fetchTronHeadBlock).mockResolvedValue({
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
});

describe("backfillTronBlacklistAmounts", () => {
  it("persists a derived replay with provenance and closes the queue row", async () => {
    const row = await makeRow();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }]);
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      { match: "blacklist-amount-repair-queue-finish", rows: [] },
      { match: "amount_native = ?", rows: [] },
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: { subrequestBudget: createBudget(1000), deadlineMs: Date.now() + 60_000, minimumConfigWindowMs: 0 },
    });

    expect(result).toMatchObject({ attempted: 1, resolved: 1, retried: 0 });
    const persistence = db.getHistory().find((entry) => entry.sql.includes("amount_native = ?"));
    expect(persistence?.binds[0]).toBe(4.5);
    expect(persistence?.binds[2]).toBe("derived");
    expect(persistence?.binds).toContain("trongrid-transfer-replay");
    const queueFinish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(queueFinish?.binds[0]).toBe("resolved");
  });

  it("records attempt bookkeeping and a queue retry when evidence is unprovable", async () => {
    const row = await makeRow();
    await stubEvidence([{ timestampMs: FREEZE_MS - 60_000, value: BigInt(4_500_000), direction: "in" }], {
      balance: BigInt(9_000_000),
    });
    const db = mockD1([
      { match: "blacklist-tron-replay-candidates", rows: [row as unknown as Record<string, unknown>] },
      { match: "blacklist-amount-repair-queue-finish", rows: [] },
      { match: "amount_attempt_count = COALESCE", rows: [] },
      { match: "FROM blacklist_price_cache", rows: [], first: null },
    ]);

    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: "tron-key",
      limiter: createRateLimiter(1000),
      runBudget: { subrequestBudget: createBudget(1000), deadlineMs: Date.now() + 60_000, minimumConfigWindowMs: 0 },
    });

    expect(result).toMatchObject({ attempted: 1, resolved: 0, retried: 1 });
    expect(db.getHistory().some((entry) => entry.sql.includes("amount_native = ?"))).toBe(false);
    const attempt = db.getHistory().find((entry) => entry.sql.includes("amount_attempt_count = COALESCE"));
    expect(attempt?.binds[1]).toBe("evidence_mismatch");
    expect(attempt?.binds[2]).toBe("trongrid");
    expect(attempt?.binds[3]).toBe("provider_failed");
  });

  it("does nothing when no Tron freeze row is outstanding", async () => {
    const db = mockD1([{ match: "blacklist-tron-replay-candidates", rows: [] }]);
    const result = await backfillTronBlacklistAmounts(db, {
      trongridApiKey: null,
      limiter: createRateLimiter(1000),
      runBudget: { subrequestBudget: createBudget(1000), deadlineMs: Date.now() + 60_000, minimumConfigWindowMs: 0 },
    });
    expect(result).toMatchObject({ attempted: 0, resolved: 0, retried: 0 });
    expect(vi.mocked(fetchTronTransactionInfo)).not.toHaveBeenCalled();
  });
});
