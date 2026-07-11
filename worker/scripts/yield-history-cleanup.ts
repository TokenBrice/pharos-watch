#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { parseYieldHistoryWriterPause, YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY } from "../src/lib/yield-history-cleanup";
import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../src/lib/yield-history-ownership-handoffs";
import {
  parseDestructiveOperationArgs,
  type DestructiveOperationMode,
} from "./lib/destructive-operation-guard";
import { createWorkerD1Client, sqlString } from "./lib/remote-d1";

const DB_NAME = "stablecoin-db";
const SCRIPT_NAME = "yield-history-cleanup";
const SCRIPT_USAGE = `Usage: tsx worker/scripts/yield-history-cleanup.ts [options]

Default Wrangler mode is a remote D1 dry-run. Every Wrangler D1 mutation, including
writer-pause changes, requires --execute --confirm ${SCRIPT_NAME}. SQLite restore remains
an explicit local-file operation.

Options:
  --sqlite <path>              Use a local SQLite database file
  --export <path>              Write a rollback artifact before cleanup
  --restore <path>             Restore rows from a cleanup artifact
  --operator <name>            Record the operator in exported pause/artifact metadata
  --arm-writer-pause           Preview or arm the Wrangler D1 yield writer pause
  --clear-writer-pause         Preview or clear the Wrangler D1 yield writer pause
  --execute                    Execute the selected mutation
  --confirm <script>           Required for live mutation; value must be ${SCRIPT_NAME}
  --dry-run                    Force dry-run mode
  --local                      Target local Wrangler D1
  --remote                     Target remote Wrangler D1 (default)
  -h, --help                   Show this help`;

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

export interface YieldHistoryCleanupCliOptions {
  help: boolean;
  sqlitePath: string | null;
  exportPath: string | null;
  restorePath: string | null;
  operator: string | null;
  remote: boolean;
  execute: boolean;
  armWriterPause: boolean;
  clearWriterPause: boolean;
  operationMode: DestructiveOperationMode;
}

export interface YieldHistoryCleanupCliDependencies {
  setWriterPause?: (remote: boolean, operator: string | null) => void;
  clearWriterPause?: (remote: boolean) => void;
  printJson?: (value: unknown) => void;
}

function listYieldHistoryCleanupTargets(): YieldHistoryCleanupTarget[] {
  return Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS).map(([stablecoinId, sourceKeys]) => ({
    stablecoinId,
    sourceKeys,
  }));
}

function buildYieldHistoryWriterPausePayload(
  reason = SCRIPT_NAME,
  operator: string | null = null,
  pausedAt = Math.floor(Date.now() / 1000),
) {
  return {
    reason,
    pausedAt,
    operator,
  };
}

function sqlValue(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return sqlString(String(value));
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

export function deleteCleanupRowsFromSqlite(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const target of listYieldHistoryCleanupTargets()) {
      db.exec(buildDeleteSql(target));
    }
  } finally {
    db.close();
  }
}

export function restoreCleanupRowsToSqlite(dbPath: string, rows: readonly YieldHistoryCleanupRow[]): void {
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

function queryRemoteRows<T>(sql: string, remote: boolean): T[] {
  return createWorkerD1Client(DB_NAME, remote ? "remote" : "local").query<T>(sql);
}

function execRemoteStatements(statements: string[], remote: boolean): void {
  createWorkerD1Client(DB_NAME, remote ? "remote" : "local").executeStatements(
    statements.map((statement) => (statement.endsWith(";") ? statement : `${statement};`)),
    SCRIPT_NAME,
  );
}

function loadCleanupRowsFromWrangler(remote: boolean): YieldHistoryCleanupRow[] {
  const rows: YieldHistoryCleanupRow[] = [];
  for (const target of listYieldHistoryCleanupTargets()) {
    const targetRows = queryRemoteRows<YieldHistoryCleanupRow>(buildSelectSql(target), remote);
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
  const rows = queryRemoteRows<{ value?: string; updated_at?: number }>(
    // SAFETY: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY is a fixed repo constant,
    // not user input, and sqlValue() still quotes it defensively.
    `SELECT value, updated_at FROM cache WHERE key = ${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)} LIMIT 1`,
    remote,
  );
  const row = rows[0];
  if (!row || typeof row.value !== "string" || typeof row.updated_at !== "number") {
    return null;
  }
  return parseYieldHistoryWriterPause({ value: row.value, updatedAt: row.updated_at });
}

function setWriterPauseInWrangler(remote: boolean, operator: string | null): void {
  const payload = buildYieldHistoryWriterPausePayload(SCRIPT_NAME, operator);
  execRemoteStatements(
    [
      `INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)}, ${sqlValue(JSON.stringify(payload))}, ${payload.pausedAt})`,
    ],
    remote,
  );
}

function clearWriterPauseInWrangler(remote: boolean): void {
  execRemoteStatements(
    [
      // SAFETY: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY is a fixed repo constant,
      // not user input, and sqlValue() still quotes it defensively.
      `DELETE FROM cache WHERE key = ${sqlValue(YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY)}`,
    ],
    remote,
  );
}

function isYieldWriterActiveInWrangler(remote: boolean): boolean {
  const now = Math.floor(Date.now() / 1000);
  const rows = queryRemoteRows<{ lease_until?: number }>(
    `SELECT lease_until FROM cron_leases WHERE job = 'sync-yield-data' LIMIT 1`,
    remote,
  );
  const leaseUntil = rows[0] && typeof rows[0].lease_until === "number" ? rows[0].lease_until : null;
  return leaseUntil != null && leaseUntil >= now;
}

export function parseYieldHistoryCleanupCliOptions(argv: string[]): YieldHistoryCleanupCliOptions {
  const { mode: operationMode, values } = parseDestructiveOperationArgs({
    argv,
    cliOptions: {
      sqlite: { type: "string" },
      export: { type: "string" },
      restore: { type: "string" },
      operator: { type: "string" },
      "arm-writer-pause": { type: "boolean" },
      "clear-writer-pause": { type: "boolean" },
    },
    conflicts: [
      ["arm-writer-pause", "clear-writer-pause", "restore", "export"],
      ["sqlite", "arm-writer-pause"],
      ["sqlite", "clear-writer-pause"],
    ],
    defaultTarget: "--remote",
    executeAsDryRunWhen: (parsedValues) => (
      typeof parsedValues.sqlite === "string" && typeof parsedValues.restore === "string"
    ),
    scriptName: SCRIPT_NAME,
  });
  const help = values.help === true;

  return {
    help,
    sqlitePath: typeof values.sqlite === "string" ? values.sqlite : null,
    exportPath: typeof values.export === "string" ? values.export : null,
    restorePath: typeof values.restore === "string" ? values.restore : null,
    operator: typeof values.operator === "string" ? values.operator : null,
    remote: operationMode.remote,
    execute: !operationMode.dryRun,
    armWriterPause: values["arm-writer-pause"] === true,
    clearWriterPause: values["clear-writer-pause"] === true,
    operationMode,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runYieldHistoryCleanupCli(
  argv: string[],
  dependencies: YieldHistoryCleanupCliDependencies = {},
): Promise<void> {
  const {
    help,
    sqlitePath,
    exportPath,
    restorePath,
    operator,
    remote,
    execute,
    armWriterPause,
    clearWriterPause,
  } = parseYieldHistoryCleanupCliOptions(argv);
  if (writeCliHelpIfRequested({ help }, SCRIPT_USAGE)) return;
  const writeJson = dependencies.printJson ?? printJson;

  if (armWriterPause && sqlitePath) {
    throw new Error("--arm-writer-pause is only supported with Wrangler D1 mode");
  }
  if (clearWriterPause && sqlitePath) {
    throw new Error("--clear-writer-pause is only supported with Wrangler D1 mode");
  }

  if (armWriterPause) {
    if (!execute) {
      writeJson({
        action: "arm-writer-pause",
        mode: "dry-run",
        key: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
        operator,
        remote,
      });
      return;
    }
    (dependencies.setWriterPause ?? setWriterPauseInWrangler)(remote, operator);
    writeJson({
      armed: true,
      key: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
      operator,
      remote,
    });
    return;
  }

  if (clearWriterPause) {
    if (!execute) {
      writeJson({
        action: "clear-writer-pause",
        mode: "dry-run",
        key: YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
        remote,
      });
      return;
    }
    (dependencies.clearWriterPause ?? clearWriterPauseInWrangler)(remote);
    writeJson({
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
      writeJson({
        restored: artifact.rows.length,
        mode: "sqlite",
        sqlitePath,
      });
      return;
    }

    restoreCleanupRowsToWrangler(artifact.rows, remote);
    writeJson({
      restored: artifact.rows.length,
      mode: remote ? "wrangler-remote" : "wrangler-local",
    });
    return;
  }

  const beforeRows = sqlitePath ? loadCleanupRowsFromSqlite(sqlitePath) : loadCleanupRowsFromWrangler(remote);
  const beforeSummary = summarizeYieldHistoryCleanupRows(beforeRows);

  if (exportPath) {
    const artifact = createYieldHistoryCleanupArtifact(beforeRows, operator);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(exportPath, JSON.stringify(artifact, null, 2));
  }

  if (!execute) {
    writeJson({
      mode: sqlitePath ? "sqlite" : remote ? "wrangler-remote" : "wrangler-local",
      targets: listYieldHistoryCleanupTargets(),
      exportPath,
      before: beforeSummary,
    });
    return;
  }

  if (!sqlitePath) {
    const writerPause = readWriterPauseFromWrangler(remote);
    if (!writerPause) {
      throw new Error(`Writer pause guard is not armed. Run --arm-writer-pause before --execute.`);
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

  const afterRows = sqlitePath ? loadCleanupRowsFromSqlite(sqlitePath) : loadCleanupRowsFromWrangler(remote);
  const afterSummary = summarizeYieldHistoryCleanupRows(afterRows);

  writeJson({
    mode: sqlitePath ? "sqlite" : remote ? "wrangler-remote" : "wrangler-local",
    exportPath,
    before: beforeSummary,
    after: afterSummary,
  });
}

const isDirectRun = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void runCliEntrypoint(() => runYieldHistoryCleanupCli(process.argv.slice(2)), {
    label: SCRIPT_NAME,
    usage: SCRIPT_USAGE,
  });
}
