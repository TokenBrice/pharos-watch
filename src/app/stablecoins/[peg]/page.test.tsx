// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PEG_HUB_PAGES,
  PEG_TAXONOMY_PAGES,
  PEG_TAXONOMY_PAGE_BY_SLUG,
  PRE_LAUNCH_PEG_TAXONOMY_PAGES,
} from "@/lib/peg-taxonomy";
import PegPage from "./page";

vi.mock("./client", () => ({
  PegLandingClient: ({ pegCurrency }: { pegCurrency: string }) => (
    <div data-testid="peg-client">peg client {pegCurrency}</div>
  ),
}));

describe("PegPage", () => {
  it("renders currency-specific context, top coins, and conversion links", async () => {
    const page = PEG_TAXONOMY_PAGE_BY_SLUG.get("usd")!;
    const html = renderToStaticMarkup(
      await PegPage({ params: Promise.resolve({ peg: "usd" }) }),
    );

    expect(html).toContain("USD pegs are the deepest settlement layer");
    expect(html).toContain(`Pharos currently maps ${page.coins.length} tracked stablecoins`);
    for (const coin of page.topCoins) {
      expect(html).toContain(`${coin.name} (${coin.symbol})`);
    }
    expect(html).toContain(`${page.shortLabel} risk review starts with`);
    expect(html).toContain("Compare leaders");
    expect(html).toContain(">Alerts<");
    expect(html).toContain("peg client USD");
  });

  it("leads with a one-line deck and the live table, folding the intro and directory below", async () => {
    const page = PEG_TAXONOMY_PAGE_BY_SLUG.get("usd")!;
    const html = renderToStaticMarkup(
      await PegPage({ params: Promise.resolve({ peg: "usd" }) }),
    );

    expect(html).toContain(page.description);
    expect(html).toContain(`About ${page.shortLabel} stablecoins`);
    const detailsStart = html.indexOf("<details");
    expect(html.indexOf("USD pegs are the deepest settlement layer")).toBeGreaterThan(detailsStart);
    expect(html.indexOf("peg client USD")).toBeLessThan(html.indexOf("Stablecoin directory"));
    // The authored market context appears once, not again in the directory blurb.
    expect(html.split("USD pegs are the deepest settlement layer").length - 1).toBe(1);
  });

  it("puts the ISO code in currency hub titles and leaves commodity and index hubs unchanged", () => {
    const eur = PEG_TAXONOMY_PAGE_BY_SLUG.get("eur")!;
    expect(eur.title).toBe(`Euro (EUR) Stablecoins: ${eur.coins.length} Tracked, Ranked by Risk`);
    const gold = PEG_TAXONOMY_PAGE_BY_SLUG.get("gold")!;
    expect(gold.title).toBe(`Gold Stablecoins: ${gold.coins.length} Coins Ranked by Risk`);
    for (const page of PEG_HUB_PAGES) {
      // Room for the root " | Pharos" template inside the 70-character snippet budget.
      expect(page.title.length, page.slug).toBeLessThanOrEqual(61);
      expect(page.description.length, page.slug).toBeGreaterThanOrEqual(110);
      expect(page.description.length, page.slug).toBeLessThanOrEqual(180);
    }
  });

  it("renders the registry-only at-a-glance table, upcoming and former lists on a currency hub", async () => {
    const eur = PEG_TAXONOMY_PAGE_BY_SLUG.get("eur")!;
    const html = renderToStaticMarkup(await PegPage({ params: Promise.resolve({ peg: "eur" }) }));
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.querySelector("h1")?.textContent).toBe(eur.title);
    const table = document.querySelector('table[aria-labelledby="peg-at-a-glance"]');
    expect(table?.textContent).toContain("MiCA status");
    expect(table?.querySelectorAll("tbody tr").length).toBe(Math.min(eur.coins.length, 24));
    expect(table?.textContent).not.toMatch(/\$\d/);

    const upcoming = document.getElementById("peg-upcoming")?.closest("section");
    expect(eur.upcomingCoins.length).toBeGreaterThan(0);
    for (const coin of eur.upcomingCoins) {
      expect(upcoming?.querySelector(`a[href^="/stablecoin/${coin.id}"]`), coin.id).not.toBeNull();
    }
    const former = document.getElementById("peg-former")?.closest("section");
    expect(former?.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(html.indexOf("peg client EUR")).toBeLessThan(html.indexOf("peg-at-a-glance"));
  });

  it("serves each all-pre-launch peg as a hub with launch copy and no live table", async () => {
    for (const page of PRE_LAUNCH_PEG_TAXONOMY_PAGES) {
      expect(page.preLaunchOnly).toBe(true);
      expect(page.coins.length, page.slug).toBeGreaterThanOrEqual(2);
      expect(page.title, page.slug).toContain(`${page.shortLabel} (${page.value}) Stablecoins:`);
      expect(page.title, page.slug).not.toContain("Ranked by Risk");
      expect(PEG_TAXONOMY_PAGES.some((active) => active.slug === page.slug)).toBe(false);

      const html = renderToStaticMarkup(await PegPage({ params: Promise.resolve({ peg: page.slug }) }));
      expect(html).not.toContain("peg client");
      expect(html).not.toContain("Compare leaders");
      expect(html).not.toContain("live table above");
      // next/link drops the trailing slash outside the app's trailingSlash config.
      for (const coin of page.coins) expect(html).toContain(`href="/stablecoin/${coin.id}`);
    }
  });

});
