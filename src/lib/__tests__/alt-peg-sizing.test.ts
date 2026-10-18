import { describe, expect, it } from "vitest";
import { coinEmblemSize, FIAT_MAP_SIZE_CEIL, SIZE_CEIL, SIZE_FLOOR, sizeCapMarketCap } from "@/lib/alt-peg-sizing";

describe("coinEmblemSize", () => {
  it("returns SIZE_FLOOR for 0 or negative market cap", () => {
    expect(coinEmblemSize(0)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(-1)).toBe(SIZE_FLOOR);
    expect(coinEmblemSize(Number.NaN)).toBe(SIZE_FLOOR);
  });

  it("clamps to SIZE_CEIL for very large mcaps", () => {
    expect(coinEmblemSize(100_000_000_000)).toBe(SIZE_CEIL);
  });

  it("keeps the leading euro coins apart on the map: the map ceiling sits above $1B", () => {
    expect(sizeCapMarketCap(FIAT_MAP_SIZE_CEIL)).toBeGreaterThan(1_000_000_000);
    const [eurc, eutbl] = [497_000_000, 638_000_000].map((cap) => coinEmblemSize(cap, { ceil: FIAT_MAP_SIZE_CEIL }));
    expect(eutbl).toBeGreaterThan(eurc!);
    expect(coinEmblemSize(1_700_000_000, { ceil: FIAT_MAP_SIZE_CEIL })).toBeGreaterThan(eutbl!);
  });

  it("keeps unknown supply neutral, distinct from the zero floor", () => {
    expect(coinEmblemSize(null, { ceil: FIAT_MAP_SIZE_CEIL })).toBeGreaterThan(SIZE_FLOOR);
  });

  it("scales monotonically between $1M and $500M", () => {
    const sizes = [1_000_000, 10_000_000, 100_000_000, 500_000_000].map((marketCapUsd) => coinEmblemSize(marketCapUsd));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

});
