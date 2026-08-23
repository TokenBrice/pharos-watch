/**
 * Page-generation policy for `/depeg/[event]/`.
 *
 * Lives in a standalone module (no JSON imports) so it can be imported by
 * `sitemap.ts` and other build-time consumers without dragging the full
 * depeg-events fixture into their dependency graph.
 */

/**
 * Severity threshold (basis points) below which a confirmed event does NOT
 * qualify for its own static page. Events whose absolute peak deviation is
 * under 5.0% remain tracked in D1, surface in feeds and dashboards, and stay
 * citable through `/api/depeg-events`, but they don't earn a dedicated route.
 * Keeps the static archive focused on materially noteworthy events.
 */
export const MIN_DEPEG_PAGE_DEVIATION_BPS = 500;

/**
 * Grow-only archive epoch (2026-01-01T00:00:00Z). Every confirmed event that
 * starts at or after this instant and clears MIN_DEPEG_PAGE_DEVIATION_BPS
 * keeps a permanent static page, permanently listed in the archive and the
 * sitemap. This replaces the former 12-newest recency window
 * (INDEXABLE_DEPEG_EVENT_LIMIT), which deleted already-ranked pages as newer
 * events arrived — Search Console showed churned-out event URLs returning
 * 404 after earning impressions and clicks.
 *
 * File-count budget: the static export writes ~9 files per event route.
 * 2026 H1 produced ~260 qualifying events (~1.5/day), so the archive adds
 * roughly 5k files/year against the Cloudflare Pages 20k direct-upload cap
 * (~13k used today) — revisit the epoch or split deploys before that cap
 * gets close, but do not reintroduce deletion of published event URLs.
 */
export const DEPEG_ARCHIVE_EPOCH_SECONDS = 1_767_225_600;

/**
 * Durable indexability ledger for events that predate the archive epoch.
 * Pinned events are unioned into both the static page set and the indexable
 * set. Post-epoch events no longer need pinning — permanence is structural.
 */
export const PINNED_DEPEG_EVENT_SLUGS = ["usdc-2023-03-11"] as const;

interface DepegEventIndexCandidate {
  slug: string;
  startedAt: number;
}

interface DepegEventPageCandidate {
  peakDeviationBps: number;
}

interface DepegEventStaticPageCandidate extends DepegEventIndexCandidate, DepegEventPageCandidate {}

export function getPeakDeviationMagnitudeBps(event: DepegEventPageCandidate): number {
  return Math.abs(event.peakDeviationBps);
}

export function hasDedicatedDepegEventPage(event: DepegEventPageCandidate): boolean {
  return getPeakDeviationMagnitudeBps(event) >= MIN_DEPEG_PAGE_DEVIATION_BPS;
}

function sortNewestDeterministic<T extends DepegEventIndexCandidate>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return a.slug.localeCompare(b.slug);
  });
}

export function selectIndexableDepegEvents<T extends DepegEventIndexCandidate>(
  events: readonly T[],
): readonly T[] {
  const bySlug = new Map(events.map((event) => [event.slug, event] as const));
  const selected = new Map<string, T>();

  for (const event of events) {
    if (event.startedAt >= DEPEG_ARCHIVE_EPOCH_SECONDS) selected.set(event.slug, event);
  }
  for (const slug of PINNED_DEPEG_EVENT_SLUGS) {
    const event = bySlug.get(slug);
    if (event) selected.set(slug, event);
  }

  return sortNewestDeterministic([...selected.values()]);
}

/**
 * Static pages and indexable pages are deliberately the same set: every
 * generated event page is linked from the archive, listed in the sitemap,
 * and served `index,follow`. Each qualifying record carries the measured
 * price path, resolution state, source, and methodology context needed for
 * the route's data-driven briefing, so there is no low-information noindex
 * tier within the current archive.
 */
export function selectStaticDepegEventPages<T extends DepegEventStaticPageCandidate>(
  events: readonly T[],
): readonly T[] {
  return selectIndexableDepegEvents(events.filter(hasDedicatedDepegEventPage));
}
