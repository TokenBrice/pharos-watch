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

export const LATEST_DAILY_DIGEST =
  DIGEST_ENTRIES.find((entry) => (entry.digestType ?? "daily") !== "weekly") ?? DIGEST_ENTRIES[0];
