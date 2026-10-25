import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REMOVED_STABLECOINS } from "@/lib/removed-stablecoins";
import { RemovedStablecoinsSection } from "./removed-stablecoins-section";

describe("RemovedStablecoinsSection", () => {
  it("renders an anchored row per removed coin with its peg hub, removal date and reason", () => {
    const html = renderToStaticMarkup(<RemovedStablecoinsSection />);

    expect(html).toContain("Removed from coverage");
    for (const coin of REMOVED_STABLECOINS) expect(html).toContain(`id="${coin.id}"`);
    expect(html).toContain("Moneta Digital");
    expect(html).toContain("(MMXN)");
    expect(html).toContain('href="/stablecoins/mxn');
    expect(html).toContain("Removed July 19, 2026");
    expect(html).toContain("No live issued token");
  });
});
