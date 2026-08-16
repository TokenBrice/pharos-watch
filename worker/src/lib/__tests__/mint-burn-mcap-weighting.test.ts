import { describe, expect, it } from "vitest";
import { getMintBurnTrackedChains, sumMcapForTrackedChains } from "../mint-burn-mcap-weighting";

// Per-coin tracked-chain contract pins. When a coin adds a second tracked
// chain (e.g., USDC on Base via CCTP), update the assertion here deliberately —
// the change will shift gauge weighting, and that's a methodology decision
// that should be reflected in the version timeline.
describe("getMintBurnTrackedChains — per-coin contract pins", () => {
  it("USDC tracks ethereum only (until Base/CCTP expansion)", () => {
    expect(getMintBurnTrackedChains("usdc-circle")).toEqual(["ethereum"]);
  });
  it("USDai tracks arbitrum only", () => {
    expect(getMintBurnTrackedChains("usdai-usd-ai")).toEqual(["arbitrum"]);
  });
  it("USDT tracks ethereum only (until Tron support)", () => {
    expect(getMintBurnTrackedChains("usdt-tether")).toEqual(["ethereum"]);
  });
  it("EURC tracks ethereum only", () => {
    expect(getMintBurnTrackedChains("eurc-circle")).toEqual(["ethereum"]);
  });
  it("DAI tracks ethereum only", () => {
    expect(getMintBurnTrackedChains("dai-makerdao")).toEqual(["ethereum"]);
  });
  it("returns empty array for an untracked coin", () => {
    expect(getMintBurnTrackedChains("nonexistent-coin")).toEqual([]);
  });
});

describe("sumMcapForTrackedChains", () => {
  // Real DefiLlama payloads key chainCirculating by display name ("Ethereum",
  // "Arbitrum", "Solana"). The canonicalizer resolves these to lowercase
  // canonical chain ids before lookup.
  const chainCirculatingDL: Record<string, { current: number }> = {
    Ethereum: { current: 32_000_000_000 },
    Solana:   { current: 4_000_000_000 },
    Base:     { current: 1_000_000_000 },
  };
  const peggedTotal: Record<string, number> = { peggedUSD: 37_000_000_000 };

  it("sums only tracked chains for USDC (canonicalizes capitalized DL keys)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", chainCirculatingDL, peggedTotal)).toBe(32_000_000_000);
  });

  it("also works when chainCirculating uses lowercase canonical keys", () => {
    const lowercase: Record<string, { current: number }> = {
      ethereum: { current: 32_000_000_000 },
      solana:   { current: 4_000_000_000 },
    };
    expect(sumMcapForTrackedChains("usdc-circle", lowercase, peggedTotal)).toBe(32_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating has no tracked-chain key", () => {
    expect(sumMcapForTrackedChains("usdc-circle", { Solana: { current: 4e9 } }, peggedTotal)).toBe(37_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating is undefined", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, peggedTotal)).toBe(37_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating is empty (CG-fallback assets)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", {}, peggedTotal)).toBe(37_000_000_000);
  });

  it("returns the circulating bucket total for an untracked coin id", () => {
    expect(sumMcapForTrackedChains("nonexistent", chainCirculatingDL, peggedTotal)).toBe(37_000_000_000);
  });

  it("uses the canonical circulating total when tracked-chain data is absent", () => {
    expect(
      sumMcapForTrackedChains("nonexistent", undefined, {
        peggedUSD: 125_000_000,
        peggedEUR: 75_000_000,
      }),
    ).toBe(200_000_000);
  });

  it("returns 0 when both chainCirculating and circulating are undefined", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, undefined)).toBe(0);
  });

  it("treats current=0 as real data (contributes 0, does NOT trigger fallback)", () => {
    // If a tracked chain reports 0 supply (bootstrapping or burn-to-zero), weight is 0.
    // The canonicalizer creates an entry for the chain; anyFound flips true; result is 0.
    expect(sumMcapForTrackedChains("usdc-circle", { Ethereum: { current: 0 } }, peggedTotal)).toBe(0);
  });
});
