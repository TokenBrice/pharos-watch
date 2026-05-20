/**
 * Public snapshot path metadata.
 *
 * Three URL shapes are served by `worker/src/api/snapshot.ts`:
 *   GET /api/snapshots/index            → list of available snapshot dates
 *   GET /api/snapshots/<YYYY-MM-DD>.json → full daily payload
 *   GET /api/snapshot/<YYYY-MM-DD>/stablecoin/<id> → single-coin projection
 *
 * Path builders live with the rest of the registry in `./paths.ts`
 * (`API_PATHS.snapshotsIndex`, `snapshotDay`, `snapshotCoin`). Route patterns
 * for the dynamic shapes live with the rest of the router metadata in
 * `./dynamic.ts`. This module only exports the validation regex shared by
 * the worker handlers and the response shape consumed by callers of the
 * index endpoint.
 */

/** Strict YYYY-MM-DD ISO 8601 date (no time component, no timezone). */
export const SNAPSHOT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
