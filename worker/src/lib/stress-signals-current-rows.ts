import { readDewsPublishedGenerationResult } from "./dews-publication-pointer";

export interface StressSignalCurrentRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string;
  computed_at: number;
}

export type StressSignalCurrentRowForCoin = Omit<StressSignalCurrentRow, "stablecoin_id">;

export interface PreviousStressSignalCurrentRow {
  stablecoin_id: string;
  signals_json: string;
  band: string;
  computed_at: number;
}

interface CurrentRowsOptions {
  staleAfterSec: number;
  onLatestReadError?: (error: unknown) => void;
}

interface AllRowsQueries {
  latest: string;
  latestBounded: string;
  legacy: string;
  legacyBounded: string;
}

interface SingleRowQueries {
  latest: string;
  latestBounded: string;
  legacy: string;
  legacyBounded: string;
}

type CompletedDewsScope =
  | { status: "scoped"; completedAt: number }
  | { status: "no-pointer" }
  | { status: "unavailable"; reason: string };

const API_LATEST_ALL_SQL = `SELECT /* pharos:stress-signals:latest-all */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest`;

const API_LATEST_ALL_BOUNDED_SQL = `SELECT /* pharos:stress-signals:latest-all */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest
         WHERE computed_at <= ?`;

const API_LEGACY_ALL_SQL = `SELECT /* pharos:stress-signals:legacy-latest-all */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
       FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) as max_at
         FROM stress_signals GROUP BY stablecoin_id
       ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const API_LEGACY_ALL_BOUNDED_SQL = `SELECT /* pharos:stress-signals:legacy-latest-all */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
       FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) as max_at
         FROM stress_signals
         WHERE computed_at <= ?
         GROUP BY stablecoin_id
       ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const API_LATEST_ONE_SQL = `SELECT /* pharos:stress-signals:latest-one */
           score, band, signals_json, computed_at
         FROM stress_signals_latest
         WHERE stablecoin_id = ?`;

const API_LATEST_ONE_BOUNDED_SQL = `SELECT /* pharos:stress-signals:latest-one */
           score, band, signals_json, computed_at
         FROM stress_signals_latest
         WHERE stablecoin_id = ? AND computed_at <= ?
         ORDER BY computed_at DESC LIMIT 1`;

const API_LEGACY_ONE_SQL = `SELECT /* pharos:stress-signals:legacy-latest-one */
         score, band, signals_json, computed_at
       FROM stress_signals
       WHERE stablecoin_id = ?
       ORDER BY computed_at DESC LIMIT 1`;

const API_LEGACY_ONE_BOUNDED_SQL = `SELECT /* pharos:stress-signals:legacy-latest-one */
         score, band, signals_json, computed_at
       FROM stress_signals
       WHERE stablecoin_id = ? AND computed_at <= ?
       ORDER BY computed_at DESC LIMIT 1`;

const TELEGRAM_LATEST_ALL_SQL = `SELECT /* pharos:telegram-dispatch:dews-latest */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest`;

const TELEGRAM_LATEST_ALL_BOUNDED_SQL = `SELECT /* pharos:telegram-dispatch:dews-latest */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest
         WHERE computed_at <= ?`;

const TELEGRAM_LEGACY_ALL_SQL = `SELECT /* pharos:telegram-dispatch:dews-legacy */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) AS max_at
           FROM stress_signals GROUP BY stablecoin_id
      ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const TELEGRAM_LEGACY_ALL_BOUNDED_SQL = `SELECT /* pharos:telegram-dispatch:dews-legacy */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) AS max_at
             FROM stress_signals
            WHERE computed_at <= ?
            GROUP BY stablecoin_id
      ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const DEWS_PREVIOUS_LATEST_ALL_SQL = `SELECT /* pharos:dews:previous-stress-latest */
           stablecoin_id, signals_json, band, computed_at
         FROM stress_signals_latest`;

const DEWS_PREVIOUS_LATEST_ALL_BOUNDED_SQL = `SELECT /* pharos:dews:previous-stress-latest */
           stablecoin_id, signals_json, band, computed_at
         FROM stress_signals_latest
         WHERE computed_at <= ?`;

const DEWS_PREVIOUS_LEGACY_ALL_SQL = `SELECT /* pharos:dews:previous-stress-legacy */
         s.stablecoin_id, s.signals_json, s.band, s.computed_at
       FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) as max_at
         FROM stress_signals GROUP BY stablecoin_id
       ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const DEWS_PREVIOUS_LEGACY_ALL_BOUNDED_SQL = `SELECT /* pharos:dews:previous-stress-legacy */
         s.stablecoin_id, s.signals_json, s.band, s.computed_at
       FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) as max_at
         FROM stress_signals
         WHERE computed_at <= ?
         GROUP BY stablecoin_id
       ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

const API_ALL_QUERIES: AllRowsQueries = {
  latest: API_LATEST_ALL_SQL,
  latestBounded: API_LATEST_ALL_BOUNDED_SQL,
  legacy: API_LEGACY_ALL_SQL,
  legacyBounded: API_LEGACY_ALL_BOUNDED_SQL,
};

const API_ONE_QUERIES: SingleRowQueries = {
  latest: API_LATEST_ONE_SQL,
  latestBounded: API_LATEST_ONE_BOUNDED_SQL,
  legacy: API_LEGACY_ONE_SQL,
  legacyBounded: API_LEGACY_ONE_BOUNDED_SQL,
};

const TELEGRAM_ALL_QUERIES: AllRowsQueries = {
  latest: TELEGRAM_LATEST_ALL_SQL,
  latestBounded: TELEGRAM_LATEST_ALL_BOUNDED_SQL,
  legacy: TELEGRAM_LEGACY_ALL_SQL,
  legacyBounded: TELEGRAM_LEGACY_ALL_BOUNDED_SQL,
};

const DEWS_PREVIOUS_ALL_QUERIES: AllRowsQueries = {
  latest: DEWS_PREVIOUS_LATEST_ALL_SQL,
  latestBounded: DEWS_PREVIOUS_LATEST_ALL_BOUNDED_SQL,
  legacy: DEWS_PREVIOUS_LEGACY_ALL_SQL,
  legacyBounded: DEWS_PREVIOUS_LEGACY_ALL_BOUNDED_SQL,
};

function isStressSignalRowStale(
  row: { computed_at: number } | null | undefined,
  nowSec: number,
  staleAfterSec: number,
): boolean {
  return !row || nowSec - row.computed_at > staleAfterSec;
}

function areStressSignalRowsStale(
  rows: readonly { computed_at: number }[],
  nowSec: number,
  staleAfterSec: number,
): boolean {
  if (rows.length === 0) return true;
  const newestComputedAt = rows.reduce(
    (max, row) => Math.max(max, Number.isFinite(row.computed_at) ? row.computed_at : 0),
    0,
  );
  return newestComputedAt <= 0 || nowSec - newestComputedAt > staleAfterSec;
}

function isCompleteLatestGeneration<Row extends { computed_at: number }>(
  rows: readonly Row[],
  completedAt: number | null,
): boolean {
  return completedAt != null
    && rows.length > 0
    && rows.every((row) => row.computed_at === completedAt);
}

export function mergeNewestStressSignalRows<Row extends { stablecoin_id: string; computed_at: number }>(
  legacyRows: readonly Row[],
  latestRows: readonly Row[],
): Row[] {
  const byId = new Map<string, Row>();
  for (const row of legacyRows) {
    byId.set(row.stablecoin_id, row);
  }
  for (const row of latestRows) {
    const existing = byId.get(row.stablecoin_id);
    if (!existing || row.computed_at >= existing.computed_at) {
      byId.set(row.stablecoin_id, row);
    }
  }
  return [...byId.values()];
}

async function loadCompletedDewsScope(db: D1Database, nowSec: number): Promise<CompletedDewsScope> {
  const result = await readDewsPublishedGenerationResult(db, nowSec);
  switch (result.status) {
    case "ok":
      return { status: "scoped", completedAt: result.computedAt };
    case "no-pointer":
      return { status: "no-pointer" };
    case "invalid-pointer":
      return { status: "unavailable", reason: result.reason };
    case "read-failed":
      return { status: "unavailable", reason: result.error };
  }
}

function prepareCompletedAtScoped(
  db: D1Database,
  unboundedSql: string,
  boundedSql: string,
  completedAt: number | null,
  ...leadingBinds: Array<string | number>
): D1PreparedStatement {
  const statement = db.prepare(completedAt == null ? unboundedSql : boundedSql);
  if (completedAt == null) {
    return leadingBinds.length > 0 ? statement.bind(...leadingBinds) : statement;
  }
  return statement.bind(...leadingBinds, completedAt);
}

async function loadCurrentRows<Row extends { stablecoin_id: string; computed_at: number }>(
  db: D1Database,
  nowSec: number,
  queries: AllRowsQueries,
  options: CurrentRowsOptions,
): Promise<Row[]> {
  const completedScope = await loadCompletedDewsScope(db, nowSec);
  if (completedScope.status === "unavailable") {
    return [];
  }
  const completedAt = completedScope.status === "scoped" ? completedScope.completedAt : null;
  let latestRows: Row[] = [];
  try {
    const latestStmt = prepareCompletedAtScoped(
      db,
      queries.latest,
      queries.latestBounded,
      completedAt,
    );
    const rows = await latestStmt.all<Row>();
    latestRows = rows.results ?? [];
  } catch (error) {
    latestRows = [];
    options.onLatestReadError?.(error);
  }

  // A scoped publication pointer is written only after the latest table has
  // passed its exact generation-count check. When every returned row belongs
  // to that generation, canonical history cannot add a newer or legacy-only
  // row, so avoid the retained-history GROUP BY scan entirely.
  if (
    isCompleteLatestGeneration(latestRows, completedAt)
    && !areStressSignalRowsStale(latestRows, nowSec, options.staleAfterSec)
  ) {
    return latestRows;
  }

  const legacyStmt = prepareCompletedAtScoped(
    db,
    queries.legacy,
    queries.legacyBounded,
    completedAt,
  );
  const legacyRows = await legacyStmt.all<Row>();
  const legacyResults = legacyRows.results ?? [];
  if (legacyResults.length === 0) return latestRows;
  if (areStressSignalRowsStale(latestRows, nowSec, options.staleAfterSec)) return legacyResults;
  return mergeNewestStressSignalRows(legacyResults, latestRows);
}

async function loadCurrentRowForCoin<Row extends { computed_at: number }>(
  db: D1Database,
  stablecoinId: string,
  nowSec: number,
  queries: SingleRowQueries,
  options: CurrentRowsOptions,
): Promise<Row | null> {
  const completedScope = await loadCompletedDewsScope(db, nowSec);
  if (completedScope.status === "unavailable") {
    return null;
  }
  const completedAt = completedScope.status === "scoped" ? completedScope.completedAt : null;
  let latest: Row | null = null;
  try {
    const latestStmt = prepareCompletedAtScoped(
      db,
      queries.latest,
      queries.latestBounded,
      completedAt,
      stablecoinId,
    );
    latest = await latestStmt.first<Row>();
    if (latest && !isStressSignalRowStale(latest, nowSec, options.staleAfterSec)) {
      return latest;
    }
  } catch (error) {
    latest = null;
    options.onLatestReadError?.(error);
  }

  const legacyStmt = prepareCompletedAtScoped(
    db,
    queries.legacy,
    queries.legacyBounded,
    completedAt,
    stablecoinId,
  );
  return await legacyStmt.first<Row>() ?? latest;
}

export async function loadStressSignalCurrentRows(
  db: D1Database,
  nowSec: number,
  options: CurrentRowsOptions,
): Promise<{ results: StressSignalCurrentRow[] }> {
  return {
    results: await loadCurrentRows<StressSignalCurrentRow>(db, nowSec, API_ALL_QUERIES, options),
  };
}

export async function loadStressSignalCurrentRowForCoin(
  db: D1Database,
  stablecoinId: string,
  nowSec: number,
  options: CurrentRowsOptions,
): Promise<StressSignalCurrentRowForCoin | null> {
  return loadCurrentRowForCoin<StressSignalCurrentRowForCoin>(db, stablecoinId, nowSec, API_ONE_QUERIES, options);
}

export function loadTelegramDewsCurrentRows(
  db: D1Database,
  nowSec: number,
  options: CurrentRowsOptions,
): Promise<StressSignalCurrentRow[]> {
  return loadCurrentRows<StressSignalCurrentRow>(db, nowSec, TELEGRAM_ALL_QUERIES, options);
}

export function loadPreviousStressSignalCurrentRows(
  db: D1Database,
  nowSec: number,
  options: CurrentRowsOptions,
): Promise<PreviousStressSignalCurrentRow[]> {
  return loadCurrentRows<PreviousStressSignalCurrentRow>(db, nowSec, DEWS_PREVIOUS_ALL_QUERIES, options);
}
