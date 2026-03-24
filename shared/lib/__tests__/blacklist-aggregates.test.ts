import { describe, it, expect } from "vitest";
import { buildBlacklistChartData, computeBlacklistSummaryStats } from "../blacklist-aggregates";
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
    timestamp: 1770000000,
    methodologyVersion: "3.3",
    contractAddress: "0xcontract",
    configKey: "ethereum-0xcontract",
    eventSignature: "Blacklisted(address)",
    eventTopic0: "0xtopic",
    explorerTxUrl: "https://etherscan.io/tx/0xtx",
    explorerAddressUrl: "https://etherscan.io/address/0xabc",
    ...overrides,
  };
}

describe("buildBlacklistChartData", () => {
  it("includes PYUSD and USD1 in chart data and total", () => {
    const events = [
      makeEvent({ id: "1", stablecoin: "PYUSD", amountUsdAtEvent: 500, timestamp: 1770000000 }),
      makeEvent({ id: "2", stablecoin: "USD1", amountUsdAtEvent: 300, timestamp: 1770000000 }),
      makeEvent({ id: "3", stablecoin: "USDC", amountUsdAtEvent: 200, timestamp: 1770000000 }),
    ];
    const chart = buildBlacklistChartData(events);
    expect(chart.length).toBeGreaterThan(0);
    const point = chart[0];
    expect(point.PYUSD).toBe(500);
    expect(point.USD1).toBe(300);
    expect(point.USDC).toBe(200);
    expect(point.total).toBe(1000);
  });

  it("returns zero for stablecoins with no events in a quarter", () => {
    const events = [makeEvent({ stablecoin: "USDT", amountUsdAtEvent: 100, timestamp: 1770000000 })];
    const chart = buildBlacklistChartData(events);
    const point = chart[0];
    expect(point.PYUSD).toBe(0);
    expect(point.USD1).toBe(0);
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
    ];
    const stats = computeBlacklistSummaryStats(events, now);
    expect(stats.usdcBlacklisted).toBe(1);
    expect(stats.usdtBlacklisted).toBe(1);
    expect(stats.frozenAddresses).toBe(4);
  });
});
