import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const migrationsDir = resolve("worker/migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

// Check for duplicate sequence numbers (use full alphanumeric prefix to handle 0031a)
const sequenceNumbers = migrationFiles.map(f => f.match(/^(\d+[a-z]?)/)?.[1]).filter(Boolean);
const duplicates = sequenceNumbers.filter((num, i) => sequenceNumbers.indexOf(num) !== i);
const uniqueDuplicates = [...new Set(duplicates)];
// Known legacy duplicates that can't be renumbered without replay risk
const KNOWN_LEGACY_DUPLICATES = new Set(["0056", "0061"]);
const newDuplicates = uniqueDuplicates.filter(n => !KNOWN_LEGACY_DUPLICATES.has(n));
if (newDuplicates.length > 0) {
  console.error(`❌ Duplicate migration sequence numbers: ${newDuplicates.join(", ")}`);
  console.error("Each migration must have a unique numeric prefix.");
  process.exit(1);
}
if (uniqueDuplicates.length > 0) {
  console.warn(`⚠️  Known legacy duplicate prefixes: ${uniqueDuplicates.join(", ")} (suppressed)`);
}

if (migrationFiles.length === 0) {
  console.error(`No migration files found in ${migrationsDir}`);
  process.exit(1);
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

const tempDir = mkdtempSync(join(tmpdir(), "pharos-worker-migrations-"));
const dbPath = join(tempDir, "migrations.db");
const executor = await createExecutor(dbPath);

let failed = false;

try {
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");

    try {
      executor.execute(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Migration replay failed for worker/migrations/${file}`);
      console.error(message);
      failed = true;
      break;
    }
  }
} finally {
  executor.close();
  rmSync(tempDir, { force: true, recursive: true });
}

if (failed) {
  process.exit(1);
}

console.log(`Validated ${migrationFiles.length} worker migrations with ${executor.backend}.`);
