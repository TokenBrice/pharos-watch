// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import type { CemeterySelectionHandler } from "../cemetery/cemetery-selection-context";
import { PLOT_BEAM_DWELL_MS, PlotMapHero } from "../cemetery/plot-map-hero";
import { desktopPlotLayout } from "../cemetery/plot-map-scene";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
// The phone layer has its own suite; here it must not register a pin handler of its own.
vi.mock("../cemetery/plot-map-portrait-slot", () => ({ PlotMapPortraitSlot: () => null }));

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("@/hooks/use-prefers-reduced-motion", () => ({ usePrefersReducedMotion: () => motion.reduced }));

const selection = vi.hoisted(() => ({
  selectedId: null,
  pinGrave: vi.fn(),
  revealRecord: vi.fn(),
  registerPinGrave: vi.fn(),
  registerRevealRecord: vi.fn(),
  setRecordHash: vi.fn(),
}));
vi.mock("@/components/cemetery/cemetery-selection-context", () => ({ useCemeterySelection: () => selection }));

const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
const asOf = buildCemeteryStats(CEMETERY_ENTRIES).asOf.date;
const atlas = toPlotLogoAtlas(atlasManifest);
const map = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" });
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderHero() {
  const view = render(
    <PlotMapHero rows={rows} asOf={asOf} atlas={atlas} layout={layout} portraitAspectRatio="292 / 1100">
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
    const section = map.keyboard.sections.find((s) => s.ids.includes(map.newestId))!;
    const next = map.keyboard.sections[map.keyboard.sections.indexOf(section) + 1];
    const start = grave(map.newestId);
    act(() => start.focus());

    fireEvent.keyDown(start, { key: "ArrowLeft" });
    const previous = section.ids[section.ids.indexOf(map.newestId) - 1];
    expect(document.activeElement).toBe(grave(previous));
    expect(grave(previous).tabIndex).toBe(0);
    expect(start.tabIndex).toBe(-1);

    fireEvent.keyDown(grave(previous), { key: "ArrowRight" });
    expect(document.activeElement).toBe(start);

    fireEvent.keyDown(start, { key: "ArrowUp" });
    const nearest = [...next.ids].sort((a, b) => Math.abs(time(a) - time(map.newestId)) - Math.abs(time(b) - time(map.newestId)))[0];
    expect(Math.abs(time((document.activeElement as HTMLElement).dataset.graveId!) - time(map.newestId))).toBe(Math.abs(time(nearest) - time(map.newestId)));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(grave(next.ids[0]));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(grave(next.ids[next.ids.length - 1]));
  });
});

describe("PlotMapHero pinning", () => {
  it("pins on Enter (pressed state, hash, one announcement, full record card) and unpins on Esc", () => {
    const { grave } = renderHero();
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
    const { grave } = renderHero();
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
    renderHero();
    expect(selection.registerPinGrave).not.toHaveBeenCalled();
  });

  it("keeps the flower count hidden until the first flower, then counts the button and F", () => {
    const { grave } = renderHero();
    const ust = grave("ust-terrausd-2022-05");
    fireEvent.click(ust);
    const card = screen.getByRole("article", { name: /TerraUSD/ });
    expect(within(card).queryByText(/left this session/)).toBeNull();
    expect(ust.querySelector("[data-plot-flowers]")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Leave a flower" }));
    expect(within(card).getByText("1 flower left this session")).toBeTruthy();
    fireEvent.keyDown(ust, { key: "f" });
    expect(within(card).getByText("2 flowers left this session")).toBeTruthy();
    expect(ust.querySelector("[data-plot-flowers]")?.children).toHaveLength(2);
  });
});

describe("PlotMapHero section zoom", () => {
  it("zooms a section from its signpost: toolbar row, header hidden, partial view stated; Esc returns", () => {
    const { hero } = renderHero();
    fireEvent.click(within(hero).getByRole("button", { name: /Algorithmic Failure: 18 graves/ }));

    expect(hero.getAttribute("data-zooming")).toBe("true");
    expect(within(hero).getByRole("button", { name: "Whole cemetery" })).toBeTruthy();
    expect(hero.querySelector("[data-plot-zoom-chip]")?.textContent).toMatch(/showing 2022–2026, 13 of 18/);
    expect(hero.querySelector<SVGGElement>("[data-plot-world]")?.style.transform).toMatch(/scale\(/);

    fireEvent.keyDown(hero.querySelector("[data-plot-zoom-out]")!, { key: "Escape" });
    expect(hero.hasAttribute("data-zooming")).toBe(false);
    expect(within(hero).queryByRole("button", { name: "Whole cemetery" })).toBeNull();
  });
});

describe("PlotMapHero beam motion", () => {
  it("aims at a hovered grave only after the dwell", () => {
    vi.useFakeTimers();
    const { hero, grave } = renderHero();
    const beam = hero.querySelector("[data-plot-beam]")!;
    fireEvent.pointerOver(grave("mim-abracadabra"));
    expect(beam.getAttribute("data-beam")).toBe("rest");
    act(() => vi.advanceTimersByTime(PLOT_BEAM_DWELL_MS));
    expect(beam.getAttribute("data-beam")).toBe("aim");
  });

  it("under reduced motion aims at once and adds no transition", () => {
    motion.reduced = true;
    const { hero, grave } = renderHero();
    fireEvent.pointerOver(grave("mim-abracadabra"));
    expect(hero.querySelector("[data-plot-beam]")?.getAttribute("data-beam")).toBe("aim");
    expect(hero.querySelector<SVGGElement>("[data-plot-beam] > g")?.style.getPropertyValue("transition")).toBe("");
  });
});
