import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import sitemapDates from "@/generated/sitemap-dates.json";
import docsMetadata from "@/generated/docs-metadata.json";
import { changelogs } from "@/data/changelogs";
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

  it("stamps /changelog/ from the latest changelog entry, floored by its git edit date", () => {
    const entries = sitemap();
    const entry = entries.find((e) => e.url === `${SITE_ORIGIN}/changelog/`);
    const lastEdited = sitemapDates as Record<string, string>;
    const expected = new Date(
      Math.max(
        new Date(lastEdited["/changelog/"]).getTime(),
        ...changelogs.map((c) => new Date(c.dateRange.to).getTime()),
      ),
    );

    expect(entry?.lastModified).toEqual(expected);
    expect(Number.isNaN((entry?.lastModified as Date).getTime())).toBe(false);
  });

  it("stamps /docs/ from the newest public doc edit date, floored by its git edit date", () => {
    const entries = sitemap();
    const entry = entries.find((e) => e.url === `${SITE_ORIGIN}/docs/`);
    const lastEdited = sitemapDates as Record<string, string>;
    const metadata = docsMetadata as Record<string, { dateModified: string }>;
    const expected = new Date(
      Math.max(
        new Date(lastEdited["/docs/"]).getTime(),
        ...PUBLIC_DOCS.map((doc) => (metadata[doc.slug] ? new Date(metadata[doc.slug].dateModified).getTime() : 0)),
      ),
    );

    expect(entry?.lastModified).toEqual(expected);
    expect(Number.isNaN((entry?.lastModified as Date).getTime())).toBe(false);
  });
});
