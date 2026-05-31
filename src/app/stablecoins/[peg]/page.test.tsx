import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import PegPage, { generateMetadata } from "./page";

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
    expect(html).toContain("Set up alerts");
    expect(html).toContain("peg client USD");
  });

  it("uses enriched peg page metadata descriptions", async () => {
    const page = PEG_TAXONOMY_PAGE_BY_SLUG.get("eur")!;
    const metadata = await generateMetadata({ params: Promise.resolve({ peg: "eur" }) });

    expect(metadata).toMatchObject({
      title: page.title,
      description: expect.stringContaining("leading symbols like"),
      alternates: { canonical: "/stablecoins/eur/" },
    });
  });
});
