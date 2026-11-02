import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/home-alt-client", () => ({ HomeAltClient: () => null }));
vi.mock("@/components/home-alt-hero", () => ({ HomeAltHero: () => null }));
vi.mock("@/components/home-blog-banner", () => ({ HomeBlogBanner: () => null }));
vi.mock("@/components/home-media-strip", () => ({ HomeMediaStrip: () => null }));
vi.mock("@/lib/homepage-static-snapshot", () => ({ getHomepageHeroSnapshot: vi.fn(async () => null) }));
vi.mock("@/lib/homepage-evidence", () => ({
  HomepageEvidenceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/page-metadata", () => ({
  buildPageMetadata: () => ({}),
  buildLiveRouteOgImageUrl: () => undefined,
}));

import HomePage from "@/app/page";

describe("homepage ItemList JSON-LD", () => {
  it("publishes a bounded, unordered core directory instead of a market-cap ranking", async () => {
    const html = renderToStaticMarkup(await HomePage());
    const scripts = Array.from(
      html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs),
      (match) => JSON.parse(match[1]) as Record<string, unknown> | Record<string, unknown>[],
    ).flatMap((parsed) => (Array.isArray(parsed) ? parsed : [parsed]));
    const itemList = scripts.find((node) => node["@type"] === "ItemList");
    expect(itemList).toBeDefined();

    const name = String(itemList?.name);
    expect(name).not.toMatch(/Top \d+ .* by Market Cap/i);
    expect(name).toBe("20 Core Stablecoins Tracked by Pharos");
    expect(itemList?.itemListOrder).toBe("https://schema.org/ItemListUnordered");
    expect(itemList?.numberOfItems).toBe((itemList?.itemListElement as unknown[]).length);
  });
});
