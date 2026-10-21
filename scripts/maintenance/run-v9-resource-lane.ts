#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { createLocalVitestCommand, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { RESOURCE_HARNESS_REVISION, RESOURCE_PHASES } from "../../worker/scripts/lib/v9-resource-policy";
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
  policy: z.enum(["qualified", "unqualified"]), declaredPhases: z.array(z.string().min(1)).min(1),
  appliedPolicy: z.object({ globalPostGcHeapBytes: z.literal(117440512), phaseLimitsBytes: z.record(z.string(), z.number().int().positive().max(117440512)) }).optional(),
  runs: z.array(z.object({
    violations: z.array(z.unknown()).length(0),
    live: z.object({ status: z.literal(0), signal: z.null(), reasons: z.array(z.unknown()).length(0), phaseMaxima: z.record(z.string(), z.object({ postGcHeapBytes: z.number().int().positive() })), correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }) }),
    "hard-cap": z.object({ status: z.literal(0), signal: z.null(), reasons: z.array(z.unknown()).length(0), correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }) }),
  })).length(1),
});
export function assertFaithfulResourceReport(report: unknown, invocationId: string) {
  const parsed = faithfulReportSchema.parse(report);
  if (parsed.invocationId !== invocationId) throw new Error("stale-resource-report");
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

export async function runV9ResourceLane({
  argv = process.argv.slice(2), outputDirectory = ".tmp/v9-resource-lane",
  resourceDirectory = ".tmp/safety-score-v9-resource", runCommand = runSpawnCommand,
}: { argv?: readonly string[]; outputDirectory?: string; resourceDirectory?: string; runCommand?: CommandImplementation<SpawnCommand> } = {}): Promise<number> {
  const { values } = parseStrictCliArgs(argv);
  if (values.help) { console.log("Usage: npm run test:v9-resource\nRuns the faithful compute policy guard (live + natural 128 MiB), then the independent 256 MiB contagion matrix."); return 0; }
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
  const args = ["--import", "tsx", "worker/scripts/measure-v9-resource.ts", "--profile=compute", "--runs=1", "--guard", "--deadline-seconds=300", `--directory=${resourceDirectory}`, `--invocation-id=${invocationId}`];
  let failure: unknown;
  let status = 0;
  let summaryWritten = false;
  try {
    const result = await runCommand({ executable: process.execPath, args, cmd: `node ${args.join(" ")}` });
    status = typeof result === "number" ? result : result.status || (result.error || result.aborted ? 1 : 0);
    const raw: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    const summaryReport = z.object({
      policy: z.string(),
      appliedPolicy: z.object({ phaseLimitsBytes: z.record(z.string(), z.number()) }).optional(),
      runs: z.array(z.object({ live: z.object({ phaseMaxima: z.record(z.string(), z.object({ postGcHeapBytes: z.number() }).nullable()),
        correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }).optional() }).optional(),
        "hard-cap": z.object({ status: z.number().nullable(), signal: z.string().nullable().optional(),
          correctness: z.object({ publicationBytes: PublicationByteMetricsSchema }).optional() }).optional() })),
    }).parse(raw);
    const maxima = summaryReport.runs[0]?.live?.phaseMaxima ?? {};
    const limits = summaryReport.appliedPolicy?.phaseLimitsBytes ?? {};
    const rows = Object.entries(maxima).map(([phase, sample]) => {
      const live = sample?.postGcHeapBytes;
      const limit = limits[phase];
      return `| ${phase} | ${live ?? "missing"} | ${limit ?? "unavailable"} | ${live === undefined || limit === undefined ? "unavailable" : limit - live} |`;
    });
    const byteRows = summaryReport.runs.flatMap((run) => (["live", "hard-cap"] as const).map((mode) => {
      const bytes = run[mode]?.correctness?.publicationBytes;
      return `| ${mode} | ${bytes?.units ?? "unavailable"} | ${bytes?.largestUnitBytes ?? "unavailable"} | ${bytes?.unitLimitBytes ?? "unavailable"} | ${bytes?.streamedTotalBytes ?? "unavailable"} | ${bytes?.streamedTotalRegressionLimitBytes ?? "unavailable"} | ${bytes?.streamedTotalLimitBytes ?? "unavailable"} |`;
    }));
    const artifactLink = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}#artifacts` : "resource report artifacts";
    const factsMiB = maxima["facts-compiled"] ? (maxima["facts-compiled"].postGcHeapBytes / 1048576).toFixed(2) : "unavailable";
    const summary = `## Safety Score V9 resource guard\n\npolicy: **"${summaryReport.policy}"**.${summaryReport.policy === "unqualified" ? ` Phase limits are NOT enforced without a qualified policy. facts-compiled: ${factsMiB} MiB; qualification requires every phase <=110 MiB over five successful live+natural runs. Complete phases, correctness/bytes and natural 128 MiB remain required. Further remediation (P3/P4) is needed when the ceiling is exceeded.` : ""}\n\n| Phase | Post-GC bytes | Limit bytes | Margin bytes |\n|---|---:|---:|---:|\n${rows.length ? rows.join("\n") : "| unavailable | unavailable | unavailable | unavailable |"}\n\nCanonical byte metrics (one admitted card per unit; streamed total includes envelope metadata):\n\n| Run mode | Card units | Largest unit bytes | Calibrated unit cap bytes | Streamed total bytes | Aggregate regression cap bytes | Hard total cap bytes |\n|---|---:|---:|---:|---:|---:|---:|\n${byteRows.join("\n")}\n\nCalibrated byte regression guards do not replace the natural memory gate or the independent compressed/stored transport caps.\n\nNatural 128 MiB exit status: ${summaryReport.runs[0]?.["hard-cap"]?.status ?? "unavailable"}; signal: ${summaryReport.runs[0]?.["hard-cap"]?.signal ?? "none observed"}. Node-only regression evidence, not Workers capacity. [Full evidence](${artifactLink}).\n`;
    writeFileSync(join(resourceDirectory, "summary.md"), summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    summaryWritten = true;
    assertFaithfulResourceReport(raw, invocationId);
  } catch (error) {
    failure = error;
    // Even a launcher/protocol failure leaves machine-readable evidence for always-upload.
    let rejected: Record<string, unknown> = {};
    try {
      const existing = z.record(z.string(), z.unknown()).safeParse(JSON.parse(readFileSync(reportPath, "utf8")));
      if (existing.success) rejected = existing.data;
    } catch { /* Missing or malformed child evidence is represented below. */ }
    writeFileSync(reportPath, `${JSON.stringify({ ...rejected, schemaVersion: 1, invocationId, complete: false,
      violations: [...(Array.isArray(rejected.violations) ? rejected.violations : []), { reason: "lane-report-rejected", detail: String(error) }] }, null, 2)}\n`);
    const failureSummary = `\nV9 resource guard failed: ${String(error)}. See resource report artifact.\n`;
    if (!summaryWritten) {
      const unavailableSummary = `## Safety Score V9 resource guard\n\npolicy: **"unavailable"** (launcher/protocol failure).\n\n| Phase | Post-GC bytes | Limit bytes | Margin bytes |\n|---|---:|---:|---:|\n| unavailable | unavailable | unavailable | unavailable |\n${failureSummary}`;
      writeFileSync(join(resourceDirectory, "summary.md"), unavailableSummary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, unavailableSummary);
    } else {
      appendFileSync(join(resourceDirectory, "summary.md"), failureSummary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, failureSummary);
    }
  }
  const command = createLocalVitestCommand(["run", RESOURCE_TEST_FILE, "--coverage.enabled=false", "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${vitestPath}`]);
  const result = await runCommand(command, { PHAROS_V9_RESOURCE_LANE: "1" });
  assertRequiredResourceCases(JSON.parse(readFileSync(vitestPath, "utf8")));
  if (failure) throw failure;
  return status || (typeof result === "number" ? result : result.status || (result.error || result.aborted ? 1 : 0));
}

runDirectCli(import.meta.url, async () => { process.exitCode = await runV9ResourceLane(); }, { label: "[v9-resource]" });
