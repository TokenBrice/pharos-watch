import { describe, it, expect } from "vitest";
import { classifyClPoolType } from "../direct-source-helpers";

describe("classifyClPoolType", () => {
  it("classifies PancakeSwap tiers 1/5/25/100 bp into distinct buckets", () => {
    expect(classifyClPoolType("pancakeswap", 1)).toBe("pancakeswap-v3-1bp");
    expect(classifyClPoolType("pancakeswap", 5)).toBe("pancakeswap-v3-5bp");
    expect(classifyClPoolType("pancakeswap", 25)).toBe("pancakeswap-v3-25bp");
    expect(classifyClPoolType("pancakeswap", 100)).toBe("pancakeswap-v3-100bp");
  });

  it("Slipstream variants keep the existing 1/5/30 bp scheme (A6 deferred)", () => {
    expect(classifyClPoolType("aerodrome-slipstream", 1)).toBe("aerodrome-slipstream-1bp");
    expect(classifyClPoolType("aerodrome-slipstream", 5)).toBe("aerodrome-slipstream-5bp");
    expect(classifyClPoolType("aerodrome-slipstream", 30)).toBe("aerodrome-slipstream-30bp");
    expect(classifyClPoolType("velodrome-slipstream", 5)).toBe("velodrome-slipstream-5bp");
  });

  it("defaults null/undefined PancakeSwap fees to the widest tier (via the 500 fallback)", () => {
    // classifyClPoolType's internal default is normalizedFeeBps = 500. After the fix,
    // pancakeswap at 500bps flows past 1/5/25/30 into the 100bp bucket.
    expect(classifyClPoolType("pancakeswap", null)).toBe("pancakeswap-v3-100bp");
    expect(classifyClPoolType("pancakeswap", undefined)).toBe("pancakeswap-v3-100bp");
    // Slipstream still falls through to the legacy 30bp bucket.
    expect(classifyClPoolType("aerodrome-slipstream", null)).toBe("aerodrome-slipstream-30bp");
  });
});
