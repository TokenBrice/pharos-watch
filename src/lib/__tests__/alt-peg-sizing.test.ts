import { describe, expect, it } from "vitest";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SIZE_CEIL, SIZE_FLOOR } from "@/lib/alt-peg-sizing";

describe("coinEmblemSize", () => {
  it("returns SIZE_FLOOR for 0 or negative market cap", () => {
    expect(coinEmblemSize(0)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(-1)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(Number.NaN)).toBe(SIZE_FLOOR);
  });

  it("stays close to SIZE_FLOOR for sub-$1M mcaps", () => {
    expect(coinEmblemSize(100_000)).toBeGreaterThanOrEqual(SIZE_FLOOR);
    expect(coinEmblemSize(100_000)).toBeLessThanOrEqual(SIZE_FLOOR + 2);
  });

  it("clamps to SIZE_CEIL for very large mcaps", () => {
    expect(coinEmblemSize(10_000_000_000)).toBe(SIZE_CEIL);
  });

  it("supports a smaller fiat-map cap for crowded atlas clusters", () => {
    expect(coinEmblemSize(10_000_000_000, { ceil: FIAT_MAP_SIZE_CEIL })).toBe(FIAT_MAP_SIZE_CEIL);
  });

  it("scales monotonically between $1M and $500M", () => {
    const sizes = [1_000_000, 10_000_000, 100_000_000, 500_000_000].map((marketCapUsd) => coinEmblemSize(marketCapUsd));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("returns a whole pixel integer", () => {
    expect(Number.isInteger(coinEmblemSize(42_000_000))).toBe(true);
  });
});
