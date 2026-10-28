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

  it("names the peer category with its canonical peg label and hub, without the generic action", () => {
    for (const { peg, slug, label } of [
      { peg: "GBP" as const, slug: "gbp", label: "British Pound" },
      { peg: "SILVER" as const, slug: "silver", label: "Silver" },
    ]) {
      const pegCoin = { ...coin, flags: { ...coin.flags, pegCurrency: peg } };
      const { unmount } = render(
        <ExploreNextSection
          coin={pegCoin}
          related={CLIENT_ACTIVE_STABLECOINS.slice(0, 1)}
          staticComparisonPages={[]}
          logos={{}}
        />,
      );
      const actions = screen.getAllByRole("link", { name: `All ${label} stablecoins` });
      expect(actions).toHaveLength(2);
      for (const action of actions) {
        expect(action.getAttribute("href")).toBe(`/stablecoins/${slug}/`);
        expect(action.getAttribute("data-prefetch")).toBe("disabled");
      }
      expect(screen.queryByRole("link", { name: "See all peers" })).toBeNull();
      unmount();
    }
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
    status: StablecoinClientListMeta["status"] = "active",
  ): StablecoinClientListMeta {
    return {
      ...CLIENT_ACTIVE_STABLECOINS[0],
      id,
      name: id,
      symbol: id,
      variantOf: undefined,
      mechanismArchetype,
      status,
      flags: { ...coin.flags, pegCurrency, ...flags },
    };
  }

  it("keeps the first five ranked peers and fills the sixth from its relevance tier", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => peer(`usd-vault-${index}`, "USD", "protocol-position")),
      peer("chf-fiat", "CHF", "fiat-cash", { governance: "centralized", backing: "rwa-backed" }),
    ];
    const ids = getRelatedStablecoins(current, { candidates }).map((entry) => entry.id);

    expect(ids.slice(0, 5)).toEqual([
      "chf-fiat", "usd-vault-0", "usd-vault-1", "usd-vault-2", "usd-vault-3",
    ]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // The treated slot stays inside the original sixth-place tuple (all six
    // USD/CDP vaults tie), so it cannot fall back to a weaker peer.
    expect(["usd-vault-4", "usd-vault-5"]).toContain(ids[5]);
    expect(getRelatedStablecoins(current, { candidates: candidates.slice(0, 6) })).toHaveLength(6);
  });

  it("leaves the five leading peers in place and never promotes a weaker tier", () => {
    const strong = Array.from({ length: 6 }, (_, index) => peer(`strong-${index}`, "CHF", "cdp"));
    const weak = [
      ...Array.from({ length: 5 }, (_, index) => peer(`weak-${index}`, "USD", "fiat-cash")),
      peer("prelaunch-zzz", "USD", "fiat-cash", { governance: "centralized" }),
    ];
    const ids = getRelatedStablecoins(current, { candidates: [...strong, ...weak] }).map((entry) => entry.id);

    expect(ids).toHaveLength(6);
    expect(ids.every((id) => id.startsWith("strong-"))).toBe(true);
    // The weaker record has a lower hash; tuple filtering still excludes it.
    expect(ids).not.toContain("prelaunch-zzz");
  });

  it("keeps the sixth slot deterministic and free of the current coin or duplicates", () => {
    const candidates = [
      peer("test-cdp-dollar", "CHF", "cdp"),
      ...Array.from({ length: 8 }, (_, index) => peer(`usd-vault-${index}`, "USD", "protocol-position")),
    ];
    const runs = Array.from({ length: 5 }, () =>
      getRelatedStablecoins(current, { candidates }).map((entry) => entry.id));
    for (const ids of runs) expect(ids).toEqual(runs[0]);
    expect(runs[0]).not.toContain("test-cdp-dollar");
    expect(new Set(runs[0]).size).toBe(runs[0].length);
  });

  it("keeps caller-supplied pre-launch candidates eligible for the treated slot", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => peer(`peer-${index}`, "USD", "protocol-position")),
      peer("prelaunch-zzz", "USD", "protocol-position", {}, "pre-launch"),
    ];
    const ids = getRelatedStablecoins(current, { candidates }).map((entry) => entry.id);

    expect(ids.slice(0, 5)).toEqual(["peer-0", "peer-1", "peer-2", "peer-3", "peer-4"]);
    // peer-5 held sixth place in registry order; the tie-break may promote the
    // caller-supplied pre-launch record because its relevance tuple matches.
    expect(ids[5]).toBe("prelaunch-zzz");
  });

  it("returns the ordinary bounded result for zero through five candidates", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => peer(`usd-vault-${index}`, "USD", "protocol-position"));
    expect(getRelatedStablecoins(current, { candidates: [] })).toEqual([]);
    for (let count = 1; count <= 5; count += 1) {
      expect(getRelatedStablecoins(current, { candidates: candidates.slice(0, count) }).map((entry) => entry.id)).toEqual(
        candidates.slice(0, count).map((entry) => entry.id),
      );
    }
  });

  it("keeps non-six limits in today's registry order", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => peer(`usd-vault-${index}`, "USD", "protocol-position"));
    expect(getRelatedStablecoins(current, { candidates, limit: 4 }).map((entry) => entry.id)).toEqual([
      "usd-vault-0", "usd-vault-1", "usd-vault-2", "usd-vault-3",
    ]);
    expect(getRelatedStablecoins(current, { candidates, limit: 7 }).map((entry) => entry.id)).toEqual([
      "usd-vault-0", "usd-vault-1", "usd-vault-2", "usd-vault-3", "usd-vault-4", "usd-vault-5", "usd-vault-6",
    ]);
    expect(getRelatedStablecoins(current, { candidates, limit: 10 })).toHaveLength(8);
  });
});
