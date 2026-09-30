import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput, type PlotLogoAtlasManifest } from "@/lib/cemetery-plot-map-input";
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
  it("maps a register row onto the plot map's entry fields", () => {
    const [input] = toPlotMapInput([registerRow({ cause: "regulatory", deathDate: "2023-02-13", pegCurrency: "EUR", tracked: true })]);
    expect(input).toMatchObject({ id: "coin-a", name: "Coin A", symbol: "CNA", causeOfDeath: "regulatory", deathDate: "2023-02-13", peakMcap: 25_000_000, pegCurrency: "EUR" });
    expect(input.archivedDataAvailable).toBe(true);
  });

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

describe("toPlotLogoAtlas", () => {
  const manifest: PlotLogoAtlasManifest = {
    revision: "abc123",
    cellSize: 48,
    width: 200,
    height: 100,
    image: "/logos/atlas/cemetery-atlas.webp",
    entries: {
      "coin-a": { color: [0, 0], gray: [50, 0] },
      "coin-b": { color: [100, 50], gray: [150, 50] },
    },
  };

  it("keeps one grey cell per record, the shared colour offset and a revisioned image URL", () => {
    expect(toPlotLogoAtlas(manifest)).toEqual({
      href: "/logos/atlas/cemetery-atlas.webp?v=abc123",
      width: 200,
      height: 100,
      cellSize: 48,
      shift: 50,
      cells: { "coin-a": [50, 0], "coin-b": [150, 50] },
    });
  });

  it("rejects a manifest whose colour cells do not share one offset from their grey cells", () => {
    expect(() => toPlotLogoAtlas({ ...manifest, entries: { ...manifest.entries, "coin-c": { color: [0, 100], gray: [60, 100] } } })).toThrow(/shared offset/);
    expect(() => toPlotLogoAtlas({ ...manifest, entries: { "coin-d": { color: [0, 0], gray: [50, 48] } } })).toThrow(/shared offset/);
    expect(() => toPlotLogoAtlas({ ...manifest, entries: { "coin-e": { color: [0], gray: [50, 0] } } })).toThrow(/pair/);
  });
});
