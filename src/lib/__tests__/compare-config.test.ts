import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  DELISTED_IDS,
  FROZEN_IDS,
  QUARANTINED_IDS,
} from "@shared/lib/stablecoins/registry";
import { COMPARE_COIN_OPTIONS, COMPARISON_PRESETS, parseIdList, resolveCompareSelectedIds } from "../compare-config";

describe("parseIdList", () => {
  it("trims, deduplicates, and caps generic id lists", () => {
    expect(parseIdList(" a, a, , b, c ", { max: 2 })).toEqual(["a", "b"]);
  });
});

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
  it("allows active and frozen history while excluding withheld records", () => {
    for (const option of COMPARE_COIN_OPTIONS) {
      expect(ACTIVE_IDS.has(option.id) || FROZEN_IDS.has(option.id)).toBe(true);
    }
    expect(COMPARE_COIN_OPTIONS.some((option) => QUARANTINED_IDS.has(option.id))).toBe(false);
    expect(COMPARE_COIN_OPTIONS.some((option) => DELISTED_IDS.has(option.id))).toBe(false);
  });

  it("flags frozen entries with frozen=true", () => {
    for (const option of COMPARE_COIN_OPTIONS) {
      const expected = FROZEN_IDS.has(option.id);
      expect(option.frozen === true).toBe(expected);
    }
  });
});

describe("COMPARISON_PRESETS", () => {
  it("references only active or frozen comparable ids", () => {
    for (const preset of COMPARISON_PRESETS) {
      for (const id of preset.coins) {
        expect(ACTIVE_IDS.has(id) || FROZEN_IDS.has(id)).toBe(true);
      }
    }
  });
});
