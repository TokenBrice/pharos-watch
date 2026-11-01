import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
import { batchExecute, executeAtomicBatch } from "./db";
import { D1_BATCH_SIZE } from "./constants";
import { getCache, setCache } from "./db-cache";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { mintBurnTapeEligibleSql } from "./mint-burn-tape-claim";
import type { TapeEventInsert, TapeEventRow } from "./tape-event-types";

const WATERMARK_KEY_PREFIX = "tape-projector:cursor:";

export function tapeProjectorCursorKey(eventClass: string): string {
  return `${WATERMARK_KEY_PREFIX}${eventClass}`;
}

/** Parse a persisted projector watermark. 0 = no rows yet. */
export function parseProjectorWatermark(value: string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Read per-class watermark (numeric source-row marker). 0 = no rows yet. */
export async function getProjectorWatermark(db: D1Database, eventClass: string): Promise<number> {
  const row = await getCache(db, tapeProjectorCursorKey(eventClass));
  return parseProjectorWatermark(row?.value);
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

function prepareFlowInsert(db: D1Database, event: TapeEventInsert, nowSec: number): D1PreparedStatement {
  const payload = event.payload as Record<string, unknown>;
  return db
    .prepare(
      `INSERT INTO tape_events
         (event_id, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency,
          chain, title, summary, payload_json, source_table, source_row_id,
          transition, source_url, methodology_version, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM mint_burn_events AS source
           WHERE source.id = ?
             AND source.amount_usd IS ?
             AND source.flow_type IS ?
             AND source.burn_type IS ?
             AND ${mintBurnTapeEligibleSql("source")}
        )
       ON CONFLICT(source_table, source_row_id, transition) DO UPDATE SET
         severity = excluded.severity, title = excluded.title,
         summary = excluded.summary, payload_json = excluded.payload_json
       WHERE tape_events.suppressed_at IS NULL
         AND tape_events.type = excluded.type
         AND (tape_events.severity IS NOT excluded.severity
           OR tape_events.title IS NOT excluded.title
           OR tape_events.summary IS NOT excluded.summary
           OR tape_events.payload_json IS NOT excluded.payload_json)`,
    )
    .bind(
      event.eventId, event.type, event.severity, event.ts, event.endsAt, event.coinId,
      event.issuerId, event.pegCurrency, event.chain, event.title, event.summary,
      JSON.stringify(event.payload), event.sourceTable, event.sourceRowId, event.transition,
      event.sourceUrl, event.methodologyVersion, nowSec,
      event.sourceRowId, payload.amountUsd ?? null, payload.flowType ?? null, payload.burnType ?? null,
    );
}

/**
 * Source-key reclassification replaces ordinary events. Peak observations are
 * insert-if-absent; freeze corrections update only current, unsuppressed source
 * amounts. Large-flow claims insert only while the source is still eligible
 * and matches the event's snapshot, and a correction updates only presentation
 * fields of an unsuppressed claim. All retain the first permalink, ingestion ID and source/creation
 * clocks. An optional checkpoint commits with the final bounded event batch.
 */
export async function insertTapeEvents(
  db: D1Database,
  events: TapeEventInsert[],
  checkpoint?: D1PreparedStatement,
): Promise<number> {
  if (events.length === 0 && !checkpoint) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const stmts = events.map((event) => {
    if (event.sourceTable === "mint_burn_events") return prepareFlowInsert(db, event, nowSec);
    return db
      .prepare(
        `INSERT OR REPLACE INTO tape_events
           (event_id, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency,
            chain, title, summary, payload_json, source_table, source_row_id,
            transition, source_url, methodology_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ${event.type === "depeg.peak_worsened"
           ? "ON CONFLICT(source_table, source_row_id, transition) DO NOTHING"
           : event.sourceTable === "blacklist_events" && event.type.startsWith("freeze.")
             ? `ON CONFLICT(source_table, source_row_id, transition) DO UPDATE SET
                  severity = excluded.severity, title = excluded.title,
                  summary = excluded.summary, payload_json = excluded.payload_json
                WHERE tape_events.suppressed_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM blacklist_events AS source
                     WHERE source.id = excluded.source_row_id
                       AND source.suppression_reason IS NULL
                       AND source.amount_usd_at_event IS json_extract(excluded.payload_json, '$.amountUsdAtEvent')
                  )
                  AND (tape_events.severity IS NOT excluded.severity
                    OR tape_events.title IS NOT excluded.title
                    OR tape_events.summary IS NOT excluded.summary
                    OR tape_events.payload_json IS NOT excluded.payload_json)`
             : ""}`,
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
      );
  });
  if (checkpoint) {
    // Reserve one slot so even an exact multiple of the batch limit ends with
    // event writes and the checkpoint in the same transaction.
    const tailStart = Math.max(0, stmts.length - (D1_BATCH_SIZE - 1));
    await batchExecute(db, stmts.slice(0, tailStart));
    await executeAtomicBatch(db, [...stmts.slice(tailStart), checkpoint]);
  } else {
    await batchExecute(db, stmts);
  }
  return events.length;
}

/**
 * Filter a bounded static catalog through the source-key uniqueness index.
 * Each probe reads at most one index entry, avoiding a scan whose cost grows
 * with the complete history for an event type.
 */
export async function filterUnprojectedTapeEvents(
  db: D1Database,
  events: readonly TapeEventInsert[],
): Promise<TapeEventInsert[]> {
  if (events.length === 0) return [];
  const unprojected: TapeEventInsert[] = [];
  for (let offset = 0; offset < events.length; offset += D1_BATCH_SIZE) {
    const chunk = events.slice(offset, offset + D1_BATCH_SIZE);
    const observed = await runWithOverloadRetry(
      () =>
        db.batch(
          chunk.map((event) =>
            db
              .prepare(
                `SELECT 1 AS observed
                   FROM tape_events INDEXED BY idx_tape_source_key
                  WHERE source_table = ?
                    AND source_row_id = ?
                    AND transition = ?
                  LIMIT 1`,
              )
              .bind(event.sourceTable, event.sourceRowId, event.transition),
          ),
        ),
      3,
    );
    for (let index = 0; index < chunk.length; index += 1) {
      if ((observed[index]?.results?.length ?? 0) === 0) {
        unprojected.push(chunk[index]!);
      }
    }
  }
  return unprojected;
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

/**
 * `tape_events.peg_currency` historically stores either the canonical
 * `PegCurrency` (lifecycle/cemetery rows) or the source's DefiLlama peg type
 * (depeg rows written before the projectors normalized their input). A currency
 * filter must match every spelling the taxonomy admits for the requested
 * currency so stored rows stay reachable without rewriting them.
 */
function pegCurrencyFilterValues(currency: string): string[] {
  const entry = getPegTaxonomyByCurrency(currency);
  if (!entry) return [currency];
  const values = [
    entry.currency,
    ...(entry.currencyAliases ?? []),
    ...(entry.canonicalPegType ? [entry.canonicalPegType] : []),
    ...(entry.pegTypeAliases ?? []),
  ];
  return [...new Set(values)];
}

function buildWhereClause(
  filters: TapeEventQueryFilters,
  cursor: { ts: number; id: number } | null,
): { sql: string; bindings: (string | number)[] } {
  const conditions: string[] = ["suppressed_at IS NULL"];
  const bindings: (string | number)[] = [];

  const typeClauses: string[] = [];
  if (filters.typeExact && filters.typeExact.length > 0) {
    typeClauses.push(...filters.typeExact.map(() => "type = ?"));
    bindings.push(...filters.typeExact);
  }
  if (filters.typePrefixes && filters.typePrefixes.length > 0) {
    typeClauses.push(...filters.typePrefixes.map(() => "instr(LOWER(type), ?) = 1"));
    for (const prefix of filters.typePrefixes) bindings.push(`${prefix.toLowerCase()}.`);
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
    const pegValues = pegCurrencyFilterValues(filters.pegCurrency);
    conditions.push(`peg_currency IN (${pegValues.map(() => "?").join(", ")})`);
    bindings.push(...pegValues);
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
    conditions.push(
      "(instr(LOWER(title), ?) > 0 OR instr(LOWER(summary), ?) > 0 OR instr(LOWER(coin_id), ?) > 0)",
    );
    bindings.push(filters.q, filters.q, filters.q);
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
