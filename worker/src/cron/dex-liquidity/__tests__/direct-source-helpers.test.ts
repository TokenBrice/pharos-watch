import { describe, it, expect } from "vitest";
import { classifyClPoolType } from "../direct-source-helpers";
import { QUALITY_MULTIPLIERS } from "../../../lib/dex-cron-constants";

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

  it("classifies observed Slipstream 100 bp fees into their own bucket", () => {
    expect(classifyClPoolType("aerodrome-slipstream", 100)).toBe("aerodrome-slipstream-100bp");
    expect(classifyClPoolType("velodrome-slipstream", 100)).toBe("velodrome-slipstream-100bp");
  });

  it("maps every fee-bearing bucket to an explicit quality multiplier", () => {
    const feeBearingBuckets = [
      ...([1, 5, 25, 30, 100] as const).map((fee) => classifyClPoolType("pancakeswap", fee)),
      ...([1, 5, 30, 100] as const).flatMap((fee) => [
        classifyClPoolType("aerodrome-slipstream", fee),
        classifyClPoolType("velodrome-slipstream", fee),
      ]),
    ];
    for (const bucket of feeBearingBuckets) {
      expect(Number.isFinite(QUALITY_MULTIPLIERS[bucket]), `${bucket} must have an explicit multiplier`).toBe(true);
    }
    expect(QUALITY_MULTIPLIERS["aerodrome-slipstream-100bp"]).toBe(0.4);
    expect(QUALITY_MULTIPLIERS["velodrome-slipstream-100bp"]).toBe(0.4);
  });

  it("publishes the neutral bucket instead of a fabricated tier for an unknown fee", () => {
    expect(classifyClPoolType("pancakeswap", null)).toBe("pancakeswap-v3-unknown-fee");
    expect(classifyClPoolType("pancakeswap", undefined)).toBe("pancakeswap-v3-unknown-fee");
    expect(classifyClPoolType("pancakeswap", 0)).toBe("pancakeswap-v3-unknown-fee");
    expect(classifyClPoolType("aerodrome-slipstream", null)).toBe("aerodrome-slipstream-unknown-fee");
    expect(classifyClPoolType("velodrome-slipstream", Number.NaN)).toBe("velodrome-slipstream-unknown-fee");
  });
});
