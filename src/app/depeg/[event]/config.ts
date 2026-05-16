/**
 * Page-generation policy for `/depeg/[event]/`.
 *
 * Lives in a standalone module (no JSON imports) so it can be imported by
 * `sitemap.ts` and other build-time consumers without dragging the full
 * depeg-events fixture into their dependency graph.
 */

/**
 * Severity threshold (basis points) below which a confirmed event does NOT
 * get its own static page. Events with a peak deviation under 2.5% remain
 * tracked in D1, surface in feeds and dashboards, and stay citable through
 * `/api/depeg-events`, but they don't earn a dedicated route. Keeps the
 * static archive focused on materially noteworthy events.
 */
export const MIN_DEPEG_PAGE_DEVIATION_BPS = 250;
