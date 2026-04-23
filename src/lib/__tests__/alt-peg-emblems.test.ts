import { describe, expect, it } from "vitest";
import { PEG_ANCHORS } from "@/lib/alt-peg-emblems";

describe("PEG_ANCHORS", () => {
  it("anchors every fiat peg the hero renders", () => {
    const requiredPegs = [
      "EUR",
      "CHF",
      "GBP",
      "RUB",
      "TRY",
      "JPY",
      "IDR",
      "SGD",
      "CNH",
      "PHP",
      "BRL",
      "CAD",
      "MXN",
      "ZAR",
      "AUD",
    ];
    for (const peg of requiredPegs) {
      expect(PEG_ANCHORS[peg]).toBeDefined();
      expect(PEG_ANCHORS[peg].x).toBeGreaterThanOrEqual(0);
      expect(PEG_ANCHORS[peg].x).toBeLessThanOrEqual(100);
      expect(PEG_ANCHORS[peg].y).toBeGreaterThanOrEqual(0);
      expect(PEG_ANCHORS[peg].y).toBeLessThanOrEqual(100);
    }
  });
});
