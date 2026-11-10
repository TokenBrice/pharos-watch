import { describe, expect, it } from "vitest";
import { FX_RATE_BOUNDS } from "@shared/lib/peg-price-bounds";
import { PEG_CURRENCY_VALUES } from "@shared/types/core";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
import { EXPECTED_FX_PEG_KEYS, PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS, SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS, invertUnitsPerUsd, isValidFxRate, PRIMARY_CURRENCY_TO_PEG, REALTIME_FX_CURRENCY_TO_PEG, SECONDARY_FX_CURRENCY_TO_PEG } from "../fx-config";
import { getNaturalFxCadence, inferFxSourceCadence } from "../fx-cadence";

describe("fx-config currency maps", () => {
  it("covers every schema fiat FX peg with a live source and realtime recovery", () => {
    for (const currency of PEG_CURRENCY_VALUES) {
      const peg = getPegTaxonomyByCurrency(currency)!;
      if (peg.pegClass !== "fiat_fx") continue;
      const sourcePeg = PRIMARY_CURRENCY_TO_PEG[currency] ?? SECONDARY_FX_CURRENCY_TO_PEG[currency.toLowerCase()];
      expect(sourcePeg, `${currency} daily FX source`).toBe(peg.canonicalPegType);
      expect(REALTIME_FX_CURRENCY_TO_PEG[currency], `${currency} realtime FX source`).toBe(peg.canonicalPegType);
      expect(EXPECTED_FX_PEG_KEYS).toContain(peg.canonicalPegType);
    }
  });

  it.each([
    ["peggedCZK", 21.8],
    ["peggedPLN", 3.8998],
    ["peggedAED", 3.6725],
  ] as const)("rejects inverted and dollar-normalized %s provider mistakes", (pegKey, unitsPerUsd) => {
    expect(isValidFxRate(pegKey, invertUnitsPerUsd(unitsPerUsd))).toBe(true);
    expect(isValidFxRate(pegKey, unitsPerUsd)).toBe(false);
    expect(isValidFxRate(pegKey, 1)).toBe(false);
  });

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

describe("fx cadence classification", () => {
  // The declared provider pairs, not the derived Records, are the source of
  // truth for which source serves a peg; iterating them keeps the assertion
  // from restating fx-cadence.ts's own Set construction.
  it.each(PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegKey]) => pegKey))(
    "classifies %s as business-daily",
    (pegKey) => {
      expect(getNaturalFxCadence(pegKey)).toBe("business-daily");
      expect(inferFxSourceCadence(pegKey)).toBe("business-daily");
    },
  );

  it.each(SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegKey]) => pegKey))(
    "classifies %s as calendar-daily",
    (pegKey) => {
      expect(getNaturalFxCadence(pegKey)).toBe("calendar-daily");
      expect(inferFxSourceCadence(pegKey)).toBe("calendar-daily");
    },
  );

  it("keeps the two daily providers on disjoint peg sets so precedence cannot hide a duplicate", () => {
    const declared = [
      ...PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegKey]) => pegKey),
      ...SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegKey]) => pegKey),
    ];
    expect(new Set(declared).size).toBe(declared.length);
    expect(new Set(declared)).toEqual(new Set(EXPECTED_FX_PEG_KEYS));
  });

  it.each(["peggedUSD", "peggedGOLD", "peggedSILVER", "peggedUNKNOWN"])(
    "classifies %s as intraday by default",
    (pegKey) => {
      expect(getNaturalFxCadence(pegKey)).toBeNull();
      expect(inferFxSourceCadence(pegKey)).toBe("intraday");
    },
  );

  it("preserves explicit cadence before the natural default", () => {
    expect(inferFxSourceCadence("peggedEUR", "calendar-daily")).toBe("calendar-daily");
    expect(inferFxSourceCadence("peggedEUR", "business-daily")).toBe("business-daily");
  });
});
