import { describe, expect, it, vi } from "vitest";
import { CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { formatDeathDate } from "@shared/lib/format";
import * as hash from "@shared/lib/fnv1a";
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
import { buildCemeteryStats, formatCemeteryPeak } from "@/lib/cemetery-stats";
import {
  PLOT_PROJECTIONS,
  PLOT_STEP_HEIGHT,
  graveGeometry,
  plotShapeOf,
  portraitSiteMarks,
  type PlotGraveShapeInput,
  type PlotMark,
} from "@/lib/cemetery-plot-geometry";
import { toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows, type CemeteryRegisterRow } from "@/lib/cemetery-register";

let seq = 0;
function row(causeOfDeath: CauseOfDeath, deathDate: string, overrides: Partial<CemeteryPlotMapInput> = {}): CemeteryPlotMapInput {
  seq += 1;
  const id = overrides.id ?? `coin-${seq}`;
  return { id, name: `Coin ${id}`, symbol: id.toUpperCase(), causeOfDeath, deathDate, pegCurrency: "USD", peakMcap: 20_000_000, ...overrides };
}

const byId = (map: CemeteryPlotMap) => new Map(map.graves.map((g) => [g.id, g]));

const desktop = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "desktop" });
const portrait = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });

describe("scene seed parity", () => {
  it.each([["", 0x811c9dc5], ["a", 0xe40c292c], ["foobar", 0xbf9cf968]] as const)(
    "retains the frozen FNV known vector for %j",
    (input, expected) => expect(hash.fnv1a32(input)).toBe(expected),
  );

  it.each(["desktop", "portrait"] as const)("preserves %s scene bytes for legacy UTF-16 seeds", (preset) => {
    const legacyHash = (id: string) => {
      let value = 2166136261;
      for (let index = 0; index < id.length; index++) value = Math.imul(value ^ id.charCodeAt(index), 16777619);
      return value >>> 0;
    };
    const entries = [...CEMETERY_ENTRIES, row("abandoned", "2014-01", { id: "coin-😀" })];
    const serialize = () => {
      const map = buildCemeteryPlotMap(entries, { preset });
      return JSON.stringify({ map, geometry: map.graves.map((g) => graveGeometry(PLOT_PROJECTIONS[map.projection], g)) });
    };
    for (const id of ["", "fixture", "legend", "coin-😀", "\ud83d", "\ude00"]) {
      expect(hash.fnv1a32(id)).toBe(legacyHash(id));
    }
    const actual = serialize();
    const legacy = vi.spyOn(hash, "fnv1a32").mockImplementation(legacyHash);
    try {
      expect(actual).toBe(serialize());
    } finally {
      legacy.mockRestore();
    }
  });
});

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

describe("buildCemeteryPlotMap: year cypress", () => {
  it("leaves a year with no record unavailable instead of zero deaths", () => {
    const map = buildCemeteryPlotMap([
      row("abandoned", "2018-05-01", { id: "y2018" }),
      row("abandoned", "2021-03-01", { id: "y2021" }),
    ], { preset: "desktop" });
    expect(map.cypress.find((c) => c.year === 2019)).toMatchObject({
      count: null,
      height: 0,
      label: "2019 · none recorded",
    });
    expect(map.cypress.find((c) => c.year === 2021)).toMatchObject({
      count: 1,
      label: "2021 · 1 death",
    });
    for (const cypress of desktop.cypress.filter((c) => c.year === 2019 || c.year === 2020)) {
      expect(cypress.count).toBeNull();
      expect(cypress.label).toBe(`${cypress.year} · none recorded`);
    }
  });
});

describe("buildCemeteryPlotMap: year blocks", () => {
  it("puts every real grave inside its year's block, merges pre-2022 on desktop, and discloses empty years", () => {
    for (const b of desktop.blocks) {
      const expected = desktop.graves.filter((g) => !b.empty && b.years.includes(g.year)).map((g) => g.id).sort();
      expect([...b.ids].sort()).toEqual(expected);
      expect(b.count).toBe(expected.length);
    }
    for (const g of desktop.graves) {
      const block = desktop.blocks.find((b) => !b.empty && b.years.includes(g.year))!;
      expect(g.cell.i0).toBeGreaterThanOrEqual(block.i0);
      expect(g.cell.i1).toBeLessThanOrEqual(block.i1);
    }
    expect(desktop.blocks.reduce((n, b) => n + b.count, 0)).toBe(CEMETERY_ENTRIES.length);
    const oldest = desktop.blocks[desktop.blocks.length - 1];
    expect(oldest).toMatchObject({
      key: "2018-2021",
      years: [2018, 2019, 2020, 2021],
      emptyYears: [2019, 2020],
      empty: false,
      text: "2018–21 · 6",
      sub: "2019–20 none recorded",
    });
    expect(portrait.blocks.find((b) => b.key === "2019-2020")).toMatchObject({ empty: true, sub: "none recorded" });
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
  it("falls back to a legible contiguous run of years, keeps every section's colossus, and holds ≥ 28 px zoom floor across standard viewports", () => {
    const fittedFrameWidth = (w: number, h: number) => {
      const pad = w >= 1280 ? 36 : w >= 1024 ? 20 : 16;
      const columnW = Math.max(0, w - 2 * pad);
      const heightFit = Math.max(0, h - PLOT_LAYOUT.fitChromePx) * (desktop.viewBox[2] / desktop.viewBox[3]);
      return Math.min(columnW, Math.max(desktop.floorWidth, heightFit));
    };
    for (const cause of CAUSE_ORDER) {
      const narrow = fitSectionCamera(desktop, cause, { frameWidth: 700, viewportHeight: 800 })!;
      const whole = fitSectionCamera(desktop, cause, { frameWidth: 4000, viewportHeight: 4000 })!;
      expect(whole.partial).toBe(false);
      const colossi = desktop.graves.filter((g) => g.cause === cause && g.lot === 3);
      for (const [w, h] of PLOT_LAYOUT.zoomCheckViewports) {
        const cam = fitSectionCamera(desktop, cause, { frameWidth: fittedFrameWidth(w, h), viewportHeight: h })!;
        expect(cam.facePx, `${cause} at ${w}×${h}`).toBeGreaterThanOrEqual(PLOT_LAYOUT.zoomFloorFacePx);
        for (const col of colossi) {
          expect(cam.ids, `${cause} drops ${col.id} at ${w}×${h}`).toContain(col.id);
        }
      }
      if (!narrow.partial) continue;
      expect(narrow.facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.zoomFloorFacePx);
      const years = [...new Set(desktop.graves.filter((g) => g.cause === cause).map((g) => g.year))];
      expect(years).toContain(narrow.span[0]);
      expect(years).toContain(narrow.span[1]);
      expect(narrow.ids.every((id) => desktop.graves.find((g) => g.id === id)!.cause === cause)).toBe(true);
    }
  });
});

describe("validatePlotMapCapacity", () => {
  it("passes on the current data in both presets and enforces the portrait 15 px face floor", () => {
    const desktopReport = validatePlotMapCapacity(desktop);
    expect(desktopReport).toMatchObject({ ok: true, issues: [] });
    expect(desktopReport.facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.faceFloorPx);
    expect(desktopReport.fittedFacePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.faceFloorPx);
    expect(desktopReport.columnHeadroomPx).toBe(PLOT_LAYOUT.reference.frameWidth - desktop.floorWidth);
    expect(desktopReport.columnHeadroomPx!).toBeGreaterThan(0);

    const portraitReport = validatePlotMapCapacity(portrait);
    expect(portraitReport).toMatchObject({ ok: true, issues: [] });
    expect(portraitReport.facePx).not.toBeNull();
    expect(portraitReport.facePx!).toBeGreaterThanOrEqual(PLOT_LAYOUT.portraitFaceFloorPx);
    expect(portraitReport.fittedFacePx).toBe(portraitReport.facePx);
    expect(portraitReport.columnHeadroomPx).toBeNull();

    // Portrait growth (+2027 / +2028) keeps the vertical column width and 15 px face floor intact.
    const future = [
      ...CEMETERY_ENTRIES,
      ...Array.from({ length: 25 }, (_, k) => row(CAUSE_ORDER[k % CAUSE_ORDER.length], `2027-${String(1 + (k % 12)).padStart(2, "0")}-15`, { id: `p27-${k}` })),
      ...Array.from({ length: 25 }, (_, k) => row(CAUSE_ORDER[k % CAUSE_ORDER.length], `2028-${String(1 + (k % 12)).padStart(2, "0")}-15`, { id: `p28-${k}` })),
    ];
    const futurePortrait = validatePlotMapCapacity(buildCemeteryPlotMap(future, { preset: "portrait" }));
    expect(futurePortrait.ok).toBe(true);
    expect(futurePortrait.facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.portraitFaceFloorPx);

    // Widening the portrait viewBox past the 390 px face floor must fail `face-floor` loudly.
    const widePortrait = {
      ...portrait,
      viewBox: [portrait.viewBox[0], portrait.viewBox[1], 320, portrait.viewBox[3]] as [number, number, number, number],
    };
    const wideReport = validatePlotMapCapacity(widePortrait);
    expect(wideReport.ok).toBe(false);
    expect(wideReport.facePx).toBeLessThan(PLOT_LAYOUT.portraitFaceFloorPx);
    expect(wideReport.issues.map((i) => i.kind)).toContain("face-floor");

    // Item 1: floor-clamped continuous height-fit holds plain stones ≥ 15 px across desktop viewports without a 560 px cliff.
    const ar = desktop.viewBox[2] / desktop.viewBox[3];
    const fittedWidth = (w: number, h: number) => {
      const pad = w >= 1280 ? 36 : w >= 1024 ? 20 : 16;
      return Math.min(w - 2 * pad, Math.max(desktop.floorWidth, Math.max(0, h - PLOT_LAYOUT.fitChromePx) * ar));
    };
    expect(fittedWidth(1440, 559)).toBeCloseTo(fittedWidth(1440, 560), 6);
    for (const [w, h] of [[1280, 600], [1280, 720]] as const) {
      expect(fittedWidth(w, h)).toBe(w - 72);
    }
    for (const [w, h] of [[1366, 650], [1366, 768], [1440, 560], [1440, 800], [1440, 900], [1536, 864], [1920, 950], [1920, 1080]] as const) {
      expect(fittedWidth(w, h)).toBeGreaterThanOrEqual(desktop.floorWidth);
    }

    // Item 1 (FX2): sparse desktop per-block beds trim along j to occupied slots + 1 inside their lane (e.g. 2023–2026
    // Algorithmic single-grave blocks narrow from 4 slots to 2 slots without overhanging any grave), lined up.
    const algoLane = desktop.lanes.find((l) => l.cause === "algorithmic-failure")!;
    for (const year of [2023, 2024, 2025, 2026]) {
      const cell = algoLane.cells.find((c) => c.year === year)!;
      expect(cell).toBeDefined();
      expect(cell.j1 - cell.j0).toBeCloseTo(2 * desktop.slotPitch, 2);
      expect(cell.j0).toBeGreaterThanOrEqual(algoLane.j0 - 1e-6);
      expect(cell.j1).toBeLessThanOrEqual(algoLane.j1 + 1e-6);
      expect(cell.j0).toBeCloseTo(algoLane.cells.find((c) => c.year === 2026)!.j0, 6);
    }

    // Desktop colossi stand on 2 × 2 lots in their own lane; UST straddling the regulatory lane fails `lane-overflow`.
    for (const g of desktop.graves.filter((d) => d.lot === 3)) expect(Math.round((g.cell.i1 - g.cell.i0) * (g.cell.j1 - g.cell.j0) * 100)).toBe(405);
    const stray = { ...desktop, graves: desktop.graves.map((g) => (g.symbol === "UST" ? { ...g, cell: { ...g.cell, j0: 1 } } : g)) };
    expect(validatePlotMapCapacity(stray).issues.map((i) => i.kind)).toContain("lane-overflow");

    // Item 6: every portrait grave (including lot-3 colossi UST and BUSD) stays strictly inside its own cause column.
    const portraitLaneByCause = new Map(portrait.lanes.map((L) => [L.cause, L]));
    for (const g of portrait.graves) {
      const L = portraitLaneByCause.get(g.cause)!;
      expect(g.overhang, `${g.id} overhangs its portrait column`).toBe(false);
      expect(g.cell.j0).toBeGreaterThanOrEqual(L.j0 - 1e-6);
      expect(g.cell.j1).toBeLessThanOrEqual(L.j1 + 1e-6);
    }
    const overflowPortrait = {
      ...portrait,
      graves: portrait.graves.map((g) =>
        g.id === "busd-binance-usd-2023-02" ? { ...g, cell: { ...g.cell, j1: portraitLaneByCause.get(g.cause)!.j1 + 0.5 } } : g,
      ),
    };
    expect(validatePlotMapCapacity(overflowPortrait).issues.map((i) => i.kind)).toContain("lane-overflow");

    // A1 & NW-05: no portrait colossus overlaps any newer grave, and no portrait stone's shaft overlaps a plinth above it in its column.
    const proj = PLOT_PROJECTIONS[portrait.projection];
    const portraitBoxes = new Map(
      portrait.graves.map((g) => {
        const pts = graveGeometry(proj, g).pts;
        return [
          g.id,
          {
            x0: Math.min(...pts.map((pt) => pt[0])),
            x1: Math.max(...pts.map((pt) => pt[0])),
            y0: Math.min(...pts.map((pt) => pt[1])),
            y1: Math.max(...pts.map((pt) => pt[1])),
          },
        ];
      }),
    );
    for (const col of portrait.graves.filter((g) => g.lot === 3)) {
      const cBox = portraitBoxes.get(col.id)!;
      for (const other of portrait.graves) {
        if (other.id === col.id || other.year <= col.year) continue;
        const oBox = portraitBoxes.get(other.id)!;
        const overlaps = cBox.x0 < oBox.x1 && oBox.x0 < cBox.x1 && cBox.y0 < oBox.y1 && oBox.y0 < cBox.y1;
        expect(overlaps, `${col.id} overlaps newer portrait grave ${other.id}`).toBe(false);
      }
    }
    for (const b of portrait.blocks) {
      if (b.empty) continue;
      for (const L of portrait.lanes) {
        const inLane = portrait.graves.filter((g) => b.years.includes(g.year) && g.cause === L.cause);
        for (const upper of inLane) {
          for (const lower of inLane) {
            if (upper.id === lower.id || upper.cell.i1 > lower.cell.i0 + 1e-6) continue;
            const uBox = portraitBoxes.get(upper.id)!;
            const lBox = portraitBoxes.get(lower.id)!;
            if (uBox.x1 <= lBox.x0 || lBox.x1 <= uBox.x0) continue;
            expect(lBox.y0, `${b.key} ${lower.id} shaft overlaps ${upper.id} plinth`).toBeGreaterThan(uBox.y1);
          }
        }
      }
    }
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

  it.each([
    [
      "perimeter-crossing",
      () => ({ ...desktop, graves: desktop.graves.map((g, k) => (k === 0 ? { ...g, cell: { ...g.cell, j0: -0.2 } } : g)) }),
    ],
    [
      "perimeter-crossing",
      () => ({ ...desktop, gate: { ...desktop.gate, i0: desktop.gate.i0 - 0.2 } }),
    ],
    [
      "rock-clip",
      () => ({ ...desktop, lighthouse: { ...desktop.lighthouse, i: desktop.frame.iB - 0.1, rockZ0: -0.55 } }),
    ],
    [
      "empty-year-disclosure",
      () => ({ ...desktop, blocks: desktop.blocks.map((b) => (b.emptyYears.length ? { ...b, sub: null } : b)) }),
    ],
    [
      "forecourt",
      () => {
        const busd = desktop.graves.find((g) => g.id === "busd-binance-usd-2023-02")!;
        const target = desktop.graves.find((g) => g.id === "fusd-fantom-usd-2022-06")!;
        return {
          ...desktop,
          graves: desktop.graves.map((g) =>
            g.id === target.id
              ? { ...g, cell: { i0: busd.cell.i1 + 0.46, i1: busd.cell.i1 + 1.56, j0: busd.cell.j1 - 0.92, j1: busd.cell.j1 } }
              : g,
          ),
        };
      },
    ],
    [
      "curb-overhang",
      () => ({
        ...desktop,
        graves: desktop.graves.map((g, k) => (k === 0 ? { ...g, anchor: { ...g.anchor, i: g.cell.i0 - 0.2 } } : g)),
      }),
    ],
    [
      "ground-mark-off-lot",
      () => ({
        ...desktop,
        graves: desktop.graves.map((g) =>
          g.id === "usdn-neutrino-usd-2022-04"
            ? { ...g, anchor: { ...g.anchor, j: g.cell.j1 + 0.4 } }
            : g,
        ),
      }),
    ],
    [
      "zoom-drops-colossus",
      () => ({
        ...desktop,
        sectionCameras: desktop.sectionCameras.map((c) =>
          c.cause === "algorithmic-failure" ? { ...c, ids: c.ids.filter((id) => id !== "ust-terrausd-2022-05") } : c,
        ),
      }),
    ],
    [
      "medallion-occluded",
      () => {
        const front = desktop.graves.find((g) => g.draw === desktop.graves.length - 1) ?? desktop.graves[desktop.graves.length - 1];
        const back = desktop.graves.find((g) => g.draw < front.draw)!;
        return {
          ...desktop,
          graves: desktop.graves.map((g) =>
            g.id === back.id ? { ...g, anchor: { ...front.anchor }, cell: { ...front.cell } } : g,
          ),
        };
      },
    ],
  ] as const)("scene linter flags %s on crafted failing maps", (expectedKind, mutate) => {
    const report = validatePlotMapCapacity(mutate());
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.kind)).toContain(expectedKind);
  });
});

const dimetric = PLOT_PROJECTIONS.dimetric;

function stone(overrides: Partial<PlotGraveShapeInput> = {}): PlotGraveShapeInput {
  return {
    shape: "pillow",
    lot: 1,
    steps: 1,
    heightFactor: 0.83,
    weather: 0,
    fresh: false,
    archived: false,
    footstone: null,
    seed: hash.fnv1a32("fixture"),
    lean: 0,
    cell: { i0: 0, i1: 1.1, j0: 0, j1: 0.92 },
    anchor: { i: 0.3, j: 0.46 },
    ...overrides,
  };
}

const classes = (marks: PlotMark[]) => marks.map((m) => ("cls" in m ? m.cls : m.kind));

describe("graveGeometry", () => {
  it("draws one plinth box per step, and a solid neutral hatched plinth for an unrecorded peak with stone-only lean", () => {
    const plinthFaces = (marks: PlotMark[]) => classes(marks).filter((c) => c.startsWith("pl-")).length;
    for (const steps of [0, 1, 2, 3, 4] as const) expect(plinthFaces(graveGeometry(dimetric, stone({ steps })).body)).toBe(3 * steps);

    const unrecorded = graveGeometry(dimetric, stone({ steps: null, lean: 1.5 }));
    expect(classes(unrecorded.plinth)).toEqual([
      "pl-nr-s e",
      "pl-nr-e e",
      "pl-nr-t e",
      "hatch-plinth",
      "hatch-plinth",
      "hatch-plinth",
    ]);
    expect(classes(unrecorded.body).some((c) => c.includes("eo"))).toBe(false);
    expect(classes(unrecorded.stone)).toContain("hatch");
    expect(unrecorded.lean).not.toBeNull();
    expect(unrecorded.contact.length).toBeGreaterThan(0);
    expect(classes(unrecorded.body)).not.toContain("contact");
    const floorStone = graveGeometry(dimetric, stone({ steps: 0 }));
    expect(classes(floorStone.body)).not.toContain("hatch");
    // It stands on its neutral hatched plinth, never on the bare ground of the 0-step class.
    expect(unrecorded.topZ).toBeCloseTo(floorStone.topZ + PLOT_STEP_HEIGHT, 9);
  });

  it("encodes cause, not recovery: only counterparty arches split, regulatory stones stay sealed and whole", () => {
    expect(classes(graveGeometry(dimetric, stone({ shape: "split-arch" })).body)).toContain("crack");
    const tablet = classes(graveGeometry(dimetric, stone({ shape: "sealed-tablet", weather: 4 })).body);
    expect(tablet).toContain("seal e");
    expect(tablet).not.toContain("crack");
    const lot3 = { lot: 3 as const, steps: 4 as const, cell: { i0: 0, i1: 3.3, j0: 0, j1: 2.76 }, anchor: { i: 1.5, j: 1.38 } };
    const mausoleum = graveGeometry(dimetric, stone({ ...lot3, shape: plotShapeOf("sealed-tablet", 3), weather: 3 }));
    const mClasses = classes(mausoleum.body);
    expect(mClasses).not.toContain("crack");
    expect(mClasses).toContain("door e");
    // A3: cella weathering and medallion paint before the front portico columns.
    const firstCol = mClasses.indexOf("col e");
    expect(mClasses.indexOf("medallion")).toBeGreaterThan(-1);
    expect(mClasses.indexOf("medallion")).toBeLessThan(firstCol);
    expect(mClasses.indexOf("moss")).toBeLessThan(firstCol);
    // D5: colossal column omits any fallen drum (only one fracture cap on the snapped shaft).
    const ustGeo = graveGeometry(dimetric, stone({ ...lot3, shape: plotShapeOf("broken-column", 3) }));
    expect(classes(ustGeo.body).filter((c) => c === "brk e")).toHaveLength(1);
    // A1: portrait colossi cap relief while keeping UST strictly taller than BUSD.
    const ustPortrait = graveGeometry(PLOT_PROJECTIONS.portrait, stone({ ...lot3, shape: plotShapeOf("broken-column", 3) }));
    const busdPortrait = graveGeometry(PLOT_PROJECTIONS.portrait, stone({ ...lot3, shape: plotShapeOf("sealed-tablet", 3) }));
    expect(ustPortrait.topZ).toBeGreaterThan(busdPortrait.topZ);
    expect(ustPortrait.topZ).toBeLessThan(3);
    expect(busdPortrait.topZ).toBeLessThan(2);
    expect(classes(graveGeometry(dimetric, stone({ shape: "broken-column" })).body)).toContain("brk e");
  });

  it("lays bronze archive plaque and non-USD footstone side by side along j without overlap", () => {
    const dual = graveGeometry(dimetric, stone({ archived: true, footstone: "€" }));
    const gClasses = classes(dual.ground);
    expect(gClasses).toContain("bronze e");
    expect(gClasses).toContain("glyph");
    const bronze = dual.ground.find((m) => "cls" in m && m.cls === "bronze e")!;
    const glyph = dual.ground.find((m) => m.kind === "glyph")!;
    expect(bronze.kind).toBe("polygon");
    expect(glyph.kind).toBe("glyph");
  });

  it("adds lichen from w2 and moss from w3 only", () => {
    const marks = (weather: 0 | 1 | 2 | 3 | 4) => classes(graveGeometry(dimetric, stone({ weather })).body);
    for (const w of [0, 1] as const) expect(marks(w).filter((c) => c === "lichen" || c === "moss")).toEqual([]);
    expect(marks(2)).toContain("lichen");
    expect(marks(2)).not.toContain("moss");
    expect(marks(4)).toEqual(expect.arrayContaining(["lichen", "moss"]));
  });
});

describe("scene structure", () => {
  it("builds the portrait cemetery walk: lane + year gravel paths, top-anchored centered curbed beds, lawn cypresses and oblique stone depth", () => {
    const tall = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });
    const site = portraitSiteMarks(tall);
    const gravelPaths = site.ground.filter((m) => "cls" in m && m.cls === "gravel");
    expect(gravelPaths).toHaveLength((tall.blocks.length - 1) + (tall.lanes.length - 1));
    expect(site.beds.map((b) => b.cause).sort()).toEqual(tall.lanes.map((L) => L.cause).sort());
    expect(site.trees.length).toBe(tall.cypress.length);
    expect(tall.cypress.length).toBeGreaterThanOrEqual(6);
    // NW-01: no empty-year (`height: 0`) tree pit bleeding through `2019–20 · none recorded`.
    expect(tall.cypress.every((c) => c.height > 0 && c.count !== null)).toBe(true);
    const emptyBlock = tall.blocks.find((b) => b.empty)!;
    expect(tall.cypress.some((c) => c.i >= emptyBlock.i0 - 0.3 && c.i <= emptyBlock.i1 + 0.3)).toBe(false);

    // NW-05: portrait beds anchor from the top of each year block (`b.i0`), trim along `j` around centered lone graves,
    // and omit empty `bare` curb bars (empty lane-years stay quiet lawn).
    const y2026 = tall.blocks.find((b) => b.key === "2026")!;
    const reg2026 = tall.lanes.find((l) => l.cause === "regulatory")!.cells.find((c) => c.year === 2026)!;
    expect(reg2026.i0).toBeCloseTo(y2026.i0, 2);
    expect(reg2026.i1 - reg2026.i0).toBeLessThan((y2026.i1 - y2026.i0) / 2);
    expect(tall.lanes.find((l) => l.cause === "regulatory")!.cells.find((c) => c.year === 2022)).toBeUndefined();

    const algoLane = tall.lanes.find((l) => l.cause === "algorithmic-failure")!;
    const algo2026 = algoLane.cells.find((c) => c.year === 2026)!;
    expect(algo2026.j1 - algo2026.j0).toBeCloseTo(tall.slotPitch, 2);
    expect((algo2026.j0 + algo2026.j1) / 2).toBeCloseTo((algoLane.j0 + algoLane.j1) / 2, 2);

    // FX3 Item 3: front-oblique portrait projection gives stones non-zero shaded left side faces (`st-s`).
    const sampleGrave = tall.graves.find((g) => g.lot === 1 && g.shape === "urn")!;
    const sampleGeo = graveGeometry(PLOT_PROJECTIONS.portrait, sampleGrave);
    const sidePoly = sampleGeo.stone.find((m): m is Extract<PlotMark, { kind: "polygon" }> => m.kind === "polygon" && m.cls.startsWith("st-s"));
    expect(sidePoly).toBeDefined();
    const xs = sidePoly!.points.map((pt) => pt[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.5);

    // FX3 Item 5: SSR skeleton option omits cypress detail while keeping identical ground/bed structure and viewBox.
    const skel = portraitSiteMarks(tall, { detail: false });
    expect(skel.trees).toEqual([]);
    expect(skel.beds).toHaveLength(site.beds.length);
  });
});

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

  it.each(["desktop", "portrait"] as const)("rebuilds exactly the catalog plan for %s (no model field is lost)", (preset) => {
    const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
    const asOf = buildCemeteryStats(CEMETERY_ENTRIES).asOf.date;
    expect(buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset })).toEqual(buildCemeteryPlotMap(CEMETERY_ENTRIES, { asOf, preset }));
  });
});
