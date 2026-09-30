import { describe, expect, it } from "vitest";
import { CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { formatDeathDate } from "@shared/lib/format";
import {
  PLOT_HEIGHT,
  PLOT_LAYOUT,
  PLOT_STEP_THRESHOLDS_USD,
  buildCemeteryPlotMap,
  fitSectionCamera,
  placeColossusChips,
  placePlotTag,
  plotHeightFactorOf,
  plotPeakClassOf,
  validatePlotMapCapacity,
  type CemeteryPlotMap,
  type CemeteryPlotMapInput,
  type PlotGrave,
} from "@/lib/cemetery-plot-map";
import { CEMETERY_RESERVED_ID_PREFIXES, findCemeteryIdCollisions } from "@/lib/cemetery-selection";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";

let seq = 0;
function row(causeOfDeath: CauseOfDeath, deathDate: string, overrides: Partial<CemeteryPlotMapInput> = {}): CemeteryPlotMapInput {
  seq += 1;
  const id = overrides.id ?? `coin-${seq}`;
  return { id, name: `Coin ${id}`, symbol: id.toUpperCase(), causeOfDeath, deathDate, pegCurrency: "USD", peakMcap: 20_000_000, ...overrides };
}

/** Deterministic reorder: reverse, then rotate by a third. */
function shuffled<T>(items: readonly T[]): T[] {
  const reversed = [...items].reverse();
  const k = Math.floor(reversed.length / 3);
  return [...reversed.slice(k), ...reversed.slice(0, k)];
}

const byId = (map: CemeteryPlotMap) => new Map(map.graves.map((g) => [g.id, g]));
const place = (g: PlotGrave) => ({ cell: g.cell, anchor: g.anchor });
const within = (inner: { x0: number; y0: number; x1: number; y1: number }, outer: { x0: number; y0: number; x1: number; y1: number }) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;

const desktop = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "desktop" });
const portrait = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });

describe("buildCemeteryPlotMap: determinism and serialisation", () => {
  it("is byte-identical for shuffled input, in both presets", () => {
    expect(JSON.stringify(buildCemeteryPlotMap(shuffled(CEMETERY_ENTRIES), { preset: "desktop" }))).toBe(JSON.stringify(desktop));
    expect(JSON.stringify(buildCemeteryPlotMap(shuffled(CEMETERY_ENTRIES), { preset: "portrait" }))).toBe(JSON.stringify(portrait));
  });

  it("is plain data: survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(desktop))).toEqual(desktop);
    expect(JSON.parse(JSON.stringify(portrait))).toEqual(portrait);
  });

  it("rounds world units to 0.01 and screen units to 0.1", () => {
    const onGrid = (n: number, step: number) => Math.abs(Math.round(n / step) * step - n) < 1e-9;
    for (const g of desktop.graves) {
      for (const n of [g.cell.i0, g.cell.i1, g.cell.j0, g.cell.j1, g.anchor.i, g.anchor.j]) expect(onGrid(n, 0.01), `${g.id} world ${n}`).toBe(true);
      const screen = [...g.screen.ground, ...g.screen.top, g.screen.medal.x, g.screen.medal.y, g.screen.box.x0, g.screen.box.y1, ...g.screen.hit.flat()];
      for (const n of screen) expect(onGrid(n, 0.1), `${g.id} screen ${n}`).toBe(true);
    }
    for (const n of desktop.viewBox) expect(onGrid(n, 0.1)).toBe(true);
  });

  it("rejects duplicate ids and an empty set", () => {
    expect(() => buildCemeteryPlotMap([row("abandoned", "2024-01", { id: "dup" }), row("regulatory", "2024-02", { id: "dup" })], { preset: "desktop" })).toThrow(/duplicate id dup/);
    expect(() => buildCemeteryPlotMap([], { preset: "desktop" })).toThrow();
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

  it("marks non-USD pegs with a footstone glyph and tracked-archive rows with the bronze plaque", () => {
    const map = buildCemeteryPlotMap(
      [
        row("abandoned", "2024-01", { id: "eur", pegCurrency: "EUR" }),
        row("abandoned", "2024-02", { id: "odd", pegCurrency: "GOLD" }),
        row("abandoned", "2024-03", { id: "usd", archivedDataAvailable: true }),
      ],
      { preset: "desktop" },
    );
    const g = byId(map);
    expect(g.get("eur")?.footstone).toBe("€");
    expect(g.get("odd")?.footstone).toBe("◇");
    expect(g.get("usd")?.footstone).toBeNull();
    expect(g.get("usd")?.archived).toBe(true);
    expect(g.get("eur")?.archived).toBe(false);
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

  it("changes weathering with asOf and nothing else; defaults asOf to the latest recorded death", () => {
    const early = buildCemeteryPlotMap(entries, { asOf: "2026-01-01", preset: "desktop" });
    const late = buildCemeteryPlotMap(shuffled(entries), { asOf: "2031-01-01", preset: "desktop" });
    expect(late.graves.map((g) => g.weather)).toEqual(late.graves.map(() => 4));
    expect(late.graves.some((g) => g.fresh)).toBe(false);
    expect(late.graves.map(place)).toEqual(early.graves.map(place));
    expect(late.viewBox).toEqual(early.viewBox);

    const byDefault = buildCemeteryPlotMap(entries, { preset: "desktop" });
    expect(byDefault.asOf).toBe("2025-12-01");
    expect(byDefault.graves).toEqual(buildCemeteryPlotMap(entries, { asOf: "2025-12-01", preset: "desktop" }).graves);
  });
});

describe("buildCemeteryPlotMap: year blocks", () => {
  it("holds exactly each year's graves, newest block at the gate, empty years as one 'none recorded' strip", () => {
    const entries = [
      row("abandoned", "2018-03"),
      row("regulatory", "2021-04"),
      row("liquidity-drain", "2021-09"),
      row("abandoned", "2022-01"),
      row("counterparty-failure", "2022-11"),
      row("algorithmic-failure", "2022-05"),
    ];
    const map = buildCemeteryPlotMap(entries, { preset: "desktop" });
    expect(map.blocks.map((b) => b.key)).toEqual(["2022", "2021", "2019-2020", "2018"]);
    for (let k = 1; k < map.blocks.length; k++) expect(map.blocks[k].i0).toBeGreaterThan(map.blocks[k - 1].i1);
    const strip = map.blocks[2];
    expect(strip).toMatchObject({ empty: true, years: [2019, 2020], label: "2019–20", text: "2019–20", sub: "none recorded", count: 0 });
    expect(map.blocks[0]).toMatchObject({ text: "2022 · 3", count: 3, sub: null });
  });

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

describe("buildCemeteryPlotMap: append stability", () => {
  const template = CEMETERY_ENTRIES.find((e) => e.causeOfDeath === "abandoned")!;
  const later = (id: string, deathDate: string, causeOfDeath: CauseOfDeath = "abandoned") => ({ ...template, id, deathDate, causeOfDeath, peakMcap: 20_000_000 });
  const latest = CEMETERY_ENTRIES.reduce((max, e) => (e.deathDate > max ? e.deathDate : max), "");
  const nextYear = Number(latest.slice(0, 4)) + 1;
  const sameYear = Array.from({ length: 16 }, (_, k) => later(`zz-later-${k}`, `${latest.slice(0, 4)}-12-${String(10 + k).padStart(2, "0")}`, CAUSE_ORDER[k % 5]));

  for (const preset of ["desktop", "portrait"] as const) {
    it(`moves no existing grave in world coordinates when newer deaths are appended (${preset})`, () => {
      const before = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset });
      for (const added of [sameYear.slice(0, 1), sameYear, [later("zz-next-year", `${nextYear}-02-01`)]]) {
        const after = buildCemeteryPlotMap([...CEMETERY_ENTRIES, ...added], { preset });
        const moved = byId(after);
        for (const g of before.graves) expect(place(moved.get(g.id)!), g.id).toEqual(place(g));
        expect(after.lanes.map((L) => [L.j0, L.j1])).toEqual(before.lanes.map((L) => [L.j0, L.j1]));
      }
    });
  }

  it("grows the platform toward the gate", () => {
    const after = buildCemeteryPlotMap([...CEMETERY_ENTRIES, ...sameYear], { preset: "desktop" });
    expect(after.site.iWest).toBeLessThan(desktop.site.iWest);
    expect(after.site.iOldest).toBe(desktop.site.iOldest);
    expect(after.site.iEast).toBe(desktop.site.iEast);
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

  it("orders keyboard sections canonically and graves chronologically, landing first on the newest death", () => {
    expect(desktop.keyboard.sections.map((s) => s.cause)).toEqual([...CAUSE_ORDER]);
    expect(desktop.lanes.map((L) => L.cause)).toEqual([...CAUSE_ORDER]);
    for (const section of desktop.keyboard.sections) {
      const expected = sortCemeteryCoins(CEMETERY_ENTRIES.filter((e) => e.causeOfDeath === section.cause), "oldest").map((e) => e.id);
      expect(section.ids).toEqual(expected);
      section.ids.forEach((id, k) => expect(byId(desktop).get(id)?.laneIndex).toBe(k));
    }
    expect(desktop.keyboard.initialId).toBe(sortCemeteryCoins([...CEMETERY_ENTRIES], "newest")[0].id);
    // Front lane (Abandoned) nearest the gate-side front, Regulatory under the sea wall.
    for (let k = 1; k < desktop.lanes.length; k++) expect(desktop.lanes[k].j1).toBeLessThan(desktop.lanes[k - 1].j0);
    expect(desktop.signposts.map((s) => s.cause)).toEqual([...CAUSE_ORDER]);
  });

  it("keeps 1×1 graves inside their own lane; only large lots overhang", () => {
    for (const g of desktop.graves) {
      const lane = desktop.lanes.find((L) => L.cause === g.cause)!;
      if (g.lot === 1) {
        expect(g.overhang).toBe(false);
        expect(g.cell.j0).toBeGreaterThanOrEqual(lane.j0);
        expect(g.cell.j1).toBeLessThanOrEqual(lane.j1);
      } else {
        expect(g.cell.j0 < lane.j1 && g.cell.j1 > lane.j0, g.id).toBe(true);
      }
    }
  });

  it("builds the same grave set with the same encodings in the portrait preset", () => {
    expect(portrait.graves.map((g) => g.id)).toEqual(desktop.graves.map((g) => g.id));
    const d = byId(desktop);
    for (const g of portrait.graves) {
      const twin = d.get(g.id)!;
      expect([g.cause, g.year, g.lot, g.steps, g.heightFactor, g.weather, g.fresh, g.shape, g.footstone, g.archived]).toEqual([
        twin.cause, twin.year, twin.lot, twin.steps, twin.heightFactor, twin.weather, twin.fresh, twin.shape, twin.footstone, twin.archived,
      ]);
    }
    expect(portrait.keyboard).toEqual(desktop.keyboard);
    expect(portrait.columns.map((c) => c.cause)).toEqual([...CAUSE_ORDER]);
    for (let k = 1; k < portrait.columns.length; k++) expect(portrait.columns[k].x0).toBeGreaterThanOrEqual(portrait.columns[k - 1].x1);
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

  it("places chips clear of text, volumes and each other, with leaders ending at the monument", () => {
    const taken = [{ left: 0, top: 0, right: 400, bottom: 60 }];
    // Two monuments side by side: the second chip must move off the first chip and keep its leader clear of it.
    const chips = [
      { id: "a", top: [300, 260] as [number, number], width: 220, height: 24 },
      { id: "b", top: [320, 262] as [number, number], width: 220, height: 24 },
    ];
    const volumes = [{ left: 270, top: 250, right: 330, bottom: 400 }];
    const placed = placeColossusChips({ chips, frameWidth: 1200, taken, volumes });
    const [a, b] = placed.map((p) => ({ left: p.x, top: p.y, right: p.x + 220, bottom: p.y + 24 }));
    const overlaps = (r: typeof a, s: typeof a) => r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top;
    expect(placed.map((p) => p.placement)).toEqual(["clear", "clear"]);
    expect(overlaps(a, b)).toBe(false);
    for (const r of [a, b]) {
      expect(overlaps(r, taken[0])).toBe(false);
      expect(overlaps(r, volumes[0])).toBe(false);
    }
    expect(placed.map((p) => [p.leader.x2, p.leader.y2])).toEqual([[300, 258], [320, 260]]);
  });
});

describe("hover tag placement", () => {
  it("takes the first candidate clear of obstacles and reports residual collisions", () => {
    const stone = { left: 100, top: 100, right: 120, bottom: 130 };
    const tag = { width: 60, height: 16 };
    const frame = { width: 400, height: 300 };
    expect(placePlotTag({ stone, tag, frame, obstacles: [] })).toEqual({ x: 80, y: 78, collisions: 0 });
    const blocked = placePlotTag({ stone, tag, frame, obstacles: [{ left: 60, top: 60, right: 140, bottom: 95 }] });
    expect(blocked.collisions).toBe(0);
    expect(blocked.y).toBeGreaterThan(95);
    const everywhere = placePlotTag({ stone, tag, frame, obstacles: [{ left: 0, top: 0, right: 400, bottom: 300 }] });
    expect(everywhere.collisions).toBe(1);
  });
});

describe("section cameras", () => {
  it("frame each section's graves only, reaching the zoom floor at 1440×800", () => {
    expect(desktop.sectionCameras.map((c) => c.cause)).toEqual([...CAUSE_ORDER]);
    for (const camera of desktop.sectionCameras) {
      const section = desktop.graves.filter((g) => g.cause === camera.cause);
      const inSpan = section.filter((g) => g.year >= camera.span[0] && g.year <= camera.span[1]);
      expect(camera.total).toBe(section.length);
      expect([...camera.ids].sort()).toEqual(inSpan.map((g) => g.id).sort());
      expect(camera.partial).toBe(inSpan.length < section.length);
      expect(camera.facePx).toBeGreaterThanOrEqual(PLOT_LAYOUT.zoomFloorFacePx);
      for (const g of inSpan) expect(within(g.screen.box, camera.box), g.id).toBe(true);
      // The frame is the union of exactly the shown graves.
      expect(camera.box.x0).toBe(Math.min(...inSpan.map((g) => g.screen.box.x0)));
      expect(camera.box.x1).toBe(Math.max(...inSpan.map((g) => g.screen.box.x1)));
      expect(camera.box.y0).toBe(Math.min(...inSpan.map((g) => g.screen.box.y0)));
      expect(camera.box.y1).toBe(Math.max(...inSpan.map((g) => g.screen.box.y1)));
    }
  });

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

  // Real app chrome: the frame follows the content box (1024 → 984 px, 1440 → 1368, 1920 → 1848).
  const viewports = [
    { name: "1024×768", frameWidth: 984, viewportHeight: 768 },
    { name: "1440×800", frameWidth: 1368, viewportHeight: 800 },
    { name: "1920×1080", frameWidth: 1848, viewportHeight: 1080 },
  ];
  for (const viewport of viewports) {
    it(`lands every shown grave inside the visible band and centres on the section, never the lighthouse (${viewport.name})`, () => {
      const [vbX, vbY, vbW, vbH] = desktop.viewBox;
      const scale = viewport.frameWidth / vbW;
      const bandTop = PLOT_LAYOUT.zoomBar;
      const bandBottom = Math.min(vbH * scale, viewport.viewportHeight - PLOT_LAYOUT.chromeTop);
      const lighthouse = desktop.obstacles.find((o) => o.key === "lighthouse")!;
      for (const cause of CAUSE_ORDER) {
        const camera = fitSectionCamera(desktop, cause, viewport)!;
        // `translate(tx ty) scale(zoom)` about user (0, 0), then the viewBox maps user units to frame px.
        const toFrame = (x: number, y: number) => [(camera.zoom * x + camera.translate[0] - vbX) * scale, (camera.zoom * y + camera.translate[1] - vbY) * scale];
        const toUser = (px: number, py: number) => [(px / scale + vbX - camera.translate[0]) / camera.zoom, (py / scale + vbY - camera.translate[1]) / camera.zoom];

        const section = desktop.graves.filter((g) => g.cause === cause);
        // Every grave, unless the 28 px floor forces the approved partial view (then its flagged run of years).
        if (viewport.frameWidth >= PLOT_LAYOUT.reference.frameWidth && cause !== "algorithmic-failure") expect(camera.partial, cause).toBe(false);
        const shown = camera.partial ? section.filter((g) => camera.ids.includes(g.id)) : section;
        expect(shown).toHaveLength(camera.shown);
        for (const g of shown) {
          const [x0, y0] = toFrame(g.screen.box.x0, g.screen.box.y0);
          const [x1, y1] = toFrame(g.screen.box.x1, g.screen.box.y1);
          expect(x0, `${cause} ${g.id} left`).toBeGreaterThanOrEqual(-1);
          expect(x1, `${cause} ${g.id} right`).toBeLessThanOrEqual(viewport.frameWidth + 1);
          expect(y0, `${cause} ${g.id} top`).toBeGreaterThanOrEqual(bandTop - 1);
          expect(y1, `${cause} ${g.id} bottom`).toBeLessThanOrEqual(bandBottom + 1);
        }

        // The middle of the visible band shows the framed graves, not the lighthouse or the sea behind the wall.
        const [mx, my] = toUser(viewport.frameWidth / 2, (bandTop + bandBottom) / 2);
        expect(within({ x0: mx, y0: my, x1: mx, y1: my }, camera.box), `${cause} centre`).toBe(true);
        expect(within({ x0: mx, y0: my, x1: mx, y1: my }, lighthouse), `${cause} centre on the lighthouse`).toBe(false);
      }
    });
  }
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
