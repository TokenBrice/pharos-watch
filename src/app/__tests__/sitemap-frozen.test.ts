import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PUBLIC_ROUTE_PATHS } from "@/lib/public-route-inventory";
import sitemap from "../sitemap";
import digests from "../../../data/digests.json";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";
import { CHANGELOG_MONTH_ARCHIVES } from "@/lib/changelog-history";
import { getIndexableChainIds } from "@/lib/chain-indexing";
import { PEG_HUB_PAGES } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { DIGEST_ENTRIES } from "@/lib/digest-registry";
import { PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";
import sitemapDates from "@/generated/sitemap-dates.json";

const entries = sitemap();
const urls = new Set(entries.map((entry) => entry.url));
const entriesByUrl = new Map(entries.map((entry) => [entry.url, entry]));

describe("sitemap", () => {

  it("is the machine-readable projection of the canonical public route inventory", () => {
    const sitemapPaths = entries.map((entry) => new URL(entry.url).pathname).sort();
    expect(sitemapPaths).toEqual([...PUBLIC_ROUTE_PATHS].sort());
  });

  it("includes every history archive and the canonical Reference document", () => {
    for (const archive of [...METHODOLOGY_HISTORY_ARCHIVES, ...CHANGELOG_MONTH_ARCHIVES]) {
      expect(urls.has(`${SITE_ORIGIN}${archive.path}`), archive.path).toBe(true);
    }
    expect(urls.has(`${SITE_ORIGIN}/api/reference/`)).toBe(true);
  });

  it("emits a valid last-modified date for every URL", () => {
    for (const entry of entries) {
      expect(entry.lastModified, entry.url).toBeInstanceOf(Date);
      expect(Number.isFinite((entry.lastModified as Date).getTime()), entry.url).toBe(true);
    }
  });

  it("dates chain pages by their route edit, not the daily data snapshot", () => {
    const dates = sitemapDates as Record<string, string>;
    for (const chainId of getIndexableChainIds()) {
      const path = `/chains/${chainId}/`;
      expect(entriesByUrl.get(`${SITE_ORIGIN}${path}`)?.lastModified, path).toEqual(
        new Date(dates[path] ?? dates["/chains/"]),
      );
    }
  });

  it("dates client-fetch shells by their own route edit, not the depeg/digest clock", () => {
    const dates = sitemapDates as Record<string, string>;
    for (const path of [
      "/liquidity/",
      "/yield/",
      "/safety-scores/",
      "/safety-scores/map/",
      "/stability-index/",
      "/dependency-map/",
      "/status/",
      "/freezewatch/",
      "/chains/",
    ]) {
      expect(entriesByUrl.get(`${SITE_ORIGIN}${path}`)?.lastModified, path).toEqual(
        new Date(dates[path] ?? dates["/"]),
      );
    }
  });

  it("dates the digest hub by its newest publication", () => {
    const newestDigestMs = Math.max(...DIGEST_ENTRIES.map((digest) => digest.generatedAt * 1000));
    expect(entriesByUrl.get(`${SITE_ORIGIN}/digest/`)?.lastModified).toEqual(
      new Date(Math.max(new Date(sitemapDates["/digest/"]).getTime(), newestDigestMs)),
    );
  });

  it("dates the homepage by the top-stablecoins dataset the build baked", () => {
    const asOfMs = Date.parse(PUBLIC_DATASET_CURRENT_EXPORTS["top-stablecoins"]._meta.asOfISO);
    expect(entriesByUrl.get(`${SITE_ORIGIN}/`)?.lastModified).toEqual(
      new Date(Math.max(new Date(sitemapDates["/"]).getTime(), asOfMs)),
    );
  });

  it("includes every peg hub, pre-launch-only hubs included", () => {
    for (const page of PEG_HUB_PAGES) {
      expect(urls.has(`${SITE_ORIGIN}${page.href}`), page.href).toBe(true);
    }
  });

  it("dates generated peg hubs and taxonomy pages from their own family", () => {
    const dates = sitemapDates as Record<string, string>;
    for (const page of [...PEG_HUB_PAGES, ...ALL_STABLECOIN_TAXONOMY_PAGES]) {
      expect(entriesByUrl.get(`${SITE_ORIGIN}${page.href}`)?.lastModified, page.href).toEqual(
        new Date(dates[page.href] ?? dates["/stablecoins/"]),
      );
    }
  });

  it("includes every frozen detail page (TRACKED source preserves indexability)", () => {
    for (const id of FROZEN_IDS) {
      expect(urls.has(`${SITE_ORIGIN}${buildStablecoinUrl(id)}`)).toBe(true);
    }
  });

  it("lists weekly recaps and leaves every daily digest out", () => {
    for (const digest of digests) {
      const entry = entriesByUrl.get(`${SITE_ORIGIN}/digest/${digest.date}/`);
      if (digest.digestType !== "weekly") {
        expect(entry, digest.date).toBeUndefined();
        continue;
      }
      expect(entry, digest.date).toBeDefined();
      expect(entry?.lastModified).toEqual(new Date(digest.generatedAt * 1000));
      expect(entry?.changeFrequency).toBe("never");
    }
  });

});
