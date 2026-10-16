import { describe, expect, it } from "vitest";
import { CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { formatDeathDate } from "@shared/lib/format";
import {
  PLOT_HEIGHT,
  PLOT_LAYOUT,
  PLOT_STEP_THRESHOLDS_USD,
  buildCemeteryPlotMap,
  fitSectionCamera,
  plotHeightFactorOf,
  plotPeakClassOf,
  validatePlotMapCapacity,
  type CemeteryPlotMap,
  type CemeteryPlotMapInput,
} from "@/lib/cemetery-plot-map";
import { CEMETERY_RESERVED_ID_PREFIXES, findCemeteryIdCollisions } from "@/lib/cemetery-selection";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";

let seq = 0;
function row(causeOfDeath: CauseOfDeath, deathDate: string, overrides: Partial<CemeteryPlotMapInput> = {}): CemeteryPlotMapInput {
  seq += 1;
  const id = overrides.id ?? `coin-${seq}`;
  return { id, name: `Coin ${id}`, symbol: id.toUpperCase(), causeOfDeath, deathDate, pegCurrency: "USD", peakMcap: 20_000_000, ...overrides };
}

const byId = (map: CemeteryPlotMap) => new Map(map.graves.map((g) => [g.id, g]));

const desktop = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "desktop" });
const portrait = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });

describe("buildCemeteryPlotMap: encodings", () => {
  it("scales height monotonically with peak between an explicit floor and ceiling", () => {
    const peaks = [1e5, 1e6, 3e6, 5e6, 1e7, 3e7, 1e8, 1e9, 5e9, 1e10, 2e10, 1e12];
    const heights = peaks.map(plotHeightFactorOf);
    for (let k = 1; k < heights.length; k++) expect(heights[k]).toBeGreaterThanOrEqual(heights[k - 1]);
    expect(plotHeightFactorOf(1e5)).toBe(PLOT_HEIGHT.floor);
    expect(plotHeightFactorOf(1e12)).toBe(PLOT_HEIGHT.ceiling);
    expect(plotHeightFactorOf(1e8)).toBeGreaterThan(plotHeightFactorOf(1e7));
    expect(Math.min(...heights)).toBe(PLOT_HEIGHT.floor);
    expect(Math.max(...heights)).toBe(PLOT_HEIGHT.ceiling);

    const map = buildCemeteryPlotMap(peaks.map((peakMcap, k) => row("abandoned", `2024-${String(k + 1).padStart(2, "0")}`, { id: `h${k}`, peakMcap })), { preset: "desktop" });
    const built = peaks.map((_, k) => byId(map).get(`h${k}`)!.heightFactor);
    for (let k = 1; k < built.length; k++) expect(built[k]).toBeGreaterThanOrEqual(built[k - 1]);
  });

  it("adds one plinth step at each of $10M, $100M, $1B and $10B, and sizes lots at $1B and $10B", () => {
    expect(PLOT_STEP_THRESHOLDS_USD).toEqual([1e7, 1e8, 1e9, 1e10]);
    PLOT_STEP_THRESHOLDS_USD.forEach((threshold, k) => {
      expect(plotPeakClassOf(threshold - 1)).toBe(k);
      expect(plotPeakClassOf(threshold)).toBe(k + 1);
    });
    expect(plotPeakClassOf(1)).toBe(0);
    expect(plotPeakClassOf(1e13)).toBe(4);

    const map = buildCemeteryPlotMap(
      [9_999_999, 1e7, 999_999_999, 1e9, 9_999_999_999, 1e10].map((peakMcap, k) => row("regulatory", `20${10 + k}-06`, { id: `s${k}`, peakMcap })),
      { preset: "desktop" },
    );
    const g = byId(map);
    expect([0, 1, 2, 3, 4, 5].map((k) => g.get(`s${k}`)!.steps)).toEqual([0, 1, 2, 3, 3, 4]);
    expect([0, 1, 2, 3, 4, 5].map((k) => g.get(`s${k}`)!.lot)).toEqual([1, 1, 1, 2, 2, 3]);
  });

  it("gives unrecorded peaks the neutral height of the $10M–$100M class, never the floor or the 0-step class", () => {
    const entries = [
      row("abandoned", "2024-01", { peakMcap: 12_000_000 }),
      row("abandoned", "2024-02", { peakMcap: 40_000_000 }),
      row("abandoned", "2024-03", { peakMcap: 90_000_000 }),
      row("abandoned", "2024-04", { peakMcap: 1_000 }),
      row("abandoned", "2024-05", { id: "u-missing", peakMcap: undefined }),
      row("abandoned", "2024-06", { id: "u-zero", peakMcap: 0 }),
      row("abandoned", "2024-07", { id: "u-nan", peakMcap: Number.NaN }),
      row("abandoned", "2024-08", { id: "u-negative", peakMcap: -5 }),
    ];
    const map = buildCemeteryPlotMap(entries, { preset: "desktop" });
    const unrecorded = map.graves.filter((g) => g.id.startsWith("u-"));
    expect(unrecorded).toHaveLength(4);
    const median = Math.round(plotHeightFactorOf(40_000_000) * 100) / 100;
    for (const g of unrecorded) {
      expect(g.unrecorded).toBe(true);
      expect(g.peak).toBeNull();
      expect(g.peakClass).toBeNull();
      expect(g.steps).toBeNull();
      expect(g.lot).toBe(1);
      expect(g.heightFactor).toBe(median);
      expect(g.heightFactor).not.toBe(PLOT_HEIGHT.floor);
    }
    expect(map.graves.find((g) => g.peak === 1_000)?.heightFactor).toBe(PLOT_HEIGHT.floor);

    // Without any $10M–$100M peak the neutral height still sits above the floor.
    const lone = buildCemeteryPlotMap([row("regulatory", "2024-01", { peakMcap: undefined }), row("regulatory", "2024-02", { peakMcap: 1_000 })], { preset: "desktop" });
    expect(lone.neutralHeight).toBeGreaterThan(PLOT_HEIGHT.floor);
    expect(lone.graves.find((g) => g.unrecorded)?.steps).toBeNull();
  });
});

describe("buildCemeteryPlotMap: weathering depends only on asOf", () => {
  const entries = [
    row("abandoned", "2025-12-01", { id: "w0" }),
    row("abandoned", "2025-06", { id: "w1" }),
    row("abandoned", "2024-06-15", { id: "w2" }),
    row("abandoned", "2022-06-15", { id: "w3" }),
    row("abandoned", "2020-06-15", { id: "w4" }),
  ];

  it("quantises age before asOf into w0–w4 and marks fresh soil within 90 days", () => {
    const map = buildCemeteryPlotMap(entries, { asOf: "2026-01-01", preset: "desktop" });
    const g = byId(map);
    expect(["w0", "w1", "w2", "w3", "w4"].map((id) => g.get(id)!.weather)).toEqual([0, 1, 2, 3, 4]);
    expect(["w0", "w1", "w2", "w3", "w4"].map((id) => g.get(id)!.fresh)).toEqual([true, false, false, false, false]);
    for (const grave of map.graves) {
      if (grave.weather === 4) expect(Math.abs(grave.lean)).toBeGreaterThanOrEqual(1.2);
      else expect(grave.lean).toBe(0);
    }
  });
});

describe("buildCemeteryPlotMap: year blocks", () => {
  it("puts every real grave inside its own year's block and nowhere else", () => {
    for (const b of desktop.blocks) {
      const expected = desktop.graves.filter((g) => !b.empty && g.year === b.year).map((g) => g.id).sort();
      expect([...b.ids].sort()).toEqual(expected);
      expect(b.count).toBe(expected.length);
    }
    for (const g of desktop.graves) {
      const block = desktop.blocks.find((b) => !b.empty && b.year === g.year)!;
      expect(g.cell.i0).toBeGreaterThanOrEqual(block.i0);
      expect(g.cell.i1).toBeLessThanOrEqual(block.i1);
    }
    expect(desktop.blocks.reduce((n, b) => n + b.count, 0)).toBe(CEMETERY_ENTRIES.length);
  });
});

describe("buildCemeteryPlotMap: identity and order", () => {
  it("keeps every real id unique and clear of the reserved prefixes", () => {
    const ids = desktop.graves.map((g) => g.id);
    expect(new Set(ids).size).toBe(CEMETERY_ENTRIES.length);
    expect(findCemeteryIdCollisions(ids)).toEqual([]);
    for (const id of ids) for (const prefix of CEMETERY_RESERVED_ID_PREFIXES) expect(id.startsWith(prefix)).toBe(false);
    expect(new Set(desktop.drawOrder).size).toBe(desktop.drawOrder.length);
    for (const g of desktop.graves) expect(desktop.drawOrder[g.draw]).toBe(`grave:${g.id}`);
  });
});

describe("colossus chips", () => {
  it("derive name, peak and month from the entries", () => {
    const giants = CEMETERY_ENTRIES.filter((e) => (e.peakMcap ?? 0) >= 1e10);
    expect(desktop.colossi.map((c) => c.id).sort()).toEqual(giants.map((e) => e.id).sort());
    for (const e of giants) {
      const chip = desktop.colossi.find((c) => c.id === e.id)!;
      expect(chip.text).toBe(`${e.name} · peak ${formatCemeteryPeak(e.peakMcap!)} · ${formatDeathDate(e.deathDate.slice(0, 7))}`);
    }

    const map = buildCemeteryPlotMap([row("algorithmic-failure", "2025-03-14", { id: "giant", name: "Giant USD", peakMcap: 2.34e10 }), row("abandoned", "2024-01")], { preset: "desktop" });
    expect(map.colossi).toHaveLength(1);
    expect(map.colossi[0]).toMatchObject({ id: "giant", peak: "$23.4B", month: "Mar 2025", text: "Giant USD · peak $23.4B · Mar 2025" });
    expect(map.colossi[0].top).toEqual(map.graves.find((g) => g.id === "giant")?.screen.top);
  });
});

describe("section cameras", () => {
  it("falls back to the contiguous run of years with the most graves when the whole section stays under the floor", () => {
    for (const cause of CAUSE_ORDER) {
      const narrow = fitSectionCamera(desktop, cause, { frameWidth: 700, viewportHeight: 800 })!;
      const whole = fitSectionCamera(desktop, cause, { frameWidth: 4000, viewportHeight: 4000 })!;
      expect(whole.partial).toBe(false);
      if (!narrow.partial) continue;
      expect(narrow.facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.zoomTargetFacePx - 0.05);
      const years = [...new Set(desktop.graves.filter((g) => g.cause === cause).map((g) => g.year))];
      expect(years).toContain(narrow.span[0]);
      expect(years).toContain(narrow.span[1]);
      expect(narrow.ids.every((id) => desktop.graves.find((g) => g.id === id)!.cause === cause)).toBe(true);
    }
  });
});

describe("validatePlotMapCapacity", () => {
  it("passes on the current data in both presets", () => {
    expect(validatePlotMapCapacity(desktop)).toMatchObject({ ok: true, issues: [] });
    expect(validatePlotMapCapacity(desktop).facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.faceFloorPx);
    expect(validatePlotMapCapacity(portrait)).toMatchObject({ ok: true, issues: [] });
  });

  it("fails loudly when one year's deaths stretch a bed past the empty-run budget", () => {
    const flood = [
      ...Array.from({ length: 90 }, (_, k) => row("abandoned", `2026-0${1 + (k % 8)}-10`)),
      row("counterparty-failure", "2025-03"),
      row("counterparty-failure", "2027-02"),
      row("liquidity-drain", "2024-05"),
      row("algorithmic-failure", "2022-05"),
      row("regulatory", "2023-02"),
    ];
    const report = validatePlotMapCapacity(buildCemeteryPlotMap(flood, { preset: "desktop" }));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.kind)).toContain("empty-run");
  });

  it("fails when large lots no longer fit the first rows of their block", () => {
    const giants = Array.from({ length: 5 }, (_, k) => row("algorithmic-failure", `2022-0${k + 1}`, { peakMcap: 2e10 }));
    const map = buildCemeteryPlotMap([...giants, row("abandoned", "2021-01")], { preset: "desktop" });
    const report = validatePlotMapCapacity(map);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.kind)).toContain("lot-rows");
    // Still a valid plan: no two lots overlap.
    expect(report.issues.map((i) => i.kind)).not.toContain("overlap");
  });

  it("flags a year with too many ≥ $1B deaths for the exhaustive lot search, and still builds quickly", () => {
    const giants = Array.from({ length: 8 }, (_, k) => row(CAUSE_ORDER[k % 4], `2026-09-1${k}`, { peakMcap: 3e9 }));
    const map = buildCemeteryPlotMap([...CEMETERY_ENTRIES, ...giants], { preset: "desktop" });
    expect(map.blocks.find((b) => b.year === 2026)?.greedyLots).toBe(true);
    const report = validatePlotMapCapacity(map);
    expect(report.issues.map((i) => i.kind)).toContain("lot-search");
    expect(report.issues.map((i) => i.kind)).not.toContain("overlap");
  });
});
