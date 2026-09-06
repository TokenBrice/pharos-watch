// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const { ExploreNextSection } = await import("../explore-next-section");

const coin = {
  id: "test-cdp-dollar",
  name: "Test CDP Dollar",
  symbol: "TCDP",
  mechanismArchetype: "cdp",
  flags: {
    governance: "decentralized",
    backing: "crypto-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
  infrastructures: [],
} as unknown as StablecoinMeta;

describe("ExploreNextSection", () => {

  it("links mechanism tracker CTAs to the canonical active screener filter", () => {
    render(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} logos={{}} />);

    expect(screen.getByRole("link", { name: "See all CDP stablecoins" }).getAttribute("href")).toBe(
      "/screener/?mechanisms=cdp&lifecycle=active",
    );
    expect(screen.getByRole("link", { name: "Browse stablecoin comparisons" }).getAttribute("href")).toBe("/compare/");
    expect(screen.queryByRole("link", { name: /watchlist.*preset/i })).toBeNull();
  });

  it("links static comparison tiles to the crawlable brief, not only the live tool", () => {
    render(
      <ExploreNextSection
        coin={coin}
        related={[]}
        staticComparisonPages={[
          {
            href: "/compare/test-cdp-dollar-vs-usdc-circle/",
            shortTitle: "TCDP vs USDC",
            leftId: "test-cdp-dollar",
            rightId: "usdc-circle",
            counterpartId: "usdc-circle",
            counterpartSymbol: "USDC",
            counterpartName: "USD Coin",
          },
        ]}
        logos={{}}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Open static comparison brief: TCDP vs USDC" }).getAttribute("href"),
    ).toBe("/compare/test-cdp-dollar-vs-usdc-circle/");
  });

  it("keeps comparison briefs past the fourth in the DOM, hidden below lg", () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({
      href: `/compare/test-cdp-dollar-vs-peer-${i}/`,
      shortTitle: `TCDP vs P${i}`,
      leftId: "test-cdp-dollar",
      rightId: `peer-${i}`,
      counterpartId: `peer-${i}`,
      counterpartSymbol: `P${i}`,
      counterpartName: `Peer ${i}`,
    }));

    render(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={pages} logos={{}} />);

    const tiles = pages.map((page) =>
      screen.getByRole("link", { name: `Open static comparison brief: ${page.shortTitle}` }),
    );

    expect(tiles).toHaveLength(6);
    expect(tiles.slice(0, 4).every((tile) => tile.className.includes("hidden"))).toBe(false);
    expect(tiles.slice(4).every((tile) => tile.className.includes("hidden lg:flex"))).toBe(true);

    const more = screen.getByRole("link", { name: /\+2 more comparison briefs/ });
    expect(more.getAttribute("href")).toBe("/stablecoins/usd/");
    expect(more.className).toContain("lg:hidden");
  });

  it("omits the mobile overflow line when every brief fits the cap", () => {
    render(
      <ExploreNextSection
        coin={coin}
        related={[]}
        staticComparisonPages={[
          {
            href: "/compare/test-cdp-dollar-vs-usdc-circle/",
            shortTitle: "TCDP vs USDC",
            leftId: "test-cdp-dollar",
            rightId: "usdc-circle",
            counterpartId: "usdc-circle",
            counterpartSymbol: "USDC",
            counterpartName: "USD Coin",
          },
        ]}
        logos={{}}
      />,
    );

    expect(screen.queryByText(/more comparison briefs/)).toBeNull();
  });
});
