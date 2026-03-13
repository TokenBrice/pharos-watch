import { describe, expect, it } from "vitest";
import { compareBlacklistRows, type BlacklistSortKey } from "@/components/blacklist-table-logic";
import type { BlacklistEvent } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";

function makeEvent(overrides: Partial<BlacklistEvent> = {}): BlacklistEvent {
  return {
    id: "evt-1",
    stablecoin: "USDC",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "blacklist",
    address: "0xabc",
    amount: null,
    txHash: "0xhash",
    blockNumber: 1000000,
    timestamp: 1700000000,
    methodologyVersion: "v1",
    explorerTxUrl: "https://etherscan.io/tx/0xhash",
    explorerAddressUrl: "https://etherscan.io/address/0xabc",
    ...overrides,
  };
}

const sort = (key: BlacklistSortKey, direction: "asc" | "desc" = "desc"): TableSortState<BlacklistSortKey> => ({
  key,
  direction,
});

describe("compareBlacklistRows — date", () => {
  it("sorts by timestamp descending (newest first)", () => {
    const newer = makeEvent({ timestamp: 1700000100 });
    const older = makeEvent({ timestamp: 1700000000 });
    const result = compareBlacklistRows(newer, older, sort("date", "desc"));
    // desc: -(a - b) = -(newer - older) = negative → newer ranks first
    expect(result).toBeLessThan(0);
  });

  it("sorts by timestamp ascending (oldest first)", () => {
    const newer = makeEvent({ timestamp: 1700000100 });
    const older = makeEvent({ timestamp: 1700000000 });
    const result = compareBlacklistRows(newer, older, sort("date", "asc"));
    // asc: a - b = newer - older > 0 → older ranks first
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 for identical timestamps", () => {
    const a = makeEvent({ timestamp: 1700000000 });
    const b = makeEvent({ timestamp: 1700000000 });
    const result = compareBlacklistRows(a, b, sort("date", "asc"));
    expect(result).toBe(0);
  });
});

describe("compareBlacklistRows — stablecoin", () => {
  it("sorts by stablecoin name ascending", () => {
    const usdc = makeEvent({ stablecoin: "USDC" });
    const usdt = makeEvent({ stablecoin: "USDT" });
    const result = compareBlacklistRows(usdc, usdt, sort("stablecoin", "asc"));
    expect(result).toBeLessThan(0); // "USDC" < "USDT"
  });

  it("sorts by stablecoin name descending", () => {
    const usdc = makeEvent({ stablecoin: "USDC" });
    const usdt = makeEvent({ stablecoin: "USDT" });
    const result = compareBlacklistRows(usdc, usdt, sort("stablecoin", "desc"));
    expect(result).toBeGreaterThan(0); // "USDT" > "USDC" so usdt ranks first
  });

  it("returns 0 for identical stablecoin names", () => {
    const a = makeEvent({ stablecoin: "USDC" });
    const b = makeEvent({ stablecoin: "USDC" });
    const result = compareBlacklistRows(a, b, sort("stablecoin", "asc"));
    expect(result).toBe(0);
  });
});

describe("compareBlacklistRows — chain", () => {
  it("sorts by chain name ascending", () => {
    const eth = makeEvent({ chainName: "Ethereum" });
    const tron = makeEvent({ chainName: "Tron" });
    const result = compareBlacklistRows(eth, tron, sort("chain", "asc"));
    expect(result).toBeLessThan(0); // "Ethereum" < "Tron"
  });

  it("sorts by chain name descending", () => {
    const eth = makeEvent({ chainName: "Ethereum" });
    const tron = makeEvent({ chainName: "Tron" });
    const result = compareBlacklistRows(eth, tron, sort("chain", "desc"));
    expect(result).toBeGreaterThan(0); // "Tron" > "Ethereum"
  });
});

describe("compareBlacklistRows — event type", () => {
  it("sorts by event type ascending", () => {
    const blacklist = makeEvent({ eventType: "blacklist" });
    const unblacklist = makeEvent({ eventType: "unblacklist" });
    const result = compareBlacklistRows(blacklist, unblacklist, sort("event", "asc"));
    expect(result).toBeLessThan(0); // "blacklist" < "unblacklist"
  });

  it("sorts by event type descending", () => {
    const blacklist = makeEvent({ eventType: "blacklist" });
    const destroy = makeEvent({ eventType: "destroy" });
    const result = compareBlacklistRows(blacklist, destroy, sort("event", "desc"));
    // desc: -(a.eventType.localeCompare(b.eventType)) = -("blacklist" < "destroy") = positive
    expect(result).toBeGreaterThan(0); // "destroy" > "blacklist"
  });

  it("returns 0 for identical event types", () => {
    const a = makeEvent({ eventType: "blacklist" });
    const b = makeEvent({ eventType: "blacklist" });
    const result = compareBlacklistRows(a, b, sort("event", "asc"));
    expect(result).toBe(0);
  });
});

describe("compareBlacklistRows — default fallback", () => {
  it("falls back to timestamp sort for unknown key", () => {
    const newer = makeEvent({ timestamp: 1700000100 });
    const older = makeEvent({ timestamp: 1700000000 });
    const result = compareBlacklistRows(newer, older, { key: "unknown" as BlacklistSortKey, direction: "asc" });
    // asc: cmp = newer - older > 0 → older ranks first
    expect(result).toBeGreaterThan(0);
  });
});
