import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";

describe("StaticAltPegLinkHub", () => {
  it("renders crawlable peg links in static markup", () => {
    const html = renderToStaticMarkup(<StaticAltPegLinkHub />);
    const eurLinks = html.match(/href="\/stablecoins\/eur\/?"/g) ?? [];
    const goldLinks = html.match(/href="\/stablecoins\/gold\/?"/g) ?? [];
    const silverLinks = html.match(/href="\/stablecoins\/silver\/?"/g) ?? [];
    const cpiLinks = html.match(/href="\/stablecoins\/cpi\/?"/g) ?? [];

    expect(eurLinks.length).toBeGreaterThanOrEqual(1);
    expect(goldLinks.length).toBeGreaterThanOrEqual(1);
    expect(silverLinks.length).toBeGreaterThanOrEqual(1);
    expect(cpiLinks.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Europe");
    expect(html).toContain("Asia");
    expect(html).toContain("Explore Peg Cohorts");
    expect(html).toContain("Fiat Peg Geography");
    expect(html).toContain("Non-geographic references");
    expect(html).toContain("Coverage markers scale with tracked fiat coin count");
    expect(html).toContain("Marker size = tracked fiat coin count");
    expect(html).toContain("Tracked off-map because these cohorts reference assets or indices");
  });
});
