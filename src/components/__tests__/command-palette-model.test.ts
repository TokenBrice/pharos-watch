import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteResultDescriptors,
  buildPopularStablecoinDescriptors,
  groupCommandPaletteResults,
  rankCommandPaletteResults,
} from "@/components/command-palette-model";

describe("command palette model", () => {
  it("orders coins in the same match tier by live market cap, not by extra name hits", () => {
    const stablecoinLiveMetadata = new Map([
      ["syrupusdc-maple", { marketCapUsd: 1_060_000_000 }],
      ["sirloinusdc-steakhouse", { marketCapUsd: 460_800_000 }],
      ["sparkusdc-spark", { marketCapUsd: 424_800_000 }],
    ]);
    const ids = buildCommandPaletteResultDescriptors({ query: "usdc", history: [], isDark: false, stablecoinLiveMetadata })
      .filter((row) => row.id === "coin-syrupusdc-maple" || row.id === "coin-sirloinusdc-steakhouse" || row.id === "coin-sparkusdc-spark")
      .map((row) => row.id);
    expect(ids).toEqual(["coin-syrupusdc-maple", "coin-sirloinusdc-steakhouse", "coin-sparkusdc-spark"]);
  });

  it("caps every ranked section for a one-letter query", () => {
    const groups = groupCommandPaletteResults(
      buildCommandPaletteResultDescriptors({
        query: "a",
        history: [],
        isDark: false,
        watchlistCount: 2,
      }),
    );

    expect(groups.find((group) => group.section === "Stablecoins")?.items).toHaveLength(5);
    expect(groups.find((group) => group.section === "Pages")?.items).toHaveLength(5);
    expect(groups.find((group) => group.section === "Actions")?.items).toHaveLength(5);
    expect(groups.every((group) => group.items.length <= 5)).toBe(true);
  });

  it("keeps exact ticker matches ahead of higher-prominence fuzzy matches", () => {
    const ranked = rankCommandPaletteResults([
      { id: "prefix-match", score: 200, exactSymbol: false },
      { id: "exact-match", score: 100, exactSymbol: true },
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["exact-match", "prefix-match"]);
  });

  it("uses live market cap prominence before capping stablecoin results", () => {
    const stablecoinLiveMetadata = new Map([
      ["syrupusdc-maple", { marketCapUsd: 100_000_000_000 }],
    ]);
    const results = buildCommandPaletteResultDescriptors({
      query: "USDC",
      history: [],
      isDark: false,
      stablecoinLiveMetadata,
    }).filter((result) => result.section === "Stablecoins");
    const order = results.map((result) => result.href ?? "");

    expect(results).toHaveLength(5);
    expect(order).toContain("/stablecoin/syrupusdc-maple/");
    expect(order).toContain("/stablecoin/gtusdcp-gauntlet/");
    expect(order.indexOf("/stablecoin/syrupusdc-maple/")).toBeLessThan(
      order.indexOf("/stablecoin/gtusdcp-gauntlet/"),
    );
    expect(results.find((result) => result.href === "/stablecoin/syrupusdc-maple/")).toMatchObject({
      marketCapUsd: 100_000_000_000,
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

  it("floats exact-intent pages above coin substring matches", () => {
    const pageIntentQueries = [
      { query: "api", href: "/api/", label: "API" },
      { query: "yield", href: "/yield/", label: "Yield Intelligence" },
      { query: "depeg", href: "/depeg/", label: "Depeg & Recovery" },
      { query: "psi", href: "/stability-index/", label: "Stability Index" },
      { query: "mica", href: "/compliance/", label: "Compliance" },
    ];

    for (const { query, href, label } of pageIntentQueries) {
      const groups = groupCommandPaletteResults(
        buildCommandPaletteResultDescriptors({ query, history: [], isDark: false }),
      );
      const first = groups[0]?.items[0];

      expect(first, `first result for "${query}"`).toMatchObject({
        section: "Pages",
        href,
        label,
        lead: true,
      });
    }
  });

  it("keeps a reviewed dispute's badge on its recent-depeg row", () => {
    const disputed = buildCommandPaletteResultDescriptors({ query: "eurm", history: [], isDark: false })
      .find((item) => item.id === "depeg-eurm-2026-08-12");
    expect(disputed?.sublabel).toContain("Disputed");

    const ordinary = buildCommandPaletteResultDescriptors({ query: "lusd", history: [], isDark: false })
      .find((item) => item.id === "depeg-lusd-2026-10-29");
    expect(ordinary?.sublabel).not.toContain("Disputed");
  });
});
