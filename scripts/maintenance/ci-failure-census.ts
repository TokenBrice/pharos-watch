import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliUsageError, assertCliUsage, parseStrictCliArgs, requireCliString, writeFileResolved } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const execute = promisify(execFile);
const REPO = "TokenBrice/pharos-watch";
export interface Run {
  id: number;
  head_branch: string;
  head_sha: string;
  created_at: string;
  conclusion: string | null;
  run_attempt: number;
  check_suite_id?: number;
  event?: string;
}
export interface Execution extends Run {
  jobs?: Job[];
  cancellation?: "superseded" | "other" | "unknown";
}
interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
}
interface Workflow { id: number; name: string; path: string }
interface Annotation { message: string; title?: string }
export interface Share { numerator: number; denominator: number; fraction: number | null }
interface RetrySummary { count: number; mean: number | null; median: number | null }
export interface Metrics {
  runs: number; failed: number; green: number; cancelled: number; pending: number;
  failedAll: Share; failedNonCancelled: Share; branches: number; observedGreenBranches: number;
  censored: { branch: string; runIds: number[]; executions: number }[];
  firstRunIdGreenObserved: Share; firstRunIdGreenAllBranches: Share;
  attemptsToFirstGreen: Record<string, number>; retryingBranches: RetrySummary;
  executionAttemptsToFirstGreen: Record<string, number>; retryingExecutionBranches: RetrySummary;
  extraPreGreenRunIds: number; extraPreGreenRunIdsPerGreenBranch: number | null;
  executions: number; priorExecutions: number; failedExecutions: number;
  concurrencySuperseded: number; otherCancellations: number; unknownCancellations: number;
}
export interface CensusReport {
  schemaVersion: number;
  query: { repo: string; since: string; until: string; cut: string | null; untilInclusiveUtcDay: boolean };
  startedAt: string; snapshotAt: string; method: string; warnings: string[];
  inventory: { workflow: Workflow; kind: string; metrics: Metrics; cohorts?: Record<string, Metrics>; runs: Run[]; executions: Execution[] }[];
}
const share = (numerator: number, denominator: number) => ({ numerator, denominator, fraction: denominator ? numerator / denominator : null });
function distribution(values: number[]) {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    median: values.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null };
}

/** Run-ID metrics use latest conclusions; execution metrics include every retained attempt. */
export function computeMetrics(runs: Run[], executions: Execution[]): Metrics {
  const branches = new Map<string, Run[]>();
  for (const run of runs) {
    const group = branches.get(run.head_branch) ?? [];
    group.push(run);
    branches.set(run.head_branch, group);
  }
  const firstGreen: number[] = [];
  const executionGreen: number[] = [];
  const censored: { branch: string; runIds: number[]; executions: number }[] = [];
  for (const [branch, group] of branches) {
    group.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    const ordered = group.flatMap((run) => executions.filter((attempt) => attempt.id === run.id).sort((a, b) => a.run_attempt - b.run_attempt));
    const green = group.findIndex((run) => run.conclusion === "success");
    const greenExecution = ordered.findIndex((run) => run.conclusion === "success");
    if (green < 0) censored.push({ branch, runIds: group.map((run) => run.id), executions: ordered.length });
    else firstGreen.push(green + 1);
    if (greenExecution >= 0) executionGreen.push(greenExecution + 1);
  }
  const failed = runs.filter((run) => run.conclusion === "failure").length;
  const cancelled = runs.filter((run) => run.conclusion === "cancelled");
  const cancellationEvidence = cancelled.map((run) => executions.find((attempt) => attempt.id === run.id && attempt.run_attempt === run.run_attempt)?.cancellation ?? "unknown");
  return {
    runs: runs.length, failed, green: runs.filter((run) => run.conclusion === "success").length,
    cancelled: cancelled.length, pending: runs.filter((run) => run.conclusion === null).length,
    failedAll: share(failed, runs.length), failedNonCancelled: share(failed, runs.length - cancelled.length),
    branches: branches.size, observedGreenBranches: firstGreen.length, censored,
    firstRunIdGreenObserved: share(firstGreen.filter((n) => n === 1).length, firstGreen.length),
    firstRunIdGreenAllBranches: share(firstGreen.filter((n) => n === 1).length, branches.size),
    attemptsToFirstGreen: distribution(firstGreen), retryingBranches: summary(firstGreen.filter((n) => n > 1)),
    executionAttemptsToFirstGreen: distribution(executionGreen), retryingExecutionBranches: summary(executionGreen.filter((n) => n > 1)),
    extraPreGreenRunIds: firstGreen.reduce((sum, n) => sum + n - 1, 0),
    extraPreGreenRunIdsPerGreenBranch: firstGreen.length ? firstGreen.reduce((sum, n) => sum + n - 1, 0) / firstGreen.length : null,
    executions: executions.length, priorExecutions: executions.length - runs.length,
    failedExecutions: executions.filter((run) => run.conclusion === "failure").length,
    concurrencySuperseded: cancellationEvidence.filter((value) => value === "superseded").length,
    otherCancellations: cancellationEvidence.filter((value) => value === "other").length,
    unknownCancellations: cancellationEvidence.filter((value) => value === "unknown").length,
  };
}

export function classifyCancellation(annotations: Annotation[]): Execution["cancellation"] {
  const messages = annotations.map((item) => `${item.title ?? ""} ${item.message}`).join("\n");
  if (/higher priority.*waiting|cancel(?:ed|led).*concurrency|supersed/i.test(messages)) return "superseded";
  if (/cancel(?:ed|led) (?:by|at the request of)/i.test(messages)) return "other";
  return "unknown";
}
export function utcDate(value: string, name: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  assertCliUsage(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, `${name} must be a valid YYYY-MM-DD UTC date`);
  return value;
}

async function get<T>(endpoint: string): Promise<T> {
  try {
    const { stdout } = await execute("gh", ["api", "--method", "GET", endpoint], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch {
    // Never echo gh stderr/environment: it can include credential-bearing diagnostics.
    throw new Error(`GitHub GET failed: ${endpoint.split("?")[0]}`);
  }
}
async function pages<T>(endpoint: string, key?: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const payload = await get<T[] | Record<string, T[]>>(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? (payload as Record<string, T[]>)[key] : payload as T[];
    if (!Array.isArray(batch)) throw new Error("Unexpected GitHub pagination payload");
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}

// GitHub caps filtered workflow-run queries at 1,000 results. Split the UTC
// interval rather than silently returning a truncated census for busy windows.
async function workflowRuns(endpoint: string, start: number, end: number): Promise<Run[]> {
  const range = `${new Date(start).toISOString().replace(".000Z", "Z")}..${new Date(end).toISOString().replace(".000Z", "Z")}`;
  const query = `${endpoint}?created=${encodeURIComponent(range)}&per_page=100`;
  const first = await get<{ total_count: number; workflow_runs: Run[] }>(`${query}&page=1`);
  if (first.total_count > 1000) {
    if (start === end) throw new Error("Over 1,000 runs in one second: GitHub cannot provide a complete census");
    const midpoint = Math.floor((start / 1000 + end / 1000) / 2) * 1000;
    return [...await workflowRuns(endpoint, start, midpoint), ...await workflowRuns(endpoint, midpoint + 1000, end)];
  }
  const runs = [...first.workflow_runs];
  for (let page = 2; runs.length < first.total_count; page++) {
    const next = await get<{ workflow_runs: Run[] }>(`${query}&page=${page}`);
    if (!next.workflow_runs.length) throw new Error("GitHub returned an incomplete workflow-run census");
    runs.push(...next.workflow_runs);
  }
  return runs;
}
export function workflowKind(path: string) {
  if (/pull-request-checks\.yml$/.test(path)) return "pr";
  if (/deploy-cloudflare|rebuild-pages/.test(path)) return "deploy";
  if (/nightly/.test(path)) return "nightly";
  if (/weekly/.test(path)) return "weekly";
  if (/refresh/.test(path)) return "refresh";
  return "scheduled/other";
}

export function computeCohorts(runs: Run[], executions: Execution[], cut: string): Record<string, Metrics> {
  return Object.fromEntries(["before", "onward"].map((cohort) => {
    const selected = runs.filter((run) => (run.created_at < `${cut}T00:00:00Z`) === (cohort === "before"));
    const ids = new Set(selected.map((run) => run.id));
    return [cohort, computeMetrics(selected, executions.filter((run) => ids.has(run.id)))];
  }));
}

export async function capture(since: string, until: string, cut?: string): Promise<CensusReport> {
  const startedAt = new Date().toISOString();
  const base = `repos/${REPO}`;
  const workflows = await pages<Workflow>(`${base}/actions/workflows`, "workflows");
  const inventory = [];
  const warnings: string[] = [];
  for (const workflow of workflows) {
    const runs = await workflowRuns(`${base}/actions/workflows/${workflow.id}/runs`, Date.parse(`${since}T00:00:00Z`), Date.parse(`${until}T23:59:59Z`));
    const executions: Execution[] = [];
    for (const run of runs) {
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const execution: Execution = attempt === run.run_attempt ? { ...run } : await get<Run>(`${base}/actions/runs/${run.id}/attempts/${attempt}`);
        // Retain all non-green leaves, including failed leaves on cancelled executions.
        if (execution.conclusion !== "success" || workflowKind(workflow.path) === "nightly") {
          execution.jobs = await pages<Job>(`${base}/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
        }
        if (execution.conclusion === "cancelled") {
          try {
            const checks = await pages<{ id: number }>(`${base}/check-suites/${execution.check_suite_id ?? run.check_suite_id}/check-runs`, "check_runs");
            const annotations: Annotation[] = [];
            for (const check of checks) annotations.push(...await pages<Annotation>(`${base}/check-runs/${check.id}/annotations`));
            execution.cancellation = classifyCancellation(annotations);
          } catch {
            execution.cancellation = "unknown";
            warnings.push(`Annotations unavailable for run ${run.id} attempt ${attempt}`);
          }
        }
        executions.push(execution);
      }
    }
    const cohorts = cut ? computeCohorts(runs, executions, cut) : undefined;
    inventory.push({ workflow, kind: workflowKind(workflow.path), metrics: computeMetrics(runs, executions), cohorts, runs, executions });
  }
  return { schemaVersion: 1, query: { repo: REPO, since, until, cut: cut ?? null, untilInclusiveUtcDay: true }, startedAt, snapshotAt: new Date().toISOString(),
    method: "Latest run-ID conclusions; branch grouping by head_branch; all retained attempts; cancellations included before first green. UTC created_at cohorts are descriptive, not workflow exposure or causal attribution. Non-cancelled denominator includes pending runs. Annotation evidence is not inferred from cancellation alone.",
    warnings, inventory };
}
export function markdown(report: CensusReport) {
  const rows = ["# CI failure census", "", `Snapshot: ${report.snapshotAt}; UTC window: ${report.query.since} through ${report.query.until} (inclusive).`, "", "| Workflow | Runs | Failed/all | Failed/non-cancelled | Cancelled | Superseded | Unknown cancellation |", "|---|---:|---:|---:|---:|---:|---:|"];
  const ratio = (value: Share) => `${value.numerator}/${value.denominator}${value.fraction === null ? " (n/a)" : ` (${(value.fraction * 100).toFixed(1)}%)`}`;
  for (const item of report.inventory) {
    const m = item.metrics;
    rows.push(`| ${item.workflow.path} | ${m.runs} | ${ratio(m.failedAll)} | ${ratio(m.failedNonCancelled)} | ${m.cancelled} | ${m.concurrencySuperseded} | ${m.unknownCancellations} |`);
  }
  for (const item of report.inventory) {
    const m = item.metrics;
    if (item.kind === "pr") {
      rows.push("", "| PR branch metric | Value |", "|---|---:|",
        `| First-run-ID green / observed-green branches | ${ratio(m.firstRunIdGreenObserved)} |`,
        `| First-run-ID green / all branches | ${ratio(m.firstRunIdGreenAllBranches)} |`,
        `| Censored branches | ${m.censored.length} |`,
        `| Run IDs to first green (distribution) | ${JSON.stringify(m.attemptsToFirstGreen)} |`,
        `| Retrying branch mean / median | ${m.retryingBranches.mean ?? "n/a"} / ${m.retryingBranches.median ?? "n/a"} |`,
        `| Executions to first green (distribution) | ${JSON.stringify(m.executionAttemptsToFirstGreen)} |`,
        `| Retrying execution mean / median | ${m.retryingExecutionBranches.mean ?? "n/a"} / ${m.retryingExecutionBranches.median ?? "n/a"} |`,
        `| Extra pre-green IDs / per green branch | ${m.extraPreGreenRunIds} / ${m.extraPreGreenRunIdsPerGreenBranch ?? "n/a"} |`, "");
    }
    if (item.cohorts) for (const [name, metrics] of Object.entries(item.cohorts)) rows.push(`\n${item.workflow.path} ${name} ${report.query.cut}: failed/all ${ratio(metrics.failedAll)}; failed/non-cancelled ${ratio(metrics.failedNonCancelled)}.`);
  }
  rows.push("", report.method, "", "Raw run/attempt/job metadata is in the JSON receipt. Failure leaves require owner classification; aggregate success alone does not prove a complete nightly outcome. No category is guessed from job names.");
  return `${rows.join("\n")}\n`;
}
async function main() {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { since: { type: "string" }, until: { type: "string" }, out: { type: "string" }, cut: { type: "string" } } });
  if (values.help) {
    console.log("Usage: npm run ci:census -- --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--cut=YYYY-MM-DD] [--out=path.json]\nGET-only GitHub census via authenticated gh; until defaults to today's inclusive UTC day.\n--cut splits created_at cohorts at UTC midnight. --out writes JSON plus path.json.md; otherwise both print to stdout. No GitHub mutation; receipt files are the only local writes.");
    return;
  }
  const since = utcDate(requireCliString(values.since, "--since"), "--since");
  const until = utcDate(typeof values.until === "string" ? values.until : new Date().toISOString().slice(0, 10), "--until");
  const cut = typeof values.cut === "string" ? utcDate(values.cut, "--cut") : undefined;
  assertCliUsage(since <= until, "--since must not follow --until");
  const report = await capture(since, until, cut);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (typeof values.out === "string") {
    writeFileResolved(values.out, json);
    writeFileResolved(`${values.out}.md`, markdown(report));
    console.log(markdown(report));
  } else console.log(`${json}\n${markdown(report)}`);
}
if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Census failed");
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  });
}
