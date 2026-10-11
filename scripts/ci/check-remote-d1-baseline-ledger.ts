#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDirectCli } from "../lib/cli-args.mjs";

const BASELINE = "0000_baseline.sql";
// Both Worker configs use Wrangler's default migration directory and ledger.
const LEDGER_TABLE = "d1_migrations";
const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND name != '_cf_KV' ORDER BY name;";
const LEDGER_SQL = 'SELECT name FROM "d1_migrations" ORDER BY id;';
const WORKER_DIR = fileURLToPath(new URL("../../worker/", import.meta.url));

type BaselinePreflight = {
  status: "adopted" | "fresh";
  pendingMigrations: string[];
};

function parseD1Names(stdout: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Cannot parse remote D1 ${label}: expected Wrangler execute --json output.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Cannot parse remote D1 ${label}: expected exactly one query result.`);
  }
  const query: unknown = parsed[0];
  if (typeof query !== "object" || query === null || !("success" in query) || query.success !== true
    || !("results" in query) || !Array.isArray(query.results)) {
    throw new Error(`Cannot parse remote D1 ${label}: missing successful query rows.`);
  }
  const names: string[] = [];
  for (const row of query.results) {
    if (typeof row !== "object" || row === null || !("name" in row)
      || typeof row.name !== "string" || row.name.trim() === "" || row.name !== row.name.trim()) {
      throw new Error(`Cannot parse remote D1 ${label}: invalid name row.`);
    }
    names.push(row.name);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`Cannot parse remote D1 ${label}: duplicate names.`);
  }
  return names;
}

/** Strict JSON receipts, not missing/failed reads, establish adoption or freshness. */
export function checkRemoteD1BaselineLedger(
  tablesOutput: string,
  ledgerOutput: string | null,
  localMigrations: readonly string[],
): BaselinePreflight {
  if (!localMigrations.includes(BASELINE)) {
    throw new Error(`Local migration tree is missing ${BASELINE}.`);
  }
  const tables = parseD1Names(tablesOutput, "table inventory");
  const ledgerExists = tables.includes(LEDGER_TABLE);
  if (ledgerExists !== (ledgerOutput !== null)) {
    throw new Error("Remote D1 ledger receipt does not match the table inventory.");
  }
  const applied = ledgerOutput === null ? [] : parseD1Names(ledgerOutput, "migration ledger");
  const appliedNames = new Set(applied);
  const pendingMigrations = localMigrations.filter((name) => !appliedNames.has(name)).sort();
  if (appliedNames.has(BASELINE)) {
    return { status: "adopted", pendingMigrations };
  }
  // An empty/missing ledger alone does not prove a database with existing tables is fresh.
  if (applied.length > 0 || tables.some((name) => name !== LEDGER_TABLE)) {
    throw new Error(`${BASELINE} is pending on an existing database; stop for a reviewed baseline-adoption plan.`);
  }
  return { status: "fresh", pendingMigrations };
}

function executeReadOnlyQuery(sql: string): string {
  return execFileSync("npx", [
    "--no-install", "wrangler", "d1", "execute", "stablecoin-db",
    "--remote", "--config", "wrangler.toml", "--json", "--command", sql,
  ], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function runRemoteD1BaselinePreflight(
  query: (sql: string) => string = executeReadOnlyQuery,
  localMigrations: readonly string[] = readdirSync(new URL("../../worker/migrations/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name),
): BaselinePreflight {
  // Wrangler migrations list initializes its ledger (CREATE TABLE) and has no JSON mode.
  // SELECT-only execute receipts keep this preflight read-only, including on fresh D1.
  const tablesOutput = query(TABLES_SQL);
  const ledgerOutput = parseD1Names(tablesOutput, "table inventory").includes(LEDGER_TABLE)
    ? query(LEDGER_SQL)
    : null;
  return checkRemoteD1BaselineLedger(tablesOutput, ledgerOutput, localMigrations);
}

runDirectCli(import.meta.url, () => {
  const result = runRemoteD1BaselinePreflight();
  console.log(`[d1-baseline] ${result.status}: ${result.pendingMigrations.length} unapplied migrations.`);
  for (const name of result.pendingMigrations) console.log(`  ${name}`);
});
