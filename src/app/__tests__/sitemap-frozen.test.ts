import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import sitemapDates from "@/generated/sitemap-dates.json";
import docsMetadata from "@/generated/docs-metadata.json";
import { changelogs } from "@/data/changelogs";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { buildStablecoinUrl } from "@/lib/urls";
import sitemap, {
  DIGEST_DAILY_SITEMAP_LIMIT,
  METHODOLOGY_CHANGELOG_SITEMAP_PATHS,
  selectSitemapDigestEntries,
} from "../sitemap";

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

  it("promotes weekly digests plus a bounded newest-daily digest slice", () => {
    const weekly = { date: "2026-01-01-weekly", generatedAt: 1_767_264_000, digestType: "weekly" as const };
    const daily = Array.from({ length: DIGEST_DAILY_SITEMAP_LIMIT + 2 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      generatedAt: 1_767_264_001 + index,
      digestType: "daily" as const,
    }));

    const selected = selectSitemapDigestEntries([weekly, ...daily]);

    expect(selected).toHaveLength(DIGEST_DAILY_SITEMAP_LIMIT + 1);
    expect(selected.map((entry) => entry.date)).toContain(weekly.date);
    expect(selected.map((entry) => entry.date)).toContain("2026-01-16");
    expect(selected.map((entry) => entry.date)).toContain("2026-01-03");
    expect(selected.map((entry) => entry.date)).not.toContain("2026-01-02");
    expect(selected.map((entry) => entry.date)).not.toContain("2026-01-01");
  });

  it("uses an explicit sitemap allowlist for methodology changelog pages", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));

    for (const path of METHODOLOGY_CHANGELOG_SITEMAP_PATHS) {
      expect(urls.has(`${SITE_ORIGIN}${path}`)).toBe(true);
    }
  });
});
