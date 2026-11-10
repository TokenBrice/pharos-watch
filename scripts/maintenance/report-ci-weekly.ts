#!/usr/bin/env node
/**
 * Render the weekly CI report: lane p50/p90 against the report-only lane
 * budgets, the PR failure rate by failing lane, the slowest test files, the
 * test files added in the window and the test/production byte ratio.
 *
 * Every remote read stays in `.github/workflows/weekly-validation.yml`
 * (`gh api`, nightly artifact download, `git log`), so this module only parses
 * saved inputs and renders Markdown and every number is reproducible offline.
 * A missing or unreadable optional input becomes an explicit `unavailable`
 * line with a machine-readable reason — never a zero, never a silent pass.
 *
 * Lane budgets are reporting thresholds owned by `scripts/lib/pr-lanes.mts`
 * (and `PR_PREPARE_BUDGET_SECONDS` for the first job); this report never fails
 * a lane and never hard-codes a second copy of a budget. Cadence and the issue
 * identity belong to `docs/testing.md#scheduled-validation`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { argv as processArgv } from "node:process";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeFileResolved,
} from "../lib/cli-args.mjs";
import { PR_LANES, PR_PREPARE_BUDGET_SECONDS } from "../lib/pr-lanes.mts";

const USAGE = `Usage: node --experimental-strip-types scripts/maintenance/report-ci-weekly.ts --runs <runs.json> --jobs <jobs.json> --since <ISO> [--timings <test-timings.json>] [--added-test-log <git-log.txt>] [--until <ISO>] [--run-url <url>] [--repo-root <dir>] [--output <report.md>]

Renders the weekly CI report from inputs the weekly workflow already fetched.
--runs/--jobs are the GitHub runs and jobs of "Pull Request Checks"; --timings
is the newest nightly test-timings artifact; --added-test-log is
\`git log --diff-filter=A --no-renames --diff-merges=first-parent --name-only\`
for the window, so the census is commit-dated and a merge reports what its
branch added. Missing optional inputs render as unavailable evidence, never as
zero.`;

/** Per-file budget: a test file slower than this on the nightly run is flagged. */
export const SLOW_TEST_FILE_SECONDS = 10;
const REPORTED_SLOW_FILES = 10;
const REPORTED_ADDED_FILES = 10;
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const FAILED_RUN_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
/**
 * The added-file count must not be read as a merge-report: `git log --since`
 * prunes by the commit that added each path (`--diff-merges=first-parent` makes
 * a merge show what its branch added), so branch age — not merge time — decides
 * membership.
 */
const ADDED_FILE_CENSUS_NOTE =
  "Census is commit-dated: `git log --since` keeps the commits that added each path, so a file written " +
  "weeks before its merge falls outside the window and a merge-only view would count differently.";

export interface WeeklyRun {
  id: number;
  createdAt: string;
  conclusion: string | null;
}

export interface WeeklyJob {
  runId: number;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LaneBudgetRow {
  lane: string;
  budgetSeconds: number | null;
  samples: number;
  p50Seconds: number | null;
  p90Seconds: number | null;
  overBudget: number;
}

export interface FailureCensus {
  total: number;
  green: number;
  failed: number;
  cancelled: number;
  failureRate: number | null;
  byLane: { lane: string; runs: number }[];
}

export interface CodeByteSummary {
  testBytes: number;
  productionBytes: number;
  testFiles: number;
  productionFiles: number;
  ratio: number | null;
}

/** A `null` field means the input was unavailable; `reason` names why (R2/R4). */
export interface UnavailableInput {
  section: string;
  reason: string;
}

export interface WeeklyReportInput {
  since: string;
  until: string;
  runUrl?: string;
  runs: WeeklyRun[];
  jobs: WeeklyJob[];
  timings: { generatedAt: string; files: Record<string, number> } | null;
  addedTestLog: string | null;
  addedTestSizes: Record<string, number>;
  codeBytes: CodeByteSummary | null;
  unavailable: UnavailableInput[];
  notes: string[];
}

export interface WeeklyReport extends FailureCensus {
  since: string;
  until: string;
  runUrl?: string;
  lanes: LaneBudgetRow[];
  excludedLaneJobs: number;
  slowest: { file: string; seconds: number }[];
  slowOverBudget: number;
  timingsGeneratedAt: string | null;
  added: { file: string; bytes: number }[];
  addedTotal: number;
  addedUnmeasured: number;
  codeBytes: CodeByteSummary | null;
  unavailable: UnavailableInput[];
  notes: string[];
}

/** Matrix job names carry a `(1/4)` shard suffix; each display name maps to a lane id. */
export function laneOfJobName(name: string): string {
  return name.replace(/\s*\(\d+\/\d+\)$/, "").trim().toLowerCase().replaceAll(" ", "-");
}

/** Report-only budget for a lane id; `null` when that job carries none. */
export function budgetSecondsForLane(lane: string): number | null {
  if (lane === "prepare") return PR_PREPARE_BUDGET_SECONDS;
  return PR_LANES.find((candidate) => candidate.id === lane)?.budgetSeconds ?? null;
}

/** Lanes the report tracks: the first job, then every budgeted lane in manifest order. */
const REPORTED_LANES: readonly string[] = [
  "prepare",
  ...PR_LANES.filter((lane) => lane.budgetSeconds !== undefined).map((lane) => lane.id),
];

/** Nearest-rank percentile of an ascending sample, matching the RUM analyzer's vocabulary. */
export function percentileSeconds(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export function jobDurationSeconds(job: WeeklyJob): number | null {
  if (!job.startedAt || !job.completedAt) return null;
  const started = Date.parse(job.startedAt);
  const completed = Date.parse(job.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return (completed - started) / 1000;
}

/** Only concluded runs are timing evidence: a cancelled run's aborted jobs would bias p50 low. */
function isConcludedRun(run: WeeklyRun): boolean {
  return run.conclusion === "success" || FAILED_RUN_CONCLUSIONS.has(run.conclusion ?? "");
}

export function buildLaneBudgets(runs: readonly WeeklyRun[], jobs: readonly WeeklyJob[]): {
  rows: LaneBudgetRow[];
  excludedLaneJobs: number;
} {
  const concluded = new Set(runs.filter(isConcludedRun).map((run) => run.id));
  const samples = new Map<string, number[]>();
  let excludedLaneJobs = 0;
  for (const job of jobs) {
    const lane = laneOfJobName(job.name);
    if (budgetSecondsForLane(lane) === null) continue;
    const duration = jobDurationSeconds(job);
    if (!concluded.has(job.runId) || duration === null) {
      excludedLaneJobs += 1;
      continue;
    }
    samples.set(lane, [...(samples.get(lane) ?? []), duration]);
  }
  const rows = REPORTED_LANES.map((lane) => {
    const values = [...(samples.get(lane) ?? [])].sort((left, right) => left - right);
    const budgetSeconds = budgetSecondsForLane(lane);
    return {
      lane,
      budgetSeconds,
      samples: values.length,
      p50Seconds: percentileSeconds(values, 50),
      p90Seconds: percentileSeconds(values, 90),
      overBudget: budgetSeconds === null ? 0 : values.filter((value) => value > budgetSeconds).length,
    };
  });
  return { rows, excludedLaneJobs };
}

export function buildFailureCensus(runs: readonly WeeklyRun[], jobs: readonly WeeklyJob[]): FailureCensus {
  const failed = runs.filter((run) => FAILED_RUN_CONCLUSIONS.has(run.conclusion ?? ""));
  const green = runs.filter((run) => run.conclusion === "success");
  const failedIds = new Set(failed.map((run) => run.id));
  const counted = new Set<string>();
  const byLane = new Map<string, number>();
  for (const job of jobs) {
    if (!failedIds.has(job.runId) || !FAILED_RUN_CONCLUSIONS.has(job.conclusion ?? "")) continue;
    const lane = laneOfJobName(job.name);
    const key = `${job.runId}:${lane}`;
    if (counted.has(key)) continue;
    counted.add(key);
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  }
  const denominator = failed.length + green.length;
  return {
    total: runs.length,
    green: green.length,
    failed: failed.length,
    cancelled: runs.filter((run) => run.conclusion === "cancelled").length,
    failureRate: denominator === 0 ? null : failed.length / denominator,
    byLane: [...byLane.entries()]
      .map(([lane, count]) => ({ lane, runs: count }))
      .sort((left, right) => right.runs - left.runs || left.lane.localeCompare(right.lane)),
  };
}

export function rankSlowTestFiles(
  files: Readonly<Record<string, number>>,
  thresholdSeconds = SLOW_TEST_FILE_SECONDS,
): { slowest: { file: string; seconds: number }[]; overBudget: number } {
  const ranked = Object.entries(files)
    .map(([file, milliseconds]) => ({ file, seconds: milliseconds / 1000 }))
    .sort((left, right) => right.seconds - left.seconds || left.file.localeCompare(right.file));
  return {
    slowest: ranked.slice(0, REPORTED_SLOW_FILES),
    overBudget: ranked.filter((entry) => entry.seconds > thresholdSeconds).length,
  };
}

/** Test corpus = executable tests, per-suite support and fixtures (`__tests__/`, `__fixtures__/`). */
export function isTestCorpusPath(file: string): boolean {
  return /(^|\/)__(tests|fixtures)__\//.test(file) || /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/.test(file);
}

export function parseAddedTestFiles(log: string): { commit: string; file: string }[] {
  const added: { commit: string; file: string }[] = [];
  const seen = new Set<string>();
  let commit = "unknown";
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT ")) {
      commit = line.slice("COMMIT ".length).trim() || "unknown";
      continue;
    }
    if (!isTestCorpusPath(line) || seen.has(line)) continue;
    seen.add(line);
    added.push({ commit, file: line });
  }
  return added;
}

/** Added test files ranked by their current byte size; a missing size stays unmeasured, not zero. */
export function rankAddedTestFiles(
  added: readonly { file: string }[],
  sizes: Readonly<Record<string, number>>,
): { files: { file: string; bytes: number }[]; total: number; unmeasured: number } {
  const measured: { file: string; bytes: number }[] = [];
  let unmeasured = 0;
  for (const entry of added) {
    const bytes = sizes[entry.file];
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      unmeasured += 1;
      continue;
    }
    measured.push({ file: entry.file, bytes });
  }
  measured.sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
  return { files: measured.slice(0, REPORTED_ADDED_FILES), total: added.length, unmeasured };
}

export function summarizeCodeBytes(entries: readonly { path: string; bytes: number }[]): CodeByteSummary {
  let testBytes = 0;
  let productionBytes = 0;
  let testFiles = 0;
  let productionFiles = 0;
  for (const entry of entries) {
    if (!CODE_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
    if (isTestCorpusPath(entry.path)) {
      testBytes += entry.bytes;
      testFiles += 1;
    } else {
      productionBytes += entry.bytes;
      productionFiles += 1;
    }
  }
  return {
    testBytes,
    productionBytes,
    testFiles,
    productionFiles,
    ratio: productionBytes === 0 ? null : testBytes / productionBytes,
  };
}

export function parseWeeklyRuns(payload: unknown): WeeklyRun[] {
  if (!Array.isArray(payload)) throw new Error("runs input must be a JSON array");
  return payload.map((entry, index) => {
    const record = entry as Partial<WeeklyRun> | null;
    if (!record || typeof record !== "object" || !Number.isInteger(record.id) || typeof record.createdAt !== "string") {
      throw new Error(`runs[${index}] must be an {id, createdAt} record`);
    }
    return {
      id: record.id as number,
      createdAt: record.createdAt,
      conclusion: typeof record.conclusion === "string" ? record.conclusion : null,
    };
  });
}

export function parseWeeklyJobs(payload: unknown): WeeklyJob[] {
  if (!Array.isArray(payload)) throw new Error("jobs input must be a JSON array");
  return payload.map((entry, index) => {
    const record = entry as Partial<WeeklyJob> | null;
    if (!record || typeof record !== "object" || !Number.isInteger(record.runId) || typeof record.name !== "string") {
      throw new Error(`jobs[${index}] must be a {runId, name} record`);
    }
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      runId: record.runId as number,
      name: record.name,
      conclusion: text(record.conclusion),
      startedAt: text(record.startedAt),
      completedAt: text(record.completedAt),
    };
  });
}

export function parseTestTimings(payload: unknown): { generatedAt: string; files: Record<string, number> } {
  const record = payload as { version?: unknown; generatedAt?: unknown; files?: unknown } | null;
  if (!record || typeof record !== "object") throw new Error("timings input must be a JSON object");
  if (record.version !== 1) throw new Error("timings input must declare version 1");
  const files = record.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("timings input must declare a files record");
  const durations: Record<string, number> = {};
  for (const [file, value] of Object.entries(files as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`timings entry for ${file} is not a finite duration`);
    }
    durations[file] = value;
  }
  return { generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "unknown", files: durations };
}

export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const census = buildFailureCensus(input.runs, input.jobs);
  const { rows, excludedLaneJobs } = buildLaneBudgets(input.runs, input.jobs);
  const slow = input.timings
    ? rankSlowTestFiles(input.timings.files)
    : { slowest: [], overBudget: 0 };
  const added = input.addedTestLog === null
    ? { files: [], total: 0, unmeasured: 0 }
    : rankAddedTestFiles(parseAddedTestFiles(input.addedTestLog), input.addedTestSizes);
  return {
    ...census,
    since: input.since,
    until: input.until,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    lanes: rows,
    excludedLaneJobs,
    slowest: slow.slowest,
    slowOverBudget: slow.overBudget,
    timingsGeneratedAt: input.timings?.generatedAt ?? null,
    added: added.files,
    addedTotal: added.total,
    addedUnmeasured: added.unmeasured,
    codeBytes: input.codeBytes,
    unavailable: input.unavailable,
    notes: input.notes,
  };
}

function formatSeconds(seconds: number | null): string {
  return seconds === null ? "—" : `${Math.round(seconds)}`;
}

function formatPercent(fraction: number | null): string {
  return fraction === null ? "—" : `${(fraction * 100).toFixed(1)} %`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function renderWeeklyReport(report: WeeklyReport): string {
  // Runs whose conclusion is neither green, failed nor cancelled stay visible
  // instead of being folded into the denominator or dropped silently.
  const otherConclusions = Math.max(0, report.total - report.green - report.failed - report.cancelled);
  const lines: string[] = [
    "<!-- ci-weekly-report -->",
    "# Weekly CI report",
    "",
    `Window: ${report.since} → ${report.until}.`,
    ...(report.runUrl ? [`Source run: ${report.runUrl}`] : []),
    "",
    "## Lane budgets (seconds)",
    "",
    "Budgets are reporting thresholds from `scripts/lib/pr-lanes.mts`, not job timeouts: an over-budget lane still finishes and is named here instead of being killed.",
    "",
    "| Lane | Budget | p50 | p90 | Samples | Over budget |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.lanes) {
    lines.push(`| ${row.lane} | ${formatSeconds(row.budgetSeconds)} | ${formatSeconds(row.p50Seconds)} | ${formatSeconds(row.p90Seconds)} | ${row.samples} | ${row.overBudget} |`);
  }
  const overP50 = report.lanes.filter((row) => row.budgetSeconds !== null && row.p50Seconds !== null && row.p50Seconds > row.budgetSeconds);
  lines.push(
    "",
    overP50.length === 0
      ? "No reported lane exceeds its budget at p50."
      : `Over budget at p50: ${overP50.map((row) => `${row.lane} (${formatSeconds(row.p50Seconds)}s vs ${formatSeconds(row.budgetSeconds)}s)`).join(", ")}.`,
    "",
    `## PR failure rate`,
    "",
    `${report.total} run${report.total === 1 ? "" : "s"} in the window: ${report.green} green, ${report.failed} failed, ${report.cancelled} cancelled${otherConclusions === 0 ? "" : `, ${otherConclusions} with another conclusion`} → failure rate ${formatPercent(report.failureRate)} (green plus failed denominator; cancelled runs are excluded because a superseded run is not a failure).`,
  );
  if (report.byLane.length === 0) {
    lines.push("", report.failed === 0 ? "No failed jobs to attribute." : "No failed job carried a conclusion in the jobs feed.");
  } else {
    lines.push("", "Failed lanes (a run can fail in several lanes):", "", "| Lane | Failed runs |", "|---|---:|");
    for (const row of report.byLane) lines.push(`| ${row.lane} | ${row.runs} |`);
  }
  lines.push("", `## Slowest test files (> ${SLOW_TEST_FILE_SECONDS} s per-file budget)`, "");
  if (report.timingsGeneratedAt === null) {
    lines.push("Unavailable — no nightly test-timings artifact was supplied for this window.");
  } else {
    lines.push(
      `Timings generated at ${report.timingsGeneratedAt}. Summed assertion durations per file; import duration is not collected by the nightly suite.`,
      "",
      `${report.slowOverBudget} file(s) exceed the ${SLOW_TEST_FILE_SECONDS} s per-file budget.`,
    );
    if (report.slowest.length > 0) {
      lines.push("", "| File | Duration |", "|---|---:|");
      for (const entry of report.slowest) lines.push(`| \`${entry.file}\` | ${entry.seconds.toFixed(1)} s |`);
    }
  }
  lines.push("", "## Test files added in the window", "");
  const addedLogSupplied = !report.unavailable.some((entry) => entry.section === "added-test-files");
  if (!addedLogSupplied) {
    lines.push("Unavailable — the added-file log was not supplied for this window.");
  } else if (report.addedTotal === 0) {
    lines.push("No test file was added in the window.");
  } else {
    lines.push(`${report.addedTotal} test file(s) added.`, "");
    lines.push("| File | Bytes |", "|---|---:|");
    for (const entry of report.added) lines.push(`| \`${entry.file}\` | ${formatBytes(entry.bytes)} |`);
    if (report.addedUnmeasured > 0) {
      lines.push("", `${report.addedUnmeasured} added file(s) could not be measured from the checkout.`);
    }
  }
  if (addedLogSupplied) lines.push("", ADDED_FILE_CENSUS_NOTE);
  lines.push("", "## Test / production bytes", "");
  if (report.codeBytes === null) {
    lines.push("Unavailable — the tracked file list could not be measured from this checkout.");
  } else {
    const ratio = report.codeBytes.ratio;
    lines.push(
      `Test corpus ${formatBytes(report.codeBytes.testBytes)} across ${report.codeBytes.testFiles} files vs production ${formatBytes(report.codeBytes.productionBytes)} across ${report.codeBytes.productionFiles} files → ratio ${ratio === null ? "unavailable" : ratio.toFixed(2)}.`,
      "",
      "Test corpus counts `__tests__/` and `__fixtures__/` paths plus `*.test.*`, `*.spec.*` and `*.test-support.*` files; both sides are tracked code extensions only.",
    );
  }
  if (report.unavailable.length > 0) {
    lines.push("", "## Unavailable inputs", "");
    for (const entry of report.unavailable) lines.push(`- ${entry.section}: \`${entry.reason}\``);
  }
  lines.push(
    "",
    "## Method",
    "",
    `Per-job durations come from the GitHub jobs feed of \`Pull Request Checks\` (${report.excludedLaneJobs} reported-lane job(s) excluded: cancelled or still running). Percentiles are nearest-rank over per-job samples, so a lane's p50 is not a per-run wall time. Failure attribution counts each failed lane once per run. No category is inferred from job names beyond the matrix name → lane mapping.`,
  );
  for (const note of report.notes) lines.push("", note);
  return `${lines.join("\n")}\n`;
}

function readOptionalInput(path: string | undefined, name: string): { text: string | null; reason: string | null } {
  if (!path) return { text: null, reason: `${name}:not-supplied` };
  const resolved = resolve(path);
  if (!existsSync(resolved)) return { text: null, reason: `${name}:missing` };
  try {
    return { text: readFileSync(resolved, "utf8"), reason: null };
  } catch {
    return { text: null, reason: `${name}:unreadable` };
  }
}

/** Tracked code files and their byte sizes; unmeasurable paths are counted, never zero-filled. */
export function measureCodeBytes(root: string): { entries: { path: string; bytes: number }[]; unmeasured: number } {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Keep git's diagnostics in the thrown error instead of the job log.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries: { path: string; bytes: number }[] = [];
  let unmeasured = 0;
  for (const path of listed.split("\0")) {
    if (!path || !CODE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    try {
      entries.push({ path, bytes: statSync(resolve(root, path)).size });
    } catch {
      unmeasured += 1;
    }
  }
  return { entries, unmeasured };
}

/** Current sizes of the added test files present in this checkout. */
export function measureAddedTestSizes(files: readonly string[], root: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const file of files) {
    try {
      sizes[file] = statSync(resolve(root, file)).size;
    } catch {
      // Deleted again inside the window: reported as unmeasured, not as zero.
    }
  }
  return sizes;
}

export function main(argv: readonly string[] = processArgv.slice(2)): number {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "added-test-log": { type: "string" },
      jobs: { type: "string" },
      output: { type: "string" },
      "repo-root": { type: "string" },
      "run-url": { type: "string" },
      runs: { type: "string" },
      since: { type: "string" },
      timings: { type: "string" },
      until: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return 0;
  const since = requireCliString(values.since, "--since");
  const until = typeof values.until === "string" && values.until ? values.until : new Date().toISOString();
  const root = typeof values["repo-root"] === "string" && values["repo-root"] ? resolve(values["repo-root"]) : process.cwd();
  const unavailable: UnavailableInput[] = [];
  const notes: string[] = [];

  const runsText = requireCliString(values.runs, "--runs");
  const jobsText = requireCliString(values.jobs, "--jobs");
  const runs = parseWeeklyRuns(JSON.parse(readFileSync(resolve(runsText), "utf8")));
  const jobs = parseWeeklyJobs(JSON.parse(readFileSync(resolve(jobsText), "utf8")));

  let timings: WeeklyReportInput["timings"] = null;
  const timingsInput = readOptionalInput(typeof values.timings === "string" ? values.timings : undefined, "test-timings");
  if (timingsInput.text === null) {
    unavailable.push({ section: "slow-test-files", reason: timingsInput.reason ?? "test-timings:missing" });
  } else {
    try {
      timings = parseTestTimings(JSON.parse(timingsInput.text));
    } catch (error) {
      unavailable.push({ section: "slow-test-files", reason: `test-timings:invalid:${error instanceof Error ? error.message : "unknown"}` });
    }
  }

  let addedTestLog: string | null = null;
  const addedInput = readOptionalInput(typeof values["added-test-log"] === "string" ? values["added-test-log"] : undefined, "added-test-files");
  if (addedInput.text === null) {
    unavailable.push({ section: "added-test-files", reason: addedInput.reason ?? "added-test-files:missing" });
  } else {
    addedTestLog = addedInput.text;
  }

  let codeBytes: CodeByteSummary | null = null;
  try {
    const measured = measureCodeBytes(root);
    codeBytes = summarizeCodeBytes(measured.entries);
    if (measured.unmeasured > 0) notes.push(`${measured.unmeasured} tracked code file(s) could not be measured for the byte ratio.`);
  } catch (error) {
    unavailable.push({ section: "test-production-bytes", reason: `tracked-files:unavailable:${error instanceof Error ? error.message : "unknown"}` });
  }

  const report = buildWeeklyReport({
    since,
    until,
    ...(typeof values["run-url"] === "string" && values["run-url"] ? { runUrl: values["run-url"] } : {}),
    runs,
    jobs,
    timings,
    addedTestLog,
    addedTestSizes: addedTestLog === null
      ? {}
      : measureAddedTestSizes(parseAddedTestFiles(addedTestLog).map((entry) => entry.file), root),
    codeBytes,
    unavailable,
    notes,
  });
  const markdown = renderWeeklyReport(report);
  if (typeof values.output === "string" && values.output) writeFileResolved(values.output, markdown);
  else process.stdout.write(markdown);
  return 0;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
}, { label: "[ci-weekly]", usage: USAGE });
