import { describe, expect, it } from "vitest";
import {
  BOTTOM_NAV_ITEMS,
  DEFAULT_EXPANDED,
  NAV_GROUPS,
  NAV_ITEMS,
  QUICK_NAV_ITEMS,
} from "@/lib/nav-config";
import { COMMAND_PALETTE_PAGES } from "@/components/command-palette-model";

describe("nav-config", () => {
  it("uses a quick rail plus four section menus as the canonical navigation model", () => {
    expect(QUICK_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/safety-scores/",
      "/yield/",
      "/depeg/",
      "/stability-index/",
    ]);

    expect(NAV_GROUPS.map((group) => group.key)).toEqual(["markets", "risk", "tools", "more"]);
    expect(NAV_GROUPS.map((group) => group.label)).toEqual(["Markets", "Risk", "Tools", "More"]);
  });

  it("keeps every rail route inside its owning menu so the section still answers for it", () => {
    const marketsHrefs = NAV_GROUPS.find((group) => group.key === "markets")?.items.map((item) => item.href);
    const riskHrefs = NAV_GROUPS.find((group) => group.key === "risk")?.items.map((item) => item.href);

    expect(marketsHrefs).toContain("/stability-index/");
    expect(marketsHrefs).toContain("/yield/");
    expect(riskHrefs).toContain("/safety-scores/");
    expect(riskHrefs).toContain("/depeg/");
  });

  it("splits market structure, failure modes, and interactive tools", () => {
    expect(NAV_GROUPS.find((group) => group.key === "markets")?.items.map((item) => item.href)).toEqual([
      "/stability-index/",
      "/yield/",
      "/liquidity/",
      "/flows/",
      "/chains/",
      "/alt-pegs/",
      "/upcoming/",
    ]);

    expect(NAV_GROUPS.find((group) => group.key === "risk")?.items.map((item) => item.href)).toEqual([
      "/safety-scores/",
      "/depeg/",
      "/freezewatch/",
      "/compliance/",
      "/dependency-map/",
      "/cemetery/",
    ]);

    expect(NAV_GROUPS.find((group) => group.key === "tools")?.items.map((item) => item.href)).toEqual([
      "/screener/",
      "/compare/",
      "/portfolio/",
      "/stablecoins/",
    ]);
  });

  it("organizes the low-traffic tail into labeled More columns", () => {
    const more = NAV_GROUPS.find((group) => group.key === "more");

    expect(more?.columns?.map((column) => column.key)).toEqual(["learn", "updates", "pharos"]);
    expect(more?.columns?.map((column) => column.label)).toEqual(["Learn", "Updates", "Pharos"]);
    // `items` must stay the exact flattening, or the mobile drawer and
    // /sitemap-tree/ silently drop rows the desktop panel still shows.
    expect(more?.items).toEqual(more?.columns?.flatMap((column) => column.items));
  });

  it("gives every chrome-only utility route a home in a group", () => {
    const groupedHrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

    // /status/ previously lived only in the hardcoded desktop overflow and had
    // no mobile surface at all.
    for (const href of ["/status/", "/api/", "/changelog/", "/pharoswatchbot/"]) {
      expect(groupedHrefs).toContain(href);
    }
  });

  it("exposes PharosVille as an external row rather than an internal route", () => {
    const ville = NAV_ITEMS.find((item) => item.label === "PharosVille");

    expect(ville?.external).toBe(true);
    expect(ville?.href.startsWith("https://")).toBe(true);
  });

  it("indexes canonical labels, not the rail's presentation-only short forms", () => {
    // NAV_ITEMS feeds the command palette and the 404 route-guess: search must
    // offer "Yield Intelligence", never the rail's "Yield".
    expect(NAV_ITEMS.find((item) => item.href === "/yield/")?.label).toBe("Yield Intelligence");
    expect(NAV_ITEMS.find((item) => item.href === "/stability-index/")?.shortLabel).toBeUndefined();
    expect(NAV_ITEMS.find((item) => item.href === "/safety-scores/")?.shortLabel).toBeUndefined();
  });

  it("keeps footer-only routes searchable through the palette page index", () => {
    // /coverage/ and /funding/ left the menus in the 2026-09-04 revamp; search
    // must still find them or the demotion becomes a disappearance.
    const hrefs = COMMAND_PALETTE_PAGES.map((page) => page.href);

    expect(hrefs).toContain("/coverage/");
    expect(hrefs).toContain("/funding/");
  });

  it("exposes every navigable route exactly once to shared nav consumers", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);

    for (const href of [
      ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)),
      ...QUICK_NAV_ITEMS.map((item) => item.href),
      ...BOTTOM_NAV_ITEMS.map((item) => item.href),
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it("keeps every menu description to a single rendered line", () => {
    // The section panels are `w-[19rem]` with a 244px text column at
    // `text-xs`; measured in the browser, 40 characters is the last width
    // that still renders on one line. Two-line rows are what made the panels
    // tall and slow to scan, so the budget is a test, not a convention.
    for (const item of NAV_ITEMS) {
      expect(item.description ?? "", item.label).toBeTruthy();
      expect((item.description ?? "").length, item.label).toBeLessThanOrEqual(40);
    }
  });

  it("opens the mobile drawer as labeled headers now that the rail carries the hot routes", () => {
    expect(DEFAULT_EXPANDED).toEqual({
      markets: false,
      risk: false,
      tools: false,
      more: false,
    });
  });
});
