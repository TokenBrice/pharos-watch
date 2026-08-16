import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";
import { HOMEPAGE_TOP_CORE_STABLECOINS } from "@/lib/stablecoin-static-data";
import { buildStablecoinUrl } from "@shared/lib/urls";

describe("homepage server-rendered links", () => {
  it("keeps a useful profile directory in the no-JavaScript document", () => {
    const html = renderToStaticMarkup(<HomePage />);
    const anchorCount = (html.match(/<a\b/g) ?? []).length;

    expect(anchorCount).toBeGreaterThanOrEqual(20);
    expect(html).toContain('aria-label="Leading stablecoin profiles"');
    expect(html).toContain('href="/screener"');
    expect(html).toContain("sm:even:border-r");

    for (const coin of HOMEPAGE_TOP_CORE_STABLECOINS.slice(0, 8)) {
      expect(html).toContain(`href="${buildStablecoinUrl(coin.id).replace(/\/$/, "")}"`);
      expect(html).toContain(`>${coin.symbol}</span>`);
    }
  });
});
