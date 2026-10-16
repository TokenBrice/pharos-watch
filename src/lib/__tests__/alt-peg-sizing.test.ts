import { describe, expect, it } from "vitest";
import { coinEmblemSize, SIZE_CEIL, SIZE_FLOOR } from "@/lib/alt-peg-sizing";

describe("coinEmblemSize", () => {
  it("returns SIZE_FLOOR for 0 or negative market cap", () => {
    expect(coinEmblemSize(0)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(-1)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(Number.NaN)).toBe(SIZE_FLOOR);
  });

  it("clamps to SIZE_CEIL for very large mcaps", () => {
    expect(coinEmblemSize(10_000_000_000)).toBe(SIZE_CEIL);
  });

  it("scales monotonically between $1M and $500M", () => {
    const sizes = [1_000_000, 10_000_000, 100_000_000, 500_000_000].map((marketCapUsd) => coinEmblemSize(marketCapUsd));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

});
