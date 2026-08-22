import { describe, expect, it } from "vitest";
import { findCanonicalChainData } from "@shared/lib/chains/circulating";

type ChainCirculating = Record<
  string,
  {
    current?: number;
    circulatingPrevDay?: number;
    circulatingPrevWeek?: number;
    circulatingPrevMonth?: number;
  }
>;

describe("findCanonicalChainData", () => {
  it("returns null when chainCirculating is empty", () => {
    const result = findCanonicalChainData({}, "ethereum");
    expect(result).toBeNull();
  });

  it("finds data by exact canonical chain id", () => {
    const cc: ChainCirculating = {
      ethereum: { current: 1_000_000, circulatingPrevDay: 990_000, circulatingPrevWeek: 980_000, circulatingPrevMonth: 950_000 },
    };
    const result = findCanonicalChainData(cc, "ethereum");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(1_000_000);
    expect(result!.circulatingPrevDay).toBe(990_000);
    expect(result!.circulatingPrevWeek).toBe(980_000);
    expect(result!.circulatingPrevMonth).toBe(950_000);
  });

  it("resolves DL display name 'BSC' to canonical chain id 'bsc'", () => {
    const cc: ChainCirculating = {
      BSC: { current: 500_000, circulatingPrevDay: 490_000, circulatingPrevWeek: 480_000, circulatingPrevMonth: 470_000 },
    };
    const result = findCanonicalChainData(cc, "bsc");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(500_000);
  });

  it("resolves alias 'hyperliquid-l1' to canonical 'hyperliquid'", () => {
    const cc: ChainCirculating = {
      "hyperliquid-l1": { current: 200_000, circulatingPrevDay: 195_000, circulatingPrevWeek: 190_000, circulatingPrevMonth: 185_000 },
    };
    const result = findCanonicalChainData(cc, "hyperliquid");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(200_000);
  });

  it("returns null for a target chain not present in chainCirculating", () => {
    const cc: ChainCirculating = {
      ethereum: { current: 1_000_000, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
    };
    const result = findCanonicalChainData(cc, "solana");
    expect(result).toBeNull();
  });

  it("sums data when multiple keys resolve to the same chain (aliased + canonical)", () => {
    // Both 'hyperliquid-l1' and 'hyperliquid' resolve to 'hyperliquid'
    const cc: ChainCirculating = {
      "hyperliquid-l1": { current: 100_000, circulatingPrevDay: 90_000, circulatingPrevWeek: 80_000, circulatingPrevMonth: 70_000 },
      hyperliquid: { current: 50_000, circulatingPrevDay: 45_000, circulatingPrevWeek: 40_000, circulatingPrevMonth: 35_000 },
    };
    const result = findCanonicalChainData(cc, "hyperliquid");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(150_000);
    expect(result!.circulatingPrevDay).toBe(135_000);
  });

  it("uses 0 as default when individual sub-fields are missing", () => {
    const cc: ChainCirculating = {
      ethereum: { current: 500_000 }, // missing prev fields
    };
    const result = findCanonicalChainData(cc, "ethereum");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(500_000);
    expect(result!.circulatingPrevDay).toBe(0);
    expect(result!.circulatingPrevWeek).toBe(0);
    expect(result!.circulatingPrevMonth).toBe(0);
  });

  it("resolves DL display name 'Ethereum' (capitalized) to canonical 'ethereum'", () => {
    const cc: ChainCirculating = {
      Ethereum: { current: 999_000, circulatingPrevDay: 998_000, circulatingPrevWeek: 997_000, circulatingPrevMonth: 996_000 },
    };
    const result = findCanonicalChainData(cc, "ethereum");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(999_000);
  });

  it("skips null/undefined entries without throwing", () => {
    const cc = {
      ethereum: null as unknown as ChainCirculating["ethereum"],
      solana: { current: 123_000, circulatingPrevDay: 122_000, circulatingPrevWeek: 121_000, circulatingPrevMonth: 120_000 },
    };
    const result = findCanonicalChainData(cc, "solana");
    expect(result).not.toBeNull();
    expect(result!.current).toBe(123_000);
  });

  it("returns null for chains with unknown keys that do not resolve", () => {
    const cc: ChainCirculating = {
      "totally-unknown-chain-xyz": { current: 999, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
    };
    const result = findCanonicalChainData(cc, "ethereum");
    expect(result).toBeNull();
  });
});
