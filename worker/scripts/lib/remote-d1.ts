import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export type RemoteD1Client = {
  query<T>(sql: string): T[];
  executeStatements(statements: string[], prefix: string): void;
};

export function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function getWorkerCwd(): string {
  return process.cwd().endsWith("/worker") ? process.cwd() : join(process.cwd(), "worker");
}

function executeWrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: getWorkerCwd(),
    encoding: "utf8",
    maxBuffer: DEFAULT_MAX_BUFFER,
    stdio: "pipe",
  });
}

export function createRemoteD1Client(database: string): RemoteD1Client {
  return {
    query<T>(sql: string): T[] {
      const raw = executeWrangler(["d1", "execute", database, "--remote", "--json", "--command", sql]);
      return JSON.parse(raw)[0]?.results ?? [];
    },
    executeStatements(statements: string[], prefix: string): void {
      if (statements.length === 0) return;

      const tmpDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      try {
        const sqlFile = join(tmpDir, "statements.sql");
        // Temp SQL file is created under mkdtempSync() and never leaves this function.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        writeFileSync(sqlFile, statements.join("\n"));
        executeWrangler(["d1", "execute", database, "--remote", "--json", "--file", sqlFile]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
