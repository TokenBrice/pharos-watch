import { describe, expect, it, vi } from "vitest";
import { buildVerbPreview, clampCommandPaletteSelectedIndex, executeParsedVerb } from "@/components/command-palette/command-palette-actions";
import {
  buildCommandPaletteResultDescriptors,
  buildPopularStablecoinDescriptors,
  extractStablecoinIdFromPathname,
  groupCommandPaletteResults,
  rankCommandPaletteResults,
} from "@/components/command-palette/command-palette-model";
import { parsePaletteInput } from "@/lib/command-palette-verbs";
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
    // Select by the verdict the badge reads, not by a curated event slug; the ten newest published
    // events need not include a reviewed dispute, so add one when they don't.
    if (!events.some((event) => isDisputedAuditVerdict(event.auditVerdict))) {
      events.push({ ...events[0]!, slug: "test-disputed-2026-01-01", auditVerdict: "disputed" });
    }
    const disputedEvent = events.find((event) => isDisputedAuditVerdict(event.auditVerdict));
    const ordinaryEvent = events.find((event) => !isDisputedAuditVerdict(event.auditVerdict))!;

    const disputed = buildCommandPaletteResultDescriptors({ query: disputedEvent!.slug, history: [], isDark: false })
      .find((item) => item.id === `depeg-${disputedEvent!.slug}`);
    expect(disputed?.sublabel).toContain("Disputed");

    const ordinary = buildCommandPaletteResultDescriptors({ query: ordinaryEvent.slug, history: [], isDark: false })
      .find((item) => item.id === `depeg-${ordinaryEvent.slug}`);
    expect(ordinary?.sublabel).not.toContain("Disputed");
  });

  it("emits route-contextual actions on dossier routes and watchlist portfolio action", () => {
    expect(extractStablecoinIdFromPathname("/stablecoin/usdc-circle/")).toBe("usdc-circle");
    expect(extractStablecoinIdFromPathname("/stablecoin/nonexistent-coin/")).toBeNull();
    expect(extractStablecoinIdFromPathname("/yield/")).toBeNull();

    const groups = groupCommandPaletteResults(
      buildCommandPaletteResultDescriptors({
        query: "",
        history: [],
        isDark: false,
        watchlistCount: 1,
        watchlistIds: ["usdc-circle"],
        pathname: "/stablecoin/usdc-circle/",
      }),
    );

    expect(groups[0]?.section).toBe("This coin");
    expect(groups[0]?.items.map((item) => item.label)).toEqual([
      "Unwatch USDC",
      "Add USDC to Portfolio",
      "Compare USDC",
      "Alerts for USDC",
    ]);

    const actionsGroup = groups.find((group) => group.section === "Actions");
    expect(actionsGroup?.items.some((item) => item.actionId === "portfolio-watchlist")).toBe(true);
  });
});

describe("command palette action helpers", () => {
  const makeExecutor = () => ({
    push: vi.fn(), closePalette: vi.fn(), addToWatchlist: vi.fn(),
    removeFromWatchlist: vi.fn(), clearWatchlist: vi.fn(),
  });

  it("clamps selected index when the result set shrinks or empties", () => {
    expect(clampCommandPaletteSelectedIndex(4, 2)).toBe(1);
    expect(clampCommandPaletteSelectedIndex(1, 0)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(-1, 5)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(2, 5)).toBe(2);
  });

  it.each([
    ["screen safety>=80 safety>=90", true, 1],
    ["screen dews>=20 dews<=80", true, 2],
    ["screen type=invalid safety>=80", true, 1],
    ["screen safety>=0", false, 0],
    ["screen type=invalid", false, 0],
    ["screen dews>=80 dews<=20", false, 2],
    ["screen supply>=200 supply<=100", false, 2],
    ["screen safety>=110", false, 1],
  ])("previews only admitted constraints and never executes rejected bounds: %s", (input, runnable, count) => {
    const parsed = parsePaletteInput(input);
    const preview = buildVerbPreview(parsed);
    expect(preview?.runnable).toBe(runnable);
    const executor = makeExecutor();
    expect(executeParsedVerb(parsed, executor)).toBe(runnable);
    expect(executor.push).toHaveBeenCalledTimes(runnable ? 1 : 0);
    if (runnable) {
      expect(preview?.label).toBe(`Screen ${count} filter${count === 1 ? "" : "s"}`);
      if (parsed.kind !== "screen") throw new Error("expected screen");
      expect(Object.keys(parsed.filters)).toHaveLength(count);
      expect(executor.push).toHaveBeenCalledWith(parsed.href);
    } else if (parsed.kind === "screen" && parsed.error) {
      expect(preview?.sublabel).toBe(parsed.error);
    }
  });

  it("previews and executes portfolio and deep section intents", () => {
    const executor = makeExecutor();

    const portfolioParsed = parsePaletteInput("portfolio USDC USDT");
    expect(buildVerbPreview(portfolioParsed)).toMatchObject({ runnable: true, label: "Portfolio USDC, USDT" });
    expect(executeParsedVerb(portfolioParsed, executor)).toBe(true);
    expect(executor.push).toHaveBeenCalledWith("/portfolio/?coins=usdc-circle,usdt-tether");

    const sectionParsed = parsePaletteInput("usdc freeze");
    expect(buildVerbPreview(sectionParsed)).toMatchObject({ runnable: true, label: "USD Coin · Freeze & Seizure" });
    expect(executeParsedVerb(sectionParsed, executor)).toBe(true);
    expect(executor.push).toHaveBeenCalledWith("/stablecoin/usdc-circle/#freeze-seizure");
  });
});
