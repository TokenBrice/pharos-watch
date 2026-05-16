/**
 * Public snapshot path constants and helpers.
 *
 * Three URL shapes:
 *   GET /api/snapshots/index            → list of available snapshot dates
 *   GET /api/snapshots/<YYYY-MM-DD>.json → full daily payload
 *   GET /api/snapshot/<YYYY-MM-DD>/stablecoin/<id> → single-coin projection
 *
 * The full path builders are also re-exported via API_PATHS in ./paths.ts;
 * the constants here exist so worker handlers and route patterns can share a
 * single source of truth.
 */

import { buildQueryPath } from "./paths";

export const PATH_SNAPSHOTS_INDEX = "/api/snapshots/index";

export function pathSnapshotDay(date: string): string {
  return `/api/snapshots/${date}.json`;
}

export function pathSnapshotCoin(date: string, stablecoinId: string): string {
  return `/api/snapshot/${date}/stablecoin/${encodeURIComponent(stablecoinId)}`;
}

/** Strict YYYY-MM-DD ISO 8601 date (no time component, no timezone). */
export const SNAPSHOT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Regex matching the per-day blob URL with a `date` capture group. */
export const SNAPSHOT_DAY_ROUTE_PATTERN = /^\/api\/snapshots\/(\d{4}-\d{2}-\d{2})\.json$/;

/** Regex matching the per-coin projection URL with `date` and `id` capture groups. */
export const SNAPSHOT_COIN_ROUTE_PATTERN = /^\/api\/snapshot\/(\d{4}-\d{2}-\d{2})\/stablecoin\/([^/]+)$/;

/**
 * Returns true when the given path matches one of the three snapshot URL shapes.
 * Used by routing helpers that need to short-circuit caching before the
 * worker router fully dispatches.
 */
export function isSnapshotPath(path: string): boolean {
  if (path === PATH_SNAPSHOTS_INDEX) return true;
  if (SNAPSHOT_DAY_ROUTE_PATTERN.test(path)) return true;
  if (SNAPSHOT_COIN_ROUTE_PATTERN.test(path)) return true;
  return false;
}

/** Build a query-string variant of the index path for cache-bust experimentation. */
export function snapshotIndexPath(params?: Record<string, string | number | undefined>): string {
  return buildQueryPath(PATH_SNAPSHOTS_INDEX, params);
}

export interface PublicSnapshotMethodologyVersions {
  pegScore: string;
  dews: string;
  liquidityScore: string;
  psi: string;
  reportCard: string;
  chainHealth: string;
  redemptionBackstop: string;
  pricingPipeline: string;
  yieldMethodology: string;
}

export interface PublicSnapshotIndexEntry {
  snapshotDate: string;
  contentHash: string;
  byteSize: number;
  createdAt: number;
  methodologyVersions: PublicSnapshotMethodologyVersions;
}

export interface PublicSnapshotIndexResponse {
  snapshots: PublicSnapshotIndexEntry[];
}
