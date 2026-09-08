import { describe, expect, it } from "vitest";
import {
  buildBlacklistRecordIdentityKey,
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
  type BlacklistCurrentBalanceSnapshot,
  type BlacklistActiveRecord,
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
    configKey: "ethereum-primary",
    eventSignature: "Blacklisted(address)",
    eventTopic0: "0xtopic",
    suppressionReason: null,
    explorerTxUrl: "https://etherscan.io/tx/0xtx",
    explorerAddressUrl: "https://etherscan.io/address/0xabc",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<BlacklistCurrentBalanceSnapshot>): BlacklistCurrentBalanceSnapshot {
  return {
    stablecoin: "USDT", chainId: "ethereum", address: "0x1",
    amountNative: 100, amountUsd: 100, status: "resolved",
    source: "current_balance", observedAt: 20, ...overrides,
  };
}

function makeActiveRecord(overrides: Partial<BlacklistActiveRecord> = {}): BlacklistActiveRecord {
  return {
    id: "1", stablecoin: "USDT", chainId: "ethereum", chainName: "Ethereum",
    address: "0x1", blacklistedAt: 10, blacklistTxHash: "0x1",
    destroyedAt: null, destroyTxHash: null, frozenAmountNative: 100,
    frozenAmountUsd: 100, amountStatus: "resolved", amountSource: "event", ...overrides,
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
        makeSnapshot({ chainId: "tron", address: "0x1234", amountNative: 500, amountUsd: 500 }),
      ],
    ]);

    const records = buildBlacklistActiveRecords(events, balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(500);
    expect(records[0]?.amountSource).toBe("current_balance");
  });

  it("reports an unavailable amount when a Tron blacklist has no current snapshot", () => {
    const records = buildBlacklistActiveRecords([makeEvent({
      chainId: "tron",
      chainName: "Tron",
      amountNative: 1_000,
      amountUsdAtEvent: 1_000,
    })]);

    expect(records[0]).toMatchObject({
      frozenAmountNative: null,
      frozenAmountUsd: null,
      amountStatus: "provider_failed",
      amountSource: "unavailable",
    });
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
        makeSnapshot({ address: "0x9999", amountNative: 250, amountUsd: 250 }),
      ],
    ]);

    const records = buildBlacklistActiveRecords(events, balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(250);
    expect(records[0]?.amountSource).toBe("current_balance");
  });

  it("prefers contract-scoped current balance snapshots over legacy address rows", () => {
    const event = makeEvent({
      id: "1",
      stablecoin: "USDT",
      chainId: "optimism",
      chainName: "Optimism",
      address: "0x8888",
      configKey: "optimism-new",
      contractAddress: "0xnew",
      timestamp: 10,
    });
    const scopedKey = buildBlacklistRecordIdentityKey(event);

    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:optimism:0x8888",
        makeSnapshot({ chainId: "optimism", address: "0x8888", amountNative: 100, amountUsd: 100 }),
      ],
      [
        scopedKey,
        makeSnapshot({
          chainId: "optimism", address: "0x8888", configKey: "optimism-new",
          contractAddress: "0xnew", amountNative: 250, amountUsd: 250, observedAt: 21,
        }),
      ],
    ]);

    const records = buildBlacklistActiveRecords([event], balances);
    expect(records).toHaveLength(1);
    expect(records[0]?.frozenAmountUsd).toBe(250);
  });

  it("does not collapse same-symbol same-chain records with different contract scope", () => {
    const legacy = makeEvent({
      id: "1",
      chainId: "optimism",
      chainName: "Optimism",
      address: "0xshared",
      configKey: "optimism-old",
      contractAddress: "0xlegacy",
      timestamp: 10,
    });
    const upgraded = makeEvent({
      id: "2",
      chainId: "optimism",
      chainName: "Optimism",
      address: "0xshared",
      configKey: "optimism-v2",
      contractAddress: "0xupgraded",
      timestamp: 11,
    });

    const records = buildBlacklistActiveRecords([legacy, upgraded]);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.contractAddress).sort()).toEqual(["0xlegacy", "0xupgraded"]);
  });

  it("dedupes repeated blacklist events for the same scoped identity to the latest record", () => {
    const older = makeEvent({
      id: "1",
      chainId: "optimism",
      chainName: "Optimism",
      address: "0xshared",
      configKey: "optimism-primary",
      contractAddress: "0xcontract",
      timestamp: 10,
      txHash: "0xolder",
    });
    const newer = makeEvent({
      id: "2",
      chainId: "optimism",
      chainName: "Optimism",
      address: "0xshared",
      configKey: "optimism-primary",
      contractAddress: "0xcontract",
      timestamp: 11,
      txHash: "0xnewer",
    });

    const records = buildBlacklistActiveRecords([newer, older]);

    expect(records).toHaveLength(1);
    expect(records[0]?.blacklistedAt).toBe(11);
    expect(records[0]?.blacklistTxHash).toBe("0xnewer");
  });

  it("removes both legacy and matching scoped identities without removing another contract", () => {
    const legacy = makeEvent({ id: "legacy", configKey: null, contractAddress: null, timestamp: 1 });
    const scoped = makeEvent({ id: "scoped", timestamp: 2 });
    const other = makeEvent({ id: "other", configKey: "ethereum-other", contractAddress: "0xother", timestamp: 3 });
    const events = [legacy, scoped, other];
    expect(buildBlacklistActiveRecords(events).map((record) => record.contractAddress))
      .toEqual(["0xother", "0xcontract", null]);
    const removal = makeEvent({ id: "remove", eventType: "unblacklist", timestamp: 4 });
    expect(buildBlacklistActiveRecords([...events, removal]))
      .toEqual([expect.objectContaining({ contractAddress: "0xother", blacklistedAt: 3 })]);
  });

  it("clears destruction metadata when a removed identity is blacklisted again in scrambled input", () => {
    const blacklist = makeEvent({ id: "1", timestamp: 1 });
    const destroy = makeEvent({ id: "2", eventType: "destroy", timestamp: 2, txHash: "0xdestroy" });
    const remove = makeEvent({ id: "3", eventType: "unblacklist", timestamp: 3 });
    const renewed = makeEvent({ id: "4", timestamp: 4, txHash: "0xrenewed", amountNative: 25, amountUsdAtEvent: 25 });
    expect(buildBlacklistActiveRecords([renewed, destroy, blacklist, remove])).toEqual([
      expect.objectContaining({
        blacklistedAt: 4, blacklistTxHash: "0xrenewed", destroyedAt: null, destroyTxHash: null,
        frozenAmountNative: 25, frozenAmountUsd: 25, amountSource: "event",
      }),
    ]);
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
        makeSnapshot({ address: "0x8888", amountNative: null, amountUsd: null, status: "provider_failed" }),
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
  it("counts a destroyed unresolved address without adding a frozen amount or gap", () => {
    const records = buildBlacklistActiveRecords([
      makeEvent({ timestamp: 1 }),
      makeEvent({ id: "destroy", eventType: "destroy", timestamp: 2, amountNative: null, amountUsdAtEvent: null }),
    ]);
    expect(computeBlacklistActiveSummaryStats(records)).toEqual({
      activeAddressCount: 1, activeFrozenTotal: 0, activeAmountGapCount: 0,
    });
  });

  it("excludes destroyed records from activeFrozenTotal", () => {
    const records = [
      makeActiveRecord({ frozenAmountNative: 100, frozenAmountUsd: 100 }),
      makeActiveRecord({
        id: "2", address: "0x2", blacklistedAt: 11, blacklistTxHash: "0x2",
        destroyedAt: 12, destroyTxHash: "0x3", frozenAmountNative: 500,
        frozenAmountUsd: 500, amountSource: "destroy_event",
      }),
    ];

    const stats = computeBlacklistActiveSummaryStats(records);
    // Only the non-destroyed record contributes to frozen total
    expect(stats.activeFrozenTotal).toBe(100);
    // Both records still count as active addresses
    expect(stats.activeAddressCount).toBe(2);
  });

  it("sums frozen totals and counts gaps", () => {
    const records = [
      makeActiveRecord({ frozenAmountNative: 100, frozenAmountUsd: 100 }),
      makeActiveRecord({
        id: "2", chainId: "tron", chainName: "Tron", address: "0x2",
        blacklistedAt: 11, blacklistTxHash: "0x2", frozenAmountNative: null,
        frozenAmountUsd: null, amountStatus: "provider_failed", amountSource: "current_balance",
      }),
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
        makeSnapshot({ amountNative: 100, amountUsd: 100, source: "kyc_rip_bootstrap", observedAt: 10 }),
      ],
      [
        "USDT:tron:0x2",
        makeSnapshot({
          chainId: "tron", address: "0x2", amountNative: null, amountUsd: null,
          status: "provider_failed", observedAt: 11,
        }),
      ],
    ]);

    expect(computeBlacklistTrackedSummaryStats(balances)).toEqual({
      trackedAddressCount: 2,
      trackedFrozenTotal: 100,
      trackedAmountGapCount: 1,
    });
  });

  it("dedupes scoped and legacy snapshots that share a current-balance row id", () => {
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      [
        "USDT:optimism:0x1",
        makeSnapshot({ id: "snapshot-1", chainId: "optimism", amountNative: 100, amountUsd: 100, observedAt: 10 }),
      ],
      [
        "USDT:optimism:optimism-primary:0xcontract:0x1",
        makeSnapshot({
          id: "snapshot-1", chainId: "optimism", configKey: "optimism-primary",
          contractAddress: "0xcontract", amountNative: 100, amountUsd: 100, observedAt: 11,
        }),
      ],
    ]);

    expect(computeBlacklistTrackedSummaryStats(balances)).toEqual({
      trackedAddressCount: 1,
      trackedFrozenTotal: 100,
      trackedAmountGapCount: 0,
    });
  });
});
