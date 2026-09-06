/**
 * depeg.* projectors. Source: `depeg_events` (explicit transition table).
 *
 *   - depeg.opened       : one row per newly opened depeg
 *   - depeg.resolved     : one row per row whose ended_at was filled in by recovery evidence
 *   - depeg.peak_worsened: emitted when an OPEN row's |peak_deviation_bps| grows
 *
 * peak_worsened uses a JSON map in `cache` keyed `tape-projector:peak-worsened-seen`
 * holding `{ [depegEventId]: lastSeenAbsBps }`. On each run we scan currently
 * open rows; for each row whose magnitude exceeds the previously recorded
 * peak we emit one event and update the map.
 */
import {
  buildTapeEventId,
  deriveIssuerId,
  severityForDepegOpened,
} from "../tape-event-helpers";
import { getCache, setCache } from "../db-cache";
import {
  insertTapeEvents,
} from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import {
  DEFAULT_BATCH_LIMIT,
  fetchRowsWithTieExpansion,
  finalizeProjectorBatch,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";
import { formatDuration, formatPrice } from "@shared/lib/format";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/methodology-versions/depeg-dews";
import { classifyDepegClosure } from "@shared/lib/depeg-closure";

const PEAK_WORSENED_CACHE_KEY = "tape-projector:peak-worsened-seen";

interface DepegSourceRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;          // epoch seconds
  ended_at: number | null;     // epoch seconds
  start_price: number | null;
  recovery_price?: number | null;
  peg_reference: number;
  source: string;
  close_reason?: string | null;
}

function coinSourceUrl(coinId: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/#peg-history`;
}

function classCursorKey(variant: "opened" | "resolved"): string {
  return variant === "opened" ? "depeg.opened" : "depeg.resolved";
}

async function fetchDepegRows(
  db: D1Database,
  variant: "opened" | "resolved",
  since: number,
  until: number | null,
  limit: number,
): Promise<DepegSourceRow[]> {
  const timeColumn = variant === "opened" ? "started_at" : "ended_at";
  const selectSql = variant === "opened"
    ? `SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
              started_at, ended_at, start_price, peg_reference, source`
    : `SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
              started_at, ended_at, start_price, recovery_price, peg_reference, source, close_reason`;
  const trailingWhereSql = variant === "opened"
    ? " AND source = 'live'"
    : " AND source = 'live' AND ended_at IS NOT NULL";

  return fetchRowsWithTieExpansion<DepegSourceRow>(db, {
    selectSql,
    fromSql: "depeg_events",
    timeColumn,
    trailingWhereSql,
    orderBySql: `${timeColumn} ASC, id ASC`,
    since,
    until,
    limit,
    getTime: (row) => variant === "opened" ? row.started_at : row.ended_at,
  });
}

function isRecoveryClosure(row: DepegSourceRow): boolean {
  const closure = classifyDepegClosure({
    endedAt: row.ended_at,
    closeReason: row.close_reason,
    recoveryPrice: row.recovery_price ?? null,
  });
  return closure === "recovered" || closure === "legacy_recovered";
}

async function projectDepegByVariant(
  db: D1Database,
  variant: "opened" | "resolved",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = classCursorKey(variant);
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchDepegRows(db, variant, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    const tsSec = variant === "opened" ? row.started_at : (row.ended_at ?? row.started_at);
    if (tsSec > maxCursor) maxCursor = tsSec;
    if (variant === "resolved" && !isRecoveryClosure(row)) continue;

    const tsMs = tsSec * 1000;
    const absBps = Math.abs(row.peak_deviation_bps);
    const sign = row.direction === "below" ? "−" : "+";
    const type = variant === "opened" ? "depeg.opened" : "depeg.resolved";
    const severity = variant === "opened" ? severityForDepegOpened(absBps) : "info";
    const transition = variant === "opened" ? "opened" : "resolved";
    const sourceRowId = String(row.id);

    const title = variant === "opened"
      ? `${row.symbol} depeg opened (${sign}${absBps} bps)`
      : `${row.symbol} depeg resolved`;
    const directionWord = row.direction === "below" ? "below" : "above";
    const summary = variant === "opened"
      ? (row.start_price != null
          ? `Trading at ${formatPrice(row.start_price)} (${directionWord} peg).`
          : `${row.symbol} crossed peg threshold (${directionWord} peg).`)
      : (row.ended_at != null
          ? `Resolved after ${formatDuration(row.started_at, row.ended_at)} (peak ${sign}${absBps} bps).`
          : `Resolved (peak ${sign}${absBps} bps).`);

    events.push({
      eventId: buildTapeEventId({ tsMs, type, sourceTable: "depeg_events", sourceRowId, transition }),
      type,
      severity,
      ts: tsMs,
      endsAt: row.ended_at != null ? row.ended_at * 1000 : null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: row.peg_type,
      chain: null,
      title,
      summary,
      payload: {
        symbol: row.symbol,
        direction: row.direction,
        absDeviationBps: absBps,
        signedDeviationBps: row.peak_deviation_bps,
        pegReference: row.peg_reference,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      },
      sourceTable: "depeg_events",
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id),
      methodologyVersion: getDepegDewsMethodologyVersionAt(tsSec),
    });
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}

export function projectDepegOpened(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectDepegByVariant(db, "opened", options);
}

export function projectDepegResolved(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectDepegByVariant(db, "resolved", options);
}

interface PeakWorsenedSeenMap {
  [depegEventId: string]: number;   // last seen |peak_deviation_bps|
}

async function loadPeakSeenMap(db: D1Database): Promise<PeakWorsenedSeenMap> {
  const row = await getCache(db, PEAK_WORSENED_CACHE_KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PeakWorsenedSeenMap)
      : {};
  } catch {
    return {};
  }
}

async function savePeakSeenMap(db: D1Database, map: PeakWorsenedSeenMap): Promise<void> {
  await setCache(db, PEAK_WORSENED_CACHE_KEY, JSON.stringify(map));
}

/**
 * For each OPEN depeg row whose magnitude exceeds the previously recorded
 * peak, emit one `depeg.peak_worsened` event. Idempotent because the source
 * row id encodes the new magnitude: re-running with the same DB state is a
 * no-op (the unique index on `(source_table, source_row_id, transition)`
 * absorbs duplicates).
 */
export async function projectDepegPeakWorsened(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const limit = options?.maxRows ?? DEFAULT_BATCH_LIMIT;
  const dryRun = options?.dryRun === true;
  const seenMap = await loadPeakSeenMap(db);
  const nextMap: PeakWorsenedSeenMap = {};

  const sql = `SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
                      started_at, ended_at, start_price, peg_reference, source
                 FROM depeg_events
                 WHERE source = 'live' AND ended_at IS NULL
                 ORDER BY id ASC
                 LIMIT ?`;
  const rowsResult = await db.prepare(sql).bind(limit).all<DepegSourceRow>();

  const rows = rowsResult.results ?? [];
  const events: TapeEventInsert[] = [];
  const nowMs = Date.now();

  for (const row of rows) {
    const absBps = Math.abs(row.peak_deviation_bps);
    const prevAbsBps = seenMap[String(row.id)] ?? 0;
    nextMap[String(row.id)] = Math.max(absBps, prevAbsBps);

    if (absBps <= prevAbsBps) continue;
    if (prevAbsBps === 0) {
      // First time we have seen this open row in the seen-map. Treat it as a
      // baseline observation and do not emit — the row's `depeg.opened` event
      // already carries its initial magnitude. Future runs will only fire on a
      // genuine worsening past this baseline.
      continue;
    }

    const sign = row.direction === "below" ? "−" : "+";
    const sourceRowId = `${row.id}:${absBps}`;
    const transition = "updated";
    const type = "depeg.peak_worsened";

    events.push({
      eventId: buildTapeEventId({ tsMs: nowMs, type, sourceTable: "depeg_events", sourceRowId, transition }),
      type,
      severity: severityForDepegOpened(absBps),
      ts: nowMs,
      endsAt: null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: row.peg_type,
      chain: null,
      title: `${row.symbol} depeg peak worsened (${sign}${absBps} bps)`,
      summary: `Deviation widened to ${sign}${absBps} bps from ${sign}${prevAbsBps} bps.`,
      payload: {
        symbol: row.symbol,
        direction: row.direction,
        absDeviationBps: absBps,
        prevAbsDeviationBps: prevAbsBps,
        signedDeviationBps: row.peak_deviation_bps,
        pegReference: row.peg_reference,
        startedAt: row.started_at,
        depegEventId: row.id,
      },
      sourceTable: "depeg_events",
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id),
      methodologyVersion: getDepegDewsMethodologyVersionAt(row.started_at),
    });
  }

  if (!dryRun) {
    if (events.length > 0) await insertTapeEvents(db, events);
    await savePeakSeenMap(db, nextMap);
  }
  return { projected: events.length, advanced: null };
}
