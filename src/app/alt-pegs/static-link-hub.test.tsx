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
  it("renders the static atlas orientation markup", () => {
    const html = renderToStaticMarkup(withQueryClient(<StaticAltPegLinkHub />));
    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Alt-Peg Atlas");
    expect(html).toContain("Peg Diversity Map");
    expect(html).toContain("References beyond geography");
    expect(html).toContain("Every non-USD stablecoin sits at its geographic origin");
    expect(html).toContain("$25M");
    expect(html).toContain("$200M");
  });

  it("renders the atlas at every breakpoint instead of gating it behind xl", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const atlas = container.querySelector('[data-alt-peg-layout="responsive-atlas"]');
    expect(atlas?.className).toContain("block");
    expect(atlas?.className).not.toContain("hidden");
    expect(atlas?.className).not.toContain("xl:block");
  });

  it("renders the peg-hero night-sky composition inside the responsive atlas", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const atlas = container.querySelector('[data-alt-peg-layout="responsive-atlas"]');
    expect(atlas?.querySelector(".peg-hero")).not.toBeNull();
    expect(atlas?.querySelector(".peg-hero__sky")).not.toBeNull();
    expect(atlas?.querySelector(".peg-hero__earth")).not.toBeNull();
  });

  it("explains the live coin layer while atlas data is loading", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const atlas = container.querySelector('[data-alt-peg-layout="responsive-atlas"]');
    expect(atlas?.textContent).toContain("Fiat logo size");
    const status = atlas?.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Loading live coin positions.");
  });

  it("wraps the atlas in a responsive viewport without forcing a tab stop", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const atlas = container.querySelector('[data-alt-peg-layout="responsive-atlas"]');
    const viewport = atlas?.querySelector(".peg-hero__viewport");
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute("role")).toBe("group");
    expect(viewport?.hasAttribute("tabindex")).toBe(false);
    expect(viewport?.getAttribute("aria-label")).toBe("Peg diversity map atlas");
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
