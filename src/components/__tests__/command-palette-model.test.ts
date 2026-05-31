import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteResultDescriptors,
  buildCommandPaletteActionDefinitions,
  buildPopularStablecoinDescriptors,
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

  it("keeps exact ticker matches ahead of higher-prominence fuzzy matches", () => {
    const ranked = rankCommandPaletteResults([
      { id: "prefix-match", score: 200, exactSymbol: false },
      { id: "exact-match", score: 100, exactSymbol: true },
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["exact-match", "prefix-match"]);
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

  it("floats the canonical asset and major vaults above obscure same-substring wrappers", () => {
    const order = buildCommandPaletteResultDescriptors({
      query: "USDC",
      history: [],
      isDark: false,
    })
      .filter((result) => result.section === "Stablecoins")
      .map((result) => result.href ?? "");

    const usdCoin = order.indexOf("/stablecoin/usdc-circle/");
    const sparkVault = order.indexOf("/stablecoin/susdc-spark/");
    const movementUsdcx = order.indexOf("/stablecoin/usdcx-movement/");

    expect(usdCoin).toBe(0);
    // Prominence keeps the large Spark USDC vault above the negligible
    // "Movement USDCx" wrapper even though the wrapper scores a symbol prefix.
    expect(sparkVault).toBeGreaterThan(-1);
    expect(movementUsdcx).toBeGreaterThan(-1);
    expect(sparkVault).toBeLessThan(movementUsdcx);
  });

  it("uses live market cap prominence when live metadata is available", () => {
    const stablecoinLiveMetadata = new Map([
      ["syrupusdc-maple", { marketCapUsd: 1_400_000_000 }],
      ["usdcx-movement", { marketCapUsd: 2_300_000 }],
    ]);
    const results = buildCommandPaletteResultDescriptors({
      query: "USDC",
      history: [],
      isDark: false,
      stablecoinLiveMetadata,
    }).filter((result) => result.section === "Stablecoins");
    const order = results.map((result) => result.href ?? "");

    expect(order.indexOf("/stablecoin/syrupusdc-maple/")).toBeLessThan(
      order.indexOf("/stablecoin/usdcx-movement/"),
    );
    expect(results.find((result) => result.href === "/stablecoin/syrupusdc-maple/")).toMatchObject({
      marketCapUsd: 1_400_000_000,
    });
  });

  it("projects live metadata onto popular stablecoin descriptors", () => {
    const [result] = buildPopularStablecoinDescriptors(
      ["susds-sky"],
      new Map([["susds-sky", { marketCapUsd: 6_200_000_000, health: { kind: "nav" } }]]),
    );

    expect(result).toMatchObject({
      href: "/stablecoin/susds-sky/",
      marketCapUsd: 6_200_000_000,
      stablecoinHealth: { kind: "nav" },
    });
  });

  it("keeps Start Here unique in the command palette route model", () => {
    expect(COMMAND_PALETTE_PAGES.filter((page) => page.href === "/start/")).toHaveLength(1);

    const startResults = buildCommandPaletteResultDescriptors({
      query: "start",
      history: [],
      isDark: false,
    });
    expect(startResults.filter((result) => result.href === "/start/")).toHaveLength(1);
  });

  it("covers important route-only pages in palette search", () => {
    const routeQueries = [
      { query: "privacy", href: "/privacy/" },
      { query: "governance", href: "/stablecoins/governance/" },
      { query: "compliance", href: "/compliance/" },
      { query: "backing", href: "/stablecoins/backing/" },
      { query: "docs", href: "/docs/" },
      { query: "pricing", href: "/methodology/pricing-pipeline-changelog/" },
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
