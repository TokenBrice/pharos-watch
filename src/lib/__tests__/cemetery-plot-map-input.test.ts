import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows, type CemeteryRegisterRow } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";

function registerRow(overrides: Partial<CemeteryRegisterRow>): CemeteryRegisterRow {
  return {
    id: "coin-a",
    name: "Coin A",
    symbol: "CNA",
    logoUrl: null,
    cause: "abandoned",
    deathDate: "2024-03",
    peak: 25_000_000,
    pegCurrency: "USD",
    mechanismArchetype: null,
    tracked: false,
    caseStudy: null,
    epitaph: null,
    obituary: "Coin A stopped.",
    sourceUrl: "https://example.com/a",
    sourceLabel: "Example",
    contracts: [],
    ...overrides,
  };
}

describe("toPlotMapInput", () => {
  it("keeps an unrecorded peak unrecorded (never a $0 peak) and an untracked record without a bronze plaque", () => {
    const rows = [registerRow({ id: "coin-a", peak: null }), registerRow({ id: "coin-b", deathDate: "2024-05", peak: 3e9 })];
    const [input] = toPlotMapInput(rows);
    expect(input.peakMcap).toBeUndefined();
    expect(input.archivedDataAvailable).toBe(false);

    const grave = buildCemeteryPlotMap(toPlotMapInput(rows), { preset: "desktop" }).graves.find((g) => g.id === "coin-a");
    expect(grave).toMatchObject({ peak: null, peakClass: null, unrecorded: true, archived: false });
  });

  it("lets the client rebuild exactly the plan the catalog entries give (no field the model reads is lost)", () => {
    const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
    const asOf = buildCemeteryStats(CEMETERY_ENTRIES).asOf.date;
    for (const preset of ["desktop", "portrait"] as const) {
      expect(buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset })).toEqual(buildCemeteryPlotMap(CEMETERY_ENTRIES, { asOf, preset }));
    }
  });
});
