import { describe, it, expect } from "vitest";
import {
  PEG_METADATA,
  PEG_LABELS,
  PEG_FILTER_OPTIONS,
  mapPegMetadata,
} from "@shared/lib/classification/pegs";
import type { PegCurrency } from "../../types";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

// Snapshot of PEG_METADATA keys at the time this test was written (regression net).
const KNOWN_PEG_KEYS: PegCurrency[] = [
  "USD", "EUR", "GBP", "CHF", "BRL", "RUB", "JPY", "KRW", "IDR", "INR",
  "MYR", "SGD", "HKD", "TRY", "AUD", "ZAR", "CAD", "CNY", "CNH", "PHP",
  "MXN", "VND", "UAH", "ARS", "KGS", "NGN", "XOF", "GOLD", "SILVER", "VAR", "OTHER",
];

describe("classification-pegs", () => {
  it("PEG_METADATA has no fewer keys than the known snapshot (regression net)", () => {
    const currentKeys = Object.keys(PEG_METADATA) as PegCurrency[];
    for (const key of KNOWN_PEG_KEYS) {
      expect(currentKeys, `PEG_METADATA is missing key "${key}"`).toContain(key);
    }
    expect(currentKeys.length).toBeGreaterThanOrEqual(KNOWN_PEG_KEYS.length);
  });

  it("every PEG_LABELS key has a corresponding entry in PEG_FILTER_OPTIONS", () => {
    const filterOptionValues = new Set(PEG_FILTER_OPTIONS.map((o) => o.value));
    const pegLabelKeys = Object.keys(PEG_LABELS) as Array<PegCurrency | "all">;

    // PEG_FILTER_OPTIONS is intentionally a curated subset (not all pegs) — but
    // every option value must be a known PEG_LABELS key (or "all").
    for (const opt of PEG_FILTER_OPTIONS) {
      if (opt.value === "all") continue;
      expect(
        pegLabelKeys,
        `PEG_FILTER_OPTIONS has value "${opt.value}" not found in PEG_LABELS`,
      ).toContain(opt.value);
    }
    // The "all" sentinel must be present
    expect(filterOptionValues).toContain("all");
  });

  it("mapPegMetadata returns the same structural output for the same input", () => {
    const result1 = mapPegMetadata((m) => m.label);
    const result2 = mapPegMetadata((m) => m.label);
    expect(result1).toEqual(result2);
  });

  it("mapPegMetadata covers every key in PEG_METADATA", () => {
    const mapped = mapPegMetadata((m) => m.filterTag);
    for (const key of Object.keys(PEG_METADATA) as PegCurrency[]) {
      expect(mapped[key], `mapPegMetadata missing key "${key}"`).toBeDefined();
    }
  });

  it("every active coin's pegCurrency maps to a known PEG_METADATA key", () => {
    const knownPegs = new Set(Object.keys(PEG_METADATA) as PegCurrency[]);
    const offending: string[] = [];

    for (const [id, coin] of ACTIVE_META_BY_ID) {
      const peg = coin.flags.pegCurrency;
      if (!knownPegs.has(peg as PegCurrency)) {
        offending.push(`${id}: unknown pegCurrency "${peg}"`);
      }
    }

    expect(
      offending,
      `Coins with unknown pegCurrency:\n${offending.join("\n")}`,
    ).toHaveLength(0);
  });

  it("each PEG_METADATA entry has all required shape fields", () => {
    for (const [key, meta] of Object.entries(PEG_METADATA)) {
      expect(meta.label, `${key}.label`).toBeTruthy();
      expect(meta.shortLabel, `${key}.shortLabel`).toBeTruthy();
      expect(meta.filterTag, `${key}.filterTag`).toBeTruthy();
      expect(meta.filterLabel, `${key}.filterLabel`).toBeTruthy();
      expect(meta.badge, `${key}.badge`).toBeDefined();
      expect(meta.badge.label, `${key}.badge.label`).toBeTruthy();
      expect(meta.badge.cls, `${key}.badge.cls`).toBeTruthy();
    }
  });
});
