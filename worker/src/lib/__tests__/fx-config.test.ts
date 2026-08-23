import { describe, expect, it } from "vitest";
import { FX_RATE_BOUNDS } from "@shared/lib/peg-price-bounds";
import { EXPECTED_FX_PEG_KEYS, invertUnitsPerUsd, REALTIME_FX_CURRENCY_TO_PEG, SECONDARY_FX_CURRENCY_TO_PEG } from "../fx-config";

describe("fx-config currency maps", () => {
  it("SECONDARY (lowercase keys) and REALTIME (uppercase keys) agree on the same currencies", () => {
    for (const [lowerKey, pegValue] of Object.entries(SECONDARY_FX_CURRENCY_TO_PEG)) {
      const upperKey = lowerKey.toUpperCase();
      expect(REALTIME_FX_CURRENCY_TO_PEG[upperKey], `missing ${upperKey} in REALTIME`).toBe(pegValue);
    }
  });

  it("SECONDARY keys are lowercase and REALTIME keys are uppercase", () => {
    for (const key of Object.keys(SECONDARY_FX_CURRENCY_TO_PEG)) {
      expect(key).toBe(key.toLowerCase());
    }
    for (const key of Object.keys(REALTIME_FX_CURRENCY_TO_PEG)) {
      expect(key).toBe(key.toUpperCase());
    }
  });

  it("every expected peg key has sanity bounds so isValidFxRate fails closed", () => {
    for (const pegKey of EXPECTED_FX_PEG_KEYS) {
      const bounds = FX_RATE_BOUNDS[pegKey];
      expect(bounds, `missing FX_RATE_BOUNDS for ${pegKey}`).toBeDefined();
      expect(bounds![0]).toBeGreaterThan(0);
      expect(bounds![1]).toBeGreaterThan(bounds![0]);
    }

    for (const [pegKey, unitsPerUsd] of [
      ["peggedVND", 26_000],
      ["peggedIDR", 15_800],
      ["peggedCOP", 3_200],
    ] as const) {
      const exact = 1 / unitsPerUsd;
      const inverted = invertUnitsPerUsd(unitsPerUsd);
      const bounds = FX_RATE_BOUNDS[pegKey]!;
      expect(inverted).toBe(exact);
      expect(Math.abs(inverted - exact) / exact).toBe(0);
      expect(inverted).toBeGreaterThanOrEqual(bounds[0]);
      expect(inverted).toBeLessThanOrEqual(bounds[1]);
    }
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => invertUnitsPerUsd(invalid)).toThrow(RangeError);
    }
  });
});
