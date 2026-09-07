import { batchExecute } from "./db";
import { getCache, setCache } from "./db-cache";
import type { TapeEventInsert, TapeEventRow } from "./tape-event-types";

const WATERMARK_KEY_PREFIX = "tape-projector:cursor:";

export function tapeProjectorCursorKey(eventClass: string): string {
  return `${WATERMARK_KEY_PREFIX}${eventClass}`;
}

/** Read per-class watermark (numeric source-row marker). 0 = no rows yet. */
export async function getProjectorWatermark(db: D1Database, eventClass: string): Promise<number> {
  const row = await getCache(db, tapeProjectorCursorKey(eventClass));
  if (!row) return 0;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Write per-class watermark. */
export async function setProjectorWatermark(
  db: D1Database,
  eventClass: string,
  value: number,
): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) return;
  await setCache(db, tapeProjectorCursorKey(eventClass), String(Math.floor(value)));
}

/**
 * Idempotent batch insert. Each row writes via `INSERT OR REPLACE` keyed on
 * `(source_table, source_row_id, transition)`, which is the documented
 * idempotency contract (e.g. so a pending→confirmed reclassification
 * overwrites the row in place).
 */
export async function insertTapeEvents(db: D1Database, events: TapeEventInsert[]): Promise<number> {
  if (events.length === 0) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const stmts = events.map((event) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO tape_events
           (event_id, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency,
            chain, title, summary, payload_json, source_table, source_row_id,
            transition, source_url, methodology_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.eventId,
        event.type,
        event.severity,
        event.ts,
        event.endsAt,
        event.coinId,
        event.issuerId,
        event.pegCurrency,
        event.chain,
        event.title,
        event.summary,
        JSON.stringify(event.payload),
        event.sourceTable,
        event.sourceRowId,
        event.transition,
        event.sourceUrl,
        event.methodologyVersion,
        nowSec,
      ),
  );
  await batchExecute(db, stmts);
  return events.length;
}

/**
 * Load the set of source_row_ids already projected for a given event type.
 * Used by first-observation projectors to skip already-emitted entries.
 */
export async function loadObservedSourceRowIds(db: D1Database, type: string): Promise<Set<string>> {
  const result = await db
    .prepare(`SELECT source_row_id FROM tape_events WHERE type = ?`)
    .bind(type)
    .all<{ source_row_id: string }>();
  const seen = new Set<string>();
  for (const row of result.results ?? []) seen.add(row.source_row_id);
  return seen;
}

// --- Read path (cursor pagination) ------------------------------------------

export interface TapeEventQueryFilters {
  typeExact?: string[];
  typePrefixes?: string[];        // each entry already stripped of trailing ".*"
  coinIds?: string[];
  pegCurrency?: string | null;
  chain?: string | null;
  severitiesAllowed?: string[];   // already expanded from the floor
  since?: number | null;          // epoch ms inclusive
  until?: number | null;          // epoch ms inclusive
  q?: string | null;              // lowercase substring; matched against title/summary/coin_id
}

export interface TapeEventQueryOptions {
  filters: TapeEventQueryFilters;
  limit: number;
  cursor: { ts: number; id: number } | null;
  includeTotal: boolean;
}

export interface TapeEventQueryResult {
  rows: TapeEventRow[];
  hasMore: boolean;
  total: number | null;
}

function escapeLikeSearch(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildWhereClause(
  filters: TapeEventQueryFilters,
  cursor: { ts: number; id: number } | null,
): { sql: string; bindings: (string | number)[] } {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  const typeClauses: string[] = [];
  if (filters.typeExact && filters.typeExact.length > 0) {
    typeClauses.push(...filters.typeExact.map(() => "type = ?"));
    bindings.push(...filters.typeExact);
  }
  if (filters.typePrefixes && filters.typePrefixes.length > 0) {
    typeClauses.push(...filters.typePrefixes.map(() => "type LIKE ?"));
    for (const prefix of filters.typePrefixes) bindings.push(`${prefix}.%`);
  }
  if (typeClauses.length > 0) {
    conditions.push(`(${typeClauses.join(" OR ")})`);
  }
  if (filters.coinIds && filters.coinIds.length > 0) {
    const coinClauses = filters.coinIds.map(() => "coin_id = ?");
    conditions.push(`(${coinClauses.join(" OR ")})`);
    bindings.push(...filters.coinIds);
  }
  if (filters.pegCurrency) {
    conditions.push("peg_currency = ?");
    bindings.push(filters.pegCurrency);
  }
  if (filters.chain) {
    conditions.push("chain = ?");
    bindings.push(filters.chain);
  }
  if (filters.severitiesAllowed && filters.severitiesAllowed.length > 0) {
    const sevClauses = filters.severitiesAllowed.map(() => "severity = ?");
    conditions.push(`(${sevClauses.join(" OR ")})`);
    bindings.push(...filters.severitiesAllowed);
  }
  if (filters.since != null) {
    conditions.push("ts >= ?");
    bindings.push(filters.since);
  }
  if (filters.until != null) {
    conditions.push("ts <= ?");
    bindings.push(filters.until);
  }
  if (filters.q && filters.q.length > 0) {
    const like = `%${escapeLikeSearch(filters.q)}%`;
    conditions.push(
      "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(summary) LIKE ? ESCAPE '\\' OR LOWER(coin_id) LIKE ? ESCAPE '\\')",
    );
    bindings.push(like, like, like);
  }
  if (cursor) {
    // (ts, id) DESC keyset.
    conditions.push("(ts < ? OR (ts = ? AND id < ?))");
    bindings.push(cursor.ts, cursor.ts, cursor.id);
  }

  const sql = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  return { sql, bindings };
}

export async function queryTapeEvents(
  db: D1Database,
  options: TapeEventQueryOptions,
): Promise<TapeEventQueryResult> {
  const dataWhere = buildWhereClause(options.filters, options.cursor);
  const dataSql = `SELECT * FROM tape_events${dataWhere.sql} ORDER BY ts DESC, id DESC LIMIT ?`;
  const dataStmt = db.prepare(dataSql).bind(...dataWhere.bindings, options.limit + 1);

  let total: number | null = null;
  let rowsResult: D1Result<TapeEventRow>;

  if (options.includeTotal) {
    const countWhere = buildWhereClause(options.filters, null);
    const countSql = `SELECT COUNT(*) as total FROM tape_events${countWhere.sql}`;
    const countStmt = db.prepare(countSql).bind(...countWhere.bindings);
    const [countResult, dataResult] = await db.batch([countStmt, dataStmt]);
    total = ((countResult.results ?? []) as { total: number }[])[0]?.total ?? 0;
    rowsResult = dataResult as D1Result<TapeEventRow>;
  } else {
    rowsResult = await dataStmt.all<TapeEventRow>();
  }

  const fetched = rowsResult.results ?? [];
  const hasMore = fetched.length > options.limit;
  const rows = hasMore ? fetched.slice(0, options.limit) : fetched;
  return { rows, hasMore, total };
}
