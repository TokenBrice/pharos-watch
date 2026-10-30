import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBlacklistAmountGapStatus } from "@shared/lib/blacklist";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { backfillAmounts } from "../../../lib/blacklist/amount-recovery";
import { recoverEvmBracketAmount } from "../../../lib/blacklist/evm-amount-recovery";
import { MAX_LEGACY_EVM_REVIEW_ATTEMPTS } from "../../../lib/blacklist/amount-repair-queue";
import { getBlacklistConfigsForSymbolAndChain } from "../../../lib/blacklist-contracts";
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import type { BlacklistAmountStatus } from "@shared/types/market";
import { insertBlacklistRows } from "../persistence";
import { makePendingBlacklistRow } from "./blacklist.test-support";

vi.mock("../../../lib/blacklist/evm-amount-recovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/blacklist/evm-amount-recovery")>(),
  recoverEvmBracketAmount: vi.fn(),
}));

const fixtures = createLatestSchemaFixtureTracker();
const [config] = getBlacklistConfigsForSymbolAndChain("EURC", "ethereum");
const tx = `0x${"ab".repeat(32)}`;
const id = `ethereum-${tx}-0x2`;
const limiter = async <T>(fn: () => Promise<T>) => fn();

function legacyRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return makePendingBlacklistRow({
    id, tx_hash: tx, stablecoin: "EURC", chain_id: "ethereum", event_type: "blacklist",
    address: "0x1111111111111111111111111111111111111111", block_number: 100,
    amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven",
    config_key: config.configKey, contract_address: config.contractAddress,
    ...overrides,
  });
}

function runBudget(): BlacklistRunBudget {
  return { subrequestBudget: { count: 0, limit: 20 }, deadlineMs: Date.now() + 10_000, minimumConfigWindowMs: 0 };
}

beforeEach(() => {
  vi.mocked(recoverEvmBracketAmount).mockReset().mockResolvedValue({
    amount: null, lastErrorClass: "provider_null", lastProvider: "chain_rpc",
  });
});
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("legacy EVM event-time re-review", () => {
  it.each([0, 25])("automatically resolves an unchanged legacy generation to %s without mirror suppression", async (amount) => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [legacyRow()]);
    vi.mocked(recoverEvmBracketAmount).mockResolvedValue({ amount, lastErrorClass: null, lastProvider: "chain_rpc" });

    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 1, resolved: 1, retried: 0 });
    expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = ?").get(id)).toMatchObject({
      amount_native: amount, amount_usd_at_event: null, amount_source: "historical_balance",
      amount_status: "resolved", amount_last_error_class: null, suppression_reason: null,
    });
    expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = ?").get(id)).toMatchObject({
      status: "resolved", attempt_count: 1,
    });
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(1);
  });

  it("bounds provider failures by queue attempts while remaining outside amount-gap statuses", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [legacyRow({ amount_attempt_count: 25 })]);
    for (let attempt = 1; attempt <= MAX_LEGACY_EVM_REVIEW_ATTEMPTS; attempt++) {
      expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({
        attempted: 1, resolved: 0, retried: attempt < MAX_LEGACY_EVM_REVIEW_ATTEMPTS ? 1 : 0,
        unrecoverable: attempt === MAX_LEGACY_EVM_REVIEW_ATTEMPTS ? 1 : 0,
      });
      const event = sqlite.prepare("SELECT amount_status, amount_native, amount_attempt_count, amount_last_error_class FROM blacklist_events WHERE id = ?")
        .get(id) as { amount_status: BlacklistAmountStatus; amount_native: number | null; amount_attempt_count: number; amount_last_error_class: string };
      expect(event).toEqual({
        amount_status: "permanently_unavailable", amount_native: null,
        amount_attempt_count: 25 + attempt, amount_last_error_class: "event_time_unproven",
      });
      expect(isBlacklistAmountGapStatus(event.amount_status)).toBe(false);
      expect(sqlite.prepare("SELECT status, attempt_count, last_error_class FROM blacklist_amount_repair_queue WHERE event_id = ?").get(id)).toEqual({
        status: attempt === MAX_LEGACY_EVM_REVIEW_ATTEMPTS ? "unrecoverable" : "retry",
        attempt_count: attempt, last_error_class: "provider_null",
      });
      if (attempt < MAX_LEGACY_EVM_REVIEW_ATTEMPTS) {
        expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0 });
        sqlite.prepare("UPDATE blacklist_amount_repair_queue SET available_at = 0 WHERE event_id = ?").run(id);
      }
    }
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(MAX_LEGACY_EVM_REVIEW_ATTEMPTS);
  });

  it("makes a failed bracket terminal without reopening an amount gap", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [legacyRow()]);
    vi.mocked(recoverEvmBracketAmount).mockResolvedValue({
      amount: null, lastErrorClass: "event_time_unreconciled", lastProvider: "chain_rpc",
    });
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 1, unrecoverable: 1 });
    expect(sqlite.prepare("SELECT amount_status, amount_last_error_class FROM blacklist_events WHERE id = ?").get(id)).toEqual({
      amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unreconciled",
    });
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue WHERE event_id = ?").get(id))
      .toEqual({ status: "unrecoverable", attempt_count: 1 });
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0 });
  });

  it.each(["runtime_budget", "budget_exhausted"] as const)("preserves the review allowance after %s interrupts the bracket", async (lastErrorClass) => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [legacyRow()]);
    vi.mocked(recoverEvmBracketAmount).mockResolvedValue({ amount: null, lastErrorClass, lastProvider: "chain_rpc" });
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0, resolved: 0, retried: 0 });
    expect(sqlite.prepare("SELECT amount_status, amount_last_error_class, amount_attempt_count FROM blacklist_events WHERE id = ?").get(id)).toEqual({
      amount_status: "permanently_unavailable", amount_last_error_class: "event_time_unproven", amount_attempt_count: 0,
    });
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue WHERE event_id = ?").get(id))
      .toEqual({ status: "pending", attempt_count: 0 });
  });

  it("processes successive candidate pages without retrying a raced row", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 130 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}`, timestamp: 1_700_000_000 + index })));
    const newestId = `ethereum-${tx}-0x82`;
    vi.mocked(recoverEvmBracketAmount).mockImplementation(async ({ row }) => {
      if (row.id === newestId) {
        sqlite.prepare("UPDATE blacklist_events SET provenance_source = 'operator-refresh' WHERE id = ?").run(row.id);
      }
      return { amount: null, lastErrorClass: "provider_null", lastProvider: "chain_rpc" };
    });
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };

    expect(await backfillAmounts(db, null, limiter, wide)).toMatchObject({ attempted: 129, retried: 129 });
    const attemptedIds = vi.mocked(recoverEvmBracketAmount).mock.calls.map(([{ row }]) => row.id);
    expect(attemptedIds).toHaveLength(130);
    expect(new Set(attemptedIds).size).toBe(130);
    expect(attemptedIds[0]).toBe(newestId);
    expect(sqlite.prepare("SELECT status, attempt_count FROM blacklist_amount_repair_queue WHERE event_id = ?").get(newestId))
      .toEqual({ status: "pending", attempt_count: 0 });
  });

  it("stops paging when no event CAS applies", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 130 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    vi.mocked(recoverEvmBracketAmount).mockImplementation(async ({ row }) => {
      sqlite.prepare("UPDATE blacklist_events SET provenance_source = 'operator-refresh' WHERE id = ?").run(row.id);
      return { amount: null, lastErrorClass: "provider_null", lastProvider: "chain_rpc" };
    });
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };

    expect(await backfillAmounts(db, null, limiter, wide)).toMatchObject({ attempted: 0 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(100);
    expect(sqlite.prepare("SELECT SUM(attempt_count) AS n FROM blacklist_amount_repair_queue").get()).toEqual({ n: 0 });
  });

  it("stops at the subrequest reserve and leaves deferred rows queued", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 10 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    const reserved = { ...runBudget(), subrequestBudget: { count: 748, limit: 900 } };
    vi.mocked(recoverEvmBracketAmount).mockImplementation(async () => {
      reserved.subrequestBudget.count++;
      return { amount: null, lastErrorClass: "provider_null", lastProvider: "chain_rpc" };
    });

    expect(await backfillAmounts(db, null, limiter, reserved)).toMatchObject({ attempted: 3, retried: 3 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(3);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: 7 });
  });

  it("stops admitting rows when the runtime deadline is reached", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 10 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };
    const now = vi.spyOn(Date, "now");
    vi.mocked(recoverEvmBracketAmount).mockImplementation(async () => {
      now.mockReturnValue(wide.deadlineMs);
      return { amount: null, lastErrorClass: "provider_null", lastProvider: "chain_rpc" };
    });

    expect(await backfillAmounts(db, null, limiter, wide)).toMatchObject({ runtimeBudgetReached: true, attempted: 1, retried: 1 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: 9 });
  });

  it("stops at its repair deadline without reporting maintenance exhaustion", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 130 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };
    const attemptDeadlineMs = nowMs + 1_000;
    vi.mocked(recoverEvmBracketAmount).mockImplementation(async ({ runBudget: proofBudget }) => {
      expect(proofBudget.deadlineMs).toBe(attemptDeadlineMs);
      nowMs += 600;
      return { amount: null, lastErrorClass: nowMs >= attemptDeadlineMs ? "runtime_budget" : "provider_null", lastProvider: "chain_rpc" };
    });

    expect(await backfillAmounts(db, null, limiter, wide, undefined, { attemptDeadlineMs }))
      .toMatchObject({ runtimeBudgetReached: false, repairWindowExhausted: true, attempted: 1, retried: 1 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: 129 });
  });

  it("keeps the 500-row runaway ceiling even when mocked proofs spend no budget", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 520 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };

    expect(await backfillAmounts(db, null, limiter, wide)).toMatchObject({ attempted: 500, retried: 500 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(500);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: 20 });
  });

  it("leaves suppressed and other terminal generations untouched before attempting proof", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, [
      legacyRow({ id: "suppressed" }), legacyRow({ id: "reviewed", amount_last_error_class: "event_time_unreconciled" }),
      legacyRow({ id: "destroy", event_type: "destroy" }), legacyRow({ id: "tron", chain_id: "tron" }),
    ]);
    sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'operator-suppressed' WHERE id = 'suppressed'").run();
    const before = sqlite.prepare("SELECT * FROM blacklist_events ORDER BY id").all();
    expect(await backfillAmounts(db, null, limiter, runBudget())).toMatchObject({ attempted: 0 });
    expect(sqlite.prepare("SELECT * FROM blacklist_events ORDER BY id").all()).toEqual(before);
    expect(recoverEvmBracketAmount).not.toHaveBeenCalled();
  });
});
