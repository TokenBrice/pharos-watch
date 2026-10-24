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
const PINNED_DEPEG_EVENT_SLUGS = ["usdc-2023-03-11"] as const;

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
 * Every static event page is permanent and linked from `/depeg/archive/`.
 * Search indexing is a narrower set: see `buildNoindexDepegEventSlugs`.
 */
export function selectStaticDepegEventPages<T extends DepegEventStaticPageCandidate>(
  events: readonly T[],
): readonly T[] {
  return selectIndexableDepegEvents(events.filter(hasDedicatedDepegEventPage));
}

/**
 * Event pages that earned Google Search impressions in the three months to
 * 2026-10-22 (Search Console Pages export, 2026-10-25 SEO plan). They stay
 * `index,follow` whatever the thin-page rules below say. The export lists
 * every page with a click and 0-click pages down to 117 impressions.
 */
const SEARCH_IMPRESSION_DEPEG_EVENT_SLUGS: ReadonlySet<string> = new Set([
  "alusd-2026-05-01-down-89786",
  "eurs-2026-06-19",
  "eurs-2026-07-12",
  "jpyc-2026-05-12",
  "kag-2026-03-01-up-78521",
  "kag-2026-06-14",
  "mim-2026-06-08",
  "msusd-2026-06-21",
  "musd-2026-04-13-up-89598",
  "satusd-2026-02-25-down-31917",
  "usdc-2023-03-11",
  "usdp-2026-05-06",
  "usdxl-2026-05-29",
]);

interface DepegEventNoindexCandidate extends DepegEventPageCandidate {
  slug: string;
  stablecoinId: string;
  startedAt: number;
  pendingReason?: string | null;
}

export function isLowConfidenceDepegEvent(event: Pick<DepegEventNoindexCandidate, "pendingReason">): boolean {
  return (event.pendingReason ?? "").split("+").includes("low-confidence");
}

/**
 * Permanent event pages served `noindex, follow` and left out of the sitemap
 * and public route inventory. They stay live and listed in the archive, so
 * the published-URL continuity gate is satisfied without redirects.
 *
 * This reverses the earlier "every event page is indexable" policy (2026-10-25
 * SEO plan, decision D5). Same-day fragments of one episode read as near
 * duplicates (Google chose a sibling canonical for one GYD fragment), and
 * only 13 of 261 event pages earned impressions. Pages are not merged:
 * the producer owns the event vocabulary. Two thin-page rules apply:
 * - the event's opening was held for verification on a low-confidence price input;
 * - it is a secondary event in a same-coin, same-UTC-day cluster. The event
 *   with the largest absolute peak (low-confidence events excluded) stays indexed.
 * Pages with recent search impressions are never noindexed.
 */
export function buildNoindexDepegEventSlugs(
  events: readonly DepegEventNoindexCandidate[],
): ReadonlySet<string> {
  const clusters = new Map<string, DepegEventNoindexCandidate[]>();
  for (const event of events) {
    const key = `${event.stablecoinId}:${new Date(event.startedAt * 1000).toISOString().slice(0, 10)}`;
    const cluster = clusters.get(key);
    if (cluster) cluster.push(event);
    else clusters.set(key, [event]);
  }

  const noindex = new Set<string>();
  for (const cluster of clusters.values()) {
    const lead = cluster
      .filter((event) => !isLowConfidenceDepegEvent(event))
      .sort((a, b) =>
        getPeakDeviationMagnitudeBps(b) - getPeakDeviationMagnitudeBps(a)
        || a.startedAt - b.startedAt
        || a.slug.localeCompare(b.slug))[0];
    for (const event of cluster) {
      if (SEARCH_IMPRESSION_DEPEG_EVENT_SLUGS.has(event.slug)) continue;
      if (isLowConfidenceDepegEvent(event) || event !== lead) noindex.add(event.slug);
    }
  }
  return noindex;
}
