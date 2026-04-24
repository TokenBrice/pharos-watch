// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";
import { AltPegCohortDirectory } from "@/app/alt-pegs/fiat-world-atlas/cohort-directory";
import { buildAltPegLinkHubGroups, type AltPegLinkHubItem } from "@/lib/alt-peg-market";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();
const FIAT_LINK_HUB_ITEMS = LINK_HUB_GROUPS.find((g) => g.label === "Fiat")?.items ?? [];
const COMMODITY_INDEX_LINK_HUB_ITEMS: AltPegLinkHubItem[] = LINK_HUB_GROUPS
  .filter((g) => g.label !== "Fiat")
  .flatMap((g) => g.items);

afterEach(cleanup);

function withQueryClient(children: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StaticAltPegLinkHub", () => {
  it("renders the crawlable cohort directory markup", () => {
    const html = renderToStaticMarkup(withQueryClient(<StaticAltPegLinkHub />));
    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("References beyond geography");
  });

  it("keeps the static crawlable directory hidden with separate anchor ids", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const hiddenDirectory = container.querySelector("#static-alt-peg-cohort-list")?.closest("[hidden]");
    expect(hiddenDirectory).not.toBeNull();
    expect(container.querySelector("#static-alt-peg-region-europe")).not.toBeNull();
    expect(container.querySelector("#alt-peg-region-europe")).toBeNull();
  });
});

describe("AltPegCohortDirectory", () => {
  it("renders crawlable peg links for fiat, commodity, and index cohorts", () => {
    const html = renderToStaticMarkup(
      <AltPegCohortDirectory
        fiatItems={FIAT_LINK_HUB_ITEMS}
        commodityIndexItems={COMMODITY_INDEX_LINK_HUB_ITEMS}
      />,
    );

    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("References beyond geography");
    expect(html).toContain("Cohorts listed by coin count");
  });

  it("keeps the celestial band in the mobile-only directory view", () => {
    const { container } = render(
      <AltPegCohortDirectory
        fiatItems={FIAT_LINK_HUB_ITEMS}
        commodityIndexItems={COMMODITY_INDEX_LINK_HUB_ITEMS}
      />,
    );
    const band = container.querySelector('[data-testid="celestial-band"]');
    expect(band).not.toBeNull();
    const mobileWrapper = band?.closest(".xl\\:hidden");
    expect(mobileWrapper).not.toBeNull();
  });

  it("renders focusable region jump targets", () => {
    const { container } = render(
      <AltPegCohortDirectory
        fiatItems={FIAT_LINK_HUB_ITEMS}
        commodityIndexItems={COMMODITY_INDEX_LINK_HUB_ITEMS}
      />,
    );
    const europe = container.querySelector("#alt-peg-region-europe");
    expect(europe?.getAttribute("tabindex")).toBe("-1");
    expect(europe?.getAttribute("aria-labelledby")).toBe("alt-peg-region-europe-heading");
  });
});
