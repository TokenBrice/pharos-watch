// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildAltPegLinkHubGroups } from "@/lib/alt-peg-market";
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
    expect(html).toContain("Fiat Reference Regions");
    expect(html).toContain("Non-geographic references");
    expect(html).toContain("Coverage markers scale with tracked fiat coin count");
    expect(html).toContain("Marker size = tracked fiat coin count");
    expect(html).toContain("Tracked off-map because these cohorts reference assets or indices");
  });

  it("highlights the largest off-map cohort first", () => {
    const offMapItems = buildAltPegLinkHubGroups()
      .filter((group) => group.label !== "Fiat")
      .flatMap((group) => group.items);
    const expectedLead = [...offMapItems].sort((left, right) => right.coinCount - left.coinCount)[0];

    expect(expectedLead).toBeDefined();

    render(<StaticAltPegLinkHub />);

    const sectionHeading = screen.getByRole("heading", { name: "Non-geographic references" });
    const section = sectionHeading.closest("section");
    expect(section).not.toBeNull();

    const links = within(section as HTMLElement).getAllByRole("link");
    expect(links[0]?.getAttribute("aria-label")).toContain(expectedLead?.label ?? "");
  });

  it("keeps the desktop atlas gated behind the xl layout and scales markers by coverage", () => {
    const { container } = render(<StaticAltPegLinkHub />);

    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    const regionList = container.querySelector('[data-alt-peg-layout="region-list"]');
    const europeMarker = container.querySelector('[data-region="Europe"]');
    const africaMarker = container.querySelector('[data-region="Africa"]');

    expect(desktopAtlas?.className).toContain("hidden");
    expect(desktopAtlas?.className).toContain("xl:block");
    expect(regionList?.className).toContain("xl:hidden");
    expect(europeMarker?.getAttribute("data-coin-count")).toBe("20");
    expect(africaMarker?.getAttribute("data-coin-count")).toBe("1");
    expect(Number(europeMarker?.getAttribute("data-marker-size"))).toBeGreaterThan(
      Number(africaMarker?.getAttribute("data-marker-size")),
    );
  });
});
