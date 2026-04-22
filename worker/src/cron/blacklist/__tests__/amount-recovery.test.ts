import { describe, expect, it } from "vitest";
import { backfillAmounts, enrichRowBalances } from "../amount-recovery";
import { shouldSuppressAsMirrorZero } from "../shared";
import { mockD1 } from "../../../api/__tests__/helpers/mock-d1";
import type { BlacklistRow } from "../shared";
import { chainConfig, type ContractEventConfig } from "../../../lib/blacklist-contracts";
import type { BlacklistRunBudget } from "../run-budget";

function makeConfig(): ContractEventConfig {
  return {
    stablecoin: "USDC",
    stablecoinId: "usdc-circle",
    chain: chainConfig("ethereum"),
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    events: [{ signature: "Blacklisted(address)", eventType: "blacklist", topicHash: "0x00", hasAmount: false, addressTopicIndex: 1 }],
    configKey: "USDC:ethereum",
  };
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

describe("enrichRowBalances", () => {
  it("keeps EURC mirror-zero suppression explicit", () => {
    expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0)).toBe(true);
    expect(shouldSuppressAsMirrorZero("EURC", "destroy", 0)).toBe(false);
    expect(shouldSuppressAsMirrorZero("USDC", "blacklist", 0)).toBe(false);
  });

  it("excludes Tron rows from the EVM recovery query", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [],
      },
    ]);
    const limiter = async <T>(fn: () => Promise<T>) => fn();

    await backfillAmounts(db, null, null, limiter, makeRunBudget());

    expect(db.getHistory()[0]?.sql).toContain("AND chain_id != 'tron'");
  });

  it("values rows that already have native amounts without provider calls", async () => {
    const rows = [makeRow({ amount_native: 12.5 })];
    const limiter = async () => {
      throw new Error("provider should not be called");
    };
    const result = await enrichRowBalances(
      rows,
      makeConfig(),
      null,
      null,
      limiter,
      makeRunBudget(),
      undefined,
      undefined,
      1,
    );

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_usd_at_event).toBe(12.5);
  });

  it("marks runtime budget exhaustion without provider calls", async () => {
    const rows = [makeRow()];
    const limiter = async () => {
      throw new Error("provider should not be called");
    };
    const result = await enrichRowBalances(
      rows,
      makeConfig(),
      null,
      null,
      limiter,
      makeRunBudget({ deadlineMs: Date.now() - 1 }),
    );

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_last_error_class).toBe("runtime_budget");
    expect(rows[0].amount_last_provider).toBe("none");
  });
});
