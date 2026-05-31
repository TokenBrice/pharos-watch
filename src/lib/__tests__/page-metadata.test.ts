import { describe, expect, it, vi } from "vitest";
import {
  buildPageMetadata,
  buildStablecoinDetailMetadata,
  getMarkdownAlternateForCanonical,
} from "@/lib/page-metadata";

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
    expect(getMarkdownAlternateForCanonical("/stablecoin/usdt-tether/")).toBe(
      "/stablecoin/usdt-tether/index.md",
    );
    expect(getMarkdownAlternateForCanonical("/methodology/scoring-changelog/")).toBe(
      "/methodology/scoring-changelog/index.md",
    );
    expect(getMarkdownAlternateForCanonical("/docs/api-reference/")).toBe(
      "/docs/api-reference/index.md",
    );
    expect(getMarkdownAlternateForCanonical("/changelog/")).toBe(
      "/changelog/index.md",
    );
    expect(getMarkdownAlternateForCanonical("/learn/glossary/")).toBeNull();
    expect(getMarkdownAlternateForCanonical("/stablecoin/not-a-coin/")).toBeNull();
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

describe("buildStablecoinDetailMetadata", () => {
  it("uses query-intent titles for live, pre-launch, and frozen detail pages", () => {
    const { active, preLaunch, frozen } = fixtures;
    const activeCoin = active as Parameters<typeof buildStablecoinDetailMetadata>[0];
    const preLaunchCoin = preLaunch as Parameters<typeof buildStablecoinDetailMetadata>[0];
    const frozenCoin = frozen as Parameters<typeof buildStablecoinDetailMetadata>[0];

    expect(buildStablecoinDetailMetadata(activeCoin).title).toBe(
      `${active.symbol} Stablecoin Risk Profile: Peg, Liquidity & Safety`,
    );
    expect(buildStablecoinDetailMetadata(preLaunchCoin).title).toBe(
      `${preLaunch.symbol} Stablecoin Launch Tracker & Profile`,
    );
    expect(buildStablecoinDetailMetadata(frozenCoin).title).toBe(
      `${frozen.symbol} Failed Stablecoin Archive & Timeline`,
    );
  });
});
