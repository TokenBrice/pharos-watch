import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { getWorkerMigrationFiles } from "../lib/worker-migration-files.mts";

interface ManifestMigrationRow {
  sequence: string;
  filename: string;
}

interface ManifestMigrationRowOptions {
  sectionHeading?: string;
  nextHeading?: string;
  allowEmpty?: boolean;
}

interface DataMigrationManifestRow extends ManifestMigrationRow {
  predicate: string;
  oldWorkerCompatibility: string;
  rollbackBookmark: string;
  expectedRowBounds: string;
}

interface ManifestParity {
  activeManifestCount: number;
  retiredManifestCount: number;
}

interface RolloutSafetyPolicy {
  enforcementPrefix: string;
  requiredMode: string;
}

interface SchemaRow {
  type: string;
  name: string;
  tblName: string;
  sql: string;
}

interface MigrationExecutor {
  backend: "node:sqlite" | "sqlite3";
  close(): void;
  execute(sql: string): void;
  hasTable(name: string): boolean;
  getSchemaRows(): SchemaRow[];
}

interface ValidateWorkerMigrationsOptions {
  migrationsDir?: string;
  manifestPath?: string;
  expectedSchemaPath?: string;
  writeSchemaManifest?: boolean;
}

interface WorkerMigrationResult {
  backend: MigrationExecutor["backend"];
  migrationCount: number;
  manifestParity: ManifestParity;
  rolloutSafetyCheckedCount: number;
  dataMigrationFixtureCheckedCount: number;
  schemaObjectCount: number;
  uniqueDuplicates: string[];
}

export const ROLLOUT_SAFETY_ENFORCEMENT_PREFIX = "0071";
export const REQUIRED_ROLLOUT_SAFETY_MODE = "backward-compatible";
export const REQUIRED_DATA_MIGRATION_MODE = "reviewed";
export const DATA_MIGRATION_GRANDFATHER_FILES = Object.freeze([
  "0236_dex_deployment_attempt_attribution.sql",
]);
// Migration 0230 was already shipped before DROP INDEX entered the normal-path gate.
// Keep replay of that existing migration valid; newer migrations must use coordinated cleanup.
export const DROP_INDEX_GRANDFATHER_THROUGH_SEQUENCE = 230;
export const UNSAFE_ROLLOUT_SAFETY_PATTERNS = Object.freeze([
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "DROP INDEX", pattern: /\bDROP\s+INDEX\b/i },
  { label: "ALTER TABLE ... RENAME TO", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i },
  { label: "ALTER TABLE ... RENAME COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+COLUMN\b/i },
  { label: "ALTER TABLE ... DROP COLUMN", pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i },
]);
export const UNSAFE_ROLLOUT_ADD_COLUMN_LABEL = "ALTER TABLE ... ADD COLUMN ... NOT NULL without DEFAULT";
export const DESTRUCTIVE_DATA_MIGRATION_PATTERNS = Object.freeze([
  { label: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  {
    label: "UPDATE",
    pattern: /\bUPDATE\s+(?:OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)\s+)?["`[]?[A-Za-z_][A-Za-z0-9_]*[\]`"]?\s+SET\b/i,
  },
  { label: "INSERT OR REPLACE", pattern: /\bINSERT\s+OR\s+REPLACE\s+INTO\b/i },
]);


export function getMigrationSequenceNumber(file: string): number {
  const match = file.match(/^(\d+)/);
  if (!match) {
    throw new Error(`Migration file ${file} is missing a leading numeric sequence.`);
  }
  return Number(match[1]);
}

export function findDuplicatePrefixes(migrationFiles: readonly string[]): string[] {
  const sequenceNumbers = migrationFiles
    .map((file) => file.match(/^(\d+[a-z]?)/)?.[1])
    .filter((value): value is string => Boolean(value));
  const duplicates = sequenceNumbers.filter((num, index) => sequenceNumbers.indexOf(num) !== index);
  return [...new Set(duplicates)];
}

export function parseRolloutSafetyPolicy(manifestText: string): RolloutSafetyPolicy {
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

/**
 * @param {string} manifestText
 * @param {{ sectionHeading?: string, nextHeading?: string, allowEmpty?: boolean }} [options]
 */
export function parseManifestMigrationRows(
  manifestText: string,
  { sectionHeading, nextHeading, allowEmpty = false }: ManifestMigrationRowOptions = {},
): ManifestMigrationRow[] {
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

export function parseDataMigrationManifestRows(manifestText: string): DataMigrationManifestRow[] {
  const sectionHeading = "## Reviewed Data Migrations";
  const startIndex = manifestText.indexOf(sectionHeading);
  if (startIndex === -1) {
    throw new Error(`worker/migrations/MANIFEST.md is missing the "${sectionHeading}" section.`);
  }

  const sectionStart = startIndex + sectionHeading.length;
  const nextHeadingIndex = manifestText.indexOf("\n## ", sectionStart);
  const sectionText = manifestText.slice(
    sectionStart,
    nextHeadingIndex === -1 ? manifestText.length : nextHeadingIndex,
  );
  const rows = [...sectionText.matchAll(
    /^\|\s*(\d{4})\s*\|\s*`([^`]+\.sql)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm,
  )].map(([, sequence, filename, predicate, oldWorkerCompatibility, rollbackBookmark, expectedRowBounds]) => ({
    sequence,
    filename,
    predicate: predicate.trim(),
    oldWorkerCompatibility: oldWorkerCompatibility.trim(),
    rollbackBookmark: rollbackBookmark.trim(),
    expectedRowBounds: expectedRowBounds.trim(),
  }));

  if (rows.length === 0) {
    throw new Error(`worker/migrations/MANIFEST.md section "${sectionHeading}" has no migration rows.`);
  }
  return rows;
}

export function validateManifestMigrationParity(
  migrationFiles: readonly string[],
  manifestText: string,
): ManifestParity {
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
    nextHeading: manifestText.includes("## Completed Destructive Cleanup Operations")
      ? "## Completed Destructive Cleanup Operations"
      : manifestText.includes("## Reviewed Data Migrations")
        ? "## Reviewed Data Migrations"
        : "## Known Anomalies",
  });

  const activeFiles = migrationFiles.filter((file) => file !== "0000_baseline.sql");
  const activeManifestFiles = activeRows.map((row) => row.filename);
  const retiredManifestFiles = retiredRows.map((row) => row.filename);
  const activeFileSet = new Set(activeFiles);
  const activeManifestFileSet = new Set(activeManifestFiles);
  const retiredManifestFileSet = new Set(retiredManifestFiles);
  const errors: string[] = [];

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

export function validateRolloutSafetyPolicy(policy: RolloutSafetyPolicy): void {
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

export function validateDuplicatePrefixes(migrationFiles: readonly string[]): string[] {
  const uniqueDuplicates = findDuplicatePrefixes(migrationFiles);
  if (uniqueDuplicates.length > 0) {
    throw new Error(`Duplicate migration sequence numbers: ${uniqueDuplicates.join(", ")}`);
  }
  return uniqueDuplicates;
}

export function requiresRolloutSafetyValidation(
  file: string,
  enforcementPrefix = ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
): boolean {
  return getMigrationSequenceNumber(file) >= Number(enforcementPrefix);
}

export function parseRolloutSafetyMode(sql: string): string | null {
  return sql.match(/^\s*--\s*rollout-safety:\s*([a-z-]+)\s*$/im)?.[1].toLowerCase() ?? null;
}

export function parseDataMigrationMode(sql: string): string | null {
  return sql.match(/^\s*--\s*data-migration:\s*([a-z-]+)\s*$/im)?.[1].toLowerCase() ?? null;
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

export function findUnsafeRolloutStatements(sql: string): string[] {
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

export function findDestructiveDataStatements(sql: string): string[] {
  const normalizedSql = stripSqlComments(sql);
  return DESTRUCTIVE_DATA_MIGRATION_PATTERNS
    .filter(({ pattern }) => pattern.test(normalizedSql))
    .map(({ label }) => label);
}

export function findDataMigrationTargets(sql: string): string[] {
  const normalizedSql = stripSqlComments(sql);
  const targets = [
    ...normalizedSql.matchAll(/\bDELETE\s+FROM\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi),
    ...normalizedSql.matchAll(/\bUPDATE\s+(?:OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)[\]`"]?\s+SET\b/gi),
    ...normalizedSql.matchAll(/\bINSERT\s+OR\s+REPLACE\s+INTO\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi),
  ].map((match) => match[1].toLowerCase());
  return [...new Set(targets)];
}

export function validateDataMigrationManifestRows(
  rows: readonly DataMigrationManifestRow[],
  migrationFiles: readonly string[],
  migrationSql: ReadonlyMap<string, string>,
): void {
  const duplicateFiles = rows
    .map((row) => row.filename)
    .filter((filename, index, filenames) => filenames.indexOf(filename) !== index);
  if (duplicateFiles.length > 0) {
    throw new Error(`duplicate reviewed data-migration rows: ${[...new Set(duplicateFiles)].join(", ")}`);
  }

  for (const row of rows) {
    if (!migrationFiles.includes(row.filename)) {
      throw new Error(`reviewed data-migration row has no active migration file: ${row.filename}`);
    }
    if (row.sequence !== row.filename.slice(0, 4)) {
      throw new Error(`reviewed data-migration sequence/filename mismatch: ${row.sequence} -> ${row.filename}`);
    }
    const sql = migrationSql.get(row.filename);
    if (!sql || findDestructiveDataStatements(sql).length === 0) {
      throw new Error(`reviewed data-migration row does not name a migration with destructive DML: ${row.filename}`);
    }
  }
}

export function validateNoSqliteDotCommands(file: string, sql: string): void {
  const dotCommandLine = sql.split(/\r?\n/).find((line) => /^\s*\./.test(line));

  if (dotCommandLine) {
    throw new Error(
      `${file} contains a sqlite3 shell dot-command line (${dotCommandLine.trim()}); migrations must contain SQL only.`,
    );
  }
}

export function validateRolloutSafetyAnnotation(
  file: string,
  sql: string,
  enforcementPrefix = ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
  dataMigrationRows: readonly DataMigrationManifestRow[] = [],
): { checked: false; mode?: never } | { checked: true; mode: string } {
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

  const unsafeStatements = findUnsafeRolloutStatements(sql).filter(
    (statement) =>
      statement !== "DROP INDEX" || getMigrationSequenceNumber(file) > DROP_INDEX_GRANDFATHER_THROUGH_SEQUENCE,
  );
  if (unsafeStatements.length > 0) {
    if (unsafeStatements.includes("DROP INDEX")) {
      throw new Error(
        `${file} is marked rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE} but contains DROP INDEX, which requires the separate rollout path and coordinated cleanup process.`,
      );
    }
    throw new Error(
      `${file} is marked rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE} but contains statements that can break the still-live worker: ${unsafeStatements.join(", ")}`,
    );
  }

  const destructiveDataStatements = findDestructiveDataStatements(sql);
  const dataMigrationMode = parseDataMigrationMode(sql);
  if (destructiveDataStatements.length === 0) {
    if (dataMigrationMode) {
      throw new Error(`${file} declares data-migration metadata but contains no reviewed destructive DML.`);
    }
    return { checked: true, mode };
  }

  const manifestRow = dataMigrationRows.find((row) => row.filename === file);
  if (!manifestRow) {
    throw new Error(
      `${file} contains ${destructiveDataStatements.join(", ")} and requires a Reviewed Data Migrations manifest row.`,
    );
  }

  if (!DATA_MIGRATION_GRANDFATHER_FILES.includes(file) && dataMigrationMode !== REQUIRED_DATA_MIGRATION_MODE) {
    throw new Error(
      `${file} contains ${destructiveDataStatements.join(", ")} and must declare "-- data-migration: ${REQUIRED_DATA_MIGRATION_MODE}".`,
    );
  }
  if (dataMigrationMode && dataMigrationMode !== REQUIRED_DATA_MIGRATION_MODE) {
    throw new Error(`${file} declares unsupported data-migration mode "${dataMigrationMode}".`);
  }

  return { checked: true, mode };
}

const SCHEMA_OBJECT_QUERY = `
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE sql IS NOT NULL
  AND name NOT LIKE 'sqlite_%'
  AND tbl_name NOT LIKE 'sqlite_%'
ORDER BY type, name, tbl_name
`;

export function createSchemaObjectManifest(schemaRows: readonly SchemaRow[]): string {
  return `${schemaRows
    .map((row) => `${row.type}\t${row.name}`)
    .sort()
    .join("\n")}\n`;
}

export function validateSchemaObjectManifest(actual: string, expected: string): void {
  if (actual === expected) {
    return;
  }

  const actualObjects = new Set(actual.trim().split("\n").filter(Boolean));
  const expectedObjects = new Set(expected.trim().split("\n").filter(Boolean));
  const unexpected = [...actualObjects].filter((object) => !expectedObjects.has(object));
  const missing = [...expectedObjects].filter((object) => !actualObjects.has(object));
  const details = [
    unexpected.length > 0 ? `unexpected fresh-replay objects: ${unexpected.join(", ")}` : null,
    missing.length > 0 ? `expected objects missing from fresh replay: ${missing.join(", ")}` : null,
  ].filter(Boolean);
  if (details.length === 0) {
    details.push("object ordering, duplication, or file formatting differs");
  }

  throw new Error(`Fresh-replay schema object manifest drifted:\n- ${details.join("\n- ")}`);
}

async function createExecutor(dbPath: string): Promise<MigrationExecutor> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);

    return {
      backend: "node:sqlite",
      close() {
        db.close();
      },
      execute(sql: string) {
        db.exec(sql);
      },
      hasTable(name: string) {
        return Boolean(
          db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name),
        );
      },
      getSchemaRows() {
        return db
          .prepare(SCHEMA_OBJECT_QUERY)
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
        execute(sql: string) {
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
        hasTable(name: string) {
          const result = spawnSync(
            "sqlite3",
            ["-bail", dbPath, `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '${name}';`],
            { encoding: "utf8" },
          );
          if (result.error || result.status !== 0) {
            const detail = result.error?.message ?? (result.stderr || result.stdout || "").trim();
            throw new Error(`sqlite3 table fixture query failed: ${detail}`);
          }
          return result.stdout.trim() === "1";
        },
        getSchemaRows() {
          const result = spawnSync("sqlite3", ["-bail", "-json", dbPath, SCHEMA_OBJECT_QUERY], {
            encoding: "utf8",
          });

          if (result.error) {
            throw new Error(`sqlite3 CLI schema object query failed: ${result.error.message}`);
          }

          if (result.status !== 0) {
            const detail = (result.stderr || result.stdout || "").trim();
            throw new Error(detail || `sqlite3 schema object query exited with status ${result.status}`);
          }

          const rows: unknown = JSON.parse(result.stdout || "[]");
          if (!Array.isArray(rows)) {
            throw new Error("sqlite3 schema object query returned a non-array payload");
          }

          return rows.map((row): SchemaRow => {
            if (!row || typeof row !== "object") {
              throw new Error("sqlite3 schema object query returned an invalid row");
            }
            const record = row as Record<string, unknown>;
            return {
              type: String(record.type),
              name: String(record.name),
              tblName: String(record.tbl_name),
              sql: String(record.sql),
            };
          });
        },
      };
    }

    const sqlite3ErrorCode =
      sqlite3Probe.error && "code" in sqlite3Probe.error ? String(sqlite3Probe.error.code) : undefined;
    const sqlite3Detail = sqlite3Probe.error
      ? sqlite3ErrorCode === "ENOENT"
        ? "sqlite3 CLI is not installed"
        : sqlite3Probe.error.message
      : (sqlite3Probe.stderr || sqlite3Probe.stdout || "").trim() ||
        `sqlite3 -version exited with status ${sqlite3Probe.status}`;
    throw new Error(
      `Worker migration validation requires node:sqlite or sqlite3. node:sqlite load failed: ${nodeSqliteDetail}. sqlite3 probe: ${sqlite3Detail}`,
    );
  }
}

function seedPreMigrationFixture(executor: MigrationExecutor, targets: readonly string[]): void {
  for (const target of targets) {
    if (!executor.hasTable(target)) {
      throw new Error(`seeded pre-migration fixture target does not exist: ${target}`);
    }
    if (target === "cron_runs") {
      executor.execute(
        "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('migration-gate-fixture', 1, 0, 'ok');",
      );
      continue;
    }
    if (target === "dex_deployment_outcomes") {
      executor.execute(`
        INSERT INTO dex_discovery_meta (stablecoin_id, last_crawl_at)
        VALUES ('migration-gate-fixture', 100);
        INSERT INTO dex_deployment_outcomes (
          stablecoin_id, chain, contract_address, outcome, reason, observed_at
        ) VALUES (
          'migration-gate-fixture', 'ethereum', '0x0000000000000000000000000000000000000001',
          'verified_no_pools', 'migration-gate-fixture', 90
        );
      `);
      continue;
    }
    throw new Error(
      `No seeded pre-migration fixture is defined for data-migration target "${target}". Add a representative existing row before approving the migration.`,
    );
  }
}

export async function validateWorkerMigrations({
  migrationsDir = resolve("worker/migrations"),
  manifestPath = resolve("worker/migrations/MANIFEST.md"),
  expectedSchemaPath = resolve("worker/migrations/EXPECTED_SCHEMA.txt"),
  writeSchemaManifest = false,
}: ValidateWorkerMigrationsOptions = {}): Promise<WorkerMigrationResult> {
  const migrationFiles = getWorkerMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const migrationSql = new Map(
    migrationFiles.map((file) => [file, readFileSync(join(migrationsDir, file), "utf8")]),
  );
  const manifestText = readFileSync(manifestPath, "utf8");
  const rolloutSafetyPolicy = parseRolloutSafetyPolicy(manifestText);
  validateRolloutSafetyPolicy(rolloutSafetyPolicy);
  const manifestParity = validateManifestMigrationParity(migrationFiles, manifestText);
  const dataMigrationRows = parseDataMigrationManifestRows(manifestText);
  validateDataMigrationManifestRows(dataMigrationRows, migrationFiles, migrationSql);
  const uniqueDuplicates = validateDuplicatePrefixes(migrationFiles);
  let rolloutSafetyCheckedCount = 0;
  for (const file of migrationFiles) {
    const sql = migrationSql.get(file)!;
    const rolloutSafety = validateRolloutSafetyAnnotation(
      file,
      sql,
      rolloutSafetyPolicy.enforcementPrefix,
      dataMigrationRows,
    );
    validateNoSqliteDotCommands(file, sql);
    rolloutSafetyCheckedCount += rolloutSafety.checked ? 1 : 0;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pharos-worker-migrations-"));
  const dbPath = join(tempDir, "migrations.db");
  const executor = await createExecutor(dbPath);
  let dataMigrationFixtureCheckedCount = 0;
  let schemaObjectCount = 0;

  try {
    for (const file of migrationFiles) {
      try {
        executor.execute(migrationSql.get(file)!);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration replay failed for ${join(migrationsDir, file)}\n${message}`);
      }
    }

    const schemaRows = executor.getSchemaRows();
    const schemaObjectManifest = createSchemaObjectManifest(schemaRows);
    schemaObjectCount = schemaRows.length;
    if (writeSchemaManifest) {
      mkdirSync(dirname(expectedSchemaPath), { recursive: true });
      writeFileSync(expectedSchemaPath, schemaObjectManifest);
    } else {
      validateSchemaObjectManifest(schemaObjectManifest, readFileSync(expectedSchemaPath, "utf8"));
    }

    for (const row of dataMigrationRows) {
      const migrationIndex = migrationFiles.indexOf(row.filename);
      const fixtureExecutor = await createExecutor(join(tempDir, `fixture-${row.sequence}.db`));
      try {
        for (const priorFile of migrationFiles.slice(0, migrationIndex)) {
          fixtureExecutor.execute(migrationSql.get(priorFile)!);
        }
        const sql = migrationSql.get(row.filename)!;
        seedPreMigrationFixture(fixtureExecutor, findDataMigrationTargets(sql));
        fixtureExecutor.execute(sql);
        dataMigrationFixtureCheckedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Seeded pre-migration fixture failed for ${row.filename}\n${message}`);
      } finally {
        fixtureExecutor.close();
      }
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
    dataMigrationFixtureCheckedCount,
    schemaObjectCount,
    uniqueDuplicates,
  };
}

function parseCliArgs(argv: readonly string[]) {
  let writeSchemaManifest = false;

  for (const arg of argv) {
    if (arg === "--write-schema-manifest") {
      writeSchemaManifest = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { writeSchemaManifest };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await validateWorkerMigrations({
      writeSchemaManifest: options.writeSchemaManifest,
    });
    console.log(
      `Validated ${result.migrationCount} worker migrations with ${result.backend} (manifest rows: ${result.manifestParity.activeManifestCount} active, ${result.manifestParity.retiredManifestCount} retired; rollout safety checked: ${result.rolloutSafetyCheckedCount}; seeded data migrations checked: ${result.dataMigrationFixtureCheckedCount}).`,
    );
    console.log(
      `${options.writeSchemaManifest ? "Regenerated" : "Validated"} fresh-replay schema manifest (${result.schemaObjectCount} objects).`,
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

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
