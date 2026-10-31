import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildDewsStablecoinIdsDigest,
  readDewsPublishedGenerationResult,
} from "./dews-publication-pointer";
import { runWithOverloadRetry } from "./d1-overload-retry";

export interface StressSignalCurrentRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string;
  computed_at: number;
}

export type StressSignalCurrentRowForCoin = Omit<StressSignalCurrentRow, "stablecoin_id">;

export type PublishedStressSignalGenerationResult =
  | {
      status: "ok";
      computedAt: number;
      rows: StressSignalCurrentRow[];
      exactCoverageVerified: boolean;
    }
  | { status: "unavailable"; sourceStatus: "missing" | "read-failed" | "invalid"; reason: string };

export interface PreviousStressSignalCurrentRow {
  stablecoin_id: string;
  signals_json: string;
  band: string;
  computed_at: number;
}

interface CurrentRowsOptions {
  staleAfterSec: number;
  onReadError?: (error: unknown) => void;
  /**
   * The accepted-generation pointer is unreadable or invalid, so no rows are
   * served. Consumers of optional previous evidence (DEWS smoothing)
   * record this as unavailable evidence without treating it as a failed read
   * that holds their own publication: only a later publication can rewrite the
   * pointer, so a hold here would never repair it.
   */
  onGenerationUnavailable?: (reason: string) => void;
}

interface StressSignalCurrentRowsQueries {
  latest: string;
  exact: string;
  legacy: string;
}

type CompletedDewsScope =
  | {
      status: "scoped";
      completedAt: number;
      expectedRowCount: number | null;
      stablecoinIdsDigest: string | null;
    }
  // Bootstrap has no accepted generation yet; a failed/invalid pointer read is
  // unavailable evidence and must be reported, never treated as a first run.
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

interface StressSignalQueryTags {
  latest: string;
  exact: string;
  legacy: string;
}

function buildStressSignalCurrentRowsQueries(input: {
  tags: StressSignalQueryTags;
  columns: readonly string[];
  scope: "all" | "one";
}): StressSignalCurrentRowsQueries {
  const columns = input.columns.join(", ");
  const legacyColumns = input.columns.map((column) => `s.${column}`).join(", ");
  const one = input.scope === "one";
  const latestBoundedWhere = one
    ? "\nWHERE stablecoin_id = ? AND computed_at <= ?\nORDER BY computed_at DESC LIMIT 1"
    : "\nWHERE computed_at <= ?";
  const exactWhere = one
    ? "\nWHERE stablecoin_id = ? AND computed_at = ?\nLIMIT 1"
    : "\nWHERE computed_at = ?\nORDER BY stablecoin_id ASC";
  const legacy = one
    ? `SELECT /* ${input.tags.legacy} */ ${columns}
FROM stress_signals
WHERE stablecoin_id = ? AND computed_at <= ?
ORDER BY computed_at DESC LIMIT 1`
    : `SELECT /* ${input.tags.legacy} */ ${legacyColumns}
FROM stress_signals s
INNER JOIN (
  SELECT stablecoin_id, MAX(computed_at) AS max_at
  FROM stress_signals
  WHERE computed_at <= ?
  GROUP BY stablecoin_id
) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`;

  return {
    latest: `SELECT /* ${input.tags.latest} */ ${columns}
FROM stress_signals_latest${latestBoundedWhere}`,
    exact: `SELECT /* ${input.tags.exact} */ ${columns}
FROM stress_signal_publication_rows${exactWhere}`,
    legacy,
  };
}

const API_ALL_QUERIES = buildStressSignalCurrentRowsQueries({
  tags: {
    latest: "pharos:stress-signals:latest-all",
    exact: "pharos:stress-signals:published-exact-all",
    legacy: "pharos:stress-signals:legacy-latest-all",
  },
  columns: ["stablecoin_id", "score", "band", "signals_json", "computed_at"],
  scope: "all",
});

const API_ONE_QUERIES = buildStressSignalCurrentRowsQueries({
  tags: {
    latest: "pharos:stress-signals:latest-one",
    exact: "pharos:stress-signals:published-exact-one",
    legacy: "pharos:stress-signals:legacy-latest-one",
  },
  columns: ["score", "band", "signals_json", "computed_at"],
  scope: "one",
});

const TELEGRAM_ALL_QUERIES = buildStressSignalCurrentRowsQueries({
  tags: {
    latest: "pharos:telegram-dispatch:dews-latest",
    exact: "pharos:telegram-dispatch:dews-published-exact",
    legacy: "pharos:telegram-dispatch:dews-legacy",
  },
  columns: ["stablecoin_id", "score", "band", "signals_json", "computed_at"],
  scope: "all",
});

const DEWS_PREVIOUS_ALL_QUERIES = buildStressSignalCurrentRowsQueries({
  tags: {
    latest: "pharos:dews:previous-stress-latest",
    exact: "pharos:dews:previous-stress-published-exact",
    legacy: "pharos:dews:previous-stress-legacy",
  },
  columns: ["stablecoin_id", "signals_json", "band", "computed_at"],
  scope: "all",
});

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

export async function loadPublishedStressSignalGeneration(
  db: D1Database,
  nowSec: number,
): Promise<PublishedStressSignalGenerationResult> {
  const pointer = await readDewsPublishedGenerationResult(db, nowSec);
  if (pointer.status !== "ok") {
    const detail = pointer.status === "read-failed"
      ? pointer.error
      : pointer.status === "invalid-pointer"
        ? pointer.reason
        : "publication pointer is missing";
    return {
      status: "unavailable",
      sourceStatus: pointer.status === "read-failed" ? "read-failed" : pointer.status === "invalid-pointer" ? "invalid" : "missing",
      reason: `${pointer.status}:${detail}`,
    };
  }

  let rows: StressSignalCurrentRow[];
  try {
    const statement = db.prepare(
      `SELECT /* pharos:stress-signals:published-exact */
              stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signal_publication_rows
        WHERE computed_at = ?
        ORDER BY stablecoin_id ASC`,
    )
      .bind(pointer.computedAt);
    const result = await runWithOverloadRetry(() => statement.all<StressSignalCurrentRow>());
    rows = result.results ?? [];
  } catch (error) {
    return {
      status: "unavailable",
      sourceStatus: "read-failed",
      reason: `generation-read-failed:${toErrorMessage(error)}`,
    };
  }

  if (rows.length === 0) {
    return { status: "unavailable", sourceStatus: "missing", reason: `published generation ${pointer.computedAt} has no rows` };
  }
  if (pointer.expectedRowCount == null || pointer.stablecoinIdsDigest == null) {
    return {
      status: "ok",
      computedAt: pointer.computedAt,
      rows,
      exactCoverageVerified: false,
    };
  }

  const actualDigest = buildDewsStablecoinIdsDigest(rows.map((row) => row.stablecoin_id));
  if (rows.length !== pointer.expectedRowCount || actualDigest !== pointer.stablecoinIdsDigest) {
    return {
      status: "unavailable",
      sourceStatus: "invalid",
      reason: `published generation coverage mismatch: rows=${rows.length}/${pointer.expectedRowCount}`,
    };
  }
  return {
    status: "ok",
    computedAt: pointer.computedAt,
    rows,
    exactCoverageVerified: true,
  };
}

function isCompleteLatestGeneration<Row extends { stablecoin_id: string; computed_at: number }>(
  rows: readonly Row[],
  completedAt: number | null,
  expectedRowCount: number | null,
  stablecoinIdsDigest: string | null,
): boolean {
  return completedAt != null
    && expectedRowCount != null
    && stablecoinIdsDigest != null
    && rows.length === expectedRowCount
    && rows.every((row) => row.computed_at === completedAt)
    && buildDewsStablecoinIdsDigest(rows.map((row) => row.stablecoin_id)) === stablecoinIdsDigest;
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
      return {
        status: "scoped",
        completedAt: result.computedAt,
        expectedRowCount: result.expectedRowCount,
        stablecoinIdsDigest: result.stablecoinIdsDigest,
      };
    case "no-pointer":
      return { status: "missing" };
    case "invalid-pointer":
      return { status: "unavailable", reason: result.reason };
    case "read-failed":
      return { status: "unavailable", reason: result.error };
  }
}


async function loadCurrentRows<Row extends { stablecoin_id: string; computed_at: number }>(
  db: D1Database,
  nowSec: number,
  queries: StressSignalCurrentRowsQueries,
  options: CurrentRowsOptions,
): Promise<Row[]> {
  const completedScope = await loadCompletedDewsScope(db, nowSec);
  if (completedScope.status === "missing") return [];
  if (completedScope.status === "unavailable") {
    options.onGenerationUnavailable?.(completedScope.reason);
    return [];
  }
  const { completedAt, expectedRowCount, stablecoinIdsDigest } = completedScope;
  let latestRows: Row[] = [];
  try {
    const latestStmt = db.prepare(queries.latest).bind(completedAt);
    const rows = await runWithOverloadRetry(() => latestStmt.all<Row>());
    latestRows = rows.results ?? [];
  } catch (error) {
    latestRows = [];
    options.onReadError?.(error);
  }

  // A current publication pointer proves the completed row count and ID set.
  // Only that exact generation can bypass the retained-history GROUP BY scan;
  // legacy pointers and partial chunk replacements keep the canonical merge.
  if (
    isCompleteLatestGeneration(latestRows, completedAt, expectedRowCount, stablecoinIdsDigest)
    && !areStressSignalRowsStale(latestRows, nowSec, options.staleAfterSec)
  ) {
    return latestRows;
  }

  if (completedAt != null && expectedRowCount != null && stablecoinIdsDigest != null) {
    try {
      const exactStmt = db.prepare(queries.exact).bind(completedAt);
      const exactRows = await runWithOverloadRetry(() => exactStmt.all<Row>());
      const exactResults = exactRows.results ?? [];
      return isCompleteLatestGeneration(
        exactResults,
        completedAt,
        expectedRowCount,
        stablecoinIdsDigest,
      ) ? exactResults : [];
    } catch (error) {
      options.onReadError?.(error);
      return latestRows;
    }
  }

  let legacyResults: Row[];
  try {
    const legacyStmt = db.prepare(queries.legacy).bind(completedAt);
    const legacyRows = await runWithOverloadRetry(() => legacyStmt.all<Row>());
    legacyResults = legacyRows.results ?? [];
  } catch (error) {
    options.onReadError?.(error);
    return latestRows;
  }
  if (legacyResults.length === 0) return latestRows;
  if (areStressSignalRowsStale(latestRows, nowSec, options.staleAfterSec)) return legacyResults;
  return mergeNewestStressSignalRows(legacyResults, latestRows);
}

async function loadCurrentRowForCoin<Row extends { computed_at: number }>(
  db: D1Database,
  stablecoinId: string,
  nowSec: number,
  queries: StressSignalCurrentRowsQueries,
  options: CurrentRowsOptions,
): Promise<Row | null> {
  const completedScope = await loadCompletedDewsScope(db, nowSec);
  if (completedScope.status === "missing") return null;
  if (completedScope.status === "unavailable") {
    options.onGenerationUnavailable?.(completedScope.reason);
    return null;
  }
  const { completedAt } = completedScope;
  const hasExactCoverage = completedScope.expectedRowCount != null
    && completedScope.stablecoinIdsDigest != null;
  let latest: Row | null = null;
  try {
    const latestStmt = db.prepare(queries.latest).bind(stablecoinId, completedAt);
    latest = await runWithOverloadRetry(() => latestStmt.first<Row>());
    if (
      latest
      && (!hasExactCoverage || latest.computed_at === completedAt)
      && !isStressSignalRowStale(latest, nowSec, options.staleAfterSec)
    ) {
      return latest;
    }
  } catch (error) {
    latest = null;
    options.onReadError?.(error);
  }
  if (completedAt != null && hasExactCoverage) {
    try {
      const exactStmt = db.prepare(queries.exact).bind(stablecoinId, completedAt);
      return await runWithOverloadRetry(() => exactStmt.first<Row>());
    } catch (error) {
      options.onReadError?.(error);
      return latest;
    }
  }

  try {
    const legacyStmt = db.prepare(queries.legacy).bind(stablecoinId, completedAt);
    return await runWithOverloadRetry(() => legacyStmt.first<Row>()) ?? latest;
  } catch (error) {
    options.onReadError?.(error);
    return latest;
  }
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
