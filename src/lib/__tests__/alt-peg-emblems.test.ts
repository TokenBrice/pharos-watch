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
      "KRW",
      "IDR",
      "MYR",
      "SGD",
      "CNH",
      "PHP",
      "KGS",
      "BRL",
      "ARS",
      "NGN",
      "XOF",
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

  it("keeps Swiss franc markers in central Europe", () => {
    expect(PEG_ANCHORS.CHF).toMatchObject({ x: 50, y: 28 });
  });

  it("keeps southern hemisphere anchors below the equatorial band", () => {
    expect(PEG_ANCHORS.BRL.y).toBeGreaterThanOrEqual(60);
    expect(PEG_ANCHORS.ARS.y).toBeGreaterThanOrEqual(75);
    expect(PEG_ANCHORS.ZAR.y).toBeGreaterThanOrEqual(70);
    expect(PEG_ANCHORS.AUD.y).toBeGreaterThanOrEqual(70);
  });
});
