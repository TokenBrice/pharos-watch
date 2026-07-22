import { describe, expect, it } from "vitest";

import { PEG_CURRENCY_VALUES } from "@shared/types/core";

import {
  classifyPegClass,
  FX_RATE_BOUNDS,
  HARDCODED_PRICE_BOUNDS,
  normalizeLegacyPegType,
  normalizePegTypeFromCurrency,
  type PegClass,
} from "../peg-price-bounds";

type BoundsCase = {
  label: string;
  hardcodedKey: string;
  hardcodedBounds: [number, number];
  hardcodedWidth: number;
  fxKey?: string;
  fxBounds?: [number, number];
  fxWidth?: number;
};

describe("peg price bounds", () => {
  const boundsCases: BoundsCase[] = [
    {
      label: "USD",
      hardcodedKey: "USD",
      hardcodedBounds: [0.01, 1.19],
      hardcodedWidth: 1.18,
    },
    {
      label: "EUR fiat FX",
      hardcodedKey: "EUR",
      hardcodedBounds: [0.01, 2],
      hardcodedWidth: 1.99,
      fxKey: "peggedEUR",
      fxBounds: [0.5, 2.5],
      fxWidth: 2,
    },
    {
      label: "CHF fiat FX",
      hardcodedKey: "CHF",
      hardcodedBounds: [0.01, 2],
      hardcodedWidth: 1.99,
      fxKey: "peggedCHF",
      fxBounds: [0.4, 2.5],
      fxWidth: 2.1,
    },
    {
      label: "JPY small-unit fiat FX",
      hardcodedKey: "JPY",
      hardcodedBounds: [0.001, 0.05],
      hardcodedWidth: 0.049,
      fxKey: "peggedJPY",
      fxBounds: [0.003, 0.03],
      fxWidth: 0.027,
    },
    {
      label: "GOLD commodity",
      hardcodedKey: "GOLD",
      hardcodedBounds: [100, 100_000],
      hardcodedWidth: 99_900,
      fxKey: "peggedGOLD",
      fxBounds: [500, 10_000],
      fxWidth: 9_500,
    },
    {
      label: "SILVER commodity",
      hardcodedKey: "SILVER",
      hardcodedBounds: [5, 500],
      hardcodedWidth: 495,
      fxKey: "peggedSILVER",
      fxBounds: [5, 500],
      fxWidth: 495,
    },
  ];

  for (const entry of boundsCases) {
    it(`pins ${entry.label} absolute price bounds`, () => {
      const hardcodedBounds = HARDCODED_PRICE_BOUNDS[entry.hardcodedKey];

      expect(hardcodedBounds).toEqual(entry.hardcodedBounds);
      expect(hardcodedBounds![1] - hardcodedBounds![0]).toBeCloseTo(entry.hardcodedWidth, 12);

      if (entry.fxKey) {
        const fxBounds = FX_RATE_BOUNDS[entry.fxKey];

        expect(fxBounds).toEqual(entry.fxBounds);
        expect(fxBounds![1] - fxBounds![0]).toBeCloseTo(entry.fxWidth!, 12);
      }
    });
  }

  const classCases: Array<{
    label: string;
    pegCurrency: string | undefined;
    pegType: string | undefined;
    navToken: boolean;
    expected: PegClass;
  }> = [
    { label: "USD", pegCurrency: "USD", pegType: "peggedUSD", navToken: false, expected: "usd" },
    { label: "EUR", pegCurrency: "EUR", pegType: "peggedEUR", navToken: false, expected: "fiat_fx" },
    { label: "CHF", pegCurrency: "CHF", pegType: "peggedCHF", navToken: false, expected: "fiat_fx" },
    { label: "GOLD", pegCurrency: "GOLD", pegType: "peggedGOLD", navToken: false, expected: "commodity" },
    { label: "NAV token", pegCurrency: "USD", pegType: "peggedUSD", navToken: true, expected: "nav" },
    { label: "VAR", pegCurrency: "VAR", pegType: undefined, navToken: false, expected: "variable" },
    { label: "OTHER", pegCurrency: "OTHER", pegType: "peggedOTHER", navToken: false, expected: "variable" },
    { label: "missing peg type", pegCurrency: undefined, pegType: undefined, navToken: false, expected: "unknown" },
  ];

  for (const entry of classCases) {
    it(`classifies ${entry.label} pegs`, () => {
      expect(classifyPegClass(entry.pegCurrency, entry.pegType, entry.navToken)).toBe(entry.expected);
    });
  }

  it("pins peg-type normalization edge cases", () => {
    expect(normalizeLegacyPegType("peggedBRL")).toBe("peggedREAL");
    expect(normalizeLegacyPegType("peggedEUR")).toBe("peggedEUR");
    expect(normalizePegTypeFromCurrency("BRL")).toBe("peggedREAL");
    expect(normalizePegTypeFromCurrency("USD")).toBe("peggedUSD");
    expect(normalizePegTypeFromCurrency("VAR")).toBeUndefined();
    expect(normalizePegTypeFromCurrency("OTHER")).toBeUndefined();
  });

  it("covers every supported fiat and commodity peg currency", () => {
    const unsupported: string[] = [];
    const hardcodedKeys = Object.keys(HARDCODED_PRICE_BOUNDS).filter((key) => key !== "USD");
    let covered = 0;

    for (const pegCurrency of PEG_CURRENCY_VALUES) {
      const pegType = normalizePegTypeFromCurrency(pegCurrency);
      const pegClass = classifyPegClass(pegCurrency, pegType, false);
      if (pegClass === "unknown") {
        unsupported.push(pegCurrency);
        continue;
      }
      if (pegClass !== "fiat_fx" && pegClass !== "commodity") continue;
      expect(pegType, `${pegCurrency} normalized peg type`).toBeDefined();
      if (!pegType) continue;
      expect(
        hardcodedKeys.some((key) => pegType.includes(key)),
        `${pegCurrency} hardcoded bounds`,
      ).toBe(true);
      expect(FX_RATE_BOUNDS[pegType], `${pegCurrency} FX bounds`).toBeDefined();
      covered += 1;
    }

    expect(unsupported).toEqual([]);
    expect(covered).toBe(28);
  });

  it("keeps non-USD hardcoded maxima within 0.1x-10x of FX maxima", () => {
    for (const [currency, [, hardcodedMax]] of Object.entries(HARDCODED_PRICE_BOUNDS)) {
      if (currency === "USD") continue;
      const pegType = normalizePegTypeFromCurrency(currency);
      const fxMax = pegType ? FX_RATE_BOUNDS[pegType]?.[1] : undefined;
      if (fxMax === undefined) continue;
      const ratio = hardcodedMax / fxMax;
      expect(ratio, `${currency} hardcoded/FX maximum ratio`).toBeGreaterThanOrEqual(0.1);
      expect(ratio, `${currency} hardcoded/FX maximum ratio`).toBeLessThanOrEqual(10);
    }
  });
});
