import { describe, expect, it } from "vitest";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
  type BlacklistCurrentBalanceSnapshot,
} from "../blacklist-active-records";
import type { BlacklistEvent } from "../../types/market";

function makeEvent(overrides: Partial<BlacklistEvent> = {}): BlacklistEvent {
  return {
    id: "bl-1",
    stablecoin: "USDT",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "blacklist",
    address: "0xabc",
    amountNative: 1000,
    amountUsdAtEvent: 1000,
    amountSource: "event",
    amountStatus: "resolved",
    txHash: "0xtx",
    blockNumber: 19000000,
    timestamp: 1_770_000_000,
    methodologyVersion: "3.3",
    contractAddress: "0xcontract",
    configKey: "ethereum-0xcontract",
    eventSignature: "Blacklisted(address)",
    eventTopic0: "0xtopic",
    suppressionReason: null,
    explorerTxUrl: "https://etherscan.io/tx/0xtx",
    explorerAddressUrl: "https://etherscan.io/address/0xabc",
    ...overrides,
  };
}

describe("buildBlacklistActiveRecords", () => {
  it("keeps destroy amounts on active records until an unblacklist arrives", () => {
    const events = [
      makeEvent({ id: "1", eventType: "blacklist", amountNative: 10, amountUsdAtEvent: 10, timestamp: 10 }),
      makeEvent({ id: "2", eventType: "destroy", amountNative: 8, amountUsdAtEvent: 8, timestamp: 11 }),
    ];

    const records = buildBlacklistActiveRecords(events);
    expect(records).toHaveLength(1);
    expect(records[0]?.destroyedAt).toBe(11);
    expect(records[0]?.frozenAmountUsd).toBe(8);
    expect(records[0]?.amountSource).toBe("destroy_event");
  });

  it("uses current balance snapshots for active Tron blacklist records", () => {
    const events = [
      makeEvent({
        id: "1",
        stablecoin: "USDT",
        chainId: "tron",
        chainName: "Tron",
        address: "0x1234",
        amountNative: null,
        amountUsdAtEvent: null,
        amountSource: "unavailable",
        amountStatus: "permanently_unavailable",
        timestamp: 10,
      }),
    ];

    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:tron:0x1234",
        {
          stablecoin: "USDT",
          chainId: "tron",
          address: "0x1234",
          amountNative: 500,
          amountUsd: 500,
          status: "resolved",
          source: "current_balance",
          observedAt: 20,
        },
      ],
    ]);

    const records = buildBlacklistActiveRecords(events, balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(500);
    expect(records[0]?.amountSource).toBe("current_balance");
  });

  it("prefers resolved current balance snapshots for active EVM blacklist records", () => {
    const events = [
      makeEvent({
        id: "1",
        stablecoin: "USDT",
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x9999",
        amountNative: 100,
        amountUsdAtEvent: 100,
        amountSource: "historical_balance",
        amountStatus: "resolved",
        timestamp: 10,
      }),
    ];

    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:ethereum:0x9999",
        {
          stablecoin: "USDT",
          chainId: "ethereum",
          address: "0x9999",
          amountNative: 250,
          amountUsd: 250,
          status: "resolved",
          source: "current_balance",
          observedAt: 20,
        },
      ],
    ]);

    const records = buildBlacklistActiveRecords(events, balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(250);
    expect(records[0]?.amountSource).toBe("current_balance");
  });

  it("falls back to event-time EVM amounts when current balance refresh fails", () => {
    const events = [
      makeEvent({
        id: "1",
        stablecoin: "USDT",
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x8888",
        amountNative: 100,
        amountUsdAtEvent: 100,
        amountSource: "historical_balance",
        amountStatus: "resolved",
        timestamp: 10,
      }),
    ];

    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:ethereum:0x8888",
        {
          stablecoin: "USDT",
          chainId: "ethereum",
          address: "0x8888",
          amountNative: null,
          amountUsd: null,
          status: "provider_failed",
          source: "current_balance",
          observedAt: 20,
        },
      ],
    ]);

    const records = buildBlacklistActiveRecords(events, balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(100);
    expect(records[0]?.amountSource).toBe("historical_balance");
  });

  it("drops records after unblacklist", () => {
    const events = [
      makeEvent({ id: "1", eventType: "blacklist", timestamp: 10 }),
      makeEvent({ id: "2", eventType: "unblacklist", timestamp: 11 }),
    ];

    expect(buildBlacklistActiveRecords(events)).toHaveLength(0);
  });
});

describe("computeBlacklistActiveSummaryStats", () => {
  it("excludes destroyed records from activeFrozenTotal", () => {
    const records = [
      {
        id: "1",
        stablecoin: "USDT" as const,
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x1",
        blacklistedAt: 10,
        blacklistTxHash: "0x1",
        destroyedAt: null,
        destroyTxHash: null,
        frozenAmountNative: 100,
        frozenAmountUsd: 100,
        amountStatus: "resolved" as const,
        amountSource: "event",
      },
      {
        id: "2",
        stablecoin: "USDT" as const,
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x2",
        blacklistedAt: 11,
        blacklistTxHash: "0x2",
        destroyedAt: 12,
        destroyTxHash: "0x3",
        frozenAmountNative: 500,
        frozenAmountUsd: 500,
        amountStatus: "resolved" as const,
        amountSource: "destroy_event",
      },
    ];

    const stats = computeBlacklistActiveSummaryStats(records);
    // Only the non-destroyed record contributes to frozen total
    expect(stats.activeFrozenTotal).toBe(100);
    // Both records still count as active addresses
    expect(stats.activeAddressCount).toBe(2);
  });

  it("sums frozen totals and counts gaps", () => {
    const records = [
      {
        id: "1",
        stablecoin: "USDT" as const,
        chainId: "ethereum",
        chainName: "Ethereum",
        address: "0x1",
        blacklistedAt: 10,
        blacklistTxHash: "0x1",
        destroyedAt: null,
        destroyTxHash: null,
        frozenAmountNative: 100,
        frozenAmountUsd: 100,
        amountStatus: "resolved" as const,
        amountSource: "event",
      },
      {
        id: "2",
        stablecoin: "USDT" as const,
        chainId: "tron",
        chainName: "Tron",
        address: "0x2",
        blacklistedAt: 11,
        blacklistTxHash: "0x2",
        destroyedAt: null,
        destroyTxHash: null,
        frozenAmountNative: null,
        frozenAmountUsd: null,
        amountStatus: "provider_failed" as const,
        amountSource: "current_balance",
      },
    ];

    expect(computeBlacklistActiveSummaryStats(records)).toEqual({
      activeAddressCount: 2,
      activeFrozenTotal: 100,
      activeAmountGapCount: 1,
    });
  });
});

describe("computeBlacklistTrackedSummaryStats", () => {
  it("sums snapshot totals and counts unresolved rows", () => {
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:ethereum:0x1",
        {
          stablecoin: "USDT",
          chainId: "ethereum",
          address: "0x1",
          amountNative: 100,
          amountUsd: 100,
          status: "resolved",
          source: "kyc_rip_bootstrap",
          observedAt: 10,
        },
      ],
      [
        "USDT:tron:0x2",
        {
          stablecoin: "USDT",
          chainId: "tron",
          address: "0x2",
          amountNative: null,
          amountUsd: null,
          status: "provider_failed",
          source: "current_balance",
          observedAt: 11,
        },
      ],
    ]);

    expect(computeBlacklistTrackedSummaryStats(balances)).toEqual({
      trackedAddressCount: 2,
      trackedFrozenTotal: 100,
      trackedAmountGapCount: 1,
    });
  });
});
