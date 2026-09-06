import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import sitemapDates from "@/generated/sitemap-dates.json";
import docsMetadata from "@/generated/docs-metadata.json";
import { changelogs } from "@/data/changelogs";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PUBLIC_ROUTE_PATHS } from "@/lib/public-route-inventory";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import sitemap, { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "../sitemap";
import digests from "../../../data/digests.json";
import aiSummaries from "../../../data/ai-summaries.json";
import {
  COLLIDING_DEPEG_EVENT_SLUGS,
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
  DEPEG_EVENT_ENTRIES,
} from "@/lib/depeg-event-page-data";

describe("sitemap", () => {
  it("emits each canonical URL exactly once", () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(new Set(urls).size).toBe(urls.length);
  });

  it("is the machine-readable projection of the canonical public route inventory", () => {
    const sitemapPaths = sitemap().map((entry) => new URL(entry.url).pathname).sort();
    expect(sitemapPaths).toEqual([...PUBLIC_ROUTE_PATHS].sort());
  });

  it("preserves the frozen URL, frequency, and priority policy for public hubs", () => {
    const expected = [
      ["/", "hourly", 1], ["/coverage/", "weekly", 0.6], ["/alt-pegs/", "daily", 0.7],
      ["/start/", "monthly", 0.6], ["/freezewatch/", "daily", 0.85], ["/depeg/", "daily", 0.8],
      ["/cemetery/", "monthly", 0.7], ["/compare/", "weekly", 0.7], ["/liquidity/", "daily", 0.8],
      ["/upcoming/", "daily", 0.6], ["/digest/", "daily", 0.6], ["/safety-scores/", "daily", 0.8],
      ["/safety-scores/map/", "daily", 0.6], ["/stability-index/", "daily", 0.8],
      ["/dependency-map/", "daily", 0.7], ["/yield/", "daily", 0.7], ["/screener/", "daily", 0.7],
      ["/funding/", "weekly", 0.5], ["/status/", "daily", 0.4], ["/flows/", "daily", 0.7],
      ["/timeline/", "hourly", 0.75], ["/compliance/", "weekly", 0.6],
      ["/pharoswatchbot/", "weekly", 0.7], ["/methodology/", "monthly", 0.6],
      ["/changelog/", "weekly", 0.5], ["/blog/", "weekly", 0.6], ["/about/", "monthly", 0.5],
      ["/about/api/", "monthly", 0.5], ["/about/bluechip/", "monthly", 0.5],
      ["/depeg/archive/", "monthly", 0.5], ["/learn/", "monthly", 0.5],
      ["/learn/glossary/", "monthly", 0.5],
      ["/sitemap-tree/", "monthly", 0.3], ["/api/", "monthly", 0.5],
      ["/stablecoins/", "weekly", 0.7], ["/stablecoins/backing/", "weekly", 0.6],
      ["/stablecoins/governance/", "weekly", 0.6], ["/stablecoins/infrastructure/", "weekly", 0.6],
      ["/privacy/", "yearly", 0.3], ["/docs/", "monthly", 0.6],
    ];
    const byPath = new Map(sitemap().map((entry) => [new URL(entry.url).pathname, entry]));

    expect(expected.map(([path]) => [
      path,
      byPath.get(path as string)?.changeFrequency,
      byPath.get(path as string)?.priority,
    ])).toEqual(expected);
  });

  it("emits a valid last-modified date for every URL", () => {
    for (const entry of sitemap()) {
      expect(entry.lastModified, entry.url).toBeInstanceOf(Date);
      expect(Number.isFinite((entry.lastModified as Date).getTime()), entry.url).toBe(true);
    }
  });

  it("includes every frozen detail page (TRACKED source preserves indexability)", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));
    for (const id of FROZEN_IDS) {
      expect(urls.has(`${SITE_ORIGIN}${buildStablecoinUrl(id)}`)).toBe(true);
    }
  });

  it("advances only the edited profile for a summary-only content update", () => {
    const summary = aiSummaries["sgho-aave"];
    const originalDate = summary.updatedAt;
    const before = sitemap();
    const targetUrl = `${SITE_ORIGIN}${buildStablecoinUrl("sgho-aave")}`;
    const laterDate = new Date(Math.max(...before.map((entry) => (entry.lastModified as Date).getTime())) + 86_400_000);

    try {
      summary.updatedAt = laterDate.toISOString();
      const after = sitemap();
      expect(after.find((entry) => entry.url === targetUrl)?.lastModified).toEqual(laterDate);
      expect(after.filter((entry) => entry.url !== targetUrl)).toEqual(before.filter((entry) => entry.url !== targetUrl));
    } finally {
      summary.updatedAt = originalDate;
    }
  });

  it.each(["", "not-a-date", "2000-01-01"])("keeps the Git date floor for an unusable or older summary date: %s", (date) => {
    const summary = aiSummaries["sgho-aave"];
    const originalDate = summary.updatedAt;
    const path = buildStablecoinUrl("sgho-aave");
    try {
      summary.updatedAt = date;
      expect(sitemap().find((entry) => entry.url === `${SITE_ORIGIN}${path}`)?.lastModified).toEqual(
        new Date((sitemapDates as Record<string, string>)[path]),
      );
    } finally {
      summary.updatedAt = originalDate;
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

  it("includes substantive editorial dates in enriched comparison lastmod", () => {
    const entries = new Map(sitemap().map((entry) => [entry.url, entry]));
    const lastEdited = sitemapDates as Record<string, string>;
    for (const pair of STATIC_COMPARISON_PAGES.filter((page) => page.editorial)) {
      expect(entries.get(`${SITE_ORIGIN}${pair.href}`)?.lastModified).toEqual(new Date(Math.max(
        new Date(lastEdited[buildStablecoinUrl(pair.left.id)]).getTime(),
        new Date(lastEdited[buildStablecoinUrl(pair.right.id)]).getTime(),
        new Date(pair.editorial!.updatedAt).getTime(),
      )));
    }
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
    const entries = new Map(sitemap().map((entry) => [entry.url, entry]));
    const mechanismDate = new Date((sitemapDates as Record<string, string>)["/learn/mechanisms/"]);
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      const entry = entries.get(`${SITE_ORIGIN}/learn/mechanisms/${archetype}/`);
      expect(entry).toBeDefined();
      expect(entry?.lastModified).toEqual(mechanismDate);
    }
  });

  it("uses generated content dates instead of deploy time for unmapped dynamic routes", () => {
    const entries = new Map(sitemap().map((entry) => [entry.url, entry]));
    const generatedDates = sitemapDates as Record<string, string>;

    expect(entries.get(`${SITE_ORIGIN}/chains/ethereum/`)?.lastModified).toEqual(
      new Date(
        Math.max(
          new Date(generatedDates["/chains/"]).getTime(),
          ...digests.map((digest) => digest.generatedAt * 1000),
          ...DEPEG_EVENT_ENTRIES.map((event) => (event.endedAt ?? event.startedAt) * 1000),
        ),
      ),
    );
    expect(entries.get(`${SITE_ORIGIN}/stablecoins/usd/`)?.lastModified).toEqual(
      new Date(generatedDates["/stablecoins/"]),
    );
  });

  it("uses an explicit sitemap allowlist for methodology changelog pages", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));

    for (const path of METHODOLOGY_CHANGELOG_SITEMAP_PATHS) {
      expect(urls.has(`${SITE_ORIGIN}${path}`)).toBe(true);
    }
  });
});
