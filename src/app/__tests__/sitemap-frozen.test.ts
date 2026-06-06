import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import sitemapDates from "@/generated/sitemap-dates.json";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { buildStablecoinUrl } from "@/lib/urls";
import sitemap from "../sitemap";

describe("sitemap", () => {
  it("includes every frozen detail page (TRACKED source preserves indexability)", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));
    for (const id of FROZEN_IDS) {
      expect(urls.has(`${SITE_ORIGIN}${buildStablecoinUrl(id)}`)).toBe(true);
    }
  });

  it("lists the canonical compliance route and omits the retired MiCA route", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));

    expect(urls.has(`${SITE_ORIGIN}/compliance/`)).toBe(true);
    expect(urls.has(`${SITE_ORIGIN}/mica/`)).toBe(false);
  });

  it("includes the compare hub and derives pair lastmod from both detail pages", () => {
    const entries = sitemap();
    const entriesByUrl = new Map(entries.map((entry) => [entry.url, entry]));
    const lastEdited = sitemapDates as Record<string, string>;
    const hubEntry = entriesByUrl.get(`${SITE_ORIGIN}/compare/`);
    const pair = STATIC_COMPARISON_PAGES.find((page) => page.slug === "usdt-tether-vs-usdc-circle");

    expect(hubEntry?.lastModified).toEqual(new Date(lastEdited["/compare/"]));
    expect(pair).toBeDefined();

    const leftPath = buildStablecoinUrl(pair!.left.id);
    const rightPath = buildStablecoinUrl(pair!.right.id);
    const expectedPairLastModified = new Date(
      Math.max(new Date(lastEdited[leftPath]).getTime(), new Date(lastEdited[rightPath]).getTime()),
    );

    expect(entriesByUrl.get(`${SITE_ORIGIN}${pair!.href}`)?.lastModified).toEqual(expectedPairLastModified);
  });
});
