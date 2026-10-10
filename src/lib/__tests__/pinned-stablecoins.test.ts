import { describe, expect, it } from "vitest";
import {
  MAX_PINNED_STABLECOINS,
  normalizePinnedStablecoinIds,
} from "@/lib/pinned-stablecoins";

const validIds = new Set(Array.from({ length: 20 }, (_, i) => `coin-${i}`));

describe("normalizePinnedStablecoinIds", () => {
  it("falls back to empty for non-array values", () => {
    expect(normalizePinnedStablecoinIds("coin-1", validIds)).toEqual([]);
  });

  it("drops invalid values, inactive ids, duplicates, and over-limit ids", () => {
    const raw = [
      "coin-1",
      "missing",
      "coin-2",
      "coin-1",
      null,
      ...Array.from({ length: 20 }, (_, i) => `coin-${i}`),
    ];

    const result = normalizePinnedStablecoinIds(raw, validIds);

    expect(result).toHaveLength(MAX_PINNED_STABLECOINS);
    expect(result.slice(0, 3)).toEqual(["coin-1", "coin-2", "coin-0"]);
    expect(new Set(result).size).toBe(result.length);
    expect(result).not.toContain("missing");
  });
});
