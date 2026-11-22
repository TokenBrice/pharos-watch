// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { IntentLink } from "../intent-link";
import { BackToSource, SourceNavigationProvider, TRACKER_LABELS, getSourceSegment } from "../back-to-source";
import { Footer } from "../footer";
import { RouteSeeAlsoFooter, SeeAlsoFooter } from "../see-also-footer";
import { SEE_ALSO_GRAPH } from "@/lib/see-also-graph";

const { pathnameMock, searchMock } = vi.hoisted(() => ({
  pathnameMock: { current: null as string | null },
  searchMock: { current: "" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.current,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    searchParams: new URLSearchParams(searchMock.current),
    isReady: true,
  }),
}));

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />
  ),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  pathnameMock.current = null;
  searchMock.current = "";
});

describe("IntentLink", () => {
  it("keeps a crawlable destination without speculative work until pointer intent", () => {
    render(<IntentLink href="/compare/">Compare</IntentLink>);
    const link = screen.getByRole("link", { name: "Compare" });
    expect(link.getAttribute("href")).toBe("/compare/");
    expect(link.getAttribute("data-prefetch")).toBe("disabled");
    fireEvent.mouseEnter(link);
    expect(link.getAttribute("data-prefetch")).toBe("auto");
  });

  it("enables prefetch on keyboard focus and preserves supplied handlers", () => {
    const onFocus = vi.fn();
    render(<IntentLink href="/learn/mechanisms/" onFocus={onFocus}>Mechanisms</IntentLink>);
    const link = screen.getByRole("link", { name: "Mechanisms" });
    fireEvent.focus(link);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(link.getAttribute("data-prefetch")).toBe("auto");
  });

  it("never prefetches same-page section jumps, even after intent", () => {
    render(<IntentLink href="#report-card">Safety</IntentLink>);
    const link = screen.getByRole("link", { name: "Safety" });
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    expect(link.getAttribute("href")).toBe("#report-card");
    expect(link.getAttribute("data-prefetch")).toBe("disabled");
  });
});

describe("Footer route discovery", () => {
  it("keeps navigation order and disables all internal route prefetch", () => {
    pathnameMock.current = null;
    render(<Footer />);
    const explore = within(screen.getByRole("navigation", { name: "Explore and reference" })).getAllByRole("link");
    expect(explore.map((link) => link.textContent)).toEqual([
      "Stablecoins", "Chains", "Mechanisms", "Case Studies", "Compare", "Depeg",
      "Digest", "Blog", "Changelog", "Methodology", "Coverage", "API", "Status",
    ]);
    const about = within(screen.getByRole("navigation", { name: "About" })).getAllByRole("link");
    expect(about.map((link) => link.textContent)).toEqual(["Independent", "Funding", "MIT", "Privacy Policy"]);
    for (const link of [...explore, ...about].filter((link) => link.getAttribute("href")?.startsWith("/"))) {
      expect(link.getAttribute("data-prefetch")).toBe("disabled");
    }
  });
});

describe("SeeAlsoFooter cross-hub discovery", () => {
  it("renders curated non-self-linking cross-hub links on analytics hubs and avoids duplicating /coverage/", () => {
    for (const [route, links] of Object.entries(SEE_ALSO_GRAPH)) {
      expect(links.length).toBeGreaterThanOrEqual(3);
      expect(links.length).toBeLessThanOrEqual(4);
      expect(links.every((link) => link.href !== route)).toBe(true);
    }

    pathnameMock.current = "/safety-scores/";
    const { rerender } = render(<RouteSeeAlsoFooter />);
    const aside = screen.getByRole("complementary", { name: "See also" });
    expect(within(aside).getAllByRole("link")).toHaveLength(4);
    expect(within(aside).getByRole("link", { name: /Dependency Map/i }).getAttribute("href")).toBe("/dependency-map/");

    // /coverage/ renders SeeAlsoFooter inline inside its own page layout.
    pathnameMock.current = "/coverage/";
    rerender(<RouteSeeAlsoFooter />);
    expect(screen.queryByRole("complementary", { name: "See also" })).toBeNull();

    // Direct route prop also resolves against SEE_ALSO_GRAPH.
    rerender(<SeeAlsoFooter route="/depeg/" />);
    expect(screen.getByRole("link", { name: /Stability Index/i }).getAttribute("href")).toBe("/stability-index/");
    pathnameMock.current = null;
  });
});

describe("BackToSource", () => {
  it("extracts root and top-level path segments cleanly", () => {
    expect(getSourceSegment(null)).toBeNull();
    expect(getSourceSegment("/")).toBe("/");
    expect(getSourceSegment("/?peg=EUR")).toBe("/");
    expect(getSourceSegment("/alt-pegs/?currency=EUR")).toBe("/alt-pegs");
    expect(getSourceSegment("/chains/ethereum/")).toBe("/chains");
  });

  it.each([
    ["/", "Overview"],
    ["/?peg=EUR", "Overview"],
    ["/alt-pegs/", "Non-USD Pegs"],
    ["/compliance/", "Compliance"],
    ["/chains/", "Chains"],
    ["/chains/ethereum/", "Chains"],
    ["/safety-scores/", "Safety Scores"],
    ["/yield/", "Yield leaderboard"],
    ["/depeg/", "Depeg tracker"],
    ["/stability-index/", "Stability Index"],
    ["/freezewatch/", "FreezeWatch"],
  ])("links back to %s (%s) after navigating to a stablecoin dossier", (sourceUrl, expectedLabel) => {
    const [sourcePath, sourceQuery = ""] = sourceUrl.split("?");
    window.history.replaceState(null, "", sourceUrl);
    pathnameMock.current = sourcePath;
    searchMock.current = sourceQuery;

    const { rerender } = render(
      <SourceNavigationProvider>
        <BackToSource />
      </SourceNavigationProvider>,
    );
    expect(screen.queryByRole("link")).toBeNull();

    window.history.replaceState(null, "", "/stablecoin/usdc-circle/");
    pathnameMock.current = "/stablecoin/usdc-circle/";
    searchMock.current = "";
    rerender(
      <SourceNavigationProvider>
        <BackToSource />
      </SourceNavigationProvider>,
    );

    const link = screen.getByRole("link", { name: `Back to ${expectedLabel}` });
    expect(link.getAttribute("href")).toBe(sourceUrl);
  });

  it("recognizes every documented hub and tracker root", () => {
    for (const key of [
      "/",
      "/alt-pegs",
      "/compliance",
      "/chains",
      "/safety-scores",
      "/yield",
      "/depeg",
      "/stability-index",
      "/freezewatch",
    ]) {
      expect(TRACKER_LABELS[key]).toBeTruthy();
    }
  });
});
