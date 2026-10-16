// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
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

  it("keeps the desktop plan within its 3,500-node budget", () => {
    const { plan } = renderHero();
    expect(plan.querySelectorAll("*").length).toBeLessThanOrEqual(3500);
  });
});
