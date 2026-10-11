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

export const DIGEST_DATES: ReadonlySet<string> = new Set(DIGEST_BY_DATE.keys());

/** Daily editions stay indexable for this long; weekly recaps stay indexable forever. */
export const DAILY_DIGEST_INDEX_WINDOW_SEC = 30 * 86_400;

/**
 * Age is measured from the newest checked-in edition, not the wall clock, so
 * the sitemap and robots metadata stay deterministic for one digest snapshot.
 * Digests are refreshed into the build daily, so this tracks build time.
 */
const DIGEST_INDEX_REFERENCE_SEC = DIGEST_ENTRIES[0]?.generatedAt ?? 0;

/** Older daily pages stay live (and in the archive) but leave the index and sitemap. */
export function isDigestIndexable(entry: DigestContentEntry): boolean {
  if (entry.digestType === "weekly") return true;
  return DIGEST_INDEX_REFERENCE_SEC - entry.generatedAt <= DAILY_DIGEST_INDEX_WINDOW_SEC;
}

export const INDEXABLE_DIGEST_ENTRIES: readonly DigestContentEntry[] = Object.freeze(
  DIGEST_ENTRIES.filter(isDigestIndexable),
);

export const LATEST_DAILY_DIGEST =
  DIGEST_ENTRIES.find((entry) => (entry.digestType ?? "daily") !== "weekly") ?? DIGEST_ENTRIES[0];
