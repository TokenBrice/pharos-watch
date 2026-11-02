#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { createLocalVitestCommand, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { hasV9ContagionInput, RESOURCE_HARNESS_REVISION, RESOURCE_PHASES } from "../../worker/scripts/lib/v9-resource-policy";
import { PublicationByteMetricsSchema } from "@shared/lib/safety-score-v9-resource-bytes";

export const RESOURCE_TEST_FILE = "worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts";
const CONTAGION_CASE = "evaluates a bounded nine-scenario matrix within 256 MiB of old-space";
const vitestReportSchema = z.object({ testResults: z.array(z.object({
  name: z.string(), assertionResults: z.array(z.object({ title: z.string(), status: z.string() })),
})) });
export function assertRequiredResourceCases(report: unknown): void {
  const cases = vitestReportSchema.parse(report).testResults
    .filter((file) => file.name.replaceAll("\\", "/").endsWith(RESOURCE_TEST_FILE))
    .flatMap((file) => file.assertionResults).filter((test) => test.title === CONTAGION_CASE);
  if (cases.length !== 1 || cases[0].status !== "passed") throw new Error(`Required V9 resource case did not pass: ${CONTAGION_CASE}`);
}
const faithfulReportSchema = z.object({
  schemaVersion: z.literal(1), invocationId: z.string(), complete: z.literal(true), diagnosticOnly: z.literal(false),
  harnessRevision: z.literal(RESOURCE_HARNESS_REVISION),
  profile: z.literal("compute"), phaseManifest: z.literal("post-p2"), violations: z.array(z.unknown()).length(0),
  publicationCycles: z.union([z.literal(1), z.literal(2)]),
  policy: z.enum(["qualified", "unqualified"]), declaredPhases: z.array(z.string().min(1)).min(1),
  appliedPolicy: z.object({ globalPostGcHeapBytes: z.literal(117440512), phaseLimitsBytes: z.record(z.string(), z.number().int().positive().max(117440512)) }).optional(),
  runs: z.array(z.object({
    violations: z.array(z.unknown()).length(0),
    live: z.object({ status: z.literal(0), signal: z.null(), reasons: z.array(z.unknown()).length(0), phaseMaxima: z.record(z.string(), z.object({ postGcHeapBytes: z.number().int().positive() })), correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }) }),
    "hard-cap": z.object({ status: z.literal(0), signal: z.null(), reasons: z.array(z.unknown()).length(0), correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }) }),
  })).length(1),
});
export function assertFaithfulResourceReport(report: unknown, invocationId: string, publicationCycles = 2) {
  const parsed = faithfulReportSchema.parse(report);
  if (parsed.invocationId !== invocationId) throw new Error("stale-resource-report");
  if (parsed.publicationCycles !== publicationCycles) throw new Error("resource-cycle-count-mismatch");
  if (JSON.stringify(parsed.declaredPhases) !== JSON.stringify(RESOURCE_PHASES)) throw new Error("invalid-resource-phase-set");
  for (const phase of parsed.declaredPhases) {
    if (!parsed.runs[0].live.phaseMaxima[phase]) throw new Error(`missing-resource-phase:${phase}`);
  }
  if (parsed.policy === "qualified") {
    if (!parsed.appliedPolicy) throw new Error("missing-applied-resource-policy");
    for (const phase of parsed.declaredPhases) {
      const limit = parsed.appliedPolicy.phaseLimitsBytes[phase];
      if (!Number.isFinite(limit) || parsed.runs[0].live.phaseMaxima[phase].postGcHeapBytes > limit) throw new Error(`invalid-resource-phase:${phase}`);
    }
  } else if (parsed.appliedPolicy) throw new Error("unqualified-resource-policy-applied");
  return parsed;
}

export type V9ContagionDecision = {
  changedFiles: readonly string[];
  reason: "no-pr-base" | "contagion-inputs" | "no-contagion-inputs" | "diff-unavailable";
  required: boolean;
};

/** A PR runs the contagion matrix only when its diff reaches a contagion input; every other context fails closed to running it. */
export function decideV9Contagion(baseSha: string | undefined, listChangedFiles: (baseSha: string) => readonly string[]): V9ContagionDecision {
  if (!baseSha) return { required: true, reason: "no-pr-base", changedFiles: [] };
  let changedFiles: readonly string[];
  try { changedFiles = listChangedFiles(baseSha); }
  catch { return { required: true, reason: "diff-unavailable", changedFiles: [] }; }
  // An empty diff is not evidence that no contagion input changed.
  if (!changedFiles.length) return { required: true, reason: "diff-unavailable", changedFiles: [] };
  return hasV9ContagionInput(changedFiles)
    ? { required: true, reason: "contagion-inputs", changedFiles }
    : { required: false, reason: "no-contagion-inputs", changedFiles };
}

export function gitChangedFiles(root: string, baseSha: string): string[] {
  // NUL separation keeps git from quoting paths that need escaping.
  const result = spawnSync("git", ["diff", "--name-only", "-z", `${baseSha}...HEAD`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`v9-contagion-diff-failed:${result.error?.message ?? result.status}`);
  return result.stdout.split("\0").map((line) => line.trim()).filter(Boolean);
}

type LaneReport = {
  contagion: { changedFiles: readonly string[]; durationMs: number; reason: string; required: boolean; status: "passed" | "skipped" | "failed" };
  guard: { durationMs: number; status: number };
  prContext: boolean;
  publicationCycles: 1 | 2;
};
const summaryReportSchema = z.object({
  policy: z.string(),
  publicationCycles: z.union([z.literal(1), z.literal(2)]),
  appliedPolicy: z.object({ phaseLimitsBytes: z.record(z.string(), z.number()) }).optional(),
  stages: z.record(z.string(), z.object({ durationMs: z.number().nonnegative() }).passthrough()).optional(),
  runs: z.array(z.object({ live: z.object({ phaseMaxima: z.record(z.string(), z.object({ postGcHeapBytes: z.number() }).nullable()),
    correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }).optional() }).optional(),
    "hard-cap": z.object({ status: z.number().nullable(), signal: z.string().nullable().optional(),
      correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }).optional() }).optional() })),
});
type SummaryReport = z.infer<typeof summaryReportSchema>;

function seconds(value: number | undefined) {
  return value === undefined ? "unavailable" : `${(value / 1000).toFixed(1)} s`;
}

function stageRows(report: SummaryReport | undefined, contagion: LaneReport["contagion"]) {
  const stages = report?.stages ?? {};
  const duration = (stage: string) => (stages[stage] as { durationMs?: number } | undefined)?.durationMs;
  const cycles = report?.publicationCycles ?? 2;
  return [
    `| bundles | ${seconds(duration("bundle"))} | ${(stages.bundle as { builds?: number } | undefined)?.builds ?? "unavailable"} esbuild builds |`,
    `| setup | ${seconds(duration("setup"))} | fixture replay and warm-up publication |`,
    `| live | ${seconds(duration("live"))} | 256 MiB, forced GC, ${cycles} publication cycle${cycles === 1 ? "" : "s"} |`,
    `| natural | ${seconds(duration("natural"))} | 128 MiB, probe hook inert, ${cycles} publication cycle${cycles === 1 ? "" : "s"} |`,
    `| correctness | ${seconds(duration("correctness"))} | post-exit publication inspection |`,
    `| contagion | ${contagion.status === "skipped" ? "—" : seconds(contagion.durationMs)} | ${contagion.status === "skipped" ? `skipped (${contagion.reason})` : `nine-scenario matrix (${contagion.status})`} |`,
  ].join("\n");
}

function contagionLine(contagion: LaneReport["contagion"]) {
  if (contagion.status === "passed") {
    const trigger = contagion.reason === "contagion-inputs"
      ? `nine-scenario matrix; ${contagion.changedFiles.length} changed file${contagion.changedFiles.length === 1 ? "" : "s"} matched a contagion input`
      : contagion.reason === "no-pr-base" ? "nine-scenario matrix; no PR base (nightly/manual/local context)"
        : contagion.reason === "diff-unavailable" ? "nine-scenario matrix; PR diff unavailable, so it fails closed"
          : `nine-scenario matrix; ${contagion.reason}`;
    return `Contagion: **passed** (${trigger}).`;
  }
  if (contagion.status === "failed") return `Contagion: **failed** (${CONTAGION_CASE}).`;
  const detail = contagion.reason === "skipped-after-failure" ? "the guard measurement failed first"
    : contagion.reason === "no-pr-base" ? "not a PR validation run"
      : contagion.reason === "diff-unavailable" ? "the PR diff could not be read, so it fails closed"
        : "no contagion input changed";
  return `Contagion: **skipped** (${detail}).`;
}

export async function runV9ResourceLane({
  argv = process.argv.slice(2), outputDirectory = ".tmp/v9-resource-lane",
  resourceDirectory = ".tmp/safety-score-v9-resource", runCommand = runSpawnCommand,
  env = process.env, listChangedFiles = gitChangedFiles,
}: {
  argv?: readonly string[]; outputDirectory?: string; resourceDirectory?: string;
  runCommand?: CommandImplementation<SpawnCommand>; env?: Readonly<Record<string, string | undefined>>;
  listChangedFiles?: (root: string, baseSha: string) => readonly string[];
} = {}): Promise<number> {
  const { values } = parseStrictCliArgs(argv);
  if (values.help) { console.log("Usage: npm run test:v9-resource\nRuns the faithful compute policy guard (live + natural 128 MiB), then the independent 256 MiB contagion matrix for PRs that change a contagion input or any non-PR context."); return 0; }
  const root = resolve(import.meta.dirname, "../..");
  resourceDirectory = resolve(root, resourceDirectory);
  outputDirectory = resolve(root, outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(resourceDirectory, { recursive: true });
  const vitestPath = join(outputDirectory, "vitest.json");
  const reportPath = join(resourceDirectory, "report.json");
  rmSync(vitestPath, { force: true });
  rmSync(reportPath, { force: true });
  const invocationId = randomUUID();
  const prContext = Boolean(env.PR_BASE_SHA);
  // Owner decision: PR validation collects one warm cycle; nightly/manual/local keep two.
  const publicationCycles = prContext ? 1 : 2;
  const args = ["--import", "tsx", "worker/scripts/measure-v9-resource.ts", "--profile=compute", "--runs=1", "--guard", `--publication-cycles=${publicationCycles}`, "--deadline-seconds=300", `--directory=${resourceDirectory}`, `--invocation-id=${invocationId}`];
  let failure: unknown;
  let status = 0;
  let rawReport: Record<string, unknown> | undefined;
  let summaryReport: SummaryReport | undefined;
  let phaseRows = "| unavailable | unavailable | unavailable | unavailable |";
  let byteRows: string[] = [];
  let guardDurationMs = 0;
  const guardStarted = Date.now();
  try {
    const result = await runCommand({ executable: process.execPath, args, cmd: `node ${args.join(" ")}` });
    guardDurationMs = Date.now() - guardStarted;
    status = typeof result === "number" ? result : result.status || (result.error || result.aborted ? 1 : 0);
    rawReport = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(reportPath, "utf8")));
    summaryReport = summaryReportSchema.parse(rawReport);
    const maxima = summaryReport.runs[0]?.live?.phaseMaxima ?? {};
    const limits = summaryReport.appliedPolicy?.phaseLimitsBytes ?? {};
    phaseRows = Object.entries(maxima).map(([phase, sample]) => {
      const live = sample?.postGcHeapBytes;
      const limit = limits[phase];
      return `| ${phase} | ${live ?? "missing"} | ${limit ?? "unavailable"} | ${live === undefined || limit === undefined ? "unavailable" : limit - live} |`;
    }).join("\n") || phaseRows;
    byteRows = summaryReport.runs.flatMap((run) => (["live", "hard-cap"] as const).map((mode) => {
      const bytes = run[mode]?.correctness?.publicationBytes;
      return `| ${mode} | ${bytes?.units ?? "unavailable"} | ${bytes?.largestUnitBytes ?? "unavailable"} | ${bytes?.unitLimitBytes ?? "unavailable"} | ${bytes?.streamedTotalBytes ?? "unavailable"} | ${bytes?.streamedTotalRegressionLimitBytes ?? "unavailable"} | ${bytes?.streamedTotalLimitBytes ?? "unavailable"} |`;
    }));
    assertFaithfulResourceReport(rawReport, invocationId, publicationCycles);
  } catch (error) {
    guardDurationMs = Date.now() - guardStarted;
    failure = error;
    // Even a launcher/protocol failure leaves machine-readable evidence for always-upload.
    let rejected: Record<string, unknown> = {};
    try {
      const existing = z.record(z.string(), z.unknown()).safeParse(JSON.parse(readFileSync(reportPath, "utf8")));
      if (existing.success) rejected = existing.data;
    } catch { /* Missing or malformed child evidence is represented below. */ }
    rejected = { ...rejected, schemaVersion: 1, invocationId, complete: false,
      violations: [...(Array.isArray(rejected.violations) ? rejected.violations : []), { reason: "lane-report-rejected", detail: String(error) }] };
    rawReport = rejected;
  }
  const guardOk = !failure && status === 0;
  let contagion: LaneReport["contagion"] = { required: false, reason: "skipped-after-failure", status: "skipped", durationMs: 0, changedFiles: [] };
  if (guardOk) {
    const decision = decideV9Contagion(env.PR_BASE_SHA, (baseSha) => listChangedFiles(root, baseSha));
    contagion = { ...decision, status: "skipped", durationMs: 0 };
    if (decision.required) {
      const command = createLocalVitestCommand(["run", RESOURCE_TEST_FILE, "--coverage.enabled=false", "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${vitestPath}`]);
      const contagionStarted = Date.now();
      const result = await runCommand(command, { PHAROS_V9_RESOURCE_LANE: "1" });
      contagion.durationMs = Date.now() - contagionStarted;
      try {
        assertRequiredResourceCases(JSON.parse(readFileSync(vitestPath, "utf8")));
        contagion.status = "passed";
      } catch (error) {
        contagion.status = "failed";
        failure = error;
      }
      if (!failure) {
        const vitestStatus = typeof result === "number" ? result : result.status || (result.error || result.aborted ? 1 : 0);
        if (vitestStatus) status = vitestStatus;
      }
    }
  }
  const lane: LaneReport = { prContext, publicationCycles, guard: { durationMs: guardDurationMs, status }, contagion };
  writeFileSync(join(outputDirectory, "contagion.json"), `${JSON.stringify({ ...contagion, prContext, publicationCycles }, null, 2)}\n`);
  if (rawReport) writeFileSync(reportPath, `${JSON.stringify({ ...rawReport, lane }, null, 2)}\n`);
  const artifactLink = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}#artifacts` : "resource report artifacts";
  const factsSample = summaryReport?.runs[0]?.live?.phaseMaxima?.["facts-compiled"];
  const factsMiB = factsSample ? (factsSample.postGcHeapBytes / 1048576).toFixed(2) : "unavailable";
  const qualification = summaryReport?.policy === "unqualified"
    ? ` Phase limits are NOT enforced without a qualified policy. facts-compiled: ${factsMiB} MiB; qualification requires every phase <=110 MiB over five successful live+natural runs. Complete phases, correctness/bytes and natural 128 MiB remain required. Further remediation (P3/P4) is needed when the ceiling is exceeded.`
    : "";
  const summary = `## Safety Score V9 resource guard\n\npolicy: **"${summaryReport?.policy ?? "unavailable"}"**.${qualification}\n\n| Phase | Post-GC bytes | Limit bytes | Margin bytes |\n|---|---:|---:|---:|\n${phaseRows}\n\nCanonical byte metrics (one admitted card per unit; streamed total includes envelope metadata):\n\n| Run mode | Card units | Largest unit bytes | Calibrated unit cap bytes | Streamed total bytes | Aggregate regression cap bytes | Hard total cap bytes |\n|---|---:|---:|---:|---:|---:|---:|\n${byteRows.length ? byteRows.join("\n") : "| unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |"}\n\nCalibrated byte regression guards do not replace the natural memory gate or the independent compressed/stored transport caps.\n\nStage timings (live and natural children run concurrently after setup; ${publicationCycles} publication cycle${publicationCycles === 1 ? "" : "s"}):\n\n| Stage | Wall time | Note |\n|---|---:|---|\n${stageRows(summaryReport, contagion)}\n\n${contagionLine(contagion)}\n\nNatural 128 MiB exit status: ${summaryReport?.runs[0]?.["hard-cap"]?.status ?? "unavailable"}; signal: ${summaryReport?.runs[0]?.["hard-cap"]?.signal ?? "none observed"}. Node-only regression evidence, not Workers capacity. [Full evidence](${artifactLink}).${failure ? `\n\nV9 resource lane failed: ${String(failure)}. See resource report artifact.\n` : ""}\n`;
  writeFileSync(join(resourceDirectory, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (failure) throw failure;
  return status;
}

runDirectCli(import.meta.url, async () => { process.exitCode = await runV9ResourceLane(); }, { label: "[v9-resource]" });
