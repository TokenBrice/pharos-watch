import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StartHerePage } from "@/components/start-here-page";
import { START_HERE_ATLAS, START_HERE_GOALS, START_HERE_SCORES, START_HERE_SHORTCUTS } from "@/lib/start-here-content";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
import StablecoinsHubPage from "@/app/stablecoins/page";
import { PegLandingClient } from "@/app/stablecoins/[peg]/client";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";

vi.mock("next/link", async () => {
  // This factory is hoisted; load the shared mock only after Vitest initializes it.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/components/stablecoin-filtered-table", () => ({
  StablecoinFilteredTable: vi.fn(() => null),
}));

describe("StartHerePage", () => {
  it("renders Safety Score publication cadence from the producer interval with grade bands", () => {
    const score = START_HERE_SCORES.find(({ name }) => name === "Safety Score")!;
    const intervalMinutes = SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC / 60;
    expect(score.cadence).toContain(`${intervalMinutes} minutes`);
    expect(score.cadence).not.toMatch(/continuous/i);
    expect(score.cadence).toContain("A+ (87+)");
    expect(score.cadence).toContain("F (0–39)");

    const html = renderToStaticMarkup(<StartHerePage />);
    expect(html).toContain(score.cadence);
  });

  it("routes generic directory and category discovery to the full stablecoin directory", () => {
    expect(START_HERE_GOALS.find((goal) => goal.destinations.includes("Directory"))?.href).toBe("/stablecoins/");
    expect(START_HERE_ATLAS.flatMap((group) => group.items).find((item) => item.title === "Stablecoin directory")?.href).toBe("/stablecoins/");
    expect(START_HERE_SHORTCUTS.find((shortcut) => shortcut.title === "Browse by category")?.href).toBe("/stablecoins/");
    const html = renderToStaticMarkup(<StartHerePage />);
    expect(html).not.toContain('href="/stablecoins/usd/"');
    expect(html).toMatch(/href="\/stablecoins\/"[^>]*>browse the directory/);
    const directory = renderToStaticMarkup(<StablecoinsHubPage />);
    expect(directory).toContain('href="/stablecoins/eur/"');
  });

  it("retains peg-specific filters on explicitly USD and EUR landing pages", () => {
    renderToStaticMarkup(<PegLandingClient pegCurrency="USD" />);
    const usdProps = vi.mocked(StablecoinFilteredTable).mock.calls[0][0];
    expect(usdProps.activeFilters).toEqual(["usd-peg"]);
    vi.mocked(StablecoinFilteredTable).mockClear();
    renderToStaticMarkup(<PegLandingClient pegCurrency="EUR" />);
    expect(vi.mocked(StablecoinFilteredTable).mock.calls[0][0].activeFilters).toEqual(["eur-peg"]);
    vi.mocked(StablecoinFilteredTable).mockClear();
  });
});
