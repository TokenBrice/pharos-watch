// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";

afterEach(cleanup);

function withQueryClient(children: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StaticAltPegLinkHub", () => {
  it("renders crawlable peg links in static markup for fiat, commodity, and index cohorts", () => {
    const html = renderToStaticMarkup(withQueryClient(<StaticAltPegLinkHub />));
    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Alt-Peg Atlas");
    expect(html).toContain("References beyond geography");
    expect(html).toContain("Peg Diversity Map");
  });

  it("keeps the desktop atlas gated behind the xl layout and mobile list at xl:hidden", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    const regionList = container.querySelector('[data-alt-peg-layout="region-list"]');
    expect(desktopAtlas?.className).toContain("hidden");
    expect(desktopAtlas?.className).toContain("xl:block");
    expect(regionList?.className).toContain("xl:hidden");
  });

  it("renders the peg-hero night-sky composition inside the desktop atlas", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    expect(desktopAtlas?.querySelector(".peg-hero")).not.toBeNull();
    expect(desktopAtlas?.querySelector(".peg-hero__sky")).not.toBeNull();
    expect(desktopAtlas?.querySelector(".peg-hero__earth")).not.toBeNull();
  });

  it("keeps the celestial band as a mobile-only fallback beneath the xl:hidden wrapper", () => {
    const { container } = render(withQueryClient(<StaticAltPegLinkHub />));
    const band = container.querySelector('[data-testid="celestial-band"]');
    expect(band).not.toBeNull();
    const mobileWrapper = band?.closest(".xl\\:hidden");
    expect(mobileWrapper).not.toBeNull();
  });
});
