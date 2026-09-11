import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudget } from "../../../lib/evm-logs";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { type BlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import { ethereumConfig, makeCacheRow } from "./balance.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

vi.mock("../../../lib/blacklist-current-balances", () => ({
  upsertBlacklistCurrentBalance: vi.fn(),
}));

vi.mock("../../../lib/blacklist/balance-providers", () => ({
  fetchEvmTokenCurrentBalance: vi.fn(),
  fetchTronTokenCurrentBalance: vi.fn(),
}));

import { syncCurrentBalanceCacheForRows } from "../../../lib/blacklist/current-balance-cache";
import { upsertBlacklistCurrentBalance } from "../../../lib/blacklist-current-balances";
import { fetchEvmTokenCurrentBalance } from "../../../lib/blacklist/balance-providers";


const a7a5Config: ContractEventConfig = {
  configKey: "ethereum-0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "a7a5-old-vector",
  stablecoin: "A7A5",
  contractAddress: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  decimals: 6,
  events: [],
};

function makeContext() {
  const runBudget: BlacklistRunBudget = {
    subrequestBudget: createBudget(10),
    deadlineMs: Date.now() + 10_000,
    minimumConfigWindowMs: 0,
  };
  return {
    etherscanApiKey: null,
    drpcApiKey: null,
    trongridApiKey: null,
    etherscanLimiter: async <T>(fn: () => Promise<T>) => fn(),
    tronLimiter: async <T>(fn: () => Promise<T>) => fn(),
    runBudget,
  };
}

function makePriceDb(price: number | null, updatedAt = Math.floor(Date.now() / 1000)): D1Database {
  return makeNoopD1({
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (price == null ? null : { price, updated_at: updatedAt })),
      })),
    })),
  });
}


describe("syncCurrentBalanceCacheForRows", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fixtures.closeAll();
  });

  it("preserves existing ledger rows on unblacklist events", async () => {
    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig,
      [
        makeCacheRow({
          id: "1",
          event_type: "unblacklist",
          address: "0x111",
          amount_native: null,
          amount_usd_at_event: null,
          amount_source: "unavailable",
          amount_status: "recoverable_pending",
          tx_hash: "0xtx",
          block_number: 1,
          timestamp: 10,
          event_signature: "RemovedBlackList(address)",
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 0,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).not.toHaveBeenCalled();
  });

  it("persists destroy-event amounts instead of deleting the ledger row", async () => {
    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig,
      [
        makeCacheRow({
          id: "2",
          event_type: "destroy",
          address: "0x222",
          amount_native: 500,
          amount_usd_at_event: 500,
          amount_source: "event",
          amount_status: "resolved",
          tx_hash: "0xdestroy",
          block_number: 2,
          timestamp: 11,
          event_signature: "DestroyedBlackFunds(address,uint256)",
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stablecoin: "USDT",
        chainId: "ethereum",
        address: "0x222",
        configKey: ethereumConfig.configKey,
        contractAddress: ethereumConfig.contractAddress,
        amountNative: 500,
        amountUsd: 500,
        source: "destroy_event",
        status: "resolved",
      }),
    );
  });

  it("still refreshes blacklist rows from the latest token balance", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(1250);

    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig,
      [
        makeCacheRow({
          id: "3",
          address: "0x333",
          amount_native: null,
          amount_usd_at_event: null,
          amount_source: "unavailable",
          amount_status: "recoverable_pending",
          tx_hash: "0xblacklist",
          block_number: 3,
          timestamp: 12,
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(fetchEvmTokenCurrentBalance).toHaveBeenCalled();
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: "0x333",
        configKey: ethereumConfig.configKey,
        contractAddress: ethereumConfig.contractAddress,
        amountNative: 1250,
        amountUsd: 1250,
        source: "current_balance",
        status: "resolved",
      }),
    );
  });

  it("captures a same-batch blacklist snapshot before a later release", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(875);

    const blacklistRow = makeCacheRow({
      id: "3c-blacklist",
      address: "0x333c",
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
      tx_hash: "0xblacklist-transient",
      block_number: 3,
      timestamp: 12,
      methodology_version: "3.997",
    });
    const releaseRow = {
      ...blacklistRow,
      id: "3c-unblacklist",
      event_type: "unblacklist" as const,
      tx_hash: "0xunblacklist-transient",
      block_number: 4,
      timestamp: 13,
      event_signature: "RemovedBlackList(address)",
    };

    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig,
      [releaseRow, blacklistRow],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(fetchEvmTokenCurrentBalance).toHaveBeenCalledTimes(1);
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: "0x333c",
        amountNative: 875,
        amountUsd: 875,
        source: "current_balance",
        status: "resolved",
      }),
    );
  });

  it("records provider failures with scoped identity without supplying replacement amounts", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(null);

    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig,
      [
        makeCacheRow({
          id: "3b",
          address: "0x333",
          amount_native: 1250,
          amount_usd_at_event: 1250,
          amount_source: "historical_balance",
          amount_status: "resolved",
          tx_hash: "0xblacklist-fail",
          block_number: 3,
          timestamp: 12,
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 0,
      failed: 1,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: "0x333",
        configKey: ethereumConfig.configKey,
        contractAddress: ethereumConfig.contractAddress,
        amountNative: null,
        amountUsd: null,
        status: "provider_failed",
        lastErrorClass: "provider_null",
        consecutiveFailures: 1,
      }),
    );
  });

  it("updates provider-failure metadata without replacing prior amount columns", async () => {
    const actual = await vi.importActual<typeof import("../../../lib/blacklist-current-balances")>(
      "../../../lib/blacklist-current-balances",
    );
    const { sqlite, db } = fixtures.open();
    const previous = {
      stablecoin: "USDT" as const, chainId: "ethereum", address: "0x333",
      configKey: ethereumConfig.configKey, contractAddress: ethereumConfig.contractAddress,
      amountNative: 1250, amountUsd: 1249, source: "current_balance",
      status: "resolved" as const, observedAt: 100, lastSuccessfulObservedAt: 100,
      attemptCount: 2, lastAttemptedAt: 100, lastErrorClass: null, consecutiveFailures: 0,
    };
    await actual.upsertBlacklistCurrentBalance(db, previous);
    await actual.upsertBlacklistCurrentBalance(db, { ...previous, address: "0x444", amountNative: 99, amountUsd: 98 });

    await actual.upsertBlacklistCurrentBalance(db, {
      stablecoin: "USDT",
      chainId: "ethereum",
      address: "0x333",
      configKey: ethereumConfig.configKey,
      contractAddress: ethereumConfig.contractAddress,
      amountNative: null,
      amountUsd: null,
      source: "current_balance",
      status: "provider_failed",
      observedAt: 123,
      lastSuccessfulObservedAt: null,
      attemptCount: 1,
      lastAttemptedAt: 123,
      lastErrorClass: "provider_null",
      consecutiveFailures: 1,
    });

    expect(sqlite.prepare(`SELECT address, amount_native, amount_usd, status, observed_at,
      last_successful_observed_at, attempt_count, last_attempted_at, last_error_class, consecutive_failures
      FROM blacklist_current_balances ORDER BY address`).all()).toEqual([
      { address: "0x333", amount_native: 1250, amount_usd: 1249, status: "provider_failed",
        observed_at: 100, last_successful_observed_at: 100, attempt_count: 3,
        last_attempted_at: 123, last_error_class: "provider_null", consecutive_failures: 1 },
      { address: "0x444", amount_native: 99, amount_usd: 98, status: "resolved",
        observed_at: 100, last_successful_observed_at: 100, attempt_count: 2,
        last_attempted_at: 100, last_error_class: null, consecutive_failures: 0 },
    ]);
  });

  it("does NOT override genuine zero balance with historical amount for non-gold stablecoins", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(0);

    const result = await syncCurrentBalanceCacheForRows(
      {} as D1Database,
      ethereumConfig, // USDT — not gold
      [
        makeCacheRow({
          id: "4",
          address: "0x444",
          amount_native: 5000,
          amount_usd_at_event: 5000,
          amount_source: "historical_balance",
          amount_status: "resolved",
          tx_hash: "0xblacklist2",
          block_number: 4,
          timestamp: 13,
          methodology_version: "3.6",
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: "0x444",
        amountNative: 0, // genuine zero, NOT overridden to 5000
        status: "resolved",
      }),
    );
  });

  it("converts A7A5 ledger amounts through price_cache instead of treating RUB as USD", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(1_000);

    const result = await syncCurrentBalanceCacheForRows(
      makePriceDb(0.0125),
      a7a5Config,
      [
        makeCacheRow({
          id: "5",
          stablecoin: "A7A5",
          chain_id: "ethereum",
          address: "0x555",
          amount_native: null,
          amount_usd_at_event: null,
          amount_source: "unavailable",
          amount_status: "recoverable_pending",
          tx_hash: "0xa7a5",
          block_number: 5,
          timestamp: 14,
          methodology_version: "3.8",
          contract_address: a7a5Config.contractAddress,
          config_key: a7a5Config.configKey,
          event_signature: "Blacklisted(address)",
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stablecoin: "A7A5",
        address: "0x555",
        amountNative: 1_000,
        amountUsd: 12.5,
      }),
    );
  });

  it("leaves non-USD ledger amounts unresolved when the price_cache entry is stale", async () => {
    vi.mocked(fetchEvmTokenCurrentBalance).mockResolvedValue(1_000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const staleUpdatedAt = Math.floor(Date.now() / 1000) - (7 * 3600);

    const result = await syncCurrentBalanceCacheForRows(
      makePriceDb(0.0125, staleUpdatedAt),
      a7a5Config,
      [
        makeCacheRow({
          id: "6",
          stablecoin: "A7A5",
          chain_id: "ethereum",
          address: "0x666",
          amount_native: null,
          amount_usd_at_event: null,
          amount_source: "unavailable",
          amount_status: "recoverable_pending",
          tx_hash: "0xa7a5-stale",
          block_number: 6,
          timestamp: 15,
          methodology_version: "3.996",
          contract_address: a7a5Config.contractAddress,
          config_key: a7a5Config.configKey,
          event_signature: "Blacklisted(address)",
        }),
      ],
      makeContext(),
    );

    expect(result).toEqual({
      updated: 1,
      failed: 0,
      skippedDueBudget: 0,
      budgetExhausted: false,
    });
    expect(upsertBlacklistCurrentBalance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stablecoin: "A7A5",
        address: "0x666",
        amountNative: 1_000,
        amountUsd: null,
      }),
    );
    warnSpy.mockRestore();
  });
});
