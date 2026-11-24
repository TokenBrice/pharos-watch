// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { AtRule } from "postcss";
import type { ComponentType } from "react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { PLOT_PROJECTIONS, graveGeometry, lotPadCell, project } from "@/lib/cemetery-plot-geometry";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { CemeteryHero } from "../cemetery/cemetery-hero";
import { CemeterySelectionProvider, type CemeterySelectionHandler } from "../cemetery/cemetery-selection-context";
import type * as CemeterySelectionModule from "../cemetery/cemetery-selection-context";
import { PlotMapLegend } from "../cemetery/plot-map-legend";
import { PlotMapPortrait } from "../cemetery/plot-map-portrait";
import type { PlotMapPortraitSlotProps } from "../cemetery/plot-map-portrait-slot";
import { PlotMapHero } from "../cemetery/plot-map-hero";
import { PlotMapRecordCard } from "../cemetery/plot-map-record-card";
import { PLOT_VIEWPORT_BANDS, desktopPlotLayout } from "../cemetery/plot-map-scene";
import { PLOT_PORTRAIT_QUERY } from "../cemetery/use-plot-layout";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
// The phone layer has its own suite; here it must not register a pin handler of its own, except in the phone
// hand-off test, which mounts the real layer inside the hero.
const portrait = vi.hoisted(() => ({ real: false }));
vi.mock("../cemetery/plot-map-portrait-slot", async (importOriginal) => {
  const actual = (await importOriginal()) as { PlotMapPortraitSlot: ComponentType<PlotMapPortraitSlotProps> };
  return { PlotMapPortraitSlot: (props: PlotMapPortraitSlotProps) => (portrait.real ? <actual.PlotMapPortraitSlot {...props} /> : null) };
});

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("@/hooks/use-prefers-reduced-motion", () => ({ usePrefersReducedMotion: () => motion.reduced }));

const selection = vi.hoisted(() => ({
  selectedId: null,
  real: false,
  heroPin: null,
  setHeroPin: vi.fn(),
  pinGrave: vi.fn(),
  revealRecord: vi.fn(),
  registerPinGrave: vi.fn(),
  registerRevealRecord: vi.fn(),
  setRecordHash: vi.fn(),
}));
vi.mock("@/components/cemetery/cemetery-selection-context", async (importOriginal) => {
  const actual = await importOriginal<typeof CemeterySelectionModule>();
  function useMockSelection() {
    const [heroPin, setHeroPin] = useState<CemeterySelectionModule.CemeterySelectionContextValue["heroPin"]>(null);
    return {
      ...selection,
      heroPin,
      setHeroPin: (id: string | null, source: CemeterySelectionModule.CemeterySelectionSource = "hero") => setHeroPin(id ? { id, source } : null),
    };
  }
  return { ...actual, useCemeterySelection: () => {
    const useSelection = selection.real ? actual.useCemeterySelection : useMockSelection;
    return useSelection();
  } };
});

const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
const stats = buildCemeteryStats(CEMETERY_ENTRIES);
const asOf = stats.asOf.date;
const atlas = toPlotLogoAtlas(atlasManifest);
const map = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" });
const portraitMap = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" });
const layout = desktopPlotLayout(map);
const rowById = new Map(rows.map((r) => [r.id, r]));
const time = (id: string) => {
  const [y, m, d] = (rowById.get(id)?.deathDate ?? "").split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 15);
};

let phone = false;
const mediaListeners = new Set<() => void>();
let pinHandler: CemeterySelectionHandler | null = null;
const unregister = vi.fn();

beforeEach(() => {
  phone = false;
  selection.real = false;
  window.history.replaceState(null, "", "/cemetery/");
  portrait.real = false;
  motion.reduced = false;
  pinHandler = null;
  mediaListeners.clear();
  selection.registerPinGrave.mockImplementation((handler: CemeterySelectionHandler) => {
    pinHandler = handler;
    return unregister;
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 760px") ? phone : query.includes("min-width: 1280px") ? !phone : false,
      media: query,
      addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
    })),
  );
  window.scrollBy = vi.fn();
  // jsdom lays nothing out: give the plan frame the 1440 × 800 reference size
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1368);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(773);
  window.innerHeight = 800;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderHero(heroRows = rows, heroAsOf = asOf, heroLayout = layout) {
  const view = render(
    <PlotMapHero rows={heroRows} asOf={heroAsOf} atlas={atlas} layout={heroLayout} portraitAspectRatio="292 / 1100">
      <header data-plot-head>
        <h1 id="cemetery-title">Stablecoin Cemetery</h1>
        <a href="#methodology">Methodology</a>
      </header>
    </PlotMapHero>,
  );
  const hero = screen.getByRole("region", { name: "Stablecoin Cemetery" });
  const grave = (id: string) => document.getElementById(`grave-${id}`) as HTMLElement;
  return { ...view, hero, grave };
}

// The keyboard census needs the production plan; the pinning, phone and
// responsive-continuity cases exercise the hero's interaction contract instead,
// so they render a small plan that still carries the two named graves. Laying
// out every registered grave per case was most of this file's cost.
const pinCohortRows = [...rows.slice(0, 12), ...rows.filter((row) =>
  row.id === "ust-terrausd-2022-05" || row.id === "mim-abracadabra")]
  .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index);
const pinCohortLayout = desktopPlotLayout(buildCemeteryPlotMap(toPlotMapInput(pinCohortRows), { asOf, preset: "desktop" }));
const renderPinCohort = () => renderHero(pinCohortRows, asOf, pinCohortLayout);

describe("PlotMapHero keyboard model", () => {
  it("gives the plan one tab stop on the newest grave and keeps the hero within eight stops", () => {
    const { hero } = renderHero();
    const graves = within(hero).getAllByRole("button").filter((el) => el.hasAttribute("data-grave-id"));
    expect(graves.filter((g) => g.tabIndex === 0).map((g) => g.id)).toEqual([`grave-${map.newestId}`]);
    // skip link, the roving grave, the five signposts (the route head's own links are counted separately)
    const stops = [...hero.querySelectorAll<HTMLElement>("a[href], button")].filter((el) => el.tabIndex >= 0 && !el.closest("[data-plot-head]"));
    expect(stops.length).toBeLessThanOrEqual(8);
  });

  it("walks a section chronologically with ←/→, crosses sections at the nearest date with ↑/↓, and jumps with Home/End", () => {
    const { grave } = renderHero();
    // The newest grave can belong to the final cause lane after a catalog update.
    // Choose a lane with both an in-lane neighbor and a later nonempty lane.
    const sectionIndex = map.keyboard.sections.findIndex((s, index) =>
      s.ids.length > 1 && map.keyboard.sections.slice(index + 1).some((other) => other.ids.length > 0),
    );
    expect(sectionIndex).toBeGreaterThanOrEqual(0);
    const section = map.keyboard.sections[sectionIndex];
    const next = map.keyboard.sections.slice(sectionIndex + 1).find((s) => s.ids.length > 0)!;
    const startId = section.ids[section.ids.length - 1];
    const start = grave(startId);
    act(() => start.focus());

    fireEvent.keyDown(start, { key: "ArrowLeft" });
    const previous = section.ids[section.ids.length - 2];
    expect(document.activeElement).toBe(grave(previous));
    expect(grave(previous).tabIndex).toBe(0);
    expect(start.tabIndex).toBe(-1);

    fireEvent.keyDown(grave(previous), { key: "ArrowRight" });
    expect(document.activeElement).toBe(start);

    fireEvent.keyDown(start, { key: "ArrowUp" });
    const nearest = [...next.ids].sort((a, b) => Math.abs(time(a) - time(startId)) - Math.abs(time(b) - time(startId)))[0];
    expect(Math.abs(time((document.activeElement as HTMLElement).dataset.graveId!) - time(startId))).toBe(Math.abs(time(nearest) - time(startId)));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(grave(next.ids[0]));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(grave(next.ids[next.ids.length - 1]));
  });
});

describe("PlotMapHero pinning", () => {
  it("pins on Enter (pressed state, hash, one announcement, full record card) and unpins on Esc", () => {
    const { grave } = renderPinCohort();
    const ust = grave("ust-terrausd-2022-05");
    act(() => ust.focus());
    fireEvent.keyDown(ust, { key: "Enter" });

    expect(ust.getAttribute("aria-pressed")).toBe("true");
    expect(selection.setRecordHash).toHaveBeenCalledWith("ust-terrausd-2022-05");
    expect(screen.getByRole("status").textContent).toBe("Pinned TerraUSD");
    const card = screen.getByRole("article", { name: /TerraUSD/ });
    expect(within(card).getByText(rowById.get("ust-terrausd-2022-05")!.obituary)).toBeTruthy();

    fireEvent.keyDown(ust, { key: "Escape" });
    expect(ust.getAttribute("aria-pressed")).toBe("false");
    expect(selection.setRecordHash).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("article", { name: /TerraUSD/ })?.hasAttribute("data-preview") ?? true).toBe(true);
  });

  it("hands 'Read in the register' to the register's reveal", () => {
    const { grave } = renderPinCohort();
    fireEvent.click(grave("ust-terrausd-2022-05"));
    fireEvent.click(screen.getByRole("link", { name: /Read in the register/ }));
    expect(selection.revealRecord).toHaveBeenCalledWith("ust-terrausd-2022-05", "hero");
  });

  it("owns the selection's pin handler only while the desktop plan is the live layer", () => {
    const { grave } = renderHero();
    expect(selection.registerPinGrave).toHaveBeenCalledTimes(1);
    act(() => pinHandler!("mim-abracadabra", "register"));
    expect(grave("mim-abracadabra").getAttribute("aria-pressed")).toBe("true");
    expect(window.scrollBy).toHaveBeenCalled();

    phone = true;
    act(() => mediaListeners.forEach((listener) => listener()));
    expect(unregister).toHaveBeenCalled();
  });

  it("does not register on phones", () => {
    phone = true;
    renderPinCohort();
    expect(selection.registerPinGrave).not.toHaveBeenCalled();
  });

  it("leaves the phone layer's graves and sheet to the portrait: Enter and taps open the sheet, Esc in it closes it", () => {
    phone = true;
    portrait.real = true;
    const { grave } = renderPinCohort();
    const walk = document.getElementById("walk-ust-terrausd-2022-05") as HTMLElement;
    act(() => walk.focus());
    // Enter must reach the anchor's native activation (the click below), not be taken by the hidden desktop plan
    expect(fireEvent.keyDown(walk, { key: "Enter" })).toBe(true);
    fireEvent.click(walk);
    const sheet = screen.getByRole("dialog");
    expect(sheet.getAttribute("data-open")).toBe("true");
    expect(selection.setRecordHash).toHaveBeenCalledTimes(1);
    expect(grave("ust-terrausd-2022-05")).toBeNull();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(sheet.getAttribute("data-open")).toBe("false");
    expect(selection.setRecordHash).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(walk);
  });

});

describe("PlotMapHero responsive selection continuity", () => {
  const a = "ust-terrausd-2022-05";
  const b = "mim-abracadabra";
  const setPhone = (value: boolean) => {
    phone = value;
    act(() => mediaListeners.forEach((listener) => listener()));
  };
  const pressed = (prefix: string, id: string) => document.getElementById(`${prefix}-${id}`)?.getAttribute("aria-pressed");
  function renderResponsive() {
    selection.real = true;
    portrait.real = true;
    return render(
      <CemeterySelectionProvider knownIds={pinCohortRows.map((row) => row.id)}>
        <PlotMapHero rows={pinCohortRows} asOf={asOf} atlas={atlas} layout={pinCohortLayout} portraitAspectRatio="292 / 1100">
          <h1 id="cemetery-title">Stablecoin Cemetery</h1>
        </PlotMapHero>
      </CemeterySelectionProvider>,
    );
  }

  it("restores the live pin across layouts without replaying focus or scroll and never resurrects a dismissed pin", () => {
    renderResponsive();
    fireEvent.click(document.getElementById(`grave-${a}`)!);
    expect(window.location.hash).toBe(`#${a}`);
    const focus = document.activeElement;
    vi.mocked(window.scrollBy).mockClear();
    setPhone(true);
    expect(pressed("walk", a)).toBe("true");
    expect(screen.getByRole("dialog").getAttribute("data-open")).toBe("true");
    expect(document.activeElement).toBe(focus);
    expect(window.scrollBy).not.toHaveBeenCalled();

    fireEvent.click(document.getElementById(`walk-${b}`)!);
    expect(window.location.hash).toBe(`#${b}`);
    vi.mocked(window.scrollBy).mockClear();
    setPhone(false);
    expect(pressed("grave", b)).toBe("true");
    expect(pressed("grave", a)).toBe("false");
    expect(window.scrollBy).not.toHaveBeenCalled();

    setPhone(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(window.location.hash).toBe("");
    setPhone(false);
    expect(pressed("grave", a)).toBe("false");
    expect(pressed("grave", b)).toBe("false");
  });

  it("preserves the hash-only portrait tab stop after an intervening desktop layout", () => {
    phone = true;
    window.history.replaceState(null, "", `/cemetery/#${a}`);
    renderResponsive();
    expect((document.getElementById(`walk-${a}`) as HTMLElement)?.tabIndex).toBe(0);
    expect(screen.getByRole("dialog").getAttribute("data-open")).toBe("false");
    setPhone(false);
    expect(pressed("grave", a)).toBe("true");
    setPhone(true);
    expect((document.getElementById(`walk-${a}`) as HTMLElement)?.tabIndex).toBe(0);
    expect(pressed("walk", a)).toBe("false");
    expect(screen.getByRole("dialog").getAttribute("data-open")).toBe("false");
    expect(window.location.hash).toBe(`#${a}`);
  });
});

describe("PlotMapHero section zoom", () => {
  it("zooms a section from its signpost: toolbar row, header hidden, partial view stated; Esc returns", () => {
    // Keep the partial-view case independent of the growing production catalog.
    const zoomRows = buildCemeteryRegisterRows(
      Array.from({ length: 18 }, (_, index) => ({
        id: `zoom-${index}`,
        name: `Zoom Coin ${index}`,
        symbol: `Z${index}`,
        pegCurrency: "USD",
        causeOfDeath: "algorithmic-failure" as const,
        deathDate: `${index < 5 ? 2014 + index : 2022 + ((index - 5) % 5)}-01`,
        peakMcap: 20_000_000,
        epitaph: "A fixture grave.",
        obituary: "A fixture record for section navigation.",
        sourceUrl: "https://example.com/zoom-fixture",
        sourceLabel: "Fixture source",
      })),
    );
    const zoomAsOf = "2026-01";
    const zoomMap = buildCemeteryPlotMap(toPlotMapInput(zoomRows), { asOf: zoomAsOf, preset: "desktop" });
    // A short desktop viewport forces a partial section instead of fitting all 18 graves.
    window.innerHeight = 450;
    const { hero } = renderHero(zoomRows, zoomAsOf, desktopPlotLayout(zoomMap));
    fireEvent.click(within(hero).getByRole("button", { name: /Algorithmic Failure: 18 graves/ }));

    expect(hero.getAttribute("data-zooming")).toBe("true");
    expect(within(hero).getByRole("button", { name: "Whole cemetery" })).toBeTruthy();
    expect(hero.querySelector("[data-plot-zoom-chip]")?.textContent).toMatch(/showing 2022–2026, 13 of 18/);
    expect(hero.querySelector<SVGGElement>("[data-plot-world]")?.style.transform).toMatch(/scale\(/);

    // C7 / C-12: partial zoom exposes keyboard-reachable ‹ / › year-range buttons that pan to unseen runs and back.
    const prevBtn = hero.querySelector<HTMLButtonElement>("[data-plot-zoom-prev]")!;
    const nextBtn = hero.querySelector<HTMLButtonElement>("[data-plot-zoom-next]")!;
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(nextBtn.getAttribute("aria-label")).toMatch(/2014–2018/);

    const initialTransform = hero.querySelector<SVGGElement>("[data-plot-world]")?.style.transform;
    fireEvent.click(nextBtn);
    expect(hero.querySelector<SVGGElement>("[data-plot-world]")?.style.transform).not.toBe(initialTransform);
    expect(hero.querySelector("[data-plot-status]")?.textContent).toMatch(/2014–2018/);

    fireEvent.keyDown(hero.querySelector("[data-plot-zoom-out]")!, { key: "Escape" });
    expect(hero.hasAttribute("data-zooming")).toBe(false);
    expect(within(hero).queryByRole("button", { name: "Whole cemetery" })).toBeNull();
  });
});

describe("PlotMapHero beam motion", () => {

  it("under reduced motion aims at once and adds no transition", () => {
    motion.reduced = true;
    const { hero, grave } = renderHero();
    fireEvent.pointerOver(grave("mim-abracadabra"));
    expect(hero.querySelector("[data-plot-beam]")?.getAttribute("data-beam")).toBe("aim");
    expect(hero.querySelector<SVGGElement>("[data-plot-beam] > g")?.style.getPropertyValue("transition")).toBe("");
  });
});

describe("PlotMapRecordCard", () => {
  const rowByPeg = new Map(rows.map((row) => [row.pegCurrency, row]));

  it.each([...rowByPeg.keys()])("prints the shared peg label for %s instead of the raw peg enum", (pegCurrency) => {
    render(
      <PlotMapRecordCard
        row={rowByPeg.get(pegCurrency)!}
        flowers={0}
        onLeaveFlower={() => {}}
        onReadRegister={() => {}}
        onClose={() => {}}
        variant="sheet"
      />,
    );
    expect(screen.getByText("Peg").nextElementSibling?.textContent).toBe(PEG_LABELS_SHORT[pegCurrency]);
    expect(screen.queryByText(pegCurrency)).toBeNull();
  });

  it("docks without whole-card or sideways scroll bars: only the named obituary region gives way", () => {
    const row = rows.find((r) => r.tracked)!;
    render(<PlotMapRecordCard row={row} flowers={0} onLeaveFlower={() => {}} onReadRegister={() => {}} onClose={() => {}} variant="inspector" />);
    expect(screen.getByRole("region", { name: `Obituary of ${row.name}` }).tabIndex).toBe(0);
    for (const label of ["Peg", "Record"]) expect(screen.getByText(label).nextElementSibling?.className).toMatch(/cardGridWords/);

    const sheet = postcss.parse(readFileSync(resolve(__dirname, "../cemetery/plot-map.module.css"), "utf8"));
    const decls = (selector: string, media?: string) => {
      const found: Record<string, string> = {};
      sheet.walkRules((rule) => {
        const parent = rule.parent;
        const inMedia = parent instanceof AtRule && parent.name === "media" ? parent.params : undefined;
        if (rule.selector === selector && inMedia === media) rule.walkDecls((d) => void (found[d.prop] = d.value));
      });
      return found;
    };
    expect(decls(".inspector", "(min-width: 1280px)")).toMatchObject({ display: "flex", overflow: "hidden auto" });
    expect(decls(".inspector > .card", "(min-width: 1280px)")).toMatchObject({ "min-height": "0" });
    expect(decls(".inspector .cardObituaryFull", "(min-width: 1280px)")).toMatchObject({ flex: "0 1 auto" });
    expect(decls(".cardObituaryFull")).not.toHaveProperty("max-height");
    expect(decls(".cardGrid .cardGridWords")).toMatchObject({ "white-space": "normal" });
  });
});

describe("desktopPlotLayout and SSR contracts", () => {
  it("solves signpost plates, year stamps and colossus chips with zero conflicts across every frame band", () => {
    expect(layout.aspect).toBeGreaterThan(1.5);
    expect(layout.floorWidth).toBeGreaterThanOrEqual(1200);
    expect(layout.plateConflicts).toHaveLength(PLOT_VIEWPORT_BANDS.length);
    for (const bandHits of layout.plateConflicts) expect(bandHits).toEqual([]);

    expect(layout.stamps).toHaveLength(map.blocks.length);
    for (const stamp of layout.stamps) {
      expect(stamp.bands).toHaveLength(PLOT_VIEWPORT_BANDS.length);
      for (const band of stamp.bands) expect(band.conflicts).toEqual([]);
    }

    expect(layout.chips.length).toBeGreaterThanOrEqual(2);
    for (const chip of layout.chips) {
      expect(chip.bands).toHaveLength(PLOT_VIEWPORT_BANDS.length);
      for (const band of chip.bands) {
        expect(band.conflicts).toEqual([]);
        expect(["0%", "-50%", "-100%"]).toContain(band.tx);
      }
    }
  });

  it("uses the ≤ 1024 px coarse-pointer handoff, keeps SSR slim (lightweight portrait skeleton, deferred hits/focus), omits tooltips, and scopes the SE lawn engraving", () => {
    expect(PLOT_PORTRAIT_QUERY).toBe("(max-width: 760px), (max-width: 1024px) and (pointer: coarse)");
    portrait.real = true;
    selection.real = true;

    const heroHtml = renderToStaticMarkup(
      <CemeterySelectionProvider knownIds={rows.map((r) => r.id)}>
        <CemeteryHero rows={rows} stats={stats} asOf={asOf} atlas={atlas} portraitAspectRatio="269.6 / 1057.5" />
      </CemeterySelectionProvider>,
    );
    expect(heroHtml).toContain('aria-label="Stablecoin Cemetery plot map"');
    expect(heroHtml).not.toContain("<title");
    expect(heroHtml).toContain("data-plot-strata-divider");
    expect(heroHtml).toContain("cem-world-clip");
    expect(heroHtml).toContain("cem-sea-fade");
    expect(heroHtml).toContain("cem-g-col-dim");
    expect(heroHtml).toContain("cem-g-sea");
    // Item 2: SSR emits real desktop grave anchors directly inside objects (no duplicated hits/focus layers) and a
    // lightweight portrait skeleton (zero walk-* grave hit anchors) with a <noscript> desktop fallback.
    expect(heroHtml).toContain('id="grave-ust-terrausd-2022-05"');
    expect(heroHtml).not.toContain('data-plot-layer="hits"');
    expect(heroHtml).not.toContain('data-plot-layer="focus"');
    expect(heroHtml).toContain("data-plot-portrait-skeleton");
    expect(heroHtml).not.toContain('id="walk-');
    expect(heroHtml).toContain("<noscript>");
    // Item 10: SE lawn inscription explicitly scopes the empty front lanes instead of claiming all causes.
    expect(heroHtml).toContain("NO ABANDONED OR COUNTERPARTY");
    expect(heroHtml).toContain("DEATHS RECORDED BEFORE 2022");
    expect(heroHtml).not.toContain(">NONE RECORDED BEFORE 2022<");

    const portraitHtml = renderToStaticMarkup(<PlotMapPortrait map={portraitMap} atlas={atlas} />);
    expect(portraitHtml).not.toMatch(/title="/);

    const legendHtml = renderToStaticMarkup(<PlotMapLegend firstYear={stats.firstYear} lastYear={stats.latestYear} />);
    expect(legendHtml.match(/data-plot-lens="[^"]+"/g) ?? []).toHaveLength(14);
    // F15: SSR legend lens buttons are inert (`disabled`, no dead `aria-pressed`) until hydrated and show explicit ranges.
    expect(legendHtml.match(/disabled=""/g) ?? []).toHaveLength(14);
    expect(legendHtml).not.toContain('aria-pressed="false"');
    expect(legendHtml).toContain("$10M–$100M");
    expect(legendHtml).toContain("$100M–$1B");
    expect(legendHtml).toContain("$1B–$10B");

    const unrecordedRow = rows.find((r) => r.peak === null)!;
    const cardHtml = renderToStaticMarkup(
      <PlotMapRecordCard row={unrecordedRow} flowers={0} onLeaveFlower={() => {}} onReadRegister={() => {}} onClose={() => {}} variant="inspector" />,
    );
    expect(cardHtml).not.toContain("↗");
    expect(cardHtml).not.toMatch(/title="/);
  });

  it("keeps 0 pointer theft across all 134 visible desktop medallions (A4)", () => {
    const p = PLOT_PROJECTIONS[map.projection];
    const byDraw = [...map.graves].sort((a, b) => a.draw - b.draw);
    const geos = new Map(byDraw.map((g) => [g.id, graveGeometry(p, g)]));
    const pointInPoly = (x: number, y: number, poly: readonly (readonly [number, number])[]) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const hitPolys = new Map(
      byDraw.map((g) => {
        const geo = geos.get(g.id)!;
        const cellQuad = [
          project(p, g.cell.i0 + 0.04, g.cell.j0 + 0.04, 0),
          project(p, g.cell.i1 - 0.04, g.cell.j0 + 0.04, 0),
          project(p, g.cell.i1 - 0.04, g.cell.j1 - 0.04, 0),
          project(p, g.cell.i0 + 0.04, g.cell.j1 - 0.04, 0),
        ];
        return [g.id, [cellQuad, ...geo.body.filter((m) => m.kind === "polygon").map((m) => m.points)]];
      }),
    );
    const stolen: string[] = [];
    for (let i = 0; i < byDraw.length; i++) {
      const g = byDraw[i];
      const { x, y, r } = g.screen.medal;
      const samples: [number, number][] = [[x, y]];
      for (let k = 0; k < 8; k++) samples.push([x + r * 0.65 * Math.cos((k * Math.PI) / 4), y + r * 0.65 * Math.sin((k * Math.PI) / 4)]);
      for (const [sx, sy] of samples) {
        const bodyOccluded = byDraw
          .slice(i + 1)
          .some((later) => geos.get(later.id)!.body.some((m) => m.kind === "polygon" && pointInPoly(sx, sy, m.points)));
        if (bodyOccluded) continue;
        if (byDraw.slice(i + 1).some((later) => hitPolys.get(later.id)!.some((poly) => pointInPoly(sx, sy, poly)))) {
          stolen.push(g.id);
          break;
        }
      }
    }
    expect(stolen).toEqual([]);
  });
});

describe("PlotMapHero spotlight, hover tag, legend lenses and portrait walk", () => {
  it("avoids hover strobing (no plan-wide dim on plain pointer hover), activates spotlight on keyboard focus and pin, and composes E9 lenses with zoom & Escape", () => {
    selection.real = true;
    const { container } = render(
      <CemeterySelectionProvider knownIds={rows.map((r) => r.id)}>
        <CemeteryHero rows={rows} stats={stats} asOf={asOf} atlas={atlas} portraitAspectRatio="269.6 / 1057.5" />
      </CemeterySelectionProvider>,
    );
    const svg = container.querySelector<SVGSVGElement>("[data-plot-svg]")!;
    const focusLayer = svg.querySelector("[data-plot-layer='focus']")!;
    expect(svg.querySelector("[data-plot-layer='hits']")).toBeTruthy();
    expect(svg.getAttribute("data-dim")).toBeNull();
    expect(focusLayer.querySelector("[data-focus-copy]")).toBeNull();

    // F4: plain pointer hover shows compact tag + focus redraw + hot ring WITHOUT dimming the field.
    const usdn = document.getElementById("grave-usdn-neutrino-usd-2022-04") as HTMLElement;
    fireEvent.pointerOver(usdn);
    const tag = container.querySelector<HTMLElement>("[data-plot-tag]")!;
    expect(tag.getAttribute("data-on")).toBe("true");
    expect(tag.textContent).toContain("Neutrino USD");
    expect(screen.queryByRole("article")).toBeNull();
    expect(svg.getAttribute("data-dim")).toBeNull();
    expect(focusLayer.querySelector("[data-focus-copy='usdn-neutrino-usd-2022-04']")).toBeTruthy();
    expect(focusLayer.querySelector("[data-plot-ring='hot']")?.getAttribute("data-on")).toBe("true");
    fireEvent.pointerOut(usdn);

    // Keyboard focus (without prior pointerdown) activates spotlight dimming + dashed ring without opening the card.
    const initial = container.querySelector<HTMLElement>('a[data-grave-id][tabindex="0"]')!;
    act(() => initial.focus());
    expect(svg.getAttribute("data-dim")).toBe("spotlight");
    expect(focusLayer.querySelector("[data-plot-ring='hot']")?.getAttribute("data-focus")).toBe("true");
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.blur(initial);
    expect(svg.getAttribute("data-dim")).toBeNull();

    // Pinning UST activates spotlight, hides UST's own colossus chip/leader (C-15), redraws UST with a podium-clearing ring, and opens the full record card.
    fireEvent.click(document.getElementById("grave-ust-terrausd-2022-05")!);
    expect(svg.getAttribute("data-dim")).toBe("spotlight");
    expect(container.querySelector("[data-plot-chip='ust-terrausd-2022-05']")?.getAttribute("data-pinned")).toBe("true");
    expect(container.querySelector("[data-plot-leader='ust-terrausd-2022-05']")?.getAttribute("data-pinned")).toBe("true");
    expect(container.querySelector("[data-plot-chip='busd-binance-usd-2023-02']")?.hasAttribute("data-pinned")).toBe(false);
    const pinRing = focusLayer.querySelector("[data-plot-ring='pin']")!;
    expect(Number(pinRing.getAttribute("rx"))).toBeGreaterThanOrEqual(50);
    expect(focusLayer.querySelector("[data-focus-copy='ust-terrausd-2022-05']")).toBeTruthy();
    expect(screen.getByRole("article")).toBeTruthy();

    // E9 legend lens enables after hydration, shows compact lens bar above the legend, suppresses hover pop on ghosted
    // non-members (F17), and composes with section zoom; Escape unwinds pin → lens → zoom.
    const archivedBtn = container.querySelector<HTMLButtonElement>("[data-plot-lens='archived']")!;
    expect(archivedBtn.disabled).toBe(false);
    fireEvent.click(archivedBtn);
    expect(archivedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(svg.getAttribute("data-dim")).toBe("lens");
    expect(container.querySelector("[data-plot-lens-bar]")?.textContent).toContain("Pharos archive page");
    expect(container.querySelector("[data-plot-status]")?.textContent).toMatch(/Highlighting Pharos archive page:/);

    // F17: pointer-hovering a non-archived ghosted grave while the archived lens is active must not pop it to focus.
    const unarchived = map.graves.find((g) => !g.archived && g.id !== "ust-terrausd-2022-05")!;
    fireEvent.pointerOver(document.getElementById(`grave-${unarchived.id}`)!);
    expect(focusLayer.querySelector(`[data-focus-copy='${unarchived.id}']`)).toBeNull();
    fireEvent.pointerOut(document.getElementById(`grave-${unarchived.id}`)!);

    fireEvent.click(container.querySelector("[data-plot-signpost='algorithmic-failure']")!);
    expect(container.querySelector("[data-plot-lens-clear]")).toBeTruthy();
    expect(container.querySelector("[data-plot-lens-bar]")).toBeNull();
    expect(svg.getAttribute("data-dim")).toBe("lens");

    // F17 while zoomed: pointer-hovering a ghosted non-member (regulatory) must not pop it to focus.
    const regGrave = map.graves.find((g) => g.cause === "regulatory")!;
    fireEvent.pointerOver(document.getElementById(`grave-${regGrave.id}`)!);
    expect(focusLayer.querySelector(`[data-focus-copy='${regGrave.id}']`)).toBeNull();
    fireEvent.pointerOut(document.getElementById(`grave-${regGrave.id}`)!);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("article")).toBeNull();
    expect(archivedBtn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(archivedBtn.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-plot-root]")?.getAttribute("data-zooming")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-plot-root]")?.getAttribute("data-zooming")).toBeNull();
  });

  it("drops the desktop SVG on portrait viewports and supports cause-head toggles, legend lenses, UST full-grave ring and Escape order", () => {
    phone = true;
    portrait.real = true;
    selection.real = true;
    const { container } = render(
      <CemeterySelectionProvider knownIds={rows.map((r) => r.id)}>
        <CemeteryHero rows={rows} stats={stats} asOf={asOf} atlas={atlas} portraitAspectRatio="269.6 / 1057.5" />
      </CemeterySelectionProvider>,
    );
    expect(container.querySelector("[data-plot-svg]")).toBeNull();
    const portraitSvg = container.querySelector<SVGSVGElement>("[data-plot-portrait-svg]")!;
    expect(portraitSvg).toBeTruthy();
    expect(container.querySelector("[data-plot-year-band='2019-2020']")?.textContent).toContain("none recorded");

    const algoHead = container.querySelector<HTMLButtonElement>("[data-plot-cause-head][data-cause='algorithmic-failure']")!;
    fireEvent.click(algoHead);
    expect(algoHead.getAttribute("aria-pressed")).toBe("true");
    expect(portraitSvg.getAttribute("data-dim")).toBe("lane");

    fireEvent.click(document.getElementById("walk-ust-terrausd-2022-05")!);
    expect(document.querySelector("[data-plot-sheet]")?.getAttribute("data-open")).toBe("true");
    const ustRing = container.querySelector("[data-plot-portrait-ring='ust-terrausd-2022-05']")!;
    expect(ustRing).toBeTruthy();
    const ustPortrait = portraitMap.graves.find((g) => g.id === "ust-terrausd-2022-05")!;
    const ustPad = lotPadCell(ustPortrait.cell);
    const padPts = [
      project(PLOT_PROJECTIONS.portrait, ustPad.i0, ustPad.j0, 0),
      project(PLOT_PROJECTIONS.portrait, ustPad.i1, ustPad.j0, 0),
      project(PLOT_PROJECTIONS.portrait, ustPad.i1, ustPad.j1, 0),
      project(PLOT_PROJECTIONS.portrait, ustPad.i0, ustPad.j1, 0),
    ];
    const rx0 = Number(ustRing.getAttribute("x"));
    const ry0 = Number(ustRing.getAttribute("y"));
    const rx1 = rx0 + Number(ustRing.getAttribute("width"));
    const ry1 = ry0 + Number(ustRing.getAttribute("height"));
    expect(rx0).toBeLessThanOrEqual(Math.min(...padPts.map((pt) => pt[0])));
    expect(rx1).toBeGreaterThanOrEqual(Math.max(...padPts.map((pt) => pt[0])));
    expect(ry0).toBeLessThanOrEqual(Math.min(...padPts.map((pt) => pt[1])));
    expect(ry1).toBeGreaterThanOrEqual(Math.max(...padPts.map((pt) => pt[1])));
    expect(document.querySelector("[data-plot-sheet-fade]")).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelector("[data-plot-sheet]")?.getAttribute("data-open")).toBe("false");
    expect(algoHead.getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(algoHead.getAttribute("aria-pressed")).toBe("false");
    expect(portraitSvg.getAttribute("data-dim")).toBeNull();

    const unrecBtn = container.querySelector<HTMLButtonElement>("[data-plot-lens='unrecorded']")!;
    fireEvent.click(unrecBtn);
    expect(portraitSvg.getAttribute("data-dim")).toBe("lens");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(portraitSvg.getAttribute("data-dim")).toBeNull();
  });
});
