// @vitest-environment jsdom

import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas, toPlotMapInput } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import type { CemeterySelectionHandler } from "../cemetery/cemetery-selection-context";
import { getPortraitAspectRatio } from "../cemetery/plot-map-portrait-aspect";
import { PlotMapPortraitSlot } from "../cemetery/plot-map-portrait-slot";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

const selection = vi.hoisted(() => ({
  selectedId: null,
  heroPin: null,
  setHeroPin: vi.fn(),
  pinGrave: vi.fn(),
  revealRecord: vi.fn(),
  registerPinGrave: vi.fn(),
  registerRevealRecord: vi.fn(),
  setRecordHash: vi.fn(),
}));

vi.mock("@/components/cemetery/cemetery-selection-context", () => ({
  useCemeterySelection: () => selection,
}));

const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
const asOf = buildCemeteryStats(CEMETERY_ENTRIES).asOf.date;
const atlas = toPlotLogoAtlas(atlasManifest);
const portraitMap = buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" });
const aspectRatio = getPortraitAspectRatio(rows, asOf);
const HUSD = rows.find((r) => r.symbol === "HUSD") ?? rows[0];

let phone = true;
let pinHandler: CemeterySelectionHandler | null = null;
/** Fresh per test: RTL's auto-cleanup unmounts the previous test's tree after our `afterEach` cleared the mocks. */
let unregister = vi.fn();

beforeEach(() => {
  phone = true;
  pinHandler = null;
  unregister = vi.fn();
  selection.registerPinGrave.mockImplementation((handler: CemeterySelectionHandler) => {
    pinHandler = handler;
    return unregister;
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 760px") ? phone : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  window.scrollBy = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderSlot(flowers: Readonly<Record<string, number>> = {}) {
  const onLeaveFlower = vi.fn();
  const view = render(
    <PlotMapPortraitSlot rows={rows} asOf={asOf} atlas={atlas} aspectRatio={aspectRatio} flowers={flowers} onLeaveFlower={onLeaveFlower} />,
  );
  return { ...view, onLeaveFlower };
}

const walk = (id: string) => document.getElementById(`walk-${id}`) as HTMLElement;
const sheet = () => document.querySelector<HTMLElement>("[data-plot-sheet]");

describe("PlotMapPortraitSlot", () => {
  it("server-renders only the reserved box, sized by the portrait aspect, with a no-JS fallback", () => {
    const html = renderToString(
      <PlotMapPortraitSlot rows={rows} asOf={asOf} atlas={atlas} aspectRatio={aspectRatio} flowers={{}} onLeaveFlower={() => {}} />,
    );
    expect(html).toContain("data-plot-portrait-slot");
    expect(html).toContain(`--portrait-ar:${aspectRatio}`);
    expect(html).not.toContain("walk-");
    expect(html).toMatch(/<noscript>.*max-width: 760px.*display:none!important/);
  });

  it("keeps only the reserved box and registers no pin handler on the desktop", () => {
    phone = false;
    const { container } = renderSlot();
    expect(container.querySelector("[data-plot-portrait-slot]")).not.toBeNull();
    expect(container.querySelector("[data-plot-portrait]")).toBeNull();
    expect(container.querySelector("[id^='walk-']")).toBeNull();
    expect(selection.registerPinGrave).not.toHaveBeenCalled();
  });

  it("mounts the portrait grid on phones: one uniquely identified button per grave and one tab stop", () => {
    const { container } = renderSlot();
    const buttons = Array.from(container.querySelectorAll<HTMLElement>("[data-plot-hits] [data-grave-id]"));
    const ids = buttons.map((b) => b.id);
    expect(ids).toHaveLength(rows.length);
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => `walk-${r.id}`)));
    expect(buttons.filter((b) => b.tabIndex === 0).map((b) => b.id)).toEqual([`walk-${portraitMap.keyboard.initialId}`]);
    expect(buttons.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(selection.registerPinGrave).toHaveBeenCalledTimes(1);
  });

  it("moves the roving stop with the arrow keys: down the column is older, across is the neighbouring section", () => {
    renderSlot();
    const start = portraitMap.keyboard.initialId;
    const section = portraitMap.keyboard.sections.find((s) => s.ids.includes(start));
    const older = section?.ids[section.ids.indexOf(start) - 1];
    expect(older).toBeDefined();
    walk(start).focus();
    fireEvent.keyDown(walk(start), { key: "ArrowDown" });
    expect(document.activeElement).toBe(walk(older as string));
    expect(walk(older as string).tabIndex).toBe(0);
    expect(walk(start).tabIndex).toBe(-1);
  });

  it("opens the sheet on a tap: pressed grave, record in the sheet, hash set, focus inside", () => {
    renderSlot();
    fireEvent.click(walk(HUSD.id));
    expect(walk(HUSD.id).getAttribute("aria-pressed")).toBe("true");
    expect(selection.setRecordHash).toHaveBeenCalledWith(HUSD.id);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-open")).toBe("true");
    expect(dialog.textContent).toContain(HUSD.name);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape, clears the hash and returns focus to the grave", () => {
    renderSlot();
    fireEvent.click(walk(HUSD.id));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(sheet()?.getAttribute("data-open")).toBe("false");
    expect(walk(HUSD.id).getAttribute("aria-pressed")).toBe("false");
    expect(selection.setRecordHash).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(walk(HUSD.id));
  });

  it("hands the record to the register and closes the sheet from “Read in the register”", () => {
    renderSlot();
    fireEvent.click(walk(HUSD.id));
    fireEvent.click(within(screen.getByRole("dialog")).getByText(/Read in the register/));
    expect(selection.revealRecord).toHaveBeenCalledWith(HUSD.id, "hero");
    expect(sheet()?.getAttribute("data-open")).toBe("false");
    expect(selection.setRecordHash).not.toHaveBeenCalledWith(null);
  });

  it("opens the sheet for an external pin, but a deep link only moves the tab stop", () => {
    renderSlot();
    expect(pinHandler).not.toBeNull();
    const other = rows.find((r) => r.id !== HUSD.id && r.id !== portraitMap.keyboard.initialId) ?? rows[1];
    act(() => pinHandler?.(other.id, "hash"));
    expect(sheet()?.getAttribute("data-open")).toBe("false");
    expect(walk(other.id).tabIndex).toBe(0);

    act(() => pinHandler?.(HUSD.id, "register"));
    expect(sheet()?.getAttribute("data-open")).toBe("true");
    expect(screen.getByRole("dialog").textContent).toContain(HUSD.name);
    expect(walk(HUSD.id).getAttribute("aria-pressed")).toBe("true");
  });

  it("registers the pin handler once per mount and unregisters it on unmount", () => {
    const { rerender, unmount } = renderSlot();
    rerender(<PlotMapPortraitSlot rows={rows} asOf={asOf} atlas={atlas} aspectRatio={aspectRatio} flowers={{ [HUSD.id]: 1 }} onLeaveFlower={vi.fn()} />);
    fireEvent.click(walk(HUSD.id));
    expect(selection.registerPinGrave).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
    unmount();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("folds the legend's second disclosure once on phones", () => {
    const details = document.createElement("details");
    details.setAttribute("data-plot-legend-more", "");
    details.open = true;
    document.body.append(details);
    try {
      renderSlot();
      expect(details.open).toBe(false);
    } finally {
      details.remove();
    }
  });

  it("leaves the legend open when the page opened on a fragment, so the fragment scroll lands where it aimed", () => {
    const details = document.createElement("details");
    details.setAttribute("data-plot-legend-more", "");
    details.open = true;
    document.body.append(details);
    window.history.replaceState(null, "", "#faq");
    try {
      renderSlot();
      expect(details.open).toBe(true);
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
      details.remove();
    }
  });
});

describe("getPortraitAspectRatio", () => {
  it("is the portrait viewBox aspect, independent of row order", () => {
    const [, , w, h] = portraitMap.viewBox;
    expect(aspectRatio).toBe(`${w} / ${h}`);
    expect(getPortraitAspectRatio([...rows].reverse(), asOf)).toBe(aspectRatio);
  });
});
