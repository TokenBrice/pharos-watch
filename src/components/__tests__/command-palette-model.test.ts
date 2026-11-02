import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteResultDescriptors,
  buildPopularStablecoinDescriptors,
  groupCommandPaletteResults,
  rankCommandPaletteResults,
} from "@/components/command-palette-model";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import depegEventSearchData from "@/generated/depeg-event-search-data.json";

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
    // Expected order is the supplied market caps, descending.
    expect(ids).toEqual(
      [...stablecoinLiveMetadata]
        .sort(([, left], [, right]) => right.marketCapUsd - left.marketCapUsd)
        .map(([id]) => `coin-${id}`),
    );
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
    // The supplied market cap is the prominence signal: it carries the coin into the capped five
    // and orders every result that has live metadata.
    expect(order).toContain("/stablecoin/syrupusdc-maple/");
    const caps = results.map((result) => result.marketCapUsd).filter((cap): cap is number => cap != null);
    expect(caps).toEqual([...caps].sort((left, right) => right - left));
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
    const events = depegEventSearchData as Array<{ slug: string; auditVerdict?: string | null }>;
    // Select by the verdict the badge reads, not by a curated event slug.
    const disputedEvent = events.find((event) => isDisputedAuditVerdict(event.auditVerdict));
    expect(disputedEvent, "generated depeg search data carries a disputed verdict").toBeDefined();
    const ordinaryEvent = events.find((event) => !isDisputedAuditVerdict(event.auditVerdict))!;

    const disputed = buildCommandPaletteResultDescriptors({ query: disputedEvent!.slug, history: [], isDark: false })
      .find((item) => item.id === `depeg-${disputedEvent!.slug}`);
    expect(disputed?.sublabel).toContain("Disputed");

    const ordinary = buildCommandPaletteResultDescriptors({ query: ordinaryEvent.slug, history: [], isDark: false })
      .find((item) => item.id === `depeg-${ordinaryEvent.slug}`);
    expect(ordinary?.sublabel).not.toContain("Disputed");
  });
});
