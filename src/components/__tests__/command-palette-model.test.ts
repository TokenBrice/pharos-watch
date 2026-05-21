import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteResultDescriptors,
  buildCommandPaletteActionDefinitions,
  COMMAND_PALETTE_PAGES,
  fuzzyMatch,
  groupCommandPaletteResults,
  rankCommandPaletteResults,
} from "@/components/command-palette-model";

describe("command palette model", () => {
  it("matches direct substrings and word prefixes", () => {
    expect(fuzzyMatch("usd", "USD Coin")).toBe(true);
    expect(fuzzyMatch("co", "USD Coin")).toBe(true);
    expect(fuzzyMatch("xyz", "USD Coin")).toBe(false);
  });

  it("builds theme-dependent action descriptors without UI handlers", () => {
    expect(buildCommandPaletteActionDefinitions(true)[0]).toMatchObject({
      id: "action-theme",
      actionId: "theme",
      label: "Switch to light mode",
      icon: "theme-light",
    });
    expect(buildCommandPaletteActionDefinitions(false)[0]).toMatchObject({
      label: "Switch to dark mode",
      icon: "theme-dark",
    });
  });

  it("groups results in render order and skips empty sections", () => {
    const groups = groupCommandPaletteResults([
      { section: "Actions" as const, id: "action" },
      { section: "Stablecoins" as const, id: "coin" },
    ]);

    expect(groups).toEqual([
      { section: "Stablecoins", items: [{ section: "Stablecoins", id: "coin" }] },
      { section: "Actions", items: [{ section: "Actions", id: "action" }] },
    ]);
  });

  it("demotes frozen entries on tied scores", () => {
    const ranked = rankCommandPaletteResults([
      { id: "frozen-coin", score: 5, status: "frozen" as const },
      { id: "active-coin", score: 5, status: "active" as const },
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["active-coin", "frozen-coin"]);
  });

  it("builds stablecoin, page, and action descriptors outside the component", () => {
    const stablecoinResults = buildCommandPaletteResultDescriptors({
      query: "usdt",
      history: [],
      isDark: false,
    });
    const pageAndActionResults = buildCommandPaletteResultDescriptors({
      query: "api",
      history: [],
      isDark: false,
    });

    expect(stablecoinResults.some((result) => result.section === "Stablecoins" && result.href?.includes("/stablecoin/"))).toBe(true);
    expect(pageAndActionResults.some((result) => result.section === "Pages" && result.href)).toBe(true);
    expect(pageAndActionResults.some((result) => result.section === "Actions" && result.actionId)).toBe(true);
  });

  it("ranks exact ticker matches before wrapped or suffixed symbols", () => {
    const cases = [
      { query: "USDC", href: "/stablecoin/usdc-circle/", label: "USD Coin" },
      { query: "usdt", href: "/stablecoin/usdt-tether/", label: "Tether" },
    ];

    for (const { query, href, label } of cases) {
      const [firstStablecoin] = buildCommandPaletteResultDescriptors({
        query,
        history: [],
        isDark: false,
      }).filter((result) => result.section === "Stablecoins");

      expect(firstStablecoin).toMatchObject({
        href,
        label,
        kind: "stablecoin",
      });
    }
  });

  it("keeps Start Here unique in the command palette route model", () => {
    expect(COMMAND_PALETTE_PAGES.filter((page) => page.href === "/start")).toHaveLength(1);

    const startResults = buildCommandPaletteResultDescriptors({
      query: "start",
      history: [],
      isDark: false,
    });
    expect(startResults.filter((result) => result.href === "/start")).toHaveLength(1);
  });

  it("covers important route-only pages in palette search", () => {
    const routeQueries = [
      { query: "privacy", href: "/privacy" },
      { query: "governance", href: "/stablecoins/governance" },
      { query: "backing", href: "/stablecoins/backing" },
      { query: "docs", href: "/docs" },
      { query: "pricing", href: "/methodology/pricing-pipeline-changelog" },
    ];

    for (const { query, href } of routeQueries) {
      const results = buildCommandPaletteResultDescriptors({
        query,
        history: [],
        isDark: false,
      });
      expect(results.some((result) => result.section === "Pages" && result.href === href)).toBe(true);
    }
  });
});
