import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SQL_BATCH_SIZE = 200;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

export function d1Query(databaseName: string, sql: string): string {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", databaseName, "--remote", "--command", sql, "--json"],
    { encoding: "utf-8", maxBuffer: DEFAULT_MAX_BUFFER, stdio: "pipe" },
  );
}

export function d1QueryParsed<T>(databaseName: string, sql: string): T[] {
  const parsed = JSON.parse(d1Query(databaseName, sql));
  return parsed[0]?.results ?? [];
}

export function d1ExecFile(databaseName: string, statements: string[], prefix: string): void {
  if (statements.length === 0) return;

  const tmpFile = join(tmpdir(), `${prefix}-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, statements.join("\n")); // eslint-disable-line security/detect-non-literal-fs-filename
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", databaseName, "--remote", "--file", tmpFile, "--json"],
      { encoding: "utf-8", maxBuffer: DEFAULT_MAX_BUFFER, stdio: "pipe" },
    );
  } finally {
    try {
      unlinkSync(tmpFile); // eslint-disable-line security/detect-non-literal-fs-filename
    } catch {
      // best-effort cleanup for temporary SQL files
    }
  }
}

export function d1BatchExec(
  databaseName: string,
  statements: string[],
  options?: { batchSize?: number; prefix?: string },
): void {
  const batchSize = options?.batchSize ?? DEFAULT_SQL_BATCH_SIZE;
  const prefix = options?.prefix ?? "remote-d1";

  for (let i = 0; i < statements.length; i += batchSize) {
    const chunk = statements.slice(i, i + batchSize);
    d1ExecFile(databaseName, chunk, prefix);
    if (i + batchSize < statements.length) {
      process.stdout.write(`    batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(statements.length / batchSize)}...\r`);
    }
  }
}
