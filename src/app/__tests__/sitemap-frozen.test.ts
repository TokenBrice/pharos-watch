import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import sitemapDates from "@/generated/sitemap-dates.json";
import docsMetadata from "@/generated/docs-metadata.json";
import { changelogs } from "@/data/changelogs";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { buildStablecoinUrl } from "@/lib/urls";
import { CASE_STUDY_LIST } from "@/app/learn/case-studies/content";
import sitemap, { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "../sitemap";
import digests from "../../../data/digests.json";
import {
  COLLIDING_DEPEG_EVENT_SLUGS,
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
  DEPEG_EVENT_ENTRIES,
} from "@/app/depeg/[event]/page-data";

describe("sitemap", () => {
  it("emits each canonical URL exactly once", () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(new Set(urls).size).toBe(urls.length);
  });

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

  it("lists every digest detail page as durable archive content", () => {
    const entries = sitemap();
    const entriesByUrl = new Map(entries.map((entry) => [entry.url, entry]));

    for (const digest of digests) {
      const entry = entriesByUrl.get(`${SITE_ORIGIN}/digest/${digest.date}/`);

      expect(entry).toBeDefined();
      expect(entry?.lastModified).toEqual(new Date(digest.generatedAt * 1000));
      expect(entry?.changeFrequency).toBe("never");
    }
  });

  it("marks only collision-differentiated depeg pages with the reviewed content revision", () => {
    const entriesByUrl = new Map(sitemap().map((entry) => [entry.url, entry]));
    const collision = DEPEG_EVENT_ENTRIES.find((event) =>
      COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug),
    );
    const ordinary = DEPEG_EVENT_ENTRIES.find(
      (event) => !COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug),
    );

    expect(collision).toBeDefined();
    expect(ordinary).toBeDefined();
    expect(entriesByUrl.get(`${SITE_ORIGIN}/depeg/${collision!.slug}/`)?.lastModified).toEqual(
      new Date(
        Math.max(
          collision!.endedAt ?? collision!.startedAt,
          DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
        ) * 1000,
      ),
    );
    expect(entriesByUrl.get(`${SITE_ORIGIN}/depeg/${ordinary!.slug}/`)?.lastModified).toEqual(
      new Date((ordinary!.endedAt ?? ordinary!.startedAt) * 1000),
    );
  });

  it("stamps every case-study detail page from generated per-study dates", () => {
    const entries = sitemap();
    const entriesByUrl = new Map(entries.map((entry) => [entry.url, entry]));
    const lastEdited = sitemapDates as Record<string, string>;

    expect(entriesByUrl.get(`${SITE_ORIGIN}/learn/`)?.lastModified).toEqual(new Date(lastEdited["/learn/"]));

    for (const study of CASE_STUDY_LIST) {
      const path = `/learn/case-studies/${study.slug}/`;
      expect(lastEdited[path], `missing generated date for ${path}`).toBeDefined();
      expect(entriesByUrl.get(`${SITE_ORIGIN}${path}`)?.lastModified).toEqual(new Date(lastEdited[path]));
    }
  });

  it("includes every mechanism explainer route", () => {
    const urls = new Set(sitemap().map((entry) => entry.url));
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(urls.has(`${SITE_ORIGIN}/learn/mechanisms/${archetype}/`)).toBe(true);
    }
  });

  it("uses an explicit sitemap allowlist for methodology changelog pages", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));

    for (const path of METHODOLOGY_CHANGELOG_SITEMAP_PATHS) {
      expect(urls.has(`${SITE_ORIGIN}${path}`)).toBe(true);
    }
  });
});
