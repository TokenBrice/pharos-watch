import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LEGACY_DUPLICATE_PREFIX_ALLOWLIST = Object.freeze(["0056", "0061"]);
export const ROLLOUT_SAFETY_ENFORCEMENT_PREFIX = "0071";
export const REQUIRED_ROLLOUT_SAFETY_MODE = "backward-compatible";
export const UNSAFE_ROLLOUT_SAFETY_PATTERNS = Object.freeze([
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "ALTER TABLE ... RENAME TO", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i },
  { label: "ALTER TABLE ... RENAME COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+COLUMN\b/i },
  { label: "ALTER TABLE ... DROP COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
]);

export function getMigrationFiles(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export function getMigrationSequenceNumber(file) {
  const match = file.match(/^(\d+)/);
  if (!match) {
    throw new Error(`Migration file ${file} is missing a leading numeric sequence.`);
  }
  return Number(match[1]);
}

export function findDuplicatePrefixes(migrationFiles) {
  const sequenceNumbers = migrationFiles.map((file) => file.match(/^(\d+[a-z]?)/)?.[1]).filter(Boolean);
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

export function parseRolloutSafetyPolicy(manifestText) {
  const startMatch = manifestText.match(/Rollout-safety enforcement starts at:\s*`(\d+)`/);
  if (!startMatch) {
    throw new Error("worker/migrations/MANIFEST.md is missing the rollout-safety enforcement line.");
  }

  const headerMatch = manifestText.match(/Required rollout-safety header:\s*`--\s*rollout-safety:\s*([a-z-]+)`/i);
  if (!headerMatch) {
    throw new Error("worker/migrations/MANIFEST.md is missing the required rollout-safety header line.");
  }

  return {
    enforcementPrefix: startMatch[1],
    requiredMode: headerMatch[1].toLowerCase(),
  };
}

export function validateDuplicatePrefixAllowlist(allowlist) {
  const normalized = [...allowlist].sort();
  const expected = [...LEGACY_DUPLICATE_PREFIX_ALLOWLIST].sort();

  if (normalized.length !== expected.length || normalized.some((prefix, index) => prefix !== expected[index])) {
    throw new Error(
      `worker/migrations/MANIFEST.md duplicate-prefix allowlist must stay frozen at: ${expected.join(", ")}`,
    );
  }
}

export function validateRolloutSafetyPolicy(policy) {
  if (policy.enforcementPrefix !== ROLLOUT_SAFETY_ENFORCEMENT_PREFIX) {
    throw new Error(
      `worker/migrations/MANIFEST.md rollout-safety enforcement must stay frozen at: ${ROLLOUT_SAFETY_ENFORCEMENT_PREFIX}`,
    );
  }

  if (policy.requiredMode !== REQUIRED_ROLLOUT_SAFETY_MODE) {
    throw new Error(
      `worker/migrations/MANIFEST.md required rollout-safety mode must stay frozen at: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
    );
  }
}

export function validateDuplicatePrefixes(migrationFiles, allowlist) {
  const uniqueDuplicates = findDuplicatePrefixes(migrationFiles);
  const newDuplicates = uniqueDuplicates.filter((prefix) => !allowlist.has(prefix));
  return { uniqueDuplicates, newDuplicates };
}

export function requiresRolloutSafetyValidation(file, enforcementPrefix = ROLLOUT_SAFETY_ENFORCEMENT_PREFIX) {
  return getMigrationSequenceNumber(file) >= Number(enforcementPrefix);
}

export function parseRolloutSafetyMode(sql) {
  return sql.match(/^\s*--\s*rollout-safety:\s*([a-z-]+)\s*$/im)?.[1].toLowerCase() ?? null;
}

export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

export function findUnsafeRolloutStatements(sql) {
  const normalizedSql = stripSqlComments(sql);
  return UNSAFE_ROLLOUT_SAFETY_PATTERNS.filter(({ pattern }) => pattern.test(normalizedSql)).map(({ label }) => label);
}

export function validateRolloutSafetyAnnotation(file, sql, enforcementPrefix = ROLLOUT_SAFETY_ENFORCEMENT_PREFIX) {
  if (!requiresRolloutSafetyValidation(file, enforcementPrefix)) {
    return { checked: false };
  }

  const mode = parseRolloutSafetyMode(sql);
  if (!mode) {
    throw new Error(
      `${file} must declare "-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}" because standard deploy applies migrations before the new worker is live.`,
    );
  }

  if (mode !== REQUIRED_ROLLOUT_SAFETY_MODE) {
    throw new Error(
      `${file} declares unsupported rollout-safety "${mode}". Standard deploys only allow "${REQUIRED_ROLLOUT_SAFETY_MODE}" migrations.`,
    );
  }

  const unsafeStatements = findUnsafeRolloutStatements(sql);
  if (unsafeStatements.length > 0) {
    throw new Error(
      `${file} is marked rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE} but contains statements that can break the still-live worker: ${unsafeStatements.join(", ")}`,
    );
  }

  return { checked: true, mode };
}

async function createExecutor(dbPath) {
  const sqlite3Probe = spawnSync("sqlite3", ["-version"], {
    encoding: "utf8",
  });

  if (!sqlite3Probe.error && sqlite3Probe.status === 0) {
    return {
      backend: "sqlite3",
      close() {},
      execute(sql) {
        const result = spawnSync("sqlite3", ["-bail", dbPath], {
          encoding: "utf8",
          input: sql,
        });

        if (result.error) {
          throw new Error(`sqlite3 CLI execution failed: ${result.error.message}`);
        }

        if (result.status !== 0) {
          const detail = (result.stderr || result.stdout || "").trim();
          throw new Error(detail || `sqlite3 exited with status ${result.status}`);
        }
      },
    };
  }

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
  } catch (error) {
    const sqlite3Detail = sqlite3Probe.error
      ? sqlite3Probe.error.code === "ENOENT"
        ? "sqlite3 CLI is not installed"
        : sqlite3Probe.error.message
      : (sqlite3Probe.stderr || sqlite3Probe.stdout || "").trim() || `sqlite3 -version exited with status ${sqlite3Probe.status}`;
    const nodeSqliteDetail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Worker migration validation requires sqlite3 or node:sqlite. sqlite3 probe: ${sqlite3Detail}. node:sqlite load failed: ${nodeSqliteDetail}`,
    );
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

  const manifestText = readFileSync(manifestPath, "utf8");
  const allowlist = parseDuplicatePrefixAllowlist(manifestText);
  const rolloutSafetyPolicy = parseRolloutSafetyPolicy(manifestText);
  validateDuplicatePrefixAllowlist(allowlist);
  validateRolloutSafetyPolicy(rolloutSafetyPolicy);
  const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(migrationFiles, allowlist);

  if (newDuplicates.length > 0) {
    throw new Error(`Duplicate migration sequence numbers: ${newDuplicates.join(", ")}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pharos-worker-migrations-"));
  const dbPath = join(tempDir, "migrations.db");
  const executor = await createExecutor(dbPath);
  let rolloutSafetyCheckedCount = 0;

  try {
    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const rolloutSafety = validateRolloutSafetyAnnotation(file, sql, rolloutSafetyPolicy.enforcementPrefix);
      rolloutSafetyCheckedCount += rolloutSafety.checked ? 1 : 0;

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
    rolloutSafetyCheckedCount,
    uniqueDuplicates,
  };
}

async function main() {
  try {
    const result = await validateWorkerMigrations();
    if (result.uniqueDuplicates.length > 0) {
      console.warn(`⚠️  Known legacy duplicate prefixes: ${result.uniqueDuplicates.join(", ")} (suppressed)`);
    }
    console.log(
      `Validated ${result.migrationCount} worker migrations with ${result.backend} (rollout safety checked: ${result.rolloutSafetyCheckedCount}).`,
    );
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
