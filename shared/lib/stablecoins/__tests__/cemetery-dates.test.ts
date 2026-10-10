import { describe, expect, it } from "vitest";
import { parseCemeteryDeathDate } from "../../cemetery";
import { parseDeadStablecoinAssets, parseStablecoinMetaAssets } from "../schema";
import { makeRawStablecoinMeta } from "./test-support";

const narrative = {
  causeOfDeath: "abandoned",
  epitaph: "Closed without ceremony.",
  obituary: "The fixture issuer ended issuance.",
  sourceUrl: "https://example.com/closure",
  sourceLabel: "Issuer announcement",
};

function authoringRows(deathDate: string) {
  return {
    curated: [{ ...narrative, id: "fixture-dead", name: "Fixture", symbol: "FXT", pegCurrency: "USD", recordedAt: "2026-10-10", deathDate }],
    frozen: [makeRawStablecoinMeta({
      status: "frozen", frozenAt: "2026-10-10", obituary: { ...narrative, deathDate },
    })],
  };
}

describe("cemetery Gregorian death-date admission", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-04-30", "2026-10-10", "2026-02"])(
    "preserves valid day or month precision at both authoring boundaries: %s", (deathDate) => {
      const rows = authoringRows(deathDate);
      const parts = parseCemeteryDeathDate(deathDate);
      expect(parts).not.toBeNull();
      expect(parts?.day).toBe(deathDate.length === 7 ? null : Number(deathDate.slice(8)));
      expect(parseDeadStablecoinAssets(rows.curated, "fixture")[0]?.deathDate).toBe(deathDate);
      expect(parseStablecoinMetaAssets(rows.frozen, "fixture")[0]?.obituary?.deathDate).toBe(deathDate);
    },
  );

  it.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-02-30", "0000-01-01", "2026-13"])(
    "rejects impossible dates before either source can enter stats or exports: %s", (deathDate) => {
      const rows = authoringRows(deathDate);
      expect(parseCemeteryDeathDate(deathDate)).toBeNull();
      expect(() => parseDeadStablecoinAssets(rows.curated, "fixture")).toThrow(/deathDate/);
      expect(() => parseStablecoinMetaAssets(rows.frozen, "fixture")).toThrow(/deathDate/);
    },
  );

  it("retains shared year-precision parsing but requires month precision for authored rows", () => {
    expect(parseCemeteryDeathDate("2026")).toEqual({ year: 2026, month: null, day: null });
    const rows = authoringRows("2026");
    expect(() => parseDeadStablecoinAssets(rows.curated, "fixture")).toThrow(/deathDate/);
    expect(() => parseStablecoinMetaAssets(rows.frozen, "fixture")).toThrow(/deathDate/);
  });
});
