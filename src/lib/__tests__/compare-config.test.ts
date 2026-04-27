import { describe, expect, it } from "vitest";
import { FROZEN_IDS, READABLE_IDS } from "@shared/lib/stablecoins";
import { COMPARE_COIN_OPTIONS, resolveCompareSelectedIds } from "../compare-config";

describe("resolveCompareSelectedIds", () => {
  it("keeps canonical ids only", () => {
    expect(resolveCompareSelectedIds("usdc-circle,usdt-tether")).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it("drops non-canonical selections", () => {
    expect(resolveCompareSelectedIds("usdt,1,usdc-circle")).toEqual([
      "usdc-circle",
    ]);
  });
});

describe("COMPARE_COIN_OPTIONS", () => {
  it("sources from READABLE_STABLECOINS (active + frozen)", () => {
    for (const option of COMPARE_COIN_OPTIONS) {
      expect(READABLE_IDS.has(option.id)).toBe(true);
    }
  });

  it("flags frozen entries with frozen=true", () => {
    for (const option of COMPARE_COIN_OPTIONS) {
      const expected = FROZEN_IDS.has(option.id);
      expect(option.frozen === true).toBe(expected);
    }
  });
});
