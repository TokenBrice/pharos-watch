import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function getMigrationFiles(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export function findDuplicatePrefixes(migrationFiles) {
  const sequenceNumbers = migrationFiles
    .map((file) => file.match(/^(\d+[a-z]?)/)?.[1])
    .filter(Boolean);
  const duplicates = sequenceNumbers.filter((num, index) => sequenceNumbers.indexOf(num) !== index);
  return [...new Set(duplicates)];
}

export function parseDuplicatePrefixAllowlist(manifestText) {
  const match = manifestText.match(/Duplicate-prefix allowlist:\s*(.+)/);
  if (!match) {
    throw new Error("worker/migrations/MANIFEST.md is missing the duplicate-prefix allowlist line.");
  }
  const prefixes = [...match[1].matchAll(/`([^`]+)`/g)].map(([, prefix]) => prefix);
  if (prefixes.length === 0) {
    throw new Error("worker/migrations/MANIFEST.md duplicate-prefix allowlist is empty.");
  }
  return new Set(prefixes);
}

export function validateDuplicatePrefixes(migrationFiles, allowlist) {
  const uniqueDuplicates = findDuplicatePrefixes(migrationFiles);
  const newDuplicates = uniqueDuplicates.filter((prefix) => !allowlist.has(prefix));
  return { uniqueDuplicates, newDuplicates };
}

async function createExecutor(dbPath) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);

    return {
      backend: "node:sqlite",
      close() {
        db.close();
      },
      execute(sql) {
        db.exec(sql);
      },
    };
  } catch {
    return {
      backend: "sqlite3",
      close() {},
      execute(sql) {
        const result = spawnSync("sqlite3", [dbPath], {
          encoding: "utf8",
          input: sql,
        });

        if (result.error) {
          throw new Error(
            `sqlite3 fallback is unavailable (${result.error.message}). Use Node 22+ or install sqlite3.`,
          );
        }

        if (result.status !== 0) {
          const detail = (result.stderr || result.stdout || "").trim();
          throw new Error(detail || `sqlite3 exited with status ${result.status}`);
        }
      },
    };
  }
}

export async function validateWorkerMigrations({
  migrationsDir = resolve("worker/migrations"),
  manifestPath = resolve("worker/migrations/MANIFEST.md"),
} = {}) {
  const migrationFiles = getMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const allowlist = parseDuplicatePrefixAllowlist(readFileSync(manifestPath, "utf8"));
  const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(migrationFiles, allowlist);

  if (newDuplicates.length > 0) {
    throw new Error(`Duplicate migration sequence numbers: ${newDuplicates.join(", ")}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pharos-worker-migrations-"));
  const dbPath = join(tempDir, "migrations.db");
  const executor = await createExecutor(dbPath);

  try {
    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");

      try {
        executor.execute(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration replay failed for ${join(migrationsDir, file)}\n${message}`);
      }
    }
  } finally {
    executor.close();
    rmSync(tempDir, { force: true, recursive: true });
  }

  return {
    backend: executor.backend,
    migrationCount: migrationFiles.length,
    uniqueDuplicates,
  };
}

async function main() {
  try {
    const result = await validateWorkerMigrations();
    if (result.uniqueDuplicates.length > 0) {
      console.warn(`⚠️  Known legacy duplicate prefixes: ${result.uniqueDuplicates.join(", ")} (suppressed)`);
    }
    console.log(`Validated ${result.migrationCount} worker migrations with ${result.backend}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (message.startsWith("Duplicate migration sequence numbers:")) {
      console.error("Each migration must have a unique numeric prefix.");
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
