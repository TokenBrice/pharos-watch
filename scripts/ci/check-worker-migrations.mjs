import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

export const LEGACY_DUPLICATE_PREFIX_ALLOWLIST = Object.freeze(["0056", "0061"]);
export const ROLLOUT_SAFETY_ENFORCEMENT_PREFIX = "0071";
export const REQUIRED_ROLLOUT_SAFETY_MODE = "backward-compatible";
export const UNSAFE_ROLLOUT_SAFETY_PATTERNS = Object.freeze([
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "ALTER TABLE ... RENAME TO", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i },
  { label: "ALTER TABLE ... RENAME COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+COLUMN\b/i },
  { label: "ALTER TABLE ... DROP COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
]);
export const UNSAFE_ROLLOUT_ADD_COLUMN_LABEL = "ALTER TABLE ... ADD COLUMN ... NOT NULL without DEFAULT";

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

export function parseManifestMigrationRows(manifestText, { sectionHeading, nextHeading, allowEmpty = false } = {}) {
  const startIndex = sectionHeading ? manifestText.indexOf(sectionHeading) : 0;
  if (startIndex === -1) {
    throw new Error(`worker/migrations/MANIFEST.md is missing the "${sectionHeading}" section.`);
  }

  const sectionStart = sectionHeading ? startIndex + sectionHeading.length : 0;
  const sectionEnd =
    nextHeading && manifestText.indexOf(nextHeading, sectionStart) !== -1
      ? manifestText.indexOf(nextHeading, sectionStart)
      : manifestText.length;
  const sectionText = manifestText.slice(sectionStart, sectionEnd);
  const rows = [...sectionText.matchAll(/^\|\s*(\d{4})\s*\|\s*`([^`]+\.sql)`\s*\|/gm)].map(
    ([, sequence, filename]) => ({
      sequence,
      filename,
    }),
  );

  if (rows.length === 0) {
    if (!allowEmpty) {
      throw new Error(`worker/migrations/MANIFEST.md section "${sectionHeading}" has no migration rows.`);
    }
  }

  return rows;
}

export function validateManifestMigrationParity(migrationFiles, manifestText) {
  if (!migrationFiles.includes("0000_baseline.sql")) {
    throw new Error("worker/migrations must include 0000_baseline.sql for fresh D1 setup replay.");
  }

  const activeRows = parseManifestMigrationRows(manifestText, {
    sectionHeading: "## Individual Migrations",
    nextHeading: manifestText.includes("## Squashed Individual Migrations")
      ? "## Squashed Individual Migrations"
      : "## Retired Individual Migrations",
    allowEmpty: true,
  });
  const squashedRows = manifestText.includes("## Squashed Individual Migrations")
    ? parseManifestMigrationRows(manifestText, {
        sectionHeading: "## Squashed Individual Migrations",
        nextHeading: "## Retired Individual Migrations",
      })
    : [];
  const retiredRows = parseManifestMigrationRows(manifestText, {
    sectionHeading: "## Retired Individual Migrations",
    nextHeading: "## Known Anomalies",
  });

  const activeFiles = migrationFiles.filter((file) => file !== "0000_baseline.sql");
  const activeManifestFiles = activeRows.map((row) => row.filename);
  const retiredManifestFiles = retiredRows.map((row) => row.filename);
  const activeFileSet = new Set(activeFiles);
  const activeManifestFileSet = new Set(activeManifestFiles);
  const retiredManifestFileSet = new Set(retiredManifestFiles);
  const errors = [];

  const duplicateActiveRows = activeManifestFiles.filter(
    (filename, index) => activeManifestFiles.indexOf(filename) !== index,
  );
  if (duplicateActiveRows.length > 0) {
    errors.push(`duplicate active manifest rows: ${[...new Set(duplicateActiveRows)].join(", ")}`);
  }

  const filesMissingFromManifest = activeFiles.filter((file) => !activeManifestFileSet.has(file));
  if (filesMissingFromManifest.length > 0) {
    errors.push(`migration files missing from active manifest table: ${filesMissingFromManifest.join(", ")}`);
  }

  const manifestRowsMissingFiles = activeManifestFiles.filter((file) => !activeFileSet.has(file));
  if (manifestRowsMissingFiles.length > 0) {
    errors.push(`active manifest rows without migration files: ${manifestRowsMissingFiles.join(", ")}`);
  }

  const retiredFilesStillPresent = retiredManifestFiles.filter((file) => migrationFiles.includes(file));
  if (retiredFilesStillPresent.length > 0) {
    errors.push(`retired manifest rows still have checked-in migration files: ${retiredFilesStillPresent.join(", ")}`);
  }

  const squashedManifestFiles = squashedRows.map((row) => row.filename);
  const squashedFilesStillPresent = squashedManifestFiles.filter((file) => migrationFiles.includes(file));
  if (squashedFilesStillPresent.length > 0) {
    errors.push(`squashed manifest rows still have checked-in migration files: ${squashedFilesStillPresent.join(", ")}`);
  }
  const squashedRowsWithBadSequence = squashedRows.filter((row) => !row.filename.startsWith(`${row.sequence}_`));
  if (squashedRowsWithBadSequence.length > 0) {
    errors.push(
      `squashed manifest sequence/filename mismatches: ${squashedRowsWithBadSequence
        .map((row) => `${row.sequence} -> ${row.filename}`)
        .join(", ")}`,
    );
  }

  const activeRowsWithBadSequence = activeRows.filter((row) => !row.filename.startsWith(`${row.sequence}_`));
  if (activeRowsWithBadSequence.length > 0) {
    errors.push(
      `active manifest sequence/filename mismatches: ${activeRowsWithBadSequence
        .map((row) => `${row.sequence} -> ${row.filename}`)
        .join(", ")}`,
    );
  }

  const retiredRowsWithBadSequence = retiredRows.filter((row) => !row.filename.startsWith(`${row.sequence}_`));
  if (retiredRowsWithBadSequence.length > 0) {
    errors.push(
      `retired manifest sequence/filename mismatches: ${retiredRowsWithBadSequence
        .map((row) => `${row.sequence} -> ${row.filename}`)
        .join(", ")}`,
    );
  }

  const activeRowsListedAsRetired = activeManifestFiles.filter((file) => retiredManifestFileSet.has(file));
  if (activeRowsListedAsRetired.length > 0) {
    errors.push(`migration rows listed as both active and retired: ${activeRowsListedAsRetired.join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(`worker/migrations/MANIFEST.md is out of sync with worker/migrations:\n- ${errors.join("\n- ")}`);
  }

  return {
    activeManifestCount: activeRows.length,
    retiredManifestCount: retiredRows.length,
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
  const unsafeStatements = UNSAFE_ROLLOUT_SAFETY_PATTERNS.filter(({ pattern }) => pattern.test(normalizedSql)).map(
    ({ label }) => label,
  );
  const addColumnStatements = normalizedSql
    .split(";")
    .filter((statement) => {
      const tokens = statement.toUpperCase().split(/[^A-Z_]+/).filter(Boolean);
      return tokens.includes("ALTER") && tokens.includes("TABLE") && tokens.includes("ADD");
    });
  const hasUnsafeAddColumn = addColumnStatements.some(
    (statement) => /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement),
  );

  if (hasUnsafeAddColumn) {
    unsafeStatements.push(UNSAFE_ROLLOUT_ADD_COLUMN_LABEL);
  }

  return [...new Set(unsafeStatements)];
}

export function validateNoSqliteDotCommands(file, sql) {
  const dotCommandLine = sql.split(/\r?\n/).find((line) => /^\s*\./.test(line));

  if (dotCommandLine) {
    throw new Error(
      `${file} contains a sqlite3 shell dot-command line (${dotCommandLine.trim()}); migrations must contain SQL only.`,
    );
  }
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

const SCHEMA_FINGERPRINT_QUERY = `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE sql IS NOT NULL
  AND name NOT LIKE 'sqlite_%'
  AND tbl_name NOT LIKE 'sqlite_%'
ORDER BY type, name, tbl_name
`;

function normalizeSchemaSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

export function createSchemaFingerprint(schemaRows) {
  const normalizedRows = schemaRows
    .map((row) => `${row.type}\t${row.name}\t${row.tblName}\t${normalizeSchemaSql(row.sql)}`)
    .sort();
  const digest = createHash("sha256").update(normalizedRows.join("\n")).digest("hex");

  return {
    algorithm: "sha256",
    value: digest,
    schemaRowCount: normalizedRows.length,
  };
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
      getSchemaRows() {
        return db
          .prepare(SCHEMA_FINGERPRINT_QUERY)
          .all()
          .map((row) => ({
            type: String(row.type),
            name: String(row.name),
            tblName: String(row.tbl_name),
            sql: String(row.sql),
          }));
      },
    };
  } catch (error) {
    const nodeSqliteDetail = error instanceof Error ? error.message : String(error);
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
        getSchemaRows() {
          const result = spawnSync("sqlite3", ["-bail", "-json", dbPath, SCHEMA_FINGERPRINT_QUERY], {
            encoding: "utf8",
          });

          if (result.error) {
            throw new Error(`sqlite3 CLI schema fingerprint query failed: ${result.error.message}`);
          }

          if (result.status !== 0) {
            const detail = (result.stderr || result.stdout || "").trim();
            throw new Error(detail || `sqlite3 schema fingerprint query exited with status ${result.status}`);
          }

          const rows = JSON.parse(result.stdout || "[]");

          return rows.map((row) => ({
            type: String(row.type),
            name: String(row.name),
            tblName: String(row.tbl_name),
            sql: String(row.sql),
          }));
        },
      };
    }

    const sqlite3Detail = sqlite3Probe.error
      ? sqlite3Probe.error.code === "ENOENT"
        ? "sqlite3 CLI is not installed"
        : sqlite3Probe.error.message
      : (sqlite3Probe.stderr || sqlite3Probe.stdout || "").trim() ||
        `sqlite3 -version exited with status ${sqlite3Probe.status}`;
    throw new Error(
      `Worker migration validation requires node:sqlite or sqlite3. node:sqlite load failed: ${nodeSqliteDetail}. sqlite3 probe: ${sqlite3Detail}`,
    );
  }
}

export async function validateWorkerMigrations({
  migrationsDir = resolve("worker/migrations"),
  manifestPath = resolve("worker/migrations/MANIFEST.md"),
  includeSchemaFingerprint = false,
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
  const manifestParity = validateManifestMigrationParity(migrationFiles, manifestText);
  const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(migrationFiles, allowlist);

  if (newDuplicates.length > 0) {
    throw new Error(`Duplicate migration sequence numbers: ${newDuplicates.join(", ")}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pharos-worker-migrations-"));
  const dbPath = join(tempDir, "migrations.db");
  const executor = await createExecutor(dbPath);
  let rolloutSafetyCheckedCount = 0;
  let schemaFingerprint = null;

  try {
    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const rolloutSafety = validateRolloutSafetyAnnotation(file, sql, rolloutSafetyPolicy.enforcementPrefix);
      validateNoSqliteDotCommands(file, sql);
      rolloutSafetyCheckedCount += rolloutSafety.checked ? 1 : 0;

      try {
        executor.execute(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration replay failed for ${join(migrationsDir, file)}\n${message}`);
      }
    }

    if (includeSchemaFingerprint) {
      schemaFingerprint = createSchemaFingerprint(executor.getSchemaRows());
    }
  } finally {
    executor.close();
    rmSync(tempDir, { force: true, recursive: true });
  }

  return {
    backend: executor.backend,
    migrationCount: migrationFiles.length,
    manifestParity,
    rolloutSafetyCheckedCount,
    schemaFingerprint,
    uniqueDuplicates,
  };
}

function parseCliArgs(argv) {
  let includeSchemaFingerprint = false;
  let schemaFingerprintOutput = process.env.PHAROS_MIGRATION_SCHEMA_FINGERPRINT_PATH ?? null;

  for (const arg of argv) {
    if (arg === "--schema-fingerprint") {
      includeSchemaFingerprint = true;
      continue;
    }

    if (arg.startsWith("--schema-fingerprint-output=")) {
      includeSchemaFingerprint = true;
      schemaFingerprintOutput = arg.slice("--schema-fingerprint-output=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (schemaFingerprintOutput) {
    includeSchemaFingerprint = true;
  }

  return { includeSchemaFingerprint, schemaFingerprintOutput };
}

function writeSchemaFingerprint(path, result) {
  if (!result.schemaFingerprint) {
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    migrations: {
      count: result.migrationCount,
      activeManifestCount: result.manifestParity.activeManifestCount,
      retiredManifestCount: result.manifestParity.retiredManifestCount,
      rolloutSafetyCheckedCount: result.rolloutSafetyCheckedCount,
    },
    schemaFingerprint: result.schemaFingerprint,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await validateWorkerMigrations({
      includeSchemaFingerprint: options.includeSchemaFingerprint,
    });
    if (result.uniqueDuplicates.length > 0) {
      console.warn(`⚠️  Known legacy duplicate prefixes: ${result.uniqueDuplicates.join(", ")} (suppressed)`);
    }
    console.log(
      `Validated ${result.migrationCount} worker migrations with ${result.backend} (manifest rows: ${result.manifestParity.activeManifestCount} active, ${result.manifestParity.retiredManifestCount} retired; rollout safety checked: ${result.rolloutSafetyCheckedCount}).`,
    );
    if (result.schemaFingerprint) {
      console.log(
        `Schema fingerprint (${result.schemaFingerprint.algorithm}): ${result.schemaFingerprint.value} (${result.schemaFingerprint.schemaRowCount} schema rows).`,
      );
    }
    if (options.schemaFingerprintOutput) {
      writeSchemaFingerprint(options.schemaFingerprintOutput, result);
      console.log(`Wrote schema fingerprint artifact to ${options.schemaFingerprintOutput}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (message.startsWith("Duplicate migration sequence numbers:")) {
      console.error("Each migration must have a unique numeric prefix.");
    }
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await main();
}
