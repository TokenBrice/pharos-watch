// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";

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

  it("links a static comparison tile to the crawlable brief and omits the overflow line under the cap", () => {
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
    expect(screen.queryByText(/more comparison briefs/)).toBeNull();
  });

  it("renders every brief, unhidden through the fourth and hidden below lg past it", () => {
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

    // Counted from the DOM, not from the input array: a dropped tile must fail.
    const tiles = screen.getAllByRole("link", { name: /^Open static comparison brief:/ });
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(
      pages.map((page) => `Open static comparison brief: ${page.shortTitle}`),
    );

    // Every tile up to the cap renders unhidden; each one past it keeps the
    // link in the DOM behind `hidden lg:flex` so it stays crawlable. Asserted
    // per tile, so hiding any single card inside the cap fails.
    for (const tile of tiles.slice(0, 4)) {
      expect(tile.className).not.toContain("hidden");
    }
    for (const tile of tiles.slice(4)) {
      expect(tile.className).toContain("hidden lg:flex");
    }

    expect(screen.getByRole("link", { name: /\+2 more comparison briefs/ }).getAttribute("href")).toBe(
      "/stablecoins/usd/",
    );
  });
});

describe("Explore Next peer ranking", () => {
  const current = { ...coin, flags: { ...coin.flags, pegCurrency: "CHF" as const } };

  function peer(
    id: string,
    pegCurrency: StablecoinMeta["flags"]["pegCurrency"],
    mechanismArchetype: StablecoinMeta["mechanismArchetype"],
    flags: Partial<StablecoinMeta["flags"]> = {},
  ): StablecoinClientListMeta {
    return {
      ...CLIENT_ACTIVE_STABLECOINS[0],
      id,
      name: id,
      symbol: id,
      variantOf: undefined,
      mechanismArchetype,
      flags: { ...coin.flags, pegCurrency, ...flags },
    };
  }

  it("ranks currency first, resolved mechanism next, then previous similarity and candidate order", () => {
    const candidates = [
      peer("usd-vault", "USD", "protocol-position"),
      peer("eur-cdp", "EUR", "cdp"),
      peer("chf-fiat", "CHF", "fiat-cash", { governance: "centralized", backing: "rwa-backed" }),
      peer("chf-cdp-first", "CHF", "cdp", { governance: "centralized" }),
      peer("chf-cdp-second", "CHF", "cdp", { governance: "centralized" }),
      peer("chf-cdp-best", "CHF", "cdp"),
    ];
    expect(getRelatedStablecoins(current, { candidates }).map((entry) => entry.id)).toEqual([
      "chf-cdp-best", "chf-cdp-first", "chf-cdp-second", "chf-fiat", "eur-cdp", "usd-vault",
    ]);
  });

  it("fills remaining slots with the existing candidates when currency matches are scarce", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => peer(`usd-vault-${index}`, "USD", "protocol-position")),
      peer("chf-fiat", "CHF", "fiat-cash", { governance: "centralized", backing: "rwa-backed" }),
    ];
    expect(getRelatedStablecoins(current, { candidates }).map((entry) => entry.id)).toEqual([
      "chf-fiat", "usd-vault-0", "usd-vault-1", "usd-vault-2", "usd-vault-3", "usd-vault-4",
    ]);
    expect(getRelatedStablecoins(current, { candidates: candidates.slice(0, 6) })).toHaveLength(6);
  });
});
