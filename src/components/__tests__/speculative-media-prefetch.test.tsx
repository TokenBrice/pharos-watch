// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { LaunchedUntrackedRow, LaunchNewsItem, UpcomingCurrencyGroup } from "@/lib/upcoming-static-content";

const fixture = vi.hoisted(() => [
  ...Array.from({ length: 13 }, (_, index) => ({
    id: `coin-${index}`, name: `Coin ${index}`, symbol: `C${index}`,
    status: "pre-launch", launchPhase: "announced",
    expectedLaunchDate: `2027-01-${String(index + 1).padStart(2, "0")}`,
  })),
]);

vi.mock("@shared/lib/stablecoins/client-registry", () => ({ CLIENT_TRACKED_STABLECOINS: fixture }));
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock("@/data/blog", () => ({
  LATEST_BLOG_POST: { slug: "fresh-post", title: "Fresh post", datePublished: new Date().toISOString().slice(0, 10) },
}));
// Records the prefetch prop that real Link would act on; the default mock drops it.
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) =>
      React.createElement(
        "a",
        { href, "data-prefetch": prefetch === undefined ? "default" : String(prefetch), ...rest },
        children,
      ),
  };
});

const { HomeBlogBanner } = await import("../home-blog-banner");
const { HorizonConstellation } = await import("../horizon-constellation");
const { UpcomingClient } = await import("../upcoming-client");
const { UpcomingLaunchedSection, UpcomingStaticSections } = await import("../upcoming-static-sections");

afterEach(cleanup);

function prefetchOf(link: HTMLElement): string | null {
  return link.getAttribute("data-prefetch");
}

function profileLinks(): HTMLElement[] {
  return screen.queryAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/stablecoin/"));
}

describe("speculative media prefetch", () => {
  it("does not prefetch the blog banner destination", () => {
    render(<HomeBlogBanner />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/blog/fresh-post/");
    expect(prefetchOf(link)).toBe("false");
  });

  it("does not prefetch profile links in either constellation layout, but keeps the overflow link", () => {
    render(<HorizonConstellation widePhaseClassName="" narrowPhaseClassName="" />);
    const profiles = profileLinks();
    expect(profiles.length).toBeGreaterThan(0);
    for (const link of profiles) expect(prefetchOf(link)).toBe("false");
    const overflow = screen.getAllByRole("link").filter((link) => /more announced stablecoins/.test(link.getAttribute("aria-label") ?? ""));
    expect(overflow.length).toBeGreaterThan(0);
    for (const link of overflow) expect(prefetchOf(link)).toBe("default");
  });

  it("does not prefetch launched, news or currency-row profile links, but keeps peg hubs", () => {
    const launched: LaunchedUntrackedRow[] = [
      { id: "l1", name: "Launched One", symbol: "L1", href: "/stablecoin/l1/", launchDate: null, launchLabel: null, reason: null, reviewByLabel: null },
    ];
    const news: LaunchNewsItem[] = [
      { key: "n1", date: "2026-10-01", dateLabel: "Oct 1, 2026", symbol: "N1", title: "Milestone", href: "/stablecoin/n1/" },
    ];
    const groups: UpcomingCurrencyGroup[] = [
      {
        peg: "USD", heading: "USD", hubHref: "/peg/usd/", hubLabel: "All USD stablecoins",
        coins: [{ id: "c1", name: "Currency One", symbol: "C1", href: "/stablecoin/c1/" }],
      } as UpcomingCurrencyGroup,
    ];
    render(
      <>
        <UpcomingLaunchedSection rows={launched} />
        <UpcomingStaticSections news={news} groups={groups} />
      </>,
    );
    const profiles = profileLinks();
    expect(profiles).toHaveLength(3);
    for (const link of profiles) expect(prefetchOf(link)).toBe("false");
    expect(prefetchOf(screen.getByRole("link", { name: /All USD stablecoins/ }))).toBe("default");
  });

  it("does not prefetch interactive Upcoming profile links, including expanded rows", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(
      <UpcomingClient
        coins={[
          { ...makeStablecoinMeta({ id: "fixture-announced", name: "Announced Coin", status: "pre-launch", expectedLaunchDate: "2027-01-01" }), launchPhase: "announced" },
          { ...makeStablecoinMeta({ id: "fixture-beta", name: "Beta Coin", status: "pre-launch", expectedLaunchDate: "2027-02-01" }), launchPhase: "beta" },
        ]}
        logos={{}}
        teasers={{}}
      />,
    );
    for (const button of screen.queryAllByRole("button")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    const profiles = profileLinks();
    expect(profiles.length).toBeGreaterThan(0);
    for (const link of profiles) expect(prefetchOf(link)).toBe("false");
  });
});
