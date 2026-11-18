import digests from "../../data/digests.json";
import {
  DigestStoredSnapshotSchema,
  type DigestContentEntry,
} from "@shared/types/digest";

function compareDigestEntries(left: DigestContentEntry, right: DigestContentEntry): number {
  return right.generatedAt - left.generatedAt || right.date.localeCompare(left.date);
}

/** Checked-in digest artifacts, normalized once into deterministic newest-first order. */
export const DIGEST_ENTRIES: readonly DigestContentEntry[] = Object.freeze(
  DigestStoredSnapshotSchema.parse(digests).sort(compareDigestEntries),
);

export const DIGEST_BY_DATE: ReadonlyMap<string, DigestContentEntry> = new Map(
  DIGEST_ENTRIES.map((entry) => [entry.date, entry]),
);

export const DIGEST_CORRECTIONS: ReadonlyMap<string, { date: string; text: string; excerpt: string }> = new Map([
  ["2026-03-01", {
    date: "2026-11-18",
    text: "The two KAU readings (events 76764 and 76716) and one KAG reading (event 76729) came from comparisons against closed gold and silver reference markets. Pharos removed all three events in the November 16, 2026 archive refresh and retracts this edition’s description of them as market volatility.",
    excerpt: "Pharos retracted two KAU depeg claims and one KAG claim that used closed metal markets.",
  }],
]);

export const DIGEST_DATES: ReadonlySet<string> = new Set(DIGEST_BY_DATE.keys());

/**
 * Weekly recaps are the indexable digest unit. Daily editions stay live (and in
 * the archive) but serve `noindex, follow` from publication and never enter the
 * sitemap: Search Console left most of them crawled but not indexed, and a
 * rolling index window made every edition flip from index to noindex
 * (2026-10-25 SEO plan, NQ6).
 */
export function isDigestIndexable(entry: DigestContentEntry): boolean {
  return entry.digestType === "weekly";
}

export const INDEXABLE_DIGEST_ENTRIES: readonly DigestContentEntry[] = Object.freeze(
  DIGEST_ENTRIES.filter(isDigestIndexable),
);

export const LATEST_DAILY_DIGEST =
  DIGEST_ENTRIES.find((entry) => (entry.digestType ?? "daily") !== "weekly") ?? DIGEST_ENTRIES[0];
