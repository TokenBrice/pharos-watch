// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { CemeteryHero } from "../cemetery/cemetery-hero";
import { CemeterySelectionProvider } from "../cemetery/cemetery-selection-context";
import { getPortraitAspectRatio } from "../cemetery/plot-map-portrait-aspect";

// vi.mock factories are hoisted above the imports, so the helper loads lazily inside it.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
const stats = buildCemeteryStats(CEMETERY_ENTRIES);
const asOf = stats.asOf.date;
const atlas = toPlotLogoAtlas(atlasManifest);
const map = buildCemeteryPlotMap(CEMETERY_ENTRIES, { asOf, preset: "desktop" });

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

function renderHero() {
  const view = render(
    <CemeterySelectionProvider knownIds={rows.map((r) => r.id)}>
      <CemeteryHero rows={rows} stats={stats} asOf={asOf} atlas={atlas} portraitAspectRatio={getPortraitAspectRatio(rows, asOf)} />
    </CemeterySelectionProvider>,
  );
  return { ...view, plan: screen.getByRole("group", { name: "Stablecoin Cemetery plot map" }) };
}

describe("CemeteryHero", () => {
  it("gives every grave one focusable, uniquely identified element with its full reading", () => {
    const { plan } = renderHero();
    const graves = within(plan).getAllByRole("button");
    const ids = graves.map((g) => g.id);
    expect(ids).toHaveLength(CEMETERY_ENTRIES.length);
    expect(new Set(ids).size).toBe(CEMETERY_ENTRIES.length);
    expect(new Set(ids)).toEqual(new Set(CEMETERY_ENTRIES.map((e) => `grave-${e.id}`)));

    const ust = within(plan).getByRole("button", { name: "TerraUSD (UST), algorithmic failure, died May 2022, peak $18.8B" });
    expect(ust.id).toBe("grave-ust-terrausd-2022-05");
    expect(ust.getAttribute("aria-pressed")).toBe("false");
    expect(ust.getAttribute("href")).toBe("#ust-terrausd-2022-05");
  });

  it("offers one roving tab stop on the plan, landing on the newest grave", () => {
    const { plan } = renderHero();
    const tabbable = within(plan)
      .getAllByRole("button")
      .filter((g) => g.getAttribute("tabindex") === "0");
    expect(tabbable.map((g) => g.id)).toEqual([`grave-${map.newestId}`]);
  });

  it("teaches the reading rules in the plan's description and lets keyboard users skip it", () => {
    const { container, plan } = renderHero();
    const desc = document.getElementById(plan.getAttribute("aria-describedby") ?? "");
    expect(desc?.textContent).toMatch(/cause of death.*newest.*oldest.*plinth steps/i);
    const skip = screen.getByRole("link", { name: "Skip the cemetery map" });
    expect(skip.getAttribute("href")).toBe("#register");
    expect(skip.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("filter, feTurbulence")).toBeNull();
  });

  it("uses frost blue exactly once: the recorded-deaths figure", () => {
    const { container } = renderHero();
    const frost = container.querySelectorAll('[class~="text-frost-blue"]');
    expect(frost).toHaveLength(1);
    expect(frost[0].textContent).toBe(String(CEMETERY_ENTRIES.length));
  });

  it("keeps the desktop plan within its 3,500-node budget", () => {
    const { plan } = renderHero();
    expect(plan.querySelectorAll("*").length).toBeLessThanOrEqual(3500);
  });

  it("states the plaque, the latest death and the sub-line from the data", () => {
    renderHero();
    screen.getByRole("heading", { level: 1, name: "Stablecoin Cemetery" });
    screen.getByText(map.header.plaque);
    screen.getByText(stats.heroSubline);
    screen.getByText(map.header.rest.name);
    screen.getByText(map.header.rest.dateLabel);
  });

  it("renders the legend with every cause in canonical order", () => {
    renderHero();
    const legend = screen.getByRole("region", { name: "How to read the plot map" });
    const labels = CAUSE_ORDER.map((c) => CAUSE_META[c].label);
    const shown = within(legend)
      .getAllByText((_, el) => el?.tagName === "B" && labels.includes(el.textContent ?? ""))
      .map((el) => el.textContent);
    expect(shown).toEqual(labels);
  });
});
