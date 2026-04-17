import { describe, expect, it } from "vitest";
import { getMintBurnTrackedChains, sumMcapForTrackedChains } from "../mint-burn-canonical-chain";

describe("getMintBurnTrackedChains", () => {
  it("returns ethereum for USDC", () => {
    expect(getMintBurnTrackedChains("usdc-circle")).toEqual(["ethereum"]);
  });
  it("returns arbitrum for USDai", () => {
    expect(getMintBurnTrackedChains("usdai-usd-ai")).toEqual(["arbitrum"]);
  });
  it("returns empty array for an untracked coin", () => {
    expect(getMintBurnTrackedChains("nonexistent-coin")).toEqual([]);
  });
});

describe("sumMcapForTrackedChains", () => {
  const chainCirculating: Record<string, { current: number }> = {
    ethereum: { current: 32_000_000_000 },
    solana:   { current: 4_000_000_000 },
    base:     { current: 1_000_000_000 },
  };
  const peggedTotal: Record<string, number> = { peggedUSD: 37_000_000_000 };

  it("sums only tracked chains for USDC (ethereum-only today)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", chainCirculating, peggedTotal)).toBe(32_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating has no tracked-chain key", () => {
    expect(sumMcapForTrackedChains("usdc-circle", { solana: { current: 4e9 } }, peggedTotal)).toBe(37_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating is undefined", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, peggedTotal)).toBe(37_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating is empty (CG-fallback assets)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", {}, peggedTotal)).toBe(37_000_000_000);
  });

  it("returns sumPegBuckets(circulating) for an untracked coin id", () => {
    expect(sumMcapForTrackedChains("nonexistent", chainCirculating, peggedTotal)).toBe(37_000_000_000);
  });

  it("returns 0 when both chainCirculating and circulating are undefined", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, undefined)).toBe(0);
  });
});
