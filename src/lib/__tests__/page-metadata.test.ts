import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPageMetadata,
  buildStablecoinDetailMetadata,
  getMarkdownAlternateForCanonical,
} from "@/lib/page-metadata";
import digests from "../../../data/digests.json";

const fixtures = vi.hoisted(() => {
  const active = {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    status: "active",
    flags: {
      governance: "centralized",
      pegCurrency: "USD",
      backing: "rwa-backed",
      rwa: true,
      yieldBearing: false,
    },
  };
  const preLaunch = {
    id: "fiusd-fiserv",
    name: "FIUSD",
    symbol: "FIUSD",
    status: "pre-launch",
    flags: {
      governance: "centralized",
      pegCurrency: "USD",
      backing: "rwa-backed",
      rwa: true,
      yieldBearing: false,
    },
  };
  const frozen = {
    id: "usnd-nerite",
    name: "Nerite USD",
    symbol: "USND",
    status: "frozen",
    frozenAt: "2026-05-01",
    obituary: { epitaph: "Archived after effective abandonment." },
    flags: {
      governance: "decentralized",
      pegCurrency: "USD",
      backing: "crypto-backed",
      rwa: false,
      yieldBearing: false,
    },
  };

  return {
    active,
    preLaunch,
    frozen,
    metaById: new Map([
      [active.id, active],
      [preLaunch.id, preLaunch],
      [frozen.id, frozen],
    ]),
  };
});

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: fixtures.metaById,
}));

vi.mock("@/lib/blacklist-status", () => ({
  getResolvedBlacklistStatus: () => null,
}));

describe("buildPageMetadata", () => {
  it("emits explicit Twitter card title and description metadata", () => {
    const metadata = buildPageMetadata({
      title: "Coverage Matrix",
      description: "Feature coverage across tracked stablecoins.",
      canonical: "/coverage/",
      ogImage: "/og-coverage.png",
    });

    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Coverage Matrix",
      description: "Feature coverage across tracked stablecoins.",
      images: [{ url: "/og-coverage.png", width: 1200, height: 628 }],
    });
  });

  it("adds markdown alternates only for generated markdown route families", () => {
    expect(getMarkdownAlternateForCanonical("/stablecoin/usdt-tether/")).toBe("/stablecoin/usdt-tether/index.md");
    expect(getMarkdownAlternateForCanonical("/methodology/scoring-changelog/")).toBe(
      "/methodology/scoring-changelog/index.md",
    );
    expect(getMarkdownAlternateForCanonical("/docs/api-reference/")).toBe("/docs/api-reference/index.md");
    expect(getMarkdownAlternateForCanonical("/changelog/")).toBe("/changelog/index.md");
    expect(getMarkdownAlternateForCanonical("/learn/glossary/")).toBeNull();
    expect(getMarkdownAlternateForCanonical("/stablecoin/not-a-coin/")).toBeNull();
  });

  it("advertises digest archive markdown alternates for known dates only", () => {
    const knownDigestDate = (digests as readonly { date: string }[])[0].date;

    expect(getMarkdownAlternateForCanonical(`/digest/${knownDigestDate}/`)).toBe(
      `/digest/${knownDigestDate}/index.md`,
    );
    expect(getMarkdownAlternateForCanonical("/digest/1999-01-01/")).toBeNull();
  });

  it("places markdown alternates under metadata alternates.types", () => {
    const metadata = buildPageMetadata({
      title: "API Reference",
      description: "HTTP contracts and response conventions.",
      canonical: "/docs/api-reference/",
    });

    expect(metadata.alternates).toMatchObject({
      canonical: "/docs/api-reference/",
      types: {
        "text/markdown": [
          {
            title: "API Reference (Markdown)",
            url: "/docs/api-reference/index.md",
          },
        ],
      },
    });
  });
});

describe("METHODOLOGY_MARKDOWN_PATHS coverage", () => {
  it("covers every on-disk methodology sub-route and the base /methodology/ path", () => {
    // Derive slugs from the Next.js app-router directories under src/app/methodology/.
    // Any new changelog route must be present in the explicit Set or this test fails.
    const methodologyDir = join(process.cwd(), "src/app/methodology");
    const slugs = readdirSync(methodologyDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("(") && d.name !== "sections")
      .map((d) => `/methodology/${d.name}/`);

    // Base path must always be present
    const allPaths = ["/methodology/", ...slugs];

    for (const path of allPaths) {
      expect(
        getMarkdownAlternateForCanonical(path),
        `missing methodology path: ${path}`,
      ).toBe(`${path}index.md`);
    }
  });
});

describe("buildStablecoinDetailMetadata", () => {
  it("uses query-intent titles for live, pre-launch, and frozen detail pages", () => {
    const { active, preLaunch, frozen } = fixtures;
    const activeCoin = active as Parameters<typeof buildStablecoinDetailMetadata>[0];
    const preLaunchCoin = preLaunch as Parameters<typeof buildStablecoinDetailMetadata>[0];
    const frozenCoin = frozen as Parameters<typeof buildStablecoinDetailMetadata>[0];

    expect(buildStablecoinDetailMetadata(activeCoin).title).toBe(
      `${active.symbol} (${active.name}) Stablecoin Safety Score & Risk Profile`,
    );
    // FIUSD carries the same name and symbol — the parenthetical is dropped
    // instead of rendering a redundant "FIUSD (FIUSD)".
    expect(buildStablecoinDetailMetadata(preLaunchCoin).title).toBe(
      `${preLaunch.symbol} Stablecoin Launch Tracker & Profile`,
    );
    expect(buildStablecoinDetailMetadata(frozenCoin).title).toBe(
      `${frozen.symbol} (${frozen.name}) Failed Stablecoin Archive`,
    );
  });

  it("drops the redundant parenthetical and counts chains in active descriptions", () => {
    const coin = {
      ...fixtures.active,
      name: "pmUSD",
      symbol: "pmUSD",
      contracts: [
        { chain: "ethereum", address: "0x1", decimals: 18 },
        { chain: "base", address: "0x2", decimals: 18 },
        { chain: "base", address: "0x3", decimals: 6 },
      ],
    } as Parameters<typeof buildStablecoinDetailMetadata>[0];

    const metadata = buildStablecoinDetailMetadata(coin);
    expect(metadata.title).toBe("pmUSD Stablecoin Safety Score & Risk Profile");
    expect(metadata.description).not.toContain("pmUSD (pmUSD)");
    expect(metadata.description).not.toContain("for pmUSD");
    // Two distinct chains — the duplicate base deployment counts once.
    expect(metadata.description).toContain("on 2 chains");
  });

  it("uses static OG cards for pre-launch and policy-withheld records", () => {
    const { active, preLaunch, frozen } = fixtures;
    const quarantined = { ...active, status: "quarantined" };
    const delisted = { ...active, status: "delisted" };
    const ogUrl = (coin: unknown) => {
      const metadata = buildStablecoinDetailMetadata(coin as Parameters<typeof buildStablecoinDetailMetadata>[0]);
      const images = metadata.openGraph?.images as Array<{ url: string }>;
      return images[0].url;
    };

    // Pre-launch ids are outside the worker's READABLE_IDS set, so the
    // dynamic card 404s — the metadata must not reference it.
    expect(ogUrl(preLaunch)).toBe("/og-upcoming.png");
    expect(ogUrl(quarantined)).toBe("/og-stablecoins.png");
    expect(ogUrl(delisted)).toBe("/og-stablecoins.png");
    expect(ogUrl(active)).toBe(`https://api.pharos.watch/api/og/stablecoin/${active.id}`);
    expect(ogUrl(frozen)).toBe(`https://api.pharos.watch/api/og/stablecoin/${frozen.id}`);
  });

  it("falls back to symbol-led stablecoin titles when names are too long for snippets", () => {
    const longNameCoin = {
      ...fixtures.active,
      name: "A Very Long Protocol-Issued Stablecoin With Governance Extensions",
      symbol: "LONG",
    } as Parameters<typeof buildStablecoinDetailMetadata>[0];

    expect(buildStablecoinDetailMetadata(longNameCoin).title).toBe(
      "LONG Stablecoin Risk Profile: Peg, Liquidity & Safety",
    );
  });
});
