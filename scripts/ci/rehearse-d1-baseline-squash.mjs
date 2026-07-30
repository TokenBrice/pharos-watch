import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPLAY_START = 72;
const REPLAY_END = 227;
const RETIRED_SEQUENCES = new Set([86]);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "worker/migrations");
const CANDIDATE_DIR = join(MIGRATIONS_DIR, "squash-candidate-0072-0227");
const CANDIDATE_PATH = join(CANDIDATE_DIR, "0000_baseline.sql");
const SCHEMA_QUERY = `
SELECT type, name, tbl_name AS tblName, sql
FROM sqlite_schema
WHERE sql IS NOT NULL
  AND name NOT LIKE 'sqlite_%'
  AND tbl_name NOT LIKE 'sqlite_%'
ORDER BY type, name, tbl_name
`;

function runSqlite(args, { input } = {}) {
  const result = spawnSync("sqlite3", args, {
    encoding: "utf8",
    input,
  });

  if (result.error) {
    throw new Error(`sqlite3 failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited with ${result.status}`).trim());
  }

  return result.stdout;
}

function listOriginalMigrationFiles() {
  const filesBySequence = new Map();

  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = file.match(/^(\d{4})_.+\.sql$/);
    if (!match) {
      continue;
    }

    const sequence = Number(match[1]);
    if (sequence >= REPLAY_START && sequence <= REPLAY_END) {
      filesBySequence.set(sequence, file);
    }
  }

  const expectedSequences = [];
  for (let sequence = REPLAY_START; sequence <= REPLAY_END; sequence += 1) {
    if (!RETIRED_SEQUENCES.has(sequence)) {
      expectedSequences.push(sequence);
    }
  }

  const actualSequences = [...filesBySequence.keys()].sort((left, right) => left - right);
  if (actualSequences.length !== expectedSequences.length) {
    throw new Error(
      `Expected ${expectedSequences.length} active migrations in ${REPLAY_START.toString().padStart(4, "0")}–${REPLAY_END.toString().padStart(4, "0")}, found ${actualSequences.length}.`,
    );
  }

  for (const [index, sequence] of expectedSequences.entries()) {
    if (actualSequences[index] !== sequence) {
      throw new Error(`Migration inventory drift: expected sequence ${sequence.toString().padStart(4, "0")}.`);
    }
  }

  return ["0000_baseline.sql", ...actualSequences.map((sequence) => filesBySequence.get(sequence))];
}

function applySqlFiles(dbPath, files) {
  const sql = files
    .map((file) => `-- source: worker/migrations/${file}\n${readFileSync(join(MIGRATIONS_DIR, file), "utf8")}`)
    .join("\n\n");
  runSqlite(["-bail", dbPath], { input: sql });
}

function normalizeSchemaSql(sql) {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function schemaRows(dbPath) {
  return JSON.parse(runSqlite(["-readonly", "-json", dbPath, SCHEMA_QUERY]) || "[]");
}

function schemaDump(dbPath) {
  const typeOrder = new Map([
    ["table", 0],
    ["index", 1],
    ["trigger", 2],
    ["view", 3],
  ]);

  return schemaRows(dbPath)
    .sort((left, right) => {
      const typeDifference = typeOrder.get(left.type) - typeOrder.get(right.type);
      return typeDifference || left.name.localeCompare(right.name);
    })
    .map((row) => `${row.sql};`)
    .join("\n\n");
}

function normalizedSchema(dbPath) {
  const rows = schemaRows(dbPath);
  return rows
    .map((row) => `${row.type}\t${row.name}\t${row.tblName}\t${normalizeSchemaSql(row.sql)}`)
    .sort()
    .join("\n");
}

function dataDump(dbPath) {
  const dump = runSqlite(["-readonly", dbPath, ".dump --data-only --nosys"]).trim();
  return dump === "" ? "" : dump.split("\n").sort().join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeIdempotentBaseline(schema, seedRows) {
  const idempotentSchema = schema
    .replace(/^CREATE TABLE /gm, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE UNIQUE INDEX /gm, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE INDEX /gm, "CREATE INDEX IF NOT EXISTS ")
    .replace(/^CREATE TRIGGER /gm, "CREATE TRIGGER IF NOT EXISTS ")
    .replace(/^CREATE VIEW /gm, "CREATE VIEW IF NOT EXISTS ");
  const idempotentSeeds = seedRows.replace(/^INSERT INTO /gm, "INSERT OR IGNORE INTO ");

  return `-- Squash candidate baseline: consolidates migrations 0001 through 0227.\n--\n-- LOCAL PROOF ONLY. This file is not part of the active migration inventory.\n-- It must not replace worker/migrations/0000_baseline.sql or alter MANIFEST.md\n-- until the owner-gated, coordinated D1 rollout is approved.\n--\n-- Fresh databases only. Existing databases retain their applied-migration ledger.\n-- Source replay: 0000_baseline.sql plus active migrations 0072-0227; 0086 is retired.\n\n${idempotentSchema}\n\n-- Required fresh-database seed rows from the original replay.\n${idempotentSeeds}\n`;
}

function main() {
  const originalFiles = listOriginalMigrationFiles();
  const scratchDir = mkdtempSync(join(tmpdir(), "pharos-d1-squash-"));
  const upgradeDb = join(scratchDir, "upgrade.db");
  const freshDb = join(scratchDir, "fresh.db");

  try {
    applySqlFiles(upgradeDb, originalFiles);
    const sourceSchema = schemaDump(upgradeDb);
    const sourceSeeds = dataDump(upgradeDb);
    const candidate = makeIdempotentBaseline(sourceSchema, sourceSeeds);

    mkdirSync(CANDIDATE_DIR, { recursive: true });
    writeFileSync(CANDIDATE_PATH, candidate);
    runSqlite(["-bail", freshDb], { input: candidate });

    const upgradeSchema = normalizedSchema(upgradeDb);
    const freshSchema = normalizedSchema(freshDb);
    const upgradeSeeds = dataDump(upgradeDb);
    const freshSeeds = dataDump(freshDb);

    if (upgradeSchema !== freshSchema) {
      throw new Error("Normalized schema diff is non-empty.");
    }

    if (upgradeSeeds !== freshSeeds) {
      throw new Error("Seed-row dump diff is non-empty.");
    }

    const schemaRows = upgradeSchema === "" ? 0 : upgradeSchema.split("\n").length;
    const seedRows = upgradeSeeds === "" ? 0 : upgradeSeeds.split("\n").length;
    console.log(`Replayed ${originalFiles.length} original migration files with sqlite3.`);
    console.log(`Wrote local squash candidate: ${CANDIDATE_PATH}`);
    console.log(`Normalized schema SHA-256: ${sha256(upgradeSchema)} (${schemaRows} rows)`);
    console.log("Normalized schema diff: identical");
    console.log(`Seed-row SHA-256: ${sha256(upgradeSeeds)} (${seedRows} rows)`);
    console.log("Seed-row dump diff: identical");
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

main();
