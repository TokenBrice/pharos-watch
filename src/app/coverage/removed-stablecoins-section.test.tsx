import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REMOVED_STABLECOINS } from "@/lib/removed-stablecoins";
import { RemovedStablecoinsSection } from "./removed-stablecoins-section";

describe("RemovedStablecoinsSection", () => {
  it("renders an anchored row per removed coin with its peg hub, cemetery record, removal date and reason", () => {
    const html = renderToStaticMarkup(<RemovedStablecoinsSection />);

    expect(html).toContain("Removed from coverage");
    expect(html).toContain(`>${REMOVED_STABLECOINS.length}<`);
    for (const coin of REMOVED_STABLECOINS) expect(html).toContain(`id="${coin.id}"`);
    expect(html).toContain("Moneta Digital");
    expect(html).toContain("(MMXN)");
    expect(html).toContain('href="/stablecoins/mxn');
    expect(html).toMatch(/href="\/cemetery\/?#xai-silo-finance"/);
    expect(html).toMatch(/href="\/cemetery\/?#eura-angle-eura-2026-03"/);
    expect(html).toContain("Cemetery record");
    expect(html).toContain('dateTime="2026-07-19"');
    expect(html).toContain("July 19, 2026");
    expect(html).toContain("No live issued token");
    expect(html).not.toContain("usd-dinari");
  });
});
