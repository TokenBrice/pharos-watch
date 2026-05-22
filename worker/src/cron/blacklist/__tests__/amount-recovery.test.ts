import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../balance-providers", () => ({
  fetchEvmTokenBalance: vi.fn(),
}));

import {
  backfillAmounts,
  enrichRowBalances,
  extractDestroyAmountFromReceiptLogs,
} from "../amount-recovery";
import { fetchEvmTokenBalance } from "../balance-providers";
import { shouldSuppressAsMirrorZero } from "../shared";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
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

describe("enrichRowBalances", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmTokenBalance).mockReset().mockResolvedValue(null);
  });

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
    const result = await enrichRowBalances({
      rows,
      config: makeConfig(),
      etherscanApiKey: null,
      drpcApiKey: null,
      etherscanLimiter: limiter,
      runBudget: makeRunBudget(),
      assetPriceUsd: 1,
    });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_usd_at_event).toBe(12.5);
  });

  it("marks runtime budget exhaustion without provider calls", async () => {
    const rows = [makeRow()];
    const limiter = async () => {
      throw new Error("provider should not be called");
    };
    const result = await enrichRowBalances({
      rows,
      config: makeConfig(),
      etherscanApiKey: null,
      drpcApiKey: null,
      etherscanLimiter: limiter,
      runBudget: makeRunBudget({ deadlineMs: Date.now() - 1 }),
    });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(rows[0].amount_last_error_class).toBe("runtime_budget");
    expect(rows[0].amount_last_provider).toBe("none");
  });

  it("rethrows provider aborts instead of marking amount recovery as failed", async () => {
    vi.mocked(fetchEvmTokenBalance).mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(enrichRowBalances({
      rows: [makeRow()],
      config: makeConfig(),
      etherscanApiKey: null,
      drpcApiKey: "drpc-key",
      etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
      runBudget: makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("records inferred provider telemetry instead of a hard-coded dRPC label", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "row-1",
          chain_id: "ethereum",
          event_type: "blacklist",
          address: "0x1111111111111111111111111111111111111111",
          block_number: 100,
          stablecoin: "USDC",
          tx_hash: "0xabc",
          config_key: null,
          contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          amount_attempt_count: 0,
          amount_last_attempted_at: null,
          amount_last_error_class: null,
          amount_last_provider: null,
          amount_source: "event",
        }],
      },
    ]);

    await backfillAmounts(
      db,
      "etherscan-key",
      null,
      async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    );

    const update = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE blacklist_events") && entry.sql.includes("amount_last_provider"),
    );
    expect(update?.binds).toContain("etherscan");
    expect(update?.binds).not.toContain("drpc");
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
