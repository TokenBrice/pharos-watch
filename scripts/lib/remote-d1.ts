import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkArray } from "@shared/lib/collections";

const DEFAULT_SQL_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

export type D1Target = "remote" | "local";

export type D1ClientOptions = {
  batchSize?: number;
  cwd?: string;
  maxBuffer?: number;
  target?: D1Target;
};

export type D1Client = {
  query<T>(sql: string): T[];
  queryRaw(sql: string): string;
  executeStatements(statements: string[], prefix: string): void;
};

export type RemoteD1Client = D1Client;

export function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function executeWrangler(args: string[], options: Required<Pick<D1ClientOptions, "cwd" | "maxBuffer">>): string {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    stdio: "pipe",
  });
}

function executeSqlFile(
  databaseName: string,
  statements: string[],
  prefix: string,
  options: Required<Pick<D1ClientOptions, "cwd" | "maxBuffer" | "target">>,
): void {
  if (statements.length === 0) return;

  const tmpDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  try {
    const sqlFile = join(tmpDir, "statements.sql");
    // Temp SQL file is created under mkdtempSync() and never leaves this function.
    writeFileSync(sqlFile, statements.join("\n"));
    executeWrangler(["d1", "execute", databaseName, `--${options.target}`, "--file", sqlFile, "--json"], options);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function createD1Client(databaseName: string, options: D1ClientOptions = {}): D1Client {
  const resolvedOptions = {
    batchSize: options.batchSize ?? DEFAULT_SQL_BATCH_SIZE,
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    target: options.target ?? "remote",
  } satisfies Required<D1ClientOptions>;
  const queryRaw = (sql: string): string =>
    executeWrangler(
      ["d1", "execute", databaseName, `--${resolvedOptions.target}`, "--command", sql, "--json"],
      resolvedOptions,
    );

  return {
    query<T>(sql: string): T[] {
      const parsed = JSON.parse(queryRaw(sql));
      return parsed[0]?.results ?? [];
    },
    queryRaw,
    executeStatements(statements: string[], prefix: string): void {
      for (const batch of chunkArray(statements, resolvedOptions.batchSize)) {
        executeSqlFile(
          databaseName,
          batch,
          prefix,
          resolvedOptions,
        );
      }
    },
  };
}

export function d1BatchExec(
  databaseName: string,
  statements: string[],
  options?: { batchSize?: number; prefix?: string },
): void {
  createD1Client(databaseName, { batchSize: options?.batchSize }).executeStatements(
    statements,
    options?.prefix ?? "remote-d1",
  );
}
