import type { DepegEventEntry } from "@shared/types/market";
import { selectStaticDepegEventPages } from "@/lib/depeg-event-config";
import { DEPEG_EVENT_DATA_DIR, readDepegEventPageEntries } from "@/lib/depeg-event-snapshot";
import {
  buildSameDayDirectionCollisionSlugs,
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
} from "@/lib/depeg-event-display";

export type { DepegEventEntry } from "@shared/types/market";

function readDepegEventEntries(): readonly DepegEventEntry[] {
  try {
    return readDepegEventPageEntries();
  } catch (cause) {
    throw new Error(
      `Failed to read depeg events from ${DEPEG_EVENT_DATA_DIR}; run scripts/maintenance/sync-depeg-events.ts before building.`,
      { cause },
    );
  }
}

/**
 * Every generated event page is linked from the archive, listed in the sitemap,
 * and served `index,follow` — the static page set and the indexable set are the
 * same set by construction (`selectStaticDepegEventPages`).
 */
export const DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] = selectStaticDepegEventPages(readDepegEventEntries());

export const COLLIDING_DEPEG_EVENT_SLUGS: ReadonlySet<string> =
  buildSameDayDirectionCollisionSlugs(DEPEG_EVENT_ENTRIES);

export { DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS };

export const eventBySlug: ReadonlyMap<string, DepegEventEntry> = new Map(
  DEPEG_EVENT_ENTRIES.map((event) => [event.slug, event] as const),
);

/**
 * Incident numbers for confirmed event pages.
 *
 * Assigned in chronological order — the oldest confirmed event is Incident #1,
 * counting forward. Numbers are stable across rebuilds as long as a slug stays
 * confirmed; if an event is rejected later, numbers downstream shift by one,
 * which is acceptable because rejected events lose their permanent URL too.
 *
 * The chronological direction (ascending, not the sync-script's descending
 * order) is the canonical convention for serial publication numbering.
 */
const INCIDENT_NUMBER_BY_SLUG: ReadonlyMap<string, number> = (() => {
  const ascending = [...DEPEG_EVENT_ENTRIES].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.slug.localeCompare(b.slug);
  });
  return new Map(ascending.map((event, index) => [event.slug, index + 1] as const));
})();

export function formatIncidentNumber(slug: string): string | null {
  const number = INCIDENT_NUMBER_BY_SLUG.get(slug);
  if (number == null) return null;
  return String(number).padStart(3, "0");
}
