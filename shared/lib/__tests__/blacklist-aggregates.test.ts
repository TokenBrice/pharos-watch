import { describe, it, expect } from "vitest";
import { buildBlacklistChartData, computeBlacklistSummaryStats } from "../blacklist-aggregates";
import type { BlacklistCurrentBalanceSnapshot } from "../blacklist-active-records";
import { BLACKLIST_STABLECOINS, type BlacklistEvent } from "../../types/market";

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
    timestamp: 1770000000,
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

function makeBalance(
  overrides: Partial<BlacklistCurrentBalanceSnapshot> = {},
): BlacklistCurrentBalanceSnapshot {
  return {
    stablecoin: "USDT",
    chainId: "ethereum",
    address: "0xabc",
    amountNative: 1000,
    amountUsd: 1000,
    status: "resolved",
    source: "current_balance",
    observedAt: 1770000000,
    ...overrides,
  };
}

describe("buildBlacklistChartData", () => {
  it("includes tracked PYUSD and USD1 freeze-ledger balances in the chart total", () => {
    const events = [
      makeEvent({ id: "1", stablecoin: "PYUSD", address: "0xpy", timestamp: 1770000000 }),
      makeEvent({ id: "2", stablecoin: "USD1", address: "0xusd1", timestamp: 1770000000 }),
      makeEvent({ id: "3", stablecoin: "USDC", address: "0xusdc", timestamp: 1770000000 }),
    ];
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      ["PYUSD:ethereum:0xpy", makeBalance({ stablecoin: "PYUSD", address: "0xpy", amountUsd: 500 })],
      ["USD1:ethereum:0xusd1", makeBalance({ stablecoin: "USD1", address: "0xusd1", amountUsd: 300 })],
      ["USDC:ethereum:0xusdc", makeBalance({ stablecoin: "USDC", address: "0xusdc", amountUsd: 200 })],
    ]);
    const chart = buildBlacklistChartData(events, balances);
    expect(chart.length).toBeGreaterThan(0);
    const point = chart[0];
    expect(point.PYUSD).toBe(500);
    expect(point.USD1).toBe(300);
    expect(point.USDC).toBe(200);
    expect(point.total).toBe(1000);
  });

  it("returns zero for stablecoins with no events in a quarter", () => {
    const events = [makeEvent({ stablecoin: "USDT", amountUsdAtEvent: 100, timestamp: 1770000000 })];
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      ["USDT:ethereum:0xabc", makeBalance({ amountUsd: 100 })],
    ]);
    const chart = buildBlacklistChartData(events, balances);
    const point = chart[0];
    expect(point.PYUSD).toBe(0);
    expect(point.USD1).toBe(0);
  });

  it("attributes tracked balances to the latest recorded blacklist quarter for that address", () => {
    const events = [
      makeEvent({ id: "1", address: "0xre", stablecoin: "USDT", timestamp: 1710000000 }),
      makeEvent({ id: "2", address: "0xre", stablecoin: "USDT", eventType: "unblacklist", timestamp: 1714000000 }),
      makeEvent({ id: "3", address: "0xre", stablecoin: "USDT", timestamp: 1723000000 }),
    ];
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      ["USDT:ethereum:0xre", makeBalance({ address: "0xre", amountUsd: 250 })],
    ]);

    const chart = buildBlacklistChartData(events, balances);

    expect(chart).toHaveLength(1);
    expect(chart[0]).toMatchObject({ quarter: "Q3 '24", USDT: 250, total: 250 });
    for (const stablecoin of BLACKLIST_STABLECOINS) {
      if (stablecoin === "USDT") continue;
      expect(chart[0]?.[stablecoin]).toBe(0);
    }
  });

  it("falls back to snapshot observation time when no local event timestamp exists", () => {
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      ["USDT:ethereum:0xfallback", makeBalance({ address: "0xfallback", amountUsd: 400, observedAt: 1730500000 })],
    ]);

    const chart = buildBlacklistChartData([], balances);

    expect(chart).toHaveLength(1);
    expect(chart[0]).toMatchObject({ quarter: "Q4 '24", USDT: 400, total: 400 });
  });

  it("includes first-wave stablecoins in chart buckets", () => {
    const events = [
      makeEvent({ id: "1", stablecoin: "USDG", address: "0xusdg", timestamp: 1770000000 }),
      makeEvent({ id: "2", stablecoin: "A7A5", address: "0xa7a5", timestamp: 1770000000 }),
    ];
    const balances = new Map<string, BlacklistCurrentBalanceSnapshot>([
      ["USDG:ethereum:0xusdg", makeBalance({ stablecoin: "USDG", address: "0xusdg", amountUsd: 700 })],
      ["A7A5:ethereum:0xa7a5", makeBalance({ stablecoin: "A7A5", address: "0xa7a5", amountUsd: 30 })],
    ]);

    const chart = buildBlacklistChartData(events, balances);

    expect(chart[0]?.USDG).toBe(700);
    expect(chart[0]?.A7A5).toBe(30);
    expect(chart[0]?.total).toBe(730);
  });
});

describe("computeBlacklistSummaryStats", () => {
  it("routes PYUSD and USD1 to frozenAddresses but not usdcBlacklisted or usdtBlacklisted", () => {
    const now = 1777000000;
    const events = [
      makeEvent({ id: "1", stablecoin: "PYUSD", address: "0xpyusd1", timestamp: now - 100 }),
      makeEvent({ id: "2", stablecoin: "USD1", address: "0xusd1a", timestamp: now - 100 }),
      makeEvent({ id: "3", stablecoin: "USDC", address: "0xusdc1", timestamp: now - 100 }),
      makeEvent({ id: "4", stablecoin: "USDT", address: "0xusdt1", timestamp: now - 100 }),
      makeEvent({ id: "5", stablecoin: "USDT", address: "0xusdt1", timestamp: now - 90_000 }),
    ];
    const stats = computeBlacklistSummaryStats(events, now);
    expect(stats.usdcBlacklisted).toBe(1);
    expect(stats.usdtBlacklisted).toBe(1);
    expect(stats.frozenAddresses).toBe(4);
    expect(stats.recentCount24h).toBe(4);
  });
});
