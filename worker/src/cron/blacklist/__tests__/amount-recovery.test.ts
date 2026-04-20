import { describe, expect, it } from "vitest";
import { enrichRowBalances } from "../amount-recovery";
import type { BlacklistRow } from "../shared";
import { chainConfig, type ContractEventConfig } from "../../../lib/blacklist-contracts";

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

describe("enrichRowBalances", () => {
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
      { count: 0, limit: 1 },
      Date.now() + 10_000,
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
      { count: 0, limit: 1 },
      Date.now() - 1,
    );

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_last_error_class).toBe("runtime_budget");
    expect(rows[0].amount_last_provider).toBe("none");
  });
});
