#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKS = [
  {
    name: "duplicate_open_events",
    sql: `
SELECT stablecoin_id, COUNT(*) AS open_count
FROM depeg_events
WHERE ended_at IS NULL
GROUP BY stablecoin_id
HAVING COUNT(*) > 1;`,
  },
  {
    name: "overlapping_same_direction_events",
    sql: `
SELECT a.stablecoin_id, a.id AS event_id, b.id AS overlapping_event_id
FROM depeg_events a
JOIN depeg_events b
  ON a.stablecoin_id = b.stablecoin_id
 AND a.direction = b.direction
 AND a.id < b.id
 AND a.started_at <= COALESCE(b.ended_at, 9223372036854775807)
 AND b.started_at <= COALESCE(a.ended_at, 9223372036854775807);`,
  },
  {
    name: "recovery_prices_still_outside_threshold",
    sql: `
SELECT id, stablecoin_id, symbol, direction, recovery_price, peg_reference
FROM depeg_events
WHERE ended_at IS NOT NULL
  AND recovery_price IS NOT NULL
  AND ABS(((recovery_price / peg_reference) - 1) * 10000) >=
    CASE WHEN peg_type = 'peggedUSD' THEN 100 ELSE 150 END;`,
  },
  {
    name: "backfill_rows_missing_provenance",
    sql: `
SELECT e.id, e.stablecoin_id, e.symbol, e.started_at
FROM depeg_events e
LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
WHERE e.source = 'backfill'
  AND p.event_id IS NULL;`,
  },
  {
    name: "incomplete_replay_runs",
    sql: `
SELECT run_id, stablecoin_id, status, started_at, finished_at, error
FROM depeg_backfill_runs
WHERE status <> 'complete';`,
  },
  {
    name: "false_positive_events_still_pegscore_eligible",
    sql: `
SELECT e.id, e.stablecoin_id, e.symbol, p.audit_verdict
FROM depeg_events e
JOIN depeg_event_provenance p ON p.event_id = e.id
WHERE p.audit_verdict IN ('false_positive', 'disputed')
  AND COALESCE(json_extract(p.public_json, '$.pegScoreEligible'), 1) <> 0;`,
  },
  {
    name: "replay_fingerprint_mismatch",
    sql: `
SELECT run_id, stablecoin_id, expected_event_count, inserted_count, expected_fingerprint
FROM depeg_backfill_runs
WHERE status = 'complete'
  AND expected_event_count <> inserted_count;`,
  },
];

interface D1ResultEnvelope {
  results?: unknown[];
}

function printUsage(): void {
  console.log(`Usage:
  node --import tsx scripts/ci/check-depeg-operational-integrity.ts --print-sql
  node --import tsx scripts/ci/check-depeg-operational-integrity.ts --database stablecoin-db [--remote]

The wrangler mode is operator-run first and exits non-zero when any check returns rows.`);
}

function runWrangler(database: string, remote: boolean): number {
  const dir = mkdtempSync(join(tmpdir(), "pharos-depeg-check-"));
  try {
    let failures = 0;
    for (const check of CHECKS) {
      const sqlPath = join(dir, `${check.name}.sql`);
      writeFileSync(sqlPath, `${check.sql}\n`, "utf8");
      const args = ["wrangler", "d1", "execute", database, "--file", sqlPath, "--json"];
      if (remote) args.push("--remote");
      const result = spawnSync("npx", args, { encoding: "utf8" });
      if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout);
        return result.status ?? 1;
      }
      const output = result.stdout.trim();
      let rows: unknown[] = [];
      try {
        const parsed = JSON.parse(output) as D1ResultEnvelope | D1ResultEnvelope[];
        rows = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
      } catch {
        process.stdout.write(output + "\n");
      }
      if (rows.length > 0) {
        failures++;
        console.error(`FAIL ${check.name}: ${rows.length} row(s)`);
        console.log(JSON.stringify(rows.slice(0, 20), null, 2));
      } else {
        console.log(`ok ${check.name}`);
      }
    }
    return failures === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  printUsage();
  process.exit(args.includes("--help") ? 0 : 1);
}

if (args.includes("--print-sql")) {
  for (const check of CHECKS) {
    console.log(`-- ${check.name}`);
    console.log(check.sql.trim());
    console.log("");
  }
  process.exit(0);
}

const databaseIndex = args.indexOf("--database");
if (databaseIndex === -1 || !args[databaseIndex + 1]) {
  printUsage();
  process.exit(1);
}

process.exit(runWrangler(args[databaseIndex + 1], args.includes("--remote")));
