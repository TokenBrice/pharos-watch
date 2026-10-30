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
afterEach(() => fixtures.closeAll());

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

  it("caps proofs per run and keeps a subrequest reserve, leaving deferred rows queued", async () => {
    const { db, sqlite } = fixtures.open();
    await insertBlacklistRows(db, Array.from({ length: 30 }, (_, index) =>
      legacyRow({ id: `ethereum-${tx}-0x${(index + 1).toString(16)}` })));
    const wide = { ...runBudget(), subrequestBudget: { count: 0, limit: 900 } };
    expect(await backfillAmounts(db, null, limiter, wide)).toMatchObject({ attempted: 25, retried: 25 });
    expect(recoverEvmBracketAmount).toHaveBeenCalledTimes(25);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_amount_repair_queue WHERE status = 'pending'").get())
      .toEqual({ n: 5 });

    vi.mocked(recoverEvmBracketAmount).mockClear();
    const reserved = { ...runBudget(), subrequestBudget: { count: 800, limit: 900 } };
    expect(await backfillAmounts(db, null, limiter, reserved)).toMatchObject({ attempted: 0 });
    expect(recoverEvmBracketAmount).not.toHaveBeenCalled();
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
