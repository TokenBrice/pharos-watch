#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const DEFAULT_DATABASE = "stablecoin-db";
const DEFAULT_API_URL = "https://api.pharos.watch";
const DEFAULT_ADMIN_API_URL = "https://ops-api.pharos.watch";
const DEFAULT_METADATA_BYTES = 800;
const DEFAULT_MAX_BUFFER_MB = 32;

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
    "  --admin-api-url <url>    Admin API origin for /api/status* (default: https://ops-api.pharos.watch)",
    "  --metadata-bytes <n>     Metadata preview bytes for D1 rows (default: 800)",
    "  --include-full-metadata  Select full metadata blobs instead of bounded previews",
    "  --include-status         Fetch /api/status in addition to /api/health",
    "  --include-status-history Fetch /api/status-history in addition to /api/health",
    "  --cf-access-client-id <v> Cloudflare Access service token client id (or CF_ACCESS_CLIENT_ID)",
    "  --cf-access-client-secret <v> Cloudflare Access service token secret (or CF_ACCESS_CLIENT_SECRET)",
    "  --max-buffer-mb <n>      Max stdout buffer for wrangler D1 queries (default: 32)",
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
    adminApiUrl: DEFAULT_ADMIN_API_URL,
    remote: true,
    json: false,
    skipHealth: false,
    includeStatus: false,
    includeStatusHistory: false,
    includeFullMetadata: false,
    metadataBytes: DEFAULT_METADATA_BYTES,
    maxBufferMb: DEFAULT_MAX_BUFFER_MB,
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID ?? "",
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? "",
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
      case "--admin-api-url":
        args.adminApiUrl = next();
        break;
      case "--metadata-bytes":
        args.metadataBytes = Number.parseInt(next(), 10);
        break;
      case "--include-full-metadata":
        args.includeFullMetadata = true;
        break;
      case "--include-status":
        args.includeStatus = true;
        break;
      case "--include-status-history":
        args.includeStatusHistory = true;
        break;
      case "--cf-access-client-id":
        args.cfAccessClientId = next();
        break;
      case "--cf-access-client-secret":
        args.cfAccessClientSecret = next();
        break;
      case "--max-buffer-mb":
        args.maxBufferMb = Number.parseInt(next(), 10);
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
  if (!Number.isFinite(args.metadataBytes) || args.metadataBytes <= 0) {
    throw new Error("--metadata-bytes must be a positive number");
  }
  if (!Number.isFinite(args.maxBufferMb) || args.maxBufferMb <= 0) {
    throw new Error("--max-buffer-mb must be a positive number");
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
    maxBuffer: Math.floor(args.maxBufferMb * 1024 * 1024),
  });
  return parseWranglerRows(stdout);
}

function errorMessage(error) {
  const value = error && typeof error === "object" ? error : {};
  const stderr = "stderr" in value ? value.stderr : null;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim().slice(0, 1000);
  if (typeof stderr === "string" && stderr.length > 0) return stderr.trim().slice(0, 1000);
  if (error instanceof Error) return error.message.slice(0, 1000);
  return String(error).slice(0, 1000);
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function isMissingTableMessage(message, table) {
  const normalized = String(message).toLowerCase();
  return normalized.includes("no such table") && normalized.includes(String(table).toLowerCase());
}

export function missingOptionalArtifactGap(descriptor) {
  return {
    artifact: descriptor.artifact,
    table: descriptor.table,
    code: "missing_table",
    severity: "info",
    optional: true,
    message: `Optional D1 artifact table ${descriptor.table} is not present. Deploy the rollout migration, or ignore until this telemetry surface is enabled.`,
  };
}

export function classifyArtifactFailure(descriptor, message) {
  const missingTable = descriptor.table ? isMissingTableMessage(message, descriptor.table) : false;
  return {
    artifact: descriptor.artifact,
    table: descriptor.table ?? null,
    code: missingTable ? "missing_table" : "query_failed",
    severity: missingTable && descriptor.optionalMissing ? "info" : "warning",
    optional: Boolean(descriptor.optionalMissing),
    message: String(message).slice(0, 1000),
  };
}

function loadExistingTables(args, tables) {
  if (tables.length === 0) return { tables: new Set(), error: null };
  const tableList = tables.map((table) => `'${escapeSqlLiteral(table)}'`).join(", ");
  try {
    const rows = d1Select(
      args,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableList})`,
    );
    return {
      tables: new Set(rows.map((row) => row.name).filter((name) => typeof name === "string")),
      error: null,
    };
  } catch (error) {
    return { tables: null, error: errorMessage(error) };
  }
}

function optionalD1Select(args, descriptor, existingTables = null) {
  if (descriptor.optionalMissing && descriptor.table && existingTables?.tables) {
    if (!existingTables.tables.has(descriptor.table)) {
      return { rows: [], error: null, gap: missingOptionalArtifactGap(descriptor) };
    }
  }
  if (descriptor.optionalMissing && descriptor.table && existingTables?.error) {
    const gap = classifyArtifactFailure(descriptor, existingTables.error);
    return { rows: [], error: existingTables.error, gap };
  }

  try {
    return { rows: d1Select(args, descriptor.sql), error: null, gap: null };
  } catch (error) {
    const message = errorMessage(error);
    const gap = classifyArtifactFailure(descriptor, message);
    return {
      rows: [],
      error: gap.code === "missing_table" && gap.optional ? null : message,
      gap,
    };
  }
}

function accessHeaders(args) {
  const headers = {};
  if (args.cfAccessClientId && args.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = args.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = args.cfAccessClientSecret;
  }
  return headers;
}

async function fetchJsonProbe(args, path, origin = args.apiUrl) {
  const url = new URL(path, origin);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers: accessHeaders(args) });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text.slice(0, 1000);
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

async function fetchProbes(args) {
  const probes = {};
  if (!args.skipHealth) {
    probes.health = await fetchJsonProbe(args, "/api/health");
  }
  if (args.includeStatus) {
    probes.status = await fetchJsonProbe(args, "/api/status", args.adminApiUrl);
  }
  if (args.includeStatusHistory) {
    probes.statusHistory = await fetchJsonProbe(args, "/api/status-history", args.adminApiUrl);
  }
  return probes;
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
  console.log(`Health: ${report.probes.health ? `${report.probes.health.status} ${report.probes.health.payload?.status ?? ""}`.trim() : "skipped"}`);
  if (report.probes.status) {
    console.log(`Status: ${report.probes.status.status} ${report.probes.status.payload?.overallStatus ?? report.probes.status.payload?.status ?? ""}`.trim());
  }
  if (report.probes.statusHistory) {
    console.log(`Status history: ${report.probes.statusHistory.status}`);
  }
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

  if (report.artifactGaps?.length > 0) {
    console.log("");
    console.log("Artifact gaps:");
    for (const gap of report.artifactGaps) {
      const label = gap.optional && gap.code === "missing_table" ? "optional artifact gap" : "artifact gap";
      console.log(`- ${gap.artifact}: ${label} ${gap.code} (${gap.message})`);
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

function metadataSelect(args, columnName) {
  if (args.includeFullMetadata) {
    return `${columnName}, length(${columnName}) AS metadata_bytes`;
  }
  return `length(${columnName}) AS metadata_bytes, substr(${columnName}, 1, ${Math.floor(args.metadataBytes)}) AS metadata_preview`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceSec = Math.floor(args.sinceMinutes * 60);
  const limit = Math.floor(args.limit);
  const metadataBytes = Math.floor(args.metadataBytes);

  // SAFETY: sinceSec/limit/metadataBytes are positive integers derived from validated CLI numeric options.
  const recentRuns = d1Select(args, `
    SELECT job, started_at, duration_ms, status, error, item_count, slot_started_at, ${metadataSelect(args, "metadata")}
      FROM cron_runs
     WHERE slot_started_at >= unixepoch() - ${sinceSec}
        OR (slot_started_at IS NULL AND started_at >= unixepoch() - ${sinceSec})
     ORDER BY COALESCE(slot_started_at, started_at) DESC, started_at DESC
     LIMIT ${limit}
  `);
  const slots = d1Select(args, `
    SELECT slot_key, slot_started_at, state, result_status, execution_owner, started_at, finished_at, updated_at, ${metadataSelect(args, "metadata")}
      FROM cron_slot_executions
     WHERE slot_started_at >= unixepoch() - ${Math.max(sinceSec, 24 * 3600)}
     ORDER BY slot_started_at DESC
     LIMIT 80
  `);
  const leases = d1Select(args, `
    SELECT job, lease_owner, lease_until, heartbeat_at, updated_at
      FROM cron_leases
     ORDER BY lease_until ASC
  `);
  const progress = d1Select(args, `
    SELECT job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, slot_started_at, ${metadataSelect(args, "metadata")}
      FROM cron_run_progress
     ORDER BY updated_at DESC
  `);
  const optionalArtifactTables = [
    "worker_job_attempts",
    "worker_repair_tasks",
    "worker_canary_runs",
    "surface_publication_generations",
  ];
  const existingOptionalTables = loadExistingTables(args, optionalArtifactTables);
  const jobAttempts = optionalD1Select(args, {
    artifact: "jobAttempts",
    table: "worker_job_attempts",
    optionalMissing: true,
    sql: `
    SELECT attempt_id, schedule_key, job, slot_started_at, state, status_class, attempt_no, owner, lease_until,
           queued_at, claimed_at, started_at, last_heartbeat_at, finished_at, updated_at, duration_ms, item_count,
           error, ${metadataSelect(args, "result_metadata_json")}
      FROM worker_job_attempts
     ORDER BY updated_at DESC
     LIMIT ${Math.min(limit, 80)}
  `,
  }, existingOptionalTables);
  const repairTasks = optionalD1Select(args, {
    artifact: "repairTasks",
    table: "worker_repair_tasks",
    optionalMissing: true,
    sql: `
    SELECT task_id, kind, subject_id, priority, state, attempt_count, next_attempt_at, last_attempt_at,
           locked_by, locked_until, created_at, updated_at, closed_at, last_error,
           ${metadataSelect(args, "payload_json")}
      FROM worker_repair_tasks
     ORDER BY updated_at DESC
     LIMIT 80
  `,
  }, existingOptionalTables);
  const canaryRuns = optionalD1Select(args, {
    artifact: "canaryRuns",
    table: "worker_canary_runs",
    optionalMissing: true,
    sql: `
    SELECT check_id, status, severity, observed_at, duration_ms, error, ${metadataSelect(args, "metadata_json")}
      FROM worker_canary_runs
     ORDER BY observed_at DESC
     LIMIT 80
  `,
  }, existingOptionalTables);
  const dexPublicationGenerations = optionalD1Select(args, {
    artifact: "dexPublicationGenerations",
    table: "dex_liquidity_publication_generations",
    optionalMissing: false,
    sql: `
    SELECT generation_id, started_at, state, expected_row_count, written_row_count, current_row_count,
           published_at, failed_at, failure_reason, ${metadataSelect(args, "metadata_json")}
      FROM dex_liquidity_publication_generations
     ORDER BY started_at DESC
     LIMIT 20
  `,
  });
  const yieldPublicationGenerations = optionalD1Select(args, {
    artifact: "yieldPublicationGenerations",
    table: "yield_publication_generations",
    optionalMissing: false,
    sql: `
    SELECT generation_id, started_at, state, cache_key, ranking_updated_at, ranking_count, source_row_count,
           best_row_count, decision_count, published_at, failed_at, failure_reason, ${metadataSelect(args, "metadata_json")}
      FROM yield_publication_generations
     ORDER BY started_at DESC
     LIMIT 20
  `,
  });
  const surfacePublicationGenerations = optionalD1Select(args, {
    artifact: "surfacePublicationGenerations",
    table: "surface_publication_generations",
    optionalMissing: true,
    sql: `
    SELECT surface, generation_id, state, started_at, validated_at, published_at, failed_at,
           candidate_rows, published_rows, expected_rows, failure_reason,
           artifact_cache_key, previous_generation_id,
           length(input_watermarks_json) AS input_watermarks_bytes,
           length(dependency_snapshot_json) AS dependency_snapshot_bytes,
           length(validation_summary_json) AS validation_summary_bytes
      FROM surface_publication_generations
     ORDER BY started_at DESC
     LIMIT 40
  `,
  }, existingOptionalTables);
  const probes = await fetchProbes(args);
  const optionalResults = {
    jobAttempts,
    repairTasks,
    canaryRuns,
    dexPublicationGenerations,
    yieldPublicationGenerations,
    surfacePublicationGenerations,
  };
  const artifactGaps = Object.values(optionalResults)
    .map((result) => result.gap)
    .filter(Boolean);
  const artifactErrors = Object.fromEntries(
    Object.entries(optionalResults)
      .filter(([, result]) => result.error)
      .map(([artifact, result]) => [artifact, result.error]),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    scope: args.remote ? "remote" : "local",
    database: args.database,
    sinceMinutes: args.sinceMinutes,
    metadataBytes: args.includeFullMetadata ? null : metadataBytes,
    probes,
    runStatusCounts: summarizeRuns(recentRuns),
    recentRuns,
    slots,
    leases,
    progress,
    jobAttempts: jobAttempts.rows,
    repairTasks: repairTasks.rows,
    canaryRuns: canaryRuns.rows,
    publicationGenerations: {
      dexLiquidity: dexPublicationGenerations.rows,
      yieldRankings: yieldPublicationGenerations.rows,
      surface: surfacePublicationGenerations.rows,
    },
    artifactGaps,
    artifactErrors,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
