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
 * Only the event pages linked from the server-rendered `/depeg/` archive are
 * crawl targets. The full event table remains available through the API and
 * live tracker; the static export keeps a bounded editorial subset so the
 * Cloudflare Pages direct-upload file count stays below its hard cap.
 */
export const INDEXABLE_DEPEG_EVENT_LIMIT = 12;

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
  return sortNewestDeterministic(events).slice(0, INDEXABLE_DEPEG_EVENT_LIMIT);
}

export function selectStaticDepegEventPages<T extends DepegEventStaticPageCandidate>(
  events: readonly T[],
): readonly T[] {
  const eligible = events.filter(hasDedicatedDepegEventPage);
  const bySlug = new Map(eligible.map((event) => [event.slug, event] as const));
  const selected = new Map<string, T>();

  for (const event of selectIndexableDepegEvents(eligible)) {
    selected.set(event.slug, event);
  }
  for (const slug of PINNED_DEPEG_EVENT_SLUGS) {
    const event = bySlug.get(slug);
    if (event) selected.set(slug, event);
  }

  return sortNewestDeterministic([...selected.values()]);
}
