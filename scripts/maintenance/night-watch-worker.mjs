#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://api.pharos.watch";
const DEFAULT_ADMIN_API_URL = "https://ops-api.pharos.watch";
const DEFAULT_DATABASE = "stablecoin-db";
const DEFAULT_EVIDENCE_JSON = "agents/night-watch-evidence.json";
const DEFAULT_OUTPUT = "agents/night-watch-report.md";
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_METADATA_BYTES = 800;
const DEFAULT_SAMPLE_LIMIT = 120;
const CYCLE_MS = 4 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(dirname(__filename), "../..");
const WATCH_SCRIPT = resolve(ROOT_DIR, "scripts/maintenance/watch-worker-cron.mjs");

function usage() {
  return [
    "Usage: node scripts/maintenance/night-watch-worker.mjs [options]",
    "",
    "Collect repeated read-only Worker cron snapshots and write a structured night-watch report.",
    "",
    "Options:",
    "  --cycles <1|2>               Four-hour watch cycles to cover (default: 1)",
    "  --start <iso>                Observation start timestamp (default: now)",
    "  --end <iso>                  Observation end timestamp (default: start + cycles*4h)",
    "  --interval-minutes <n>       Sampling interval (default: 15)",
    "  --include-status             Fetch admin /api/status",
    "  --include-status-history     Fetch admin /api/status-history",
    "  --include-d1                 Include remote/local D1 snapshots through watch-worker-cron",
    "  --include-worker-tail        Mark worker-tail evidence as requested (manual attachment)",
    "  --database <name>            D1 database name (default: stablecoin-db)",
    "  --api-url <url>              Public API origin for /api/health (default: https://api.pharos.watch)",
    "  --admin-api-url <url>        Admin API origin for /api/status* (default: https://ops-api.pharos.watch)",
    "  --metadata-bytes <n>         Metadata preview bytes for D1 rows (default: 800)",
    "  --sample-limit <n>           cron_runs limit per D1 sample (default: 120)",
    "  --output <path>              Markdown report path (default: agents/night-watch-report.md)",
    "  --evidence-json <path>       JSON evidence path (default: agents/night-watch-evidence.json)",
    "  --fixture <path>             Render/analyze an existing evidence JSON instead of collecting",
    "  --dry-run                   Build the schedule matrix and empty report without network/D1 reads",
    "  --local                     Use local D1 for --include-d1",
    "  --cf-access-client-id <v>    Cloudflare Access service token client id (or CF_ACCESS_CLIENT_ID)",
    "  --cf-access-client-secret <v> Cloudflare Access service token secret (or CF_ACCESS_CLIENT_SECRET)",
    "  --json                      Print evidence JSON to stdout instead of a short summary",
    "  --help                      Show this help",
  ].join("\n");
}

function parseInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseIso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

export function parseArgs(argv, now = new Date()) {
  const args = {
    cycles: 1,
    start: now.toISOString(),
    end: null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    includeStatus: false,
    includeStatusHistory: false,
    includeD1: false,
    includeWorkerTail: false,
    database: DEFAULT_DATABASE,
    apiUrl: DEFAULT_API_URL,
    adminApiUrl: DEFAULT_ADMIN_API_URL,
    metadataBytes: DEFAULT_METADATA_BYTES,
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
    outputPath: DEFAULT_OUTPUT,
    evidenceJsonPath: DEFAULT_EVIDENCE_JSON,
    fixturePath: null,
    dryRun: false,
    remote: true,
    json: false,
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID ?? "",
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? "",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--cycles":
        args.cycles = parseInteger(next(), "--cycles");
        break;
      case "--start":
        args.start = parseIso(next(), "--start");
        break;
      case "--end":
        args.end = parseIso(next(), "--end");
        break;
      case "--interval-minutes":
        args.intervalMinutes = parseInteger(next(), "--interval-minutes");
        break;
      case "--include-status":
        args.includeStatus = true;
        break;
      case "--include-status-history":
        args.includeStatusHistory = true;
        break;
      case "--include-d1":
        args.includeD1 = true;
        break;
      case "--include-worker-tail":
        args.includeWorkerTail = true;
        break;
      case "--database":
        args.database = next();
        break;
      case "--api-url":
        args.apiUrl = next();
        break;
      case "--admin-api-url":
        args.adminApiUrl = next();
        break;
      case "--metadata-bytes":
        args.metadataBytes = parseInteger(next(), "--metadata-bytes");
        break;
      case "--sample-limit":
        args.sampleLimit = parseInteger(next(), "--sample-limit");
        break;
      case "--output":
        args.outputPath = next();
        break;
      case "--evidence-json":
        args.evidenceJsonPath = next();
        break;
      case "--fixture":
        args.fixturePath = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--local":
        args.remote = false;
        break;
      case "--cf-access-client-id":
        args.cfAccessClientId = next();
        break;
      case "--cf-access-client-secret":
        args.cfAccessClientSecret = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (args.cycles !== 1 && args.cycles !== 2) throw new Error("--cycles must be 1 or 2");
  if (args.includeStatusHistory && !args.includeStatus) args.includeStatus = true;
  const startMs = new Date(args.start).getTime();
  const end = args.end ?? new Date(startMs + args.cycles * CYCLE_MS).toISOString();
  if (new Date(end).getTime() <= startMs) throw new Error("--end must be after --start");
  return { ...args, end };
}

function ensureParent(path) {
  mkdirSync(dirname(resolve(ROOT_DIR, path)), { recursive: true });
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
    return { url: url.toString(), status: response.status, ok: response.ok, latencyMs: Date.now() - startedAt, payload };
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

async function collectProbeOnlySnapshot(args) {
  const probes = {};
  probes.health = await fetchJsonProbe(args, "/api/health");
  if (args.includeStatus) probes.status = await fetchJsonProbe(args, "/api/status", args.adminApiUrl);
  if (args.includeStatusHistory) probes.statusHistory = await fetchJsonProbe(args, "/api/status-history", args.adminApiUrl);
  return {
    collectedAt: new Date().toISOString(),
    mode: "probe-only",
    probes,
    recentRuns: [],
    slots: [],
    leases: [],
    progress: [],
  };
}

function collectD1Snapshot(args, sinceMinutes) {
  const childArgs = [
    WATCH_SCRIPT,
    "--json",
    "--database",
    args.database,
    "--since-minutes",
    String(Math.max(1, Math.ceil(sinceMinutes))),
    "--limit",
    String(args.sampleLimit),
    "--api-url",
    args.apiUrl,
    "--admin-api-url",
    args.adminApiUrl,
    "--metadata-bytes",
    String(args.metadataBytes),
  ];
  if (args.includeStatus) childArgs.push("--include-status");
  if (args.includeStatusHistory) childArgs.push("--include-status-history");
  if (!args.remote) childArgs.push("--local");
  const env = { ...process.env };
  if (args.cfAccessClientId) env.CF_ACCESS_CLIENT_ID = args.cfAccessClientId;
  if (args.cfAccessClientSecret) env.CF_ACCESS_CLIENT_SECRET = args.cfAccessClientSecret;
  const collectedAt = new Date().toISOString();
  try {
    const stdout = execFileSync(process.execPath, childArgs, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    return { collectedAt, mode: "d1", ...JSON.parse(stdout) };
  } catch (error) {
    return {
      collectedAt,
      mode: "d1-error",
      error: childProcessErrorMessage(error),
      probes: {},
      recentRuns: [],
      slots: [],
      leases: [],
      progress: [],
    };
  }
}

function childProcessErrorMessage(error) {
  const value = error && typeof error === "object" ? error : {};
  const stderr = "stderr" in value ? value.stderr : null;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8").trim().slice(0, 1000);
  if (typeof stderr === "string" && stderr.length > 0) return stderr.trim().slice(0, 1000);
  if (error instanceof Error) return error.message.slice(0, 1000);
  return String(error).slice(0, 1000);
}

function loadScheduleMatrix() {
  const source = `
    import { CRON_JOB_DEFINITIONS, CRON_CONNECTION_BUDGET_ENTRIES } from "./shared/lib/cron-jobs.ts";
    import { SCHEDULED_SLOT_PLANS } from "./shared/lib/scheduled-runner-registry.ts";
    console.log(JSON.stringify({ cronJobs: CRON_JOB_DEFINITIONS, budgetEntries: CRON_CONNECTION_BUDGET_ENTRIES, slotPlans: SCHEDULED_SLOT_PLANS }));
  `;
  const stdout = execFileSync("npx", ["--no-install", "tsx", "--eval", source], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function latestBy(items, keyFn, timeFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (!existing || Number(timeFn(item) ?? 0) > Number(timeFn(existing) ?? 0)) map.set(key, item);
  }
  return map;
}

function flattenSnapshots(snapshots, key) {
  return snapshots.flatMap((snapshot) => Array.isArray(snapshot[key]) ? snapshot[key] : []);
}

function findLatestStatusPayload(snapshots) {
  for (const snapshot of [...snapshots].reverse()) {
    const payload = snapshot.probes?.status?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  }
  return null;
}

function accessGapForProbe(name, probe) {
  if (!probe) return `${name} not collected`;
  if ([401, 403, 302].includes(probe.status)) return `${name} gated (${probe.status})`;
  if (!probe.ok) return `${name} failed (${probe.status || "network"})`;
  return null;
}

function buildCoverage(scheduleMatrix, snapshots) {
  const runs = flattenSnapshots(snapshots, "recentRuns");
  const slots = flattenSnapshots(snapshots, "slots");
  const latestRunByJob = latestBy(runs, (run) => run.job, (run) => run.started_at);
  const latestSlotByKey = latestBy(slots, (slot) => slot.slot_key, (slot) => slot.updated_at);
  const statusPayload = findLatestStatusPayload(snapshots);
  const statusCrons = statusPayload?.crons && typeof statusPayload.crons === "object" ? statusPayload.crons : {};

  const jobs = scheduleMatrix.cronJobs.map((job) => {
    const latestRun = latestRunByJob.get(job.job);
    const statusCron = statusCrons[job.job];
    const observed = Boolean(latestRun || statusCron?.lastRun);
    const grade = latestRun
      ? "confirmed"
      : statusCron?.lastRun
        ? "runtime-only"
        : statusPayload || snapshots.some((snapshot) => snapshot.mode === "d1")
          ? "code-only"
          : "access-gap";
    return {
      job: job.job,
      label: job.label,
      scheduleKey: job.scheduleKey,
      intervalSec: job.intervalSec,
      maxConnections: job.maxConnections ?? 0,
      observed,
      evidenceGrade: grade,
      latestStatus: latestRun?.status ?? statusCron?.lastRun?.status ?? null,
      latestStartedAt: latestRun?.started_at ?? statusCron?.lastRun?.startedAt ?? null,
      notes: grade === "code-only" ? "not observed in collected window; verify cadence/not-due status" : "",
    };
  });

  const slotsByKey = Object.values(scheduleMatrix.slotPlans).map((plan) => {
    const latestSlot = latestSlotByKey.get(plan.scheduleKey);
    return {
      scheduleKey: plan.scheduleKey,
      schedule: plan.schedule,
      jobs: plan.jobChains.flat(),
      budgetOnlyJobs: plan.budgetOnlyJobs ?? [],
      latestState: latestSlot?.state ?? null,
      latestUpdatedAt: latestSlot?.updated_at ?? null,
      evidenceGrade: latestSlot ? "confirmed" : snapshots.some((snapshot) => snapshot.mode === "d1") ? "code-only" : "access-gap",
    };
  });

  const cronJobSet = new Set(scheduleMatrix.cronJobs.map((job) => job.job));
  const budgetOnly = scheduleMatrix.budgetEntries
    .filter((entry) => !cronJobSet.has(entry.job))
    .map((entry) => ({
      job: entry.job,
      scheduleKey: entry.scheduleKey,
      maxConnections: entry.maxConnections ?? 0,
      evidenceGrade: statusPayload?.budgetOnlySurfaces ? "runtime-only" : "code-only",
    }));

  return { jobs, slots: slotsByKey, budgetOnly };
}

function summarizeFindings(snapshots, statusPayload, coverage, args) {
  const findings = [];
  const runs = flattenSnapshots(snapshots, "recentRuns");
  const nonOkRuns = runs.filter((run) => run.status && run.status !== "ok");
  if (nonOkRuns.length > 0) {
    findings.push({
      severity: nonOkRuns.some((run) => run.status === "error") ? "High" : "Medium",
      title: `${nonOkRuns.length} non-ok cron run rows in collected window`,
      evidence: nonOkRuns.slice(0, 8).map((run) => `${run.job}: ${run.status}${run.error ? ` (${String(run.error).slice(0, 120)})` : ""}`),
    });
  }

  const progress = flattenSnapshots(snapshots, "progress");
  if (progress.length > 0) {
    findings.push({
      severity: "Medium",
      title: `${progress.length} active progress rows present during collection`,
      evidence: progress.slice(0, 8).map((row) => `${row.job}: ${row.stage ?? "unknown"} updated_at=${row.updated_at ?? "unknown"}`),
    });
  }

  const dependencyGroups = statusPayload?.dependencyHealth?.rootCauseGroups;
  if (Array.isArray(dependencyGroups) && dependencyGroups.length > 0) {
    findings.push({
      severity: "Medium",
      title: `${dependencyGroups.length} dependency root-cause group(s) reported by status`,
      evidence: dependencyGroups.slice(0, 6).map((group) =>
        `${group.dependencyId ?? group.rootDependencyId ?? group.rootCauseId ?? "dependency"}: ${group.status ?? group.rootStatus ?? "unknown"}`),
    });
  }

  const canaries = statusPayload?.canaries;
  if (canaries?.errorCount > 0 || canaries?.degradedCount > 0) {
    findings.push({
      severity: canaries.errorCount > 0 ? "High" : "Medium",
      title: `Canaries report ${canaries.errorCount ?? 0} errors and ${canaries.degradedCount ?? 0} degraded checks`,
      evidence: Object.values(canaries.checks ?? {}).slice(0, 8).map((check) => `${check.checkId}: ${check.status}`),
    });
  }

  const unobservedFrequentJobs = coverage.jobs.filter((job) => job.intervalSec <= args.cycles * 4 * 3600 && !job.observed);
  if (unobservedFrequentJobs.length > 0) {
    findings.push({
      severity: "Low",
      title: `${unobservedFrequentJobs.length} expected in-window job(s) were not observed in collected evidence`,
      evidence: unobservedFrequentJobs.slice(0, 10).map((job) => `${job.job} (${job.scheduleKey})`),
    });
  }

  return findings;
}

function summarizeAnalysis(evidence) {
  const statusPayload = findLatestStatusPayload(evidence.snapshots);
  const coverage = buildCoverage(evidence.scheduleMatrix, evidence.snapshots);
  const probeGaps = [];
  const artifactGaps = [];
  for (const snapshot of evidence.snapshots) {
    if (snapshot.mode === "d1-error") {
      probeGaps.push(`${snapshot.collectedAt}: D1 snapshot failed (${snapshot.error ?? "unknown error"})`);
    }
    if (Array.isArray(snapshot.artifactGaps)) {
      for (const gap of snapshot.artifactGaps) {
        const label = gap.optional && gap.code === "missing_table" ? "optional artifact gap" : "artifact gap";
        artifactGaps.push(
          `${snapshot.collectedAt}: ${gap.artifact ?? "artifact"} ${label} (${gap.code ?? "unknown"}: ${gap.message ?? "no details"})`,
        );
      }
    } else {
      for (const [artifact, error] of Object.entries(snapshot.artifactErrors ?? {})) {
        probeGaps.push(`${snapshot.collectedAt}: ${artifact} unavailable (${error})`);
      }
    }
    for (const [name, probe] of Object.entries(snapshot.probes ?? {})) {
      const gap = accessGapForProbe(name, probe);
      if (gap) probeGaps.push(`${snapshot.collectedAt}: ${gap}`);
    }
  }
  if (!evidence.options.includeD1) probeGaps.push("D1 snapshots not requested; run with --include-d1 for runtime slot/lease/progress evidence");
  if (evidence.options.includeWorkerTail) probeGaps.push("Worker tail requested; attach Cloudflare tail output manually in the report appendix");

  const findings = summarizeFindings(evidence.snapshots, statusPayload, coverage, evidence.options);
  return {
    generatedAt: new Date().toISOString(),
    health: {
      latestHealthStatus: [...evidence.snapshots].reverse().find((snapshot) => snapshot.probes?.health)?.probes.health.payload?.status ?? null,
      latestStatusOverall: statusPayload?.overallStatus ?? statusPayload?.status ?? null,
      latestStatusRaw: statusPayload?.rawOverallStatus ?? null,
    },
    coverage,
    dependencyHealth: statusPayload?.dependencyHealth ?? null,
    publicationHealth: statusPayload?.publicationHealth ?? null,
    providerCircuitHealth: statusPayload?.providerCircuitHealth ?? null,
    canaries: statusPayload?.canaries ?? null,
    repairDebt: statusPayload?.dataQuality?.repairDebt ?? null,
    findings,
    artifactGaps: [...new Set(artifactGaps)],
    accessGaps: [...new Set(probeGaps)],
  };
}

function markdownTable(rows, headers) {
  if (rows.length === 0) return "_None._";
  const escapeCell = (value) =>
    String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, " ")
      .replace(/\|/g, "\\|");
  return [
    `| ${headers.map((header) => escapeCell(header.label)).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeCell(header.value(row))).join(" | ")} |`),
  ].join("\n");
}

function formatIsoFromSec(value) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : "";
}

function redactOptions(options) {
  return {
    ...options,
    cfAccessClientId: options.cfAccessClientId ? "[redacted]" : "",
    cfAccessClientSecret: options.cfAccessClientSecret ? "[redacted]" : "",
  };
}

function redactEvidence(evidence) {
  return {
    ...evidence,
    options: redactOptions(evidence.options ?? {}),
  };
}

export function renderNightWatchMarkdown(evidence) {
  const analysis = evidence.analysis ?? summarizeAnalysis(evidence);
  const startedAt = evidence.options.start;
  const endedAt = evidence.options.end;
  const adminApiUrl = evidence.options.adminApiUrl ?? DEFAULT_ADMIN_API_URL;
  const accessLevel = [
    "public health",
    evidence.options.includeStatus ? "admin status" : null,
    evidence.options.includeStatusHistory ? "status history" : null,
    evidence.options.includeD1 ? `D1 ${evidence.options.remote ? "remote" : "local"}` : null,
  ].filter(Boolean).join(", ");
  const confirmedJobs = analysis.coverage.jobs.filter((job) => job.evidenceGrade === "confirmed").length;
  const observedJobs = analysis.coverage.jobs.filter((job) => job.observed).length;
  const totalJobs = analysis.coverage.jobs.length;
  const accessGaps = analysis.accessGaps ?? [];
  const artifactGaps = analysis.artifactGaps ?? [];

  return [
    "# Worker Night Watch Report",
    "",
    "## Observation Window",
    "",
    `- Generated at: ${evidence.generatedAt}`,
    `- Window: ${startedAt} to ${endedAt} UTC`,
    `- Access level: ${accessLevel || "none"}`,
    `- Evidence JSON: ${evidence.options.evidenceJsonPath}`,
    "",
    "## Executive Summary",
    "",
    `- Latest public health: ${analysis.health.latestHealthStatus ?? "unknown"}`,
    `- Latest admin status: ${analysis.health.latestStatusOverall ?? "not collected"}`,
    `- Cron jobs observed: ${observedJobs}/${totalJobs} (${confirmedJobs} confirmed from D1 rows)`,
    `- Findings generated: ${analysis.findings.length}`,
    "",
    "## Coverage Matrix",
    "",
    markdownTable(analysis.coverage.jobs, [
      { label: "Job", value: (row) => row.job },
      { label: "Schedule", value: (row) => row.scheduleKey },
      { label: "Latest", value: (row) => row.latestStatus ?? "none" },
      { label: "Started", value: (row) => formatIsoFromSec(row.latestStartedAt) },
      { label: "Evidence", value: (row) => row.evidenceGrade },
      { label: "Notes", value: (row) => row.notes },
    ]),
    "",
    "## Per-Slot Notes",
    "",
    markdownTable(analysis.coverage.slots, [
      { label: "Slot", value: (row) => row.scheduleKey },
      { label: "Schedule", value: (row) => row.schedule },
      { label: "Jobs", value: (row) => row.jobs.join(", ") },
      { label: "Budget-only", value: (row) => row.budgetOnlyJobs.join(", ") },
      { label: "Latest state", value: (row) => row.latestState ?? "none" },
      { label: "Evidence", value: (row) => row.evidenceGrade },
    ]),
    "",
    "## Budget-Only Surfaces",
    "",
    markdownTable(analysis.coverage.budgetOnly, [
      { label: "Surface", value: (row) => row.job },
      { label: "Schedule", value: (row) => row.scheduleKey },
      { label: "Max connections", value: (row) => row.maxConnections },
      { label: "Evidence", value: (row) => row.evidenceGrade },
    ]),
    "",
    "## Findings",
    "",
    analysis.findings.length === 0
      ? "_No automated findings from collected evidence. Review appendix evidence before closing the watch._"
      : analysis.findings.map((finding) => [
          `### ${finding.severity}: ${finding.title}`,
          "",
          ...(finding.evidence ?? []).map((line) => `- ${line}`),
        ].join("\n")).join("\n\n"),
    "",
    "## Quick Wins",
    "",
    analysis.findings.length === 0
      ? "- No immediate automated quick wins."
      : "- Inspect the finding evidence above and rerun the affected slots or targeted status queries before remediation.",
    "",
    "## Deeper Refactors",
    "",
    "- Use this report alongside `agents/worker-hardening-structural.md` to decide whether follow-up work belongs in ledger, dependency, publication, provider, repair, or canary hardening.",
    "",
    "## Open Questions And Access Gaps",
    "",
    accessGaps.length === 0 ? "_None._" : accessGaps.map((gap) => `- ${gap}`).join("\n"),
    "",
    "## Artifact Gaps",
    "",
    artifactGaps.length === 0 ? "_None._" : artifactGaps.map((gap) => `- ${gap}`).join("\n"),
    "",
    "## Verification Appendix",
    "",
    `- Command: \`node scripts/maintenance/night-watch-worker.mjs --cycles ${evidence.options.cycles}${evidence.options.includeD1 ? " --include-d1" : ""}${evidence.options.includeStatus ? ` --include-status --admin-api-url ${adminApiUrl}` : ""}${evidence.options.includeStatusHistory ? " --include-status-history" : ""}\``,
    `- Samples collected: ${evidence.snapshots.length}`,
    `- Schedule registry jobs: ${evidence.scheduleMatrix.cronJobs.length}`,
    `- Slot plans: ${Object.keys(evidence.scheduleMatrix.slotPlans).length}`,
    "",
  ].join("\n");
}

function writeOutputs(evidence, args) {
  const redactedEvidence = redactEvidence(evidence);
  const analysis = summarizeAnalysis(redactedEvidence);
  const withAnalysis = { ...redactedEvidence, analysis };
  const markdown = renderNightWatchMarkdown(withAnalysis);
  ensureParent(args.evidenceJsonPath);
  ensureParent(args.outputPath);
  writeFileSync(resolve(ROOT_DIR, args.evidenceJsonPath), `${JSON.stringify(withAnalysis, null, 2)}\n`, "utf8");
  writeFileSync(resolve(ROOT_DIR, args.outputPath), `${markdown.trimEnd()}\n`, "utf8");
  return withAnalysis;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function collectEvidence(args) {
  const scheduleMatrix = loadScheduleMatrix();
  if (args.fixturePath) {
    const fixture = JSON.parse(readFileSync(resolve(ROOT_DIR, args.fixturePath), "utf8"));
    return {
      ...fixture,
      options: { ...(fixture.options ?? {}), ...args },
      scheduleMatrix: fixture.scheduleMatrix ?? scheduleMatrix,
      snapshots: fixture.snapshots ?? [],
      generatedAt: fixture.generatedAt ?? new Date().toISOString(),
    };
  }
  if (args.dryRun) {
    return {
      generatedAt: new Date().toISOString(),
      options: args,
      scheduleMatrix,
      snapshots: [],
    };
  }

  const snapshots = [];
  const startMs = new Date(args.start).getTime();
  const endMs = new Date(args.end).getTime();
  const intervalMs = args.intervalMinutes * 60 * 1000;
  for (let targetMs = startMs; targetMs <= endMs; targetMs += intervalMs) {
    const delayMs = targetMs - Date.now();
    if (delayMs > 0) await sleep(delayMs);
    const elapsedMinutes = Math.max(args.intervalMinutes, Math.ceil((Date.now() - startMs) / 60_000) + args.intervalMinutes);
    const snapshot = args.includeD1
      ? collectD1Snapshot(args, elapsedMinutes)
      : await collectProbeOnlySnapshot(args);
    snapshots.push(snapshot);
  }

  return {
    generatedAt: new Date().toISOString(),
    options: args,
    scheduleMatrix,
    snapshots,
  };
}

export async function runCli(argv, stdout = process.stdout) {
  const args = parseArgs(argv);
  const evidence = await collectEvidence(args);
  const withAnalysis = writeOutputs(evidence, args);
  if (args.json) {
    stdout.write(`${JSON.stringify(withAnalysis, null, 2)}\n`);
  } else {
    stdout.write(`Night-watch report written to ${args.outputPath}\nEvidence JSON written to ${args.evidenceJsonPath}\n`);
  }
  return 0;
}

if (process.argv[1] === __filename) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
