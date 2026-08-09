// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => cleanup());

  it("links mechanism tracker CTAs to the canonical active screener filter", () => {
    render(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} logos={{}} />);

    expect(screen.getByRole("link", { name: "See all CDP stablecoins" }).getAttribute("href")).toBe(
      "/screener/?mechanisms=cdp&lifecycle=active",
    );
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
});
