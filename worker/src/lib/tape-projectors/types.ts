/**
 * Shared shape for tape-event projectors.
 *
 * Each projector is a pure function over (db, options). The cron entry point
 * calls them with watermark-based defaults; the `/api/backfill-tape` endpoint
 * passes operator-specified overrides.
 */

export interface ProjectorOptions {
  /**
   * Override the per-class watermark. For source-row-time projectors this is
   * epoch seconds and behaves as a strict greater-than filter on the source
   * row's timestamp column. NULL/undefined means "use the persisted watermark".
   */
  since?: number | null;
  /** Inclusive upper bound on source-row timestamp (epoch seconds). */
  until?: number | null;
  /** Max source rows to scan in a single call. */
  maxRows?: number;
  /** When true, compute events but do not write to D1 or advance watermarks. */
  dryRun?: boolean;
}

export interface ProjectorResult {
  /** Events inserted (or, in dry-run, that would have been inserted). */
  projected: number;
  /** New watermark value if the projector advanced one, else null. */
  advanced: number | null;
}

export type Projector = (db: D1Database, options?: ProjectorOptions) => Promise<ProjectorResult>;

export const DEFAULT_BATCH_LIMIT = 500;
