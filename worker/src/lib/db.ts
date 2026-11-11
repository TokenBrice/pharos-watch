import { D1_BATCH_SIZE } from "./constants";
import { chunkArray } from "./collections";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { buildInClause, D1_MAX_BOUND_PARAMETERS } from "./d1-primitives";
import { toErrorMessage } from "@shared/lib/error-utils";

export { D1_SAFE_IN_CLAUSE_BIND_LIMIT, chunkArray } from "./collections";
export { batchExecute, buildInClause, D1_MAX_BOUND_PARAMETERS, type BatchExecuteOptions } from "./d1-primitives";

export interface AtomicBatchExecuteOptions {
  signal?: AbortSignal;
  returnResults?: false;
}

export interface AtomicBatchExecuteResultOptions {
  signal?: AbortSignal;
  returnResults: true;
}

function d1ErrorMessage(error: unknown): string {
  return toErrorMessage(error);
}

export function isMissingTableError(error: unknown): boolean {
  return d1ErrorMessage(error).toLowerCase().includes("no such table");
}

/** Execute one bounded D1 batch so every statement commits or rolls back together. */
export function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options: AtomicBatchExecuteResultOptions,
): Promise<D1Result[]>;
export function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options?: AtomicBatchExecuteOptions,
): Promise<number>;
export async function executeAtomicBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  options: AtomicBatchExecuteOptions | AtomicBatchExecuteResultOptions = {},
): Promise<number | D1Result[]> {
  if (stmts.length === 0) return options.returnResults ? [] : 0;
  if (stmts.length > D1_BATCH_SIZE) {
    throw new RangeError(
      `executeAtomicBatch supports at most ${D1_BATCH_SIZE} statements (received ${stmts.length})`,
    );
  }

  const { signal } = options;
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  const result = await runWithOverloadRetry(() => db.batch(stmts), 3, signal);
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  if (options.returnResults) return result;
  return result.reduce((changes, row) => changes + Number(row?.meta?.changes ?? 0), 0);
}

/**
 * Prepare bounded multi-row INSERT statements without exceeding D1's bind limit.
 * `insertSql` must contain the INSERT target/columns but not a VALUES clause.
 */
export function prepareMultiRowInsertStatements(
  db: D1Database,
  insertSql: string,
  rows: readonly (readonly unknown[])[],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const columnCount = rows[0]?.length ?? 0;
  if (columnCount <= 0 || columnCount > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(
      `prepareMultiRowInsertStatements requires 1-${D1_MAX_BOUND_PARAMETERS} columns (received ${columnCount})`,
    );
  }
  if (rows.some((row) => row.length !== columnCount)) {
    throw new RangeError("prepareMultiRowInsertStatements requires rows with a consistent column count");
  }

  const rowsPerStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / columnCount);
  return chunkArray(rows, rowsPerStatement).map((chunk) => {
    const rowPlaceholders = `(${new Array(columnCount).fill("?").join(", ")})`;
    const valuesSql = new Array(chunk.length).fill(rowPlaceholders).join(", ");
    return db.prepare(`${insertSql} VALUES ${valuesSql}`).bind(...chunk.flat());
  });
}

/** Build WHERE, LIMIT, and OFFSET clauses for paginated SQL queries */
export function buildPaginatedQuery(opts: { conditions: string[]; limit: number; offset: number }): {
  where: string;
  limitClause: string;
  offsetClause: string;
  paginationBindings: number[];
} {
  const where = opts.conditions.length > 0 ? ` WHERE ${opts.conditions.join(" AND ")}` : "";
  const limitClause = opts.limit > 0 ? " LIMIT ?" : opts.offset > 0 ? " LIMIT -1" : "";
  const offsetClause = opts.offset > 0 ? " OFFSET ?" : "";
  const paginationBindings: number[] = [];
  if (opts.limit > 0) paginationBindings.push(opts.limit);
  if (opts.offset > 0) paginationBindings.push(opts.offset);
  return { where, limitClause, offsetClause, paginationBindings };
}

export async function runChunkedInFilter<T>(
  values: readonly T[],
  buildSql: (inClauseSql: string) => string,
  runQuery: (whereSql: string, binds: unknown[]) => Promise<void>,
): Promise<void> {
  for (const chunk of chunkArray(values)) {
    const clause = buildInClause(chunk);
    await runQuery(buildSql(clause.sql), clause.binds);
  }
}

export async function runChunkedInRead<T, Row>(
  values: readonly T[],
  buildSql: (inClauseSql: string) => string,
  readRows: (whereSql: string, binds: unknown[]) => Promise<Row[]>,
): Promise<Row[]> {
  const rows: Row[] = [];
  await runChunkedInFilter(values, buildSql, async (whereSql, binds) => {
    rows.push(...(await readRows(whereSql, binds)));
  });
  return rows;
}
