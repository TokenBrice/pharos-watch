// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { IntentLink } from "../intent-link";
import { BackToSource, SourceNavigationProvider, TRACKER_LABELS, getSourceSegment } from "../back-to-source";
import { Footer } from "../footer";
import { RouteSeeAlsoFooter, SeeAlsoFooter } from "../see-also-footer";
import { SEE_ALSO_GRAPH } from "@/lib/see-also-graph";
import { ShortcutsSection } from "@/components/homepage/shortcuts-section";
import { DEFAULT_SHORTCUT_HREFS } from "@/hooks/use-shortcuts";
import { guessRoute } from "@/lib/route-guess";

const { pathnameMock, searchMock } = vi.hoisted(() => ({
  pathnameMock: { current: null as string | null },
  searchMock: { current: "" },
}));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.current }));
vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({ searchParams: new URLSearchParams(searchMock.current), isReady: true }),
}));
vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />
  ),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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
  it("renders restructured explore, about, and social navs with prefetch disabled and external sr-only hints", () => {
    render(<Footer />);
    const exploreNav = screen.getByRole("navigation", { name: "Explore and reference" });
    const aboutNav = screen.getByRole("navigation", { name: "About" });
    const socialNav = screen.getByRole("navigation", { name: "Social links" });
    const explore = within(exploreNav).getAllByRole("link");
    const about = within(aboutNav).getAllByRole("link");
    const social = within(socialNav).getAllByRole("link");

    expect(explore.length).toBeGreaterThanOrEqual(10);
    expect(about.length).toBeGreaterThanOrEqual(3);
    expect(within(exploreNav).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs/");
    expect(within(exploreNav).getByRole("link", { name: "Daily Digest" }).getAttribute("href")).toBe("/digest/");
    expect(within(aboutNav).getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about/");
    expect(within(aboutNav).queryByRole("link", { name: "Independent" })).toBeNull();
    expect(within(aboutNav).getByRole("link", { name: /PharosVille\s*\(opens in new tab\)/i }).getAttribute("href")).toBe(
      "https://pharosville.pharos.watch/",
    );

    for (const link of [...explore, ...about].filter((el) => el.getAttribute("href")?.startsWith("/"))) {
      expect(link.textContent?.trim()).toBeTruthy();
      expect(link.getAttribute("data-prefetch")).toBe("disabled");
    }
    for (const link of [...about, ...social].filter((el) => el.getAttribute("target") === "_blank")) {
      expect(link.textContent).toContain("(opens in new tab)");
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

    // All four newly added hubs are present with standardized labels and inbound /coverage/ edges.
    for (const route of ["/cemetery/", "/timeline/", "/upcoming/", "/pharoswatchbot/"]) {
      expect(SEE_ALSO_GRAPH[route]).toHaveLength(4);
    }
    expect(SEE_ALSO_GRAPH["/coverage/"]?.map((link) => link.label)).toEqual([
      "Methodology",
      "API",
      "Upcoming",
      "Cemetery",
    ]);
    expect(SEE_ALSO_GRAPH["/upcoming/"]?.some((link) => link.href === "/coverage/")).toBe(true);
    expect(SEE_ALSO_GRAPH["/pharoswatchbot/"]?.some((link) => link.href === "/coverage/")).toBe(true);

    pathnameMock.current = "/safety-scores/";
    const { rerender } = render(<RouteSeeAlsoFooter />);
    const aside = screen.getByRole("complementary", { name: "See also" });
    expect(within(aside).getAllByRole("link")).toHaveLength(4);
    expect(within(aside).getByRole("link", { name: /Dependency Map/i }).getAttribute("href")).toBe("/dependency-map/");

    pathnameMock.current = "/coverage/";
    rerender(<RouteSeeAlsoFooter />);
    expect(screen.queryByRole("complementary", { name: "See also" })).toBeNull();

    rerender(<SeeAlsoFooter route="/depeg/" />);
    expect(screen.getByRole("link", { name: /Stability Index/i }).getAttribute("href")).toBe("/stability-index/");
  });
});

describe("ShortcutsSection & route-guess alignment", () => {
  it("keeps View and Edit mode in 6-item parity, disables prefetch, migrates legacy 12-item defaults, and marks external shortcuts", async () => {
    // Seed legacy 12-item default payload and verify clean migration to aligned 6 defaults.
    window.localStorage.setItem(
      "pharos-shortcuts",
      JSON.stringify([
        "/chains/",
        "/upcoming/",
        "/portfolio/",
        "/alt-pegs/",
        "/cemetery/",
        "https://pharosville.pharos.watch/",
        "/yield/",
        "/liquidity/",
        "/screener/",
        "/compare/",
        "/dependency-map/",
        "/timeline/",
      ]),
    );

    render(<ShortcutsSection />);
    await waitFor(() => {
      const links = screen.getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual(DEFAULT_SHORTCUT_HREFS);
    });

    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("data-prefetch")).toBe("disabled");
    }

    // Switching to Edit mode keeps the exact same 6 items (no 6 -> 12 jump).
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getAllByRole("button", { name: /^Remove .* shortcut$/ })).toHaveLength(6);

    // Adding an external shortcut renders the external indicator and sr-only new-tab announcement.
    fireEvent.click(screen.getByRole("button", { name: "Add PharosVille shortcut" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const externalShortcut = screen.getByRole("link", { name: /PharosVille\s*\(opens in new tab\)/i });
    expect(externalShortcut.getAttribute("target")).toBe("_blank");
    expect(externalShortcut.getAttribute("href")).toBe("https://pharosville.pharos.watch/");
  });

  it("recovers Guided Picker and canonical nav labels in guessRoute", () => {
    expect(guessRoute("/peg-tracker/")).toEqual([{ href: "/depeg/", label: "Depeg & Recovery", distance: 0 }]);
    expect(guessRoute("/api-access/")).toEqual([{ href: "/api/", label: "API", distance: 0 }]);
    expect(guessRoute("/screener/piker/")[0]).toMatchObject({ href: "/screener/picker/", label: "Guided Picker" });
    expect(guessRoute("/depg/")[0]).toMatchObject({ href: "/depeg/", label: "Depeg & Recovery" });
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

    const tree = () => <SourceNavigationProvider><BackToSource /></SourceNavigationProvider>;
    const { rerender } = render(tree());
    expect(screen.queryByRole("link")).toBeNull();

    window.history.replaceState(null, "", "/stablecoin/usdc-circle/");
    pathnameMock.current = "/stablecoin/usdc-circle/";
    searchMock.current = "";
    rerender(tree());

    expect(screen.getByRole("link", { name: `Back to ${expectedLabel}` }).getAttribute("href")).toBe(sourceUrl);
  });

  it("recognizes every documented hub and tracker root", () => {
    for (const key of ["/", "/alt-pegs", "/compliance", "/chains", "/safety-scores", "/yield", "/depeg", "/stability-index", "/freezewatch"]) {
      expect(TRACKER_LABELS[key]).toBeTruthy();
    }
  });
});
