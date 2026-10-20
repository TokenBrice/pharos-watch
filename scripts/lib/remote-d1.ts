import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SQL_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

export type D1Target = "remote" | "local";

export type D1ClientOptions = {
  batchSize?: number;
  cwd?: string;
  maxBuffer?: number;
  target?: D1Target;
  /** Opt in only for secret-free SQL; failed imports retain their SQL and Wrangler diagnostics here. */
  failedSqlDirectory?: string;
};

export type D1Client = {
  query<T>(sql: string): T[];
  queryRaw(sql: string): string;
  executeStatements(statements: string[], prefix: string): void;
  /** One unchunked SQL-file import, retaining its aggregate receipt. */
  executeStatementsRaw?(statements: string[], prefix: string): string;
};

export type RemoteD1Client = D1Client;

export function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

export type D1QueryEnvelope = Record<string, unknown> & {
  results: unknown[];
};

/** Admit the full Wrangler response before exposing rows or statement receipts. */
export function decodeD1Envelopes(payload: unknown): D1QueryEnvelope[] {
  const envelopes: D1QueryEnvelope[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error("d1-envelope-unavailable");
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== "object") throw new Error("d1-envelope-invalid");
    const envelope = value as Record<string, unknown>;
    if ((envelope.success !== undefined && envelope.success !== true) ||
        (envelope.error !== undefined && envelope.error !== null) ||
        (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0))) {
      throw new Error(`d1-query-failed: ${JSON.stringify(envelope.errors ?? envelope.error ?? envelope.success)}`);
    }
    if ("results" in envelope) {
      if (!Array.isArray(envelope.results) || "result" in envelope) throw new Error("d1-result-invalid");
      envelopes.push(envelope as D1QueryEnvelope);
    } else if ("result" in envelope) {
      visit(envelope.result);
    } else {
      throw new Error("d1-result-unavailable");
    }
  };
  visit(payload);
  return envelopes;
}

export function decodeD1Rows<T>(stdout: string): T[] {
  return decodeD1Envelopes(JSON.parse(stdout)).flatMap((envelope) => envelope.results as T[]);
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
  options: Required<Pick<D1ClientOptions, "cwd" | "maxBuffer" | "target">> & Pick<D1ClientOptions, "failedSqlDirectory">,
): string {
  if (statements.length === 0) return "[]";

  const parent = options.failedSqlDirectory ?? tmpdir();
  if (options.failedSqlDirectory) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tmpDir = mkdtempSync(join(parent, `${prefix}-`));
  const sqlFile = join(tmpDir, "statements.sql");
  let succeeded = false;
  try {
    writeFileSync(sqlFile, statements.join("\n"), { mode: 0o600 });
    const receipt = executeWrangler(["d1", "execute", databaseName, `--${options.target}`, "--file", sqlFile, "--json"], options);
    succeeded = true;
    return receipt;
  } catch (cause) {
    if (!options.failedSqlDirectory) throw cause;
    const diagnostics: string[] = [];
    if (cause != null && typeof cause === "object") {
      const output = cause as { stdout?: unknown; stderr?: unknown };
      for (const key of ["stdout", "stderr"] as const) {
        const value = output[key];
        const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? String(value) : "";
        if (text.trim()) diagnostics.push(`Wrangler ${key}:\n${text.trim()}`);
      }
    }
    throw Object.assign(new Error([
      cause instanceof Error ? cause.message : String(cause),
      ...diagnostics,
      `Failed D1 import SQL retained at ${sqlFile}`,
    ].join("\n")), { cause });
  } finally {
    if (succeeded || !options.failedSqlDirectory) rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function createD1Client(databaseName: string, options: D1ClientOptions = {}): D1Client {
  const resolvedOptions = {
    batchSize: options.batchSize ?? DEFAULT_SQL_BATCH_SIZE,
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    target: options.target ?? "remote",
    failedSqlDirectory: options.failedSqlDirectory,
  } satisfies Required<Omit<D1ClientOptions, "failedSqlDirectory">> & Pick<D1ClientOptions, "failedSqlDirectory">;
  const queryRaw = (sql: string): string =>
    executeWrangler(
      ["d1", "execute", databaseName, `--${resolvedOptions.target}`, "--command", sql, "--json"],
      resolvedOptions,
    );

  return {
    query<T>(sql: string): T[] {
      return decodeD1Rows<T>(queryRaw(sql));
    },
    queryRaw,
    executeStatements(statements: string[], prefix: string): void {
      for (let offset = 0; offset < statements.length; offset += resolvedOptions.batchSize) {
        executeSqlFile(
          databaseName,
          statements.slice(offset, offset + resolvedOptions.batchSize),
          prefix,
          resolvedOptions,
        );
      }
    },
    executeStatementsRaw(statements: string[], prefix: string): string {
      return executeSqlFile(databaseName, statements, prefix, resolvedOptions);
    },
  };
}
