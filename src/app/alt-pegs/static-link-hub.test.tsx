// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";

describe("StaticAltPegLinkHub", () => {
  it("renders crawlable peg links in static markup for fiat, commodity, and index cohorts", () => {
    const html = renderToStaticMarkup(<StaticAltPegLinkHub />);
    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Fiat Peg Geography");
    expect(html).toContain("References beyond geography");
    expect(html).toContain("Explore Peg Cohorts");
  });

  it("keeps the desktop atlas gated behind the xl layout and mobile list at xl:hidden", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    const regionList = container.querySelector('[data-alt-peg-layout="region-list"]');
    expect(desktopAtlas?.className).toContain("hidden");
    expect(desktopAtlas?.className).toContain("xl:block");
    expect(regionList?.className).toContain("xl:hidden");
  });

  it("colors the German and Japanese country paths based on EUR and JPY fills", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const styleBlock = Array.from(container.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("");
    expect(styleBlock).toContain("path#DE{fill:#8b5cf6");
    expect(styleBlock).toContain("path#JP{fill:#f43f5e");
  });

  it("renders deadspot markers for Gold, Silver, and CPI inside the desktop map", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    const deadspots = desktopAtlas?.querySelector('[data-testid="map-deadspot-references"]');
    expect(deadspots).not.toBeNull();
    expect(deadspots?.querySelector('[data-body-kind="sun"]')).not.toBeNull();
    expect(deadspots?.querySelector('[data-body-kind="moon"]')).not.toBeNull();
    expect(deadspots?.querySelector('[data-body-kind="index"]')).not.toBeNull();
  });

  it("keeps the celestial band as a mobile-only fallback beneath the xl:hidden wrapper", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const band = container.querySelector('[data-testid="celestial-band"]');
    expect(band).not.toBeNull();
    const mobileWrapper = band?.closest(".xl\\:hidden");
    expect(mobileWrapper).not.toBeNull();
  });
});
