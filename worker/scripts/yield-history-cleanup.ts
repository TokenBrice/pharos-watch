#!/usr/bin/env npx tsx

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  parseYieldHistoryWriterPause,
  YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
} from "../src/lib/yield-history-cleanup";
import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../src/lib/yield-history-ownership-handoffs";

const DB_NAME = "stablecoin-db";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(SCRIPT_DIR, "..");

const YIELD_HISTORY_COLUMNS = [
  "stablecoin_id",
  "source_key",
  "recorded_at",
  "is_best",
  "apy",
  "apy_base",
  "apy_reward",
  "exchange_rate",
  "source_tvl_usd",
  "data_source",
  "warning_signals",
  "yield_source",
  "yield_type",
] as const;

interface YieldHistoryCleanupTarget {
  stablecoinId: string;
  sourceKeys: string[];
}

export interface YieldHistoryCleanupRow {
  stablecoin_id: string;
  source_key: string | null;
  recorded_at: number;
  is_best: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
  data_source: string;
  warning_signals: string | null;
  yield_source: string | null;
  yield_type: string | null;
}

export interface YieldHistoryCleanupArtifact {
  generatedAt: number;
  operator: string | null;
  targets: YieldHistoryCleanupTarget[];
  rowCount: number;
  rows: YieldHistoryCleanupRow[];
}

export interface YieldHistoryCleanupSummary {
  totalRows: number;
  byStablecoin: Record<string, number>;
  byStablecoinSource: Record<string, number>;
}

function listYieldHistoryCleanupTargets(): YieldHistoryCleanupTarget[] {
  return Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS).map(([stablecoinId, sourceKeys]) => ({
    stablecoinId,
    sourceKeys,
  }));
}

function buildYieldHistoryWriterPausePayload(
  reason = "yield-history-cleanup",
  operator: string | null = null,
  pausedAt = Math.floor(Date.now() / 1000),
) {
  return {
    reason,
    pausedAt,
    operator,
  };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlValue(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${escapeSqlString(String(value))}'`;
}

function buildTargetWhereClause(target: YieldHistoryCleanupTarget): string {
  const sourceList = target.sourceKeys.map((value) => sqlValue(value)).join(", ");
  const sourceClauses = [
    "source_key IS NULL",
    `source_key = ${sqlValue(LEGACY_BEST_YIELD_SOURCE_KEY)}`,
    ...(target.sourceKeys.length > 0 ? [`source_key IN (${sourceList})`] : []),
  ];
  return `stablecoin_id = ${sqlValue(target.stablecoinId)} AND (${sourceClauses.join(" OR ")})`;
}

function buildSelectSql(target: YieldHistoryCleanupTarget): string {
  return `SELECT ${YIELD_HISTORY_COLUMNS.join(", ")} FROM yield_history WHERE ${buildTargetWhereClause(target)} ORDER BY stablecoin_id ASC, recorded_at ASC, source_key ASC`;
}

function buildDeleteSql(target: YieldHistoryCleanupTarget): string {
  return `DELETE FROM yield_history WHERE ${buildTargetWhereClause(target)}`;
}

export function summarizeYieldHistoryCleanupRows(rows: readonly YieldHistoryCleanupRow[]): YieldHistoryCleanupSummary {
  const byStablecoin: Record<string, number> = {};
  const byStablecoinSource: Record<string, number> = {};

  for (const row of rows) {
    byStablecoin[row.stablecoin_id] = (byStablecoin[row.stablecoin_id] ?? 0) + 1;
    const sourceKey = row.source_key ?? "null";
    const sourceId = `${row.stablecoin_id}:${sourceKey}`;
    byStablecoinSource[sourceId] = (byStablecoinSource[sourceId] ?? 0) + 1;
  }

  return {
    totalRows: rows.length,
    byStablecoin,
    byStablecoinSource,
  };
}

export function createYieldHistoryCleanupArtifact(
  rows: YieldHistoryCleanupRow[],
  operator: string | null,
): YieldHistoryCleanupArtifact {
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    operator,
    targets: listYieldHistoryCleanupTargets(),
    rowCount: rows.length,
    rows,
  };
}

export function loadCleanupRowsFromSqlite(dbPath: string): YieldHistoryCleanupRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows: YieldHistoryCleanupRow[] = [];
    for (const target of listYieldHistoryCleanupTargets()) {
      const statement = db.prepare(buildSelectSql(target));
      const targetRows = statement.all() as unknown as YieldHistoryCleanupRow[];
      for (const row of targetRows) {
        rows.push(row);
      }
    }
    return rows;
  } finally {
    db.close();
  }
}

export function deleteCleanupRowsFromSqlite(dbPath: string): YieldHistoryCleanupSummary {
  const db = new DatabaseSync(dbPath);
  try {
    for (const target of listYieldHistoryCleanupTargets()) {
      db.exec(buildDeleteSql(target));
    }
    return summarizeYieldHistoryCleanupRows(loadCleanupRowsFromSqlite(dbPath));
  } finally {
    db.close();
  }
}

export function restoreCleanupRowsToSqlite(
  dbPath: string,
  rows: readonly YieldHistoryCleanupRow[],
): void {
  const db = new DatabaseSync(dbPath);
  try {
    const placeholders = YIELD_HISTORY_COLUMNS.map(() => "?").join(", ");
    const insertSql = `INSERT OR REPLACE INTO yield_history (${YIELD_HISTORY_COLUMNS.join(", ")}) VALUES (${placeholders})`;
    const statement = db.prepare(insertSql);
    for (const row of rows) {
      statement.run(
        row.stablecoin_id,
        row.source_key,
        row.recorded_at,
        row.is_best,
        row.apy,
        row.apy_base,
        row.apy_reward,
        row.exchange_rate,
        row.source_tvl_usd,
        row.data_source,
        row.warning_signals,
        row.yield_source,
        row.yield_type,
      );
    }
  } finally {
    db.close();
  }
}

function executeWranglerCommand(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  });
}

function queryRemoteRows(sql: string, remote: boolean): Array<Record<string, unknown>> {
  const output = executeWranglerCommand([
    "d1",
    "execute",
    DB_NAME,
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

function execRemoteStatements(statements: string[], remote: boolean): void {
  if (statements.length === 0) return;
  const tempDir = mkdtempSync(join(tmpdir(), "yield-history-cleanup-"));
  const filePath = join(tempDir, "cleanup.sql");
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(filePath, statements.join(";\n") + ";\n");
    executeWranglerCommand([
      "d1",
      "execute",
      DB_NAME,
      remote ? "--remote" : "--local",
      "--json",
      "--file",
      filePath,
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function loadCleanupRowsFromWrangler(remote: boolean): YieldHistoryCleanupRow[] {
  const rows: YieldHistoryCleanupRow[] = [];
  for (const target of listYieldHistoryCleanupTargets()) {
    const targetRows = queryRemoteRows(buildSelectSql(target), remote) as unknown as YieldHistoryCleanupRow[];
    for (const row of targetRows) {
      rows.push(row);
    }
  }
  return rows;
}

function deleteCleanupRowsFromWrangler(remote: boolean): void {
  execRemoteStatements(
    listYieldHistoryCleanupTargets().map((target) => buildDeleteSql(target)),
    remote,
  );
}

function restoreCleanupRowsToWrangler(rows: readonly YieldHistoryCleanupRow[], remote: boolean): void {
  const statements = rows.map((row) => {
    const values = YIELD_HISTORY_COLUMNS.map((column) => sqlValue(row[column]));
    return `INSERT OR REPLACE INTO yield_history (${YIELD_HISTORY_COLUMNS.join(", ")}) VALUES (${values.join(", ")})`;
  });
  execRemoteStatements(statements, remote);
}

function readWriterPauseFromWrangler(remote: boolean): ReturnType<typeof parseYieldHistoryWriterPause> {
  const rows = queryRemoteRows(
    // SAFETY: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY is a fixed repo constant,
    // not user input, and sqlValue() still quotes it defensively.
    `SELECT value, updated_at FROM cache WHERE key = ${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)} LIMIT 1`,
    remote,
  );
  const row = rows[0] as { value?: string; updated_at?: number } | undefined;
  if (!row || typeof row.value !== "string" || typeof row.updated_at !== "number") {
    return null;
  }
  return parseYieldHistoryWriterPause({ value: row.value, updatedAt: row.updated_at });
}

function setWriterPauseInWrangler(remote: boolean, operator: string | null): void {
  const payload = buildYieldHistoryWriterPausePayload("yield-history-cleanup", operator);
  execRemoteStatements([
    `INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)}, ${sqlValue(JSON.stringify(payload))}, ${payload.pausedAt})`,
  ], remote);
}

function clearWriterPauseInWrangler(remote: boolean): void {
  execRemoteStatements([
    // SAFETY: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY is a fixed repo constant,
    // not user input, and sqlValue() still quotes it defensively.
    `DELETE FROM cache WHERE key = ${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)}`,
  ], remote);
}

function isYieldWriterActiveInWrangler(remote: boolean): boolean {
  const now = Math.floor(Date.now() / 1000);
  const rows = queryRemoteRows(
    `SELECT lease_until FROM cron_leases WHERE job = 'sync-yield-data' LIMIT 1`,
    remote,
  );
  const leaseUntil = rows[0] && typeof rows[0].lease_until === "number"
    ? rows[0].lease_until
    : null;
  return leaseUntil != null && leaseUntil >= now;
}

function parseFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const sqlitePath = parseValue(argv, "--sqlite");
  const exportPath = parseValue(argv, "--export");
  const restorePath = parseValue(argv, "--restore");
  const operator = parseValue(argv, "--operator");
  const remote = !parseFlag(argv, "--local");
  const execute = parseFlag(argv, "--execute");
  const armWriterPause = parseFlag(argv, "--arm-writer-pause");
  const clearWriterPause = parseFlag(argv, "--clear-writer-pause");
  const confirmation = parseValue(argv, "--confirm");

  if (armWriterPause && sqlitePath) {
    throw new Error("--arm-writer-pause is only supported with Wrangler D1 mode");
  }
  if (clearWriterPause && sqlitePath) {
    throw new Error("--clear-writer-pause is only supported with Wrangler D1 mode");
  }

  if (armWriterPause) {
    setWriterPauseInWrangler(remote, operator);
    printJson({
      armed: true,
      key: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
      operator,
      remote,
    });
    return;
  }

  if (clearWriterPause) {
    clearWriterPauseInWrangler(remote);
    printJson({
      cleared: true,
      key: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
      remote,
    });
    return;
  }

  if (restorePath) {
    if (!sqlitePath) {
      if (!execute) {
        throw new Error("Refusing remote restore without --execute");
      }
      if (confirmation !== "yield-history-cleanup") {
        throw new Error("Refusing remote restore without --confirm yield-history-cleanup");
      }
      const writerPause = readWriterPauseFromWrangler(remote);
      if (!writerPause) {
        throw new Error("Writer pause guard is not armed. Run --arm-writer-pause before remote restore.");
      }
      if (isYieldWriterActiveInWrangler(remote)) {
        throw new Error("sync-yield-data lease is active; aborting restore.");
      }
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const artifact = JSON.parse(readFileSync(restorePath, "utf8")) as YieldHistoryCleanupArtifact;
    if (sqlitePath) {
      restoreCleanupRowsToSqlite(sqlitePath, artifact.rows);
      printJson({
        restored: artifact.rows.length,
        mode: "sqlite",
        sqlitePath,
      });
      return;
    }

    restoreCleanupRowsToWrangler(artifact.rows, remote);
    printJson({
      restored: artifact.rows.length,
      mode: remote ? "wrangler-remote" : "wrangler-local",
    });
    return;
  }

  const beforeRows = sqlitePath
    ? loadCleanupRowsFromSqlite(sqlitePath)
    : loadCleanupRowsFromWrangler(remote);
  const beforeSummary = summarizeYieldHistoryCleanupRows(beforeRows);

  if (exportPath) {
    const artifact = createYieldHistoryCleanupArtifact(beforeRows, operator);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(exportPath, JSON.stringify(artifact, null, 2));
  }

  if (!execute) {
    printJson({
      mode: sqlitePath ? "sqlite" : remote ? "wrangler-remote" : "wrangler-local",
      targets: listYieldHistoryCleanupTargets(),
      exportPath,
      before: beforeSummary,
    });
    return;
  }

  if (confirmation !== "yield-history-cleanup") {
    throw new Error("Refusing to mutate without --confirm yield-history-cleanup");
  }

  if (!sqlitePath) {
    const writerPause = readWriterPauseFromWrangler(remote);
    if (!writerPause) {
      throw new Error(
        `Writer pause guard is not armed. Run --arm-writer-pause before --execute.`,
      );
    }
    if (isYieldWriterActiveInWrangler(remote)) {
      throw new Error("sync-yield-data lease is active; aborting cleanup.");
    }
  }

  if (sqlitePath) {
    deleteCleanupRowsFromSqlite(sqlitePath);
  } else {
    deleteCleanupRowsFromWrangler(remote);
  }

  const afterRows = sqlitePath
    ? loadCleanupRowsFromSqlite(sqlitePath)
    : loadCleanupRowsFromWrangler(remote);
  const afterSummary = summarizeYieldHistoryCleanupRows(afterRows);

  printJson({
    mode: sqlitePath ? "sqlite" : remote ? "wrangler-remote" : "wrangler-local",
    exportPath,
    before: beforeSummary,
    after: afterSummary,
  });
}

const isDirectRun = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main(process.argv.slice(2));
}
