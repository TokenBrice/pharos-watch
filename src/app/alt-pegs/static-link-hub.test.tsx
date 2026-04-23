import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";

describe("StaticAltPegLinkHub", () => {
  it("renders crawlable peg links in static markup", () => {
    const html = renderToStaticMarkup(<StaticAltPegLinkHub />);

    expect(html).toContain("/stablecoins/eur");
    expect(html).toContain("/stablecoins/gold");
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Europe");
    expect(html).toContain("Asia");
    expect(html).toContain("Explore Peg Cohorts");
  });
});
