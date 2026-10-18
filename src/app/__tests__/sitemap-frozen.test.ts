import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PUBLIC_ROUTE_PATHS } from "@/lib/public-route-inventory";
import { DAILY_DIGEST_INDEX_WINDOW_SEC } from "@/lib/digest-registry";
import sitemap from "../sitemap";
import digests from "../../../data/digests.json";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";
import { CHANGELOG_MONTH_ARCHIVES } from "@/lib/changelog-history";

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

  it("includes every frozen detail page (TRACKED source preserves indexability)", () => {
    for (const id of FROZEN_IDS) {
      expect(urls.has(`${SITE_ORIGIN}${buildStablecoinUrl(id)}`)).toBe(true);
    }
  });

  it("lists weekly recaps and recent daily digests, leaving older dailies out", () => {
    const newestGeneratedAt = Math.max(...digests.map((digest) => digest.generatedAt));
    for (const digest of digests) {
      const entry = entriesByUrl.get(`${SITE_ORIGIN}/digest/${digest.date}/`);
      const indexable = digest.digestType === "weekly"
        || newestGeneratedAt - digest.generatedAt <= DAILY_DIGEST_INDEX_WINDOW_SEC;

      if (!indexable) {
        expect(entry, digest.date).toBeUndefined();
        continue;
      }
      expect(entry, digest.date).toBeDefined();
      expect(entry?.lastModified).toEqual(new Date(digest.generatedAt * 1000));
      expect(entry?.changeFrequency).toBe("never");
    }
  });

});
