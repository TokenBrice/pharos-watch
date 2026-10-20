import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
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

});
