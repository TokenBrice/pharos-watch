/**
 * Shared shape for tape-event projectors.
 *
 * Each projector is a pure function over (db, options). The cron entry point
 * calls them with watermark-based defaults; the `/api/backfill-tape` endpoint
 * passes operator-specified overrides.
 */
import { getProjectorWatermark } from "../tape-event-store";

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

export interface ResolvedProjectorOptions {
  /** Persisted per-class watermark for `cursorKey`. */
  watermark: number;
  /** Effective lower bound: `options.since` override, else the watermark. */
  since: number;
  /** Effective inclusive upper bound, or null when unbounded. */
  until: number | null;
  /** Effective max source rows to scan. */
  limit: number;
  /** Whether this is a dry run (no writes / watermark advance). */
  dryRun: boolean;
}

export interface TieExpansionSourceQuery<T> {
  selectSql: string;
  fromSql: string;
  timeColumn: string;
  timePredicatePrefix?: string;
  trailingWhereSql?: string;
  trailingBinds?: readonly unknown[];
  orderBySql: string;
  since: number;
  until: number | null;
  limit: number;
  getTime: (row: T) => number | null | undefined;
}

function buildTieExpansionSql<T>(
  query: TieExpansionSourceQuery<T>,
  includeUntil: boolean,
  includeLimit: boolean,
): string {
  const untilClause = includeUntil ? ` AND ${query.timeColumn} <= ?` : "";
  const limitClause = includeLimit ? "\n                 LIMIT ?" : "";
  return `${query.selectSql}
                 FROM ${query.fromSql}
                 WHERE ${query.timePredicatePrefix ?? ""}${query.timeColumn} > ?${untilClause}${query.trailingWhereSql ?? ""}
                 ORDER BY ${query.orderBySql}${limitClause}`;
}

export async function fetchRowsWithTieExpansion<T>(
  db: D1Database,
  query: TieExpansionSourceQuery<T>,
): Promise<T[]> {
  const trailingBinds = query.trailingBinds ?? [];
  const sql = buildTieExpansionSql(query, query.until != null, true);
  const binds: unknown[] = query.until != null
    ? [query.since, query.until, ...trailingBinds, query.limit]
    : [query.since, ...trailingBinds, query.limit];
  const result = await db.prepare(sql).bind(...binds).all<T>();
  const rows = result.results ?? [];
  if (rows.length < query.limit) return rows;

  const cutoff = query.getTime(rows[rows.length - 1]!);
  if (cutoff == null) return rows;
  const expandedUntil = query.until == null ? cutoff : Math.min(query.until, cutoff);
  const expandedSql = buildTieExpansionSql(query, true, false);
  const expanded = await db
    .prepare(expandedSql)
    .bind(query.since, expandedUntil, ...trailingBinds)
    .all<T>();
  return expanded.results ?? [];
}

/**
 * Resolve the watermark-based defaults shared by every watermark projector:
 * read the persisted watermark for `cursorKey`, then apply the operator
 * overrides from `options`. Returns the watermark alongside the effective
 * since/until/limit/dryRun so callers can advance it later.
 */
export async function resolveProjectorOptions(
  db: D1Database,
  cursorKey: string,
  options: ProjectorOptions | undefined,
): Promise<ResolvedProjectorOptions> {
  const watermark = await getProjectorWatermark(db, cursorKey);
  return {
    watermark,
    since: options?.since ?? watermark,
    until: options?.until ?? null,
    limit: options?.maxRows ?? DEFAULT_BATCH_LIMIT,
    dryRun: options?.dryRun === true,
  };
}
