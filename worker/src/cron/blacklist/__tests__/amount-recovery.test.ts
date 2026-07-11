import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../balance-providers", () => ({
  fetchEvmTokenBalance: vi.fn(),
}));

import {
  backfillAmounts,
  backfillTronFromLedger,
  enrichRowBalances,
  extractDestroyAmountFromReceiptLogs,
} from "../amount-recovery";
import { fetchEvmTokenBalance } from "../balance-providers";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
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

  it("backfills Tron ledger amounts by current-balance identity id without correlated LOWER scans", async () => {
    const db = mockD1([
      {
        match: "blacklist-tron-ledger-backfill-candidates",
        rows: [{
          id: "tron-row-1",
          stablecoin: "USDT",
          chain_id: "tron",
          address: "TBlacklisted",
          config_key: "tron-contract",
          contract_address: "TRONCONTRACT",
        }],
      },
      {
        match: "blacklist-tron-ledger-balance-lookup",
        rows: [{
          id: "USDT:tron:troncontract:tron-contract:tblacklisted",
          amount_native: 25,
          amount_usd: 25,
        }],
      },
      {
        match: "blacklist-tron-ledger-backfill-update",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

    const result = await backfillTronFromLedger(db);

    expect(result.updated).toBe(1);
    const history = db.getHistory();
    const sql = history.map((entry) => entry.sql).join("\n");
    expect(sql).not.toContain("LOWER(");
    expect(sql).toContain("FROM blacklist_current_balances");
    expect(sql).toContain("WHERE id IN");
    const candidateScan = history.find((entry) => entry.sql.includes("blacklist-tron-ledger-backfill-candidates"));
    expect(candidateScan?.sql).toContain("LIMIT ?");
    expect(candidateScan?.binds).toEqual([100]);
    const lookup = history.find((entry) => entry.sql.includes("blacklist-tron-ledger-balance-lookup"));
    expect(lookup?.binds).toContain("USDT:tron:troncontract:tron-contract:tblacklisted");
    const update = history.find((entry) => entry.sql.includes("blacklist-tron-ledger-backfill-update"));
    expect(update?.binds).toEqual([25, 25, expect.any(Number), "tron-row-1"]);
  });

  it("commits already-fetched Tron ledger balances when the budget is reached mid-loop", async () => {
    // 50 candidates -> 100 unique balance ids -> 2 lookup chunks (size 90).
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      id: `tron-row-${i}`,
      stablecoin: "USDT",
      chain_id: "tron",
      address: `TBlacklisted${i}`,
      config_key: "tron-contract",
      contract_address: "TRONCONTRACT",
    }));
    const scopedKey = (c: (typeof candidates)[number]) =>
      buildBlacklistContractBalanceKey(c.stablecoin as Parameters<typeof buildBlacklistContractBalanceKey>[0], c.chain_id, c.address, c.config_key, c.contract_address);
    const balanceRows = candidates.map((c) => ({ id: scopedKey(c), amount_native: 7, amount_usd: 7 }));

    const db = mockD1([
      { match: "blacklist-tron-ledger-backfill-candidates", rows: candidates },
      { match: "blacklist-tron-ledger-balance-lookup", rows: balanceRows },
      { match: "blacklist-tron-ledger-backfill-update", rows: [], runMeta: { changes: 1 } },
    ]);

    // Budget reads as "not reached" until the first balance-lookup query runs,
    // then flips reached so the second chunk loop iteration breaks.
    const runBudget = {
      subrequestBudget: { count: 0, limit: 1000 },
      minimumConfigWindowMs: 0,
      get deadlineMs() {
        const lookupRan = db.getHistory().some((entry) =>
          entry.sql.includes("blacklist-tron-ledger-balance-lookup"),
        );
        return lookupRan ? Date.now() - 1 : Date.now() + 10_000;
      },
    } as unknown as BlacklistRunBudget;

    const result = await backfillTronFromLedger(db, { runBudget });

    // Previously returned { updated: 0 }, discarding the first chunk's fetched balances.
    expect(result.updated).toBeGreaterThan(0);
    const history = db.getHistory();
    const lookupCount = history.filter((entry) =>
      entry.sql.includes("blacklist-tron-ledger-balance-lookup"),
    ).length;
    expect(lookupCount).toBe(1); // second chunk skipped after budget reached
    const updateCount = history.filter((entry) =>
      entry.sql.includes("blacklist-tron-ledger-backfill-update"),
    ).length;
    expect(updateCount).toBeGreaterThan(0); // accumulated matches were committed
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

  it("reuses cached asset price lookups per stablecoin during a recovery run", async () => {
    vi.mocked(fetchEvmTokenBalance).mockResolvedValue(10);
    const makeCandidate = (id: string, address: string) => ({
      id,
      chain_id: "ethereum",
      event_type: "blacklist",
      address,
      block_number: 100,
      stablecoin: "EURC",
      tx_hash: `0x${id}`,
      config_key: null,
      contract_address: null,
      amount_attempt_count: 0,
      amount_last_attempted_at: null,
      amount_last_error_class: null,
      amount_last_provider: null,
      amount_source: "event",
    });
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [
          makeCandidate("row-1", "0x1111111111111111111111111111111111111111"),
          makeCandidate("row-2", "0x2222222222222222222222222222222222222222"),
        ],
      },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 1.2, updated_at: Math.floor(Date.now() / 1000) }],
      },
    ]);

    await backfillAmounts(
      db,
      null,
      null,
      async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    );

    const history = db.getHistory();
    const priceLookups = history.filter((entry) => entry.sql.includes("FROM price_cache WHERE asset_id = ?"));
    expect(priceLookups).toHaveLength(1);
    expect(priceLookups[0]?.binds).toEqual(["eurc-circle"]);

    const resolvedUpdates = history.filter((entry) =>
      entry.sql.includes("UPDATE blacklist_events") &&
      entry.sql.includes("amount_usd_at_event = ?") &&
      entry.sql.includes("amount = ?"),
    );
    expect(resolvedUpdates).toHaveLength(2);
    expect(resolvedUpdates.map((entry) => entry.binds[2])).toEqual([12, 12]);
  });

  it("marks exhausted legacy derived-zero rows permanently unavailable when config cannot be resolved", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "row-1",
          chain_id: "ethereum",
          event_type: "blacklist",
          address: "0x1111111111111111111111111111111111111111",
          block_number: 100,
          stablecoin: "UNKNOWN",
          tx_hash: "0xabc",
          config_key: null,
          contract_address: null,
          amount_attempt_count: 2,
          amount_last_attempted_at: null,
          amount_last_error_class: null,
          amount_last_provider: null,
          amount_source: "derived",
        }],
      },
    ]);

    await backfillAmounts(
      db,
      null,
      null,
      async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    );

    const update = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE blacklist_events")
      && entry.sql.includes("amount_status = ?"),
    );
    expect(update?.binds).toEqual([
      expect.any(Number),
      "config_missing",
      "none",
      "permanently_unavailable",
      "row-1",
    ]);
  });

  it("stops retrying exhausted legacy derived-zero rows after the final failed recovery attempt", async () => {
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
          amount_attempt_count: 2,
          amount_last_attempted_at: null,
          amount_last_error_class: null,
          amount_last_provider: null,
          amount_source: "derived",
        }],
      },
    ]);

    await backfillAmounts(
      db,
      null,
      null,
      async <T>(fn: () => Promise<T>) => fn(),
      makeRunBudget({ subrequestBudget: { count: 0, limit: 10 } }),
    );

    const candidateQuery = db.getHistory().find((entry) =>
      entry.sql.includes("blacklist-amount-recovery-evm-candidates"),
    );
    expect(candidateQuery?.sql).toContain("COALESCE(events.amount_attempt_count, 0) < ?");
    expect(candidateQuery?.binds).toEqual([3, 100]);

    const update = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE blacklist_events")
      && entry.sql.includes("amount_status = ?")
      && !entry.sql.includes("amount = ?"),
    );
    expect(update?.binds).toEqual([
      expect.any(Number),
      "provider_null",
      "chain_rpc",
      "permanently_unavailable",
      "row-1",
    ]);
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
