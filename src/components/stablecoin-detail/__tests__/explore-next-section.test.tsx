// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
import type { StablecoinMeta } from "@shared/types";
import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />
  ),
}));

afterEach(cleanup);

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
  it("lists the coin's depeg event pages under Depeg history, and omits the block without events", () => {
    const depegEvents = [
      { href: "/depeg/tcdp-2026-03-11/", label: "TCDP depeg Mar 2026" },
      { href: "/depeg/tcdp-2025-08-02/", label: "TCDP depeg Aug 2025" },
    ];
    const { rerender } = render(
      <ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} depegEvents={depegEvents} logos={{}} />,
    );
    expect(screen.getByText("Depeg history")).toBeTruthy();
    for (const event of depegEvents) {
      expect(screen.getByRole("link", { name: event.label }).getAttribute("href")).toBe(event.href);
    }
    rerender(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} logos={{}} />);
    expect(screen.queryByText("Depeg history")).toBeNull();
  });

  it.each(["mouseEnter", "focus"] as const)("keeps all peer routes quiet until %s intent on one chip", (intent) => {
    const related = CLIENT_ACTIVE_STABLECOINS.slice(0, 6);
    render(<ExploreNextSection coin={coin} related={related} staticComparisonPages={[]} logos={{}} />);
    const links = related.map((peer) => screen.getByTitle(peer.name));
    for (const link of links) expect(link.getAttribute("data-prefetch")).toBe("disabled");
    expect(links[0].getAttribute("href")).toBe(`/stablecoin/${related[0].id}/`);
    fireEvent[intent](links[0]);
    expect(links[0].getAttribute("data-prefetch")).toBe("auto");
    for (const link of links.slice(1)) expect(link.getAttribute("data-prefetch")).toBe("disabled");
  });

  it.each(["mouseEnter", "focus"] as const)("keeps compact research links quiet until %s intent", (intent) => {
    render(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} logos={{}} />);
    const tracker = screen.getByRole("link", { name: "See all CDP stablecoins" });
    const action = screen.getByRole("link", { name: "Browse stablecoin comparisons" });
    expect(tracker.getAttribute("data-prefetch")).toBe("disabled");
    expect(action.getAttribute("data-prefetch")).toBe("disabled");
    expect(tracker.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent[intent](tracker);
    expect(tracker.getAttribute("data-prefetch")).toBe("auto");
    expect(action.getAttribute("data-prefetch")).toBe("disabled");
  });


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
