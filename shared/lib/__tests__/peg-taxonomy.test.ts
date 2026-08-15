import { describe, expect, it } from "vitest";

import { PEG_CURRENCY_VALUES } from "../../types/core";
import { PEG_METADATA } from "../classification/pegs";
import {
  PEG_CURRENCY_SYMBOLS,
  PEG_FX_RATE_BOUNDS,
  PEG_HARDCODED_PRICE_BOUNDS,
  PEG_HERO_CHIP_LABELS,
  PEG_TAXONOMY,
  getPegTaxonomyByCurrency,
  getPegTaxonomyByType,
  normalizePegTypeAlias,
  pegTypeFromCurrency,
} from "../peg-taxonomy";

describe("peg taxonomy", () => {
  it("exhaustively covers the PegCurrency vocabulary and presentation metadata", () => {
    expect(Object.keys(PEG_TAXONOMY)).toEqual(PEG_CURRENCY_VALUES);
    for (const currency of PEG_CURRENCY_VALUES) {
      const entry = PEG_TAXONOMY[currency];
      expect(entry.currency).toBe(currency);
      expect(entry.symbol.length).toBeGreaterThan(0);
      expect(entry.heroChipLabel).toBe(`${currency}-Pegged`);
      expect(entry.presentation).toBe(PEG_METADATA[currency]);
      expect(PEG_CURRENCY_SYMBOLS[currency]).toBe(entry.symbol);
      expect(PEG_HERO_CHIP_LABELS[currency]).toBe(entry.heroChipLabel);
    }
  });

  it("round-trips every canonical peg type", () => {
    for (const currency of PEG_CURRENCY_VALUES) {
      const entry = PEG_TAXONOMY[currency];
      expect(pegTypeFromCurrency(currency)).toBe(entry.canonicalPegType ?? undefined);
      if (!entry.canonicalPegType) continue;
      expect(getPegTaxonomyByType(entry.canonicalPegType)).toBe(entry);
      expect(PEG_HARDCODED_PRICE_BOUNDS[currency]).toEqual(entry.hardcodedPriceBounds);
      if (entry.fxRateBounds) {
        expect(PEG_FX_RATE_BOUNDS[entry.canonicalPegType]).toEqual(entry.fxRateBounds);
      }
    }
  });

  it("owns BRL/REAL currency and peg-type aliases", () => {
    expect(getPegTaxonomyByCurrency(" brl ")).toBe(PEG_TAXONOMY.BRL);
    expect(getPegTaxonomyByCurrency("REAL")).toBe(PEG_TAXONOMY.BRL);
    expect(pegTypeFromCurrency("REAL")).toBe("peggedREAL");
    expect(getPegTaxonomyByType("peggedBRL")).toBe(PEG_TAXONOMY.BRL);
    expect(normalizePegTypeAlias("peggedBRL")).toBe("peggedREAL");
    expect(PEG_HARDCODED_PRICE_BOUNDS.REAL).toEqual(PEG_TAXONOMY.BRL.hardcodedPriceBounds);
  });

  it("keeps variable and other pegs out of DefiLlama peg-type normalization", () => {
    expect(PEG_TAXONOMY.VAR.pegClass).toBe("variable");
    expect(PEG_TAXONOMY.OTHER.pegClass).toBe("variable");
    expect(pegTypeFromCurrency("VAR")).toBeUndefined();
    expect(pegTypeFromCurrency("OTHER")).toBeUndefined();
  });

  it("does not invent entries for unknown values", () => {
    expect(getPegTaxonomyByCurrency("UNKNOWN")).toBeUndefined();
    expect(getPegTaxonomyByType("peggedUNKNOWN")).toBeUndefined();
    expect(normalizePegTypeAlias("peggedUNKNOWN")).toBe("peggedUNKNOWN");
  });
});
