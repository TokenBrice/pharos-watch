import type { DepegEventEntry } from "@shared/types/market";
import { buildNoindexDepegEventSlugs, selectStaticDepegEventPages } from "@/lib/depeg-event-config";
import { DEPEG_EVENT_DATA_DIR, readDepegEventPageEntries } from "@/lib/depeg-event-snapshot";
import {
  buildSameDayDirectionCollisionSlugs,
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
  formatEventTimestamp,
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
 * Every generated event page is permanent and linked from `/depeg/archive/`
 * (`selectStaticDepegEventPages`). Thin pages in `NOINDEX_DEPEG_EVENT_SLUGS`
 * are served `noindex, follow` and stay out of the sitemap.
 */
export const DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] = selectStaticDepegEventPages(readDepegEventEntries());

export const NOINDEX_DEPEG_EVENT_SLUGS: ReadonlySet<string> = buildNoindexDepegEventSlugs(DEPEG_EVENT_ENTRIES);

/** Event pages listed in the sitemap and public route inventory. */
export const INDEXABLE_DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] = DEPEG_EVENT_ENTRIES.filter(
  (event) => !NOINDEX_DEPEG_EVENT_SLUGS.has(event.slug),
);

/**
 * The coin's newest permanent depeg event pages. The label carries the UTC start
 * time, because a coin can open several events in one month.
 */
export function buildExploreDepegEventLinks(
  coinId: string,
  symbol: string,
  limit = 5,
): Array<{ href: string; label: string }> {
  return DEPEG_EVENT_ENTRIES.filter((event) => event.stablecoinId === coinId)
    .slice(0, limit)
    .map((event) => ({
      href: `/depeg/${event.slug}/`,
      label: `${symbol} depeg ${formatEventTimestamp(event.startedAt, true)}`,
    }));
}

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
