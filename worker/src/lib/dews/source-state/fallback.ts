/**
 * DEWS source-state migration-aware fallback semantics.
 *
 * When a fresh deployment runs before backfill cron jobs have populated their
 * tables, certain D1 reads can fail with "no such table". We mark a curated
 * set of sources as bootstrap-allowed so the surrounding orchestrator reports
 * the failure without degrading the run.
 *
 * This module captures only the policy ("which errors are tolerated, and
 * when"); the actual try/catch + registerSourceFailure call sites live in the
 * hydration loaders.
 */

import { isMissingTableError } from "../../db";

const BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES = new Set([
  "dex-prices",
  "dex-liquidity-history",
  "blacklist-events",
  "mint-burn-hourly",
  "yield-data",
  "stability-index-samples",
]);

export function isBootstrapAllowedMissingTableSource(source: string): boolean {
  return BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES.has(source);
}

/**
 * Resolves the `bootstrapAllowed` flag used when reporting a source failure.
 * Returns `true` only when all three conditions are met:
 *   - bootstrap is currently pending (cron has not yet completed a full cycle)
 *   - the underlying error indicates a missing D1 table
 *   - the source is on the bootstrap-allowed allowlist
 */
export function resolveBootstrapAllowed(
  source: string,
  error: unknown,
  bootstrapPending: boolean,
): boolean {
  return bootstrapPending && isMissingTableError(error) && isBootstrapAllowedMissingTableSource(source);
}
