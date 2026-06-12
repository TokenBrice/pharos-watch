#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_DATABASE = "stablecoin-db";
const DEFAULT_API_URL = "https://api.pharos.watch";

function usage() {
  return [
    "Usage: node scripts/maintenance/watch-worker-cron.mjs [options]",
    "",
    "Read-only Worker cron watcher for recent cron_runs, fenced slots, leases, progress rows, and public health.",
    "",
    "Options:",
    "  --database <name>        D1 database name (default: stablecoin-db)",
    "  --since-minutes <n>      Recent cron_runs lookback window (default: 180)",
    "  --limit <n>              Maximum recent cron_runs rows (default: 80)",
    "  --api-url <url>          Public API origin for /api/health (default: https://api.pharos.watch)",
    "  --local                  Use local D1 instead of --remote",
    "  --skip-health            Do not fetch /api/health",
    "  --json                   Print JSON only",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    database: DEFAULT_DATABASE,
    sinceMinutes: 180,
    limit: 80,
    apiUrl: DEFAULT_API_URL,
    remote: true,
    json: false,
    skipHealth: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--database":
        args.database = next();
        break;
      case "--since-minutes":
        args.sinceMinutes = Number.parseInt(next(), 10);
        break;
      case "--limit":
        args.limit = Number.parseInt(next(), 10);
        break;
      case "--api-url":
        args.apiUrl = next();
        break;
      case "--local":
        args.remote = false;
        break;
      case "--json":
        args.json = true;
        break;
      case "--skip-health":
        args.skipHealth = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(args.sinceMinutes) || args.sinceMinutes <= 0) {
    throw new Error("--since-minutes must be a positive number");
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return args;
}

function parseWranglerRows(stdout) {
  const parsed = JSON.parse(stdout);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.flatMap((entry) => {
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.[0]?.results)) return entry.result[0].results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
    return [];
  });
}

function d1Select(args, sql) {
  const wranglerArgs = [
    "--no-install",
    "wrangler",
    "d1",
    "execute",
    args.database,
    ...(args.remote ? ["--remote"] : []),
    "--json",
    "--command",
    sql,
  ];
  const stdout = execFileSync("npx", wranglerArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseWranglerRows(stdout);
}

async function fetchHealth(args) {
  if (args.skipHealth) return null;
  const url = new URL("/api/health", args.apiUrl);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET" });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      await response.body?.cancel().catch(() => {});
    }
    return {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      latencyMs: Date.now() - startedAt,
      payload,
    };
  } catch (error) {
    return {
      url: url.toString(),
      status: 0,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeRuns(runs) {
  const byStatus = new Map();
  for (const run of runs) {
    byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
  }
  return Object.fromEntries([...byStatus.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function formatAge(epochSec, nowSec) {
  if (typeof epochSec !== "number") return "unknown";
  const age = Math.max(0, nowSec - epochSec);
  if (age < 120) return `${age}s`;
  if (age < 7200) return `${Math.round(age / 60)}m`;
  return `${Math.round(age / 3600)}h`;
}

function printHuman(report) {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Worker cron watch (${report.scope})`);
  console.log(`Health: ${report.health ? `${report.health.status} ${report.health.payload?.status ?? ""}`.trim() : "skipped"}`);
  console.log(`Recent runs: ${report.recentRuns.length} rows, status counts ${JSON.stringify(report.runStatusCounts)}`);

  const notableRuns = report.recentRuns
    .filter((run) => run.status !== "ok")
    .slice(0, 12);
  if (notableRuns.length > 0) {
    console.log("");
    console.log("Recent non-ok cron_runs:");
    for (const run of notableRuns) {
      console.log(`- ${run.job}: ${run.status} ${formatAge(run.started_at, nowSec)} ago${run.error ? ` (${String(run.error).slice(0, 120)})` : ""}`);
    }
  }

  const runningSlots = report.slots.filter((slot) => slot.state === "running");
  if (runningSlots.length > 0) {
    console.log("");
    console.log("Running slots:");
    for (const slot of runningSlots) {
      console.log(`- ${slot.slot_key}@${slot.slot_started_at}: owner=${slot.execution_owner}, updated ${formatAge(slot.updated_at, nowSec)} ago`);
    }
  }

  if (report.progress.length > 0) {
    console.log("");
    console.log("Progress rows:");
    for (const row of report.progress.slice(0, 12)) {
      const count = row.items_total != null ? ` ${row.items_done ?? 0}/${row.items_total}` : "";
      console.log(`- ${row.job}: ${row.stage ?? "unknown"}${count}, updated ${formatAge(row.updated_at, nowSec)} ago`);
    }
  }

  const expiredLeases = report.leases.filter((lease) => typeof lease.lease_until === "number" && lease.lease_until < nowSec);
  if (expiredLeases.length > 0) {
    console.log("");
    console.log("Expired leases:");
    for (const lease of expiredLeases) {
      console.log(`- ${lease.job}: owner=${lease.lease_owner}, expired ${formatAge(lease.lease_until, nowSec)} ago`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceSec = Math.floor(args.sinceMinutes * 60);
  const limit = Math.floor(args.limit);

  // SAFETY: sinceSec/limit are positive integers derived from validated CLI numeric options.
  const recentRuns = d1Select(args, `
    SELECT job, started_at, duration_ms, status, error, item_count, slot_started_at, metadata
      FROM cron_runs
     WHERE started_at >= unixepoch() - ${sinceSec}
     ORDER BY started_at DESC
     LIMIT ${limit}
  `);
  const slots = d1Select(args, `
    SELECT slot_key, slot_started_at, state, result_status, execution_owner, started_at, finished_at, updated_at, metadata
      FROM cron_slot_executions
     WHERE updated_at >= unixepoch() - ${Math.max(sinceSec, 24 * 3600)}
     ORDER BY updated_at DESC
     LIMIT 80
  `);
  const leases = d1Select(args, `
    SELECT job, lease_owner, lease_until, heartbeat_at, updated_at
      FROM cron_leases
     ORDER BY lease_until ASC
  `);
  const progress = d1Select(args, `
    SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, slot_started_at, metadata
      FROM cron_run_progress
     ORDER BY updated_at DESC
  `);
  const health = await fetchHealth(args);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: args.remote ? "remote" : "local",
    database: args.database,
    sinceMinutes: args.sinceMinutes,
    health,
    runStatusCounts: summarizeRuns(recentRuns),
    recentRuns,
    slots,
    leases,
    progress,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
