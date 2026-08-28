import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudget } from "../../../lib/evm-logs";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { type BlacklistRunBudget } from "../../../lib/blacklist/run-budget";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import { mockD1 } from "@shared/test-utils/mock-d1";

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

const ethereumConfig: ContractEventConfig = {
  configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: 6,
  events: [],
};

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
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (price == null ? null : { price, updated_at: updatedAt })),
      })),
    })),
  } as unknown as D1Database;
}

type BlacklistRowOverrides = NonNullable<Parameters<typeof makeBlacklistRow>[0]>;

function makeCacheRow(overrides: BlacklistRowOverrides = {}): BlacklistRow {
  const row = makeBlacklistRow(overrides);
  return {
    ...row,
    methodology_version: row.methodology_version ?? "3.1",
    amount_attempt_count: row.amount_attempt_count ?? 0,
    amount_last_attempted_at: row.amount_last_attempted_at ?? null,
    amount_last_error_class: row.amount_last_error_class ?? null,
    amount_last_provider: row.amount_last_provider ?? null,
  };
}

describe("syncCurrentBalanceCacheForRows", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
          methodology_version: "3.5",
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "RemovedBlackList(address)",
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xtx",
          explorer_address_url: "https://etherscan.io/address/0x111",
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
          methodology_version: "3.5",
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "DestroyedBlackFunds(address,uint256)",
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xdestroy",
          explorer_address_url: "https://etherscan.io/address/0x222",
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
          methodology_version: "3.5",
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "AddedBlackList(address)",
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xblacklist",
          explorer_address_url: "https://etherscan.io/address/0x333",
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
      contract_address: ethereumConfig.contractAddress,
      config_key: ethereumConfig.configKey,
      event_signature: "AddedBlackList(address)",
      event_topic0: "0xtopic",
      explorer_tx_url: "https://etherscan.io/tx/0xblacklist-transient",
      explorer_address_url: "https://etherscan.io/address/0x333c",
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
          methodology_version: "3.5",
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "AddedBlackList(address)",
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xblacklist-fail",
          explorer_address_url: "https://etherscan.io/address/0x333",
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
    const db = mockD1([
      {
        match: "UPDATE blacklist_current_balances",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

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

    const sql = db.getHistory()[0]?.sql ?? "";
    expect(sql).toContain("UPDATE blacklist_current_balances");
    expect(sql).not.toContain("amount_native =");
    expect(sql).not.toContain("amount_usd =");
    expect(sql).toContain("last_successful_observed_at = COALESCE");
    expect(sql).toContain("consecutive_failures = COALESCE(consecutive_failures, 0) + 1");
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
          contract_address: ethereumConfig.contractAddress,
          config_key: ethereumConfig.configKey,
          event_signature: "AddedBlackList(address)",
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xblacklist2",
          explorer_address_url: "https://etherscan.io/address/0x444",
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
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xa7a5",
          explorer_address_url: "https://etherscan.io/address/0x555",
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
          event_topic0: "0xtopic",
          explorer_tx_url: "https://etherscan.io/tx/0xa7a5-stale",
          explorer_address_url: "https://etherscan.io/address/0x666",
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
