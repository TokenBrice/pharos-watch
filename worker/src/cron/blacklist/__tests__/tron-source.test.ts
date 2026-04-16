import { describe, it, expect } from "vitest";
import { parseTronEvent } from "../tron-source";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";

function findConfig(stablecoinId: string) {
  const config = CONTRACT_CONFIGS.find(
    (c) => c.stablecoinId === stablecoinId && c.chain.chainId === "tron",
  );
  if (!config) throw new Error(`No Tron config for ${stablecoinId}`);
  return config;
}

describe("parseTronEvent", () => {
  it("parses legacy USDT AddedBlackList via _blackListedUser key", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 100,
      block_timestamp: 1_700_000_000_000,
      transaction_id: "tx_abc",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { _blackListedUser: "0xaa".padEnd(42, "a") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0xaa".padEnd(42, "a"));
    expect(row!.amount_status).toBe("recoverable_pending");
  });

  it("parses legacy USDT DestroyedBlackFunds with amount from _balance", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 200,
      block_timestamp: 1_700_000_100_000,
      transaction_id: "tx_destroy",
      event_index: 1,
      event_name: "DestroyedBlackFunds",
      result: { _blackListedUser: "0xbb".padEnd(42, "b"), _balance: "12345000000" },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("destroy");
    expect(row!.amount_native).toBe(12345);
    expect(row!.amount_status).toBe("resolved");
  });

  it("parses USD1 Freeze via tronResultKey=account", () => {
    const config = findConfig("usd1-world-liberty-financial");
    const row = parseTronEvent(config, {
      block_number: 300,
      block_timestamp: 1_700_000_200_000,
      transaction_id: "tx_freeze",
      event_index: 0,
      event_name: "Freeze",
      result: { caller: "0x11".padEnd(42, "1"), account: "0x22".padEnd(42, "2") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0x22".padEnd(42, "2"));
  });

  it("returns null on unknown event name", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 400,
      block_timestamp: 1_700_000_300_000,
      transaction_id: "tx_noop",
      event_index: 0,
      event_name: "Transfer",
      result: {},
    });
    expect(row).toBeNull();
  });

  it("falls back to positional slot 0 when no named key matches", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 500,
      block_timestamp: 1_700_000_400_000,
      transaction_id: "tx_positional",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { "0": "0x33".padEnd(42, "3") },
    });
    expect(row).not.toBeNull();
    expect(row!.address).toBe("0x33".padEnd(42, "3"));
  });
});
