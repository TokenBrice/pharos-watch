#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { median } from "@shared/lib/stats";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { PR_TEST_TIMINGS_PATH } from "../lib/pr-test-plan.mts";

const REPOSITORY = "TokenBrice/pharos-watch";
// Cold-start scheduling estimate only, never a coverage threshold or measurement.
const COVERAGE_FALLBACK_MULTIPLIER = 2;
const RunSchema = z.object({ databaseId: z.number(), headSha: z.string(), createdAt: z.string(), url: z.string() });
const ArtifactsSchema = z.object({ artifacts: z.array(z.object({ id: z.number(), name: z.string(), expired: z.boolean() })) });
const TimingSummarySchema = z.object({
  success: z.boolean(),
  files: z.array(z.object({ file: z.string().min(1), durationMs: z.number().finite().nonnegative() })),
});

function ghJson(args: string[]): unknown {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

export function deriveTimingDurations(samples: readonly { file: string; durationMs: number }[]): Record<string, number> {
  const byFile = new Map<string, number[]>();
  for (const { file, durationMs } of samples) {
    const values = byFile.get(file) ?? [];
    values.push(durationMs);
    byFile.set(file, values);
  }
  return Object.fromEntries([...byFile].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([file, values]) => [file, Math.max(1, Math.round(median(values)!))]));
}

/** Download only timing artifacts; never runs tests or modifies CI state. */
export function refreshPrTestTimings(argv: readonly string[] = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: {
    runs: { type: "string", default: "5" },
    output: { type: "string", default: PR_TEST_TIMINGS_PATH },
  } });
  if (writeCliHelpIfRequested(values, "Usage: node --import tsx scripts/maintenance/refresh-pr-test-timings.ts [--runs=5] [--output=scripts/data/pr-test-timings.json]")) return;
  const limit = parseCliInteger(values.runs, { name: "--runs", min: 1 });
  const output = String(values.output);
  const runs = z.array(RunSchema).parse(ghJson([
    "run", "list", "--repo", REPOSITORY, "--workflow", "pull-request-checks.yml", "--status", "success",
    "--limit", String(limit), "--json", "databaseId,headSha,createdAt,url",
  ]));
  const temporary = mkdtempSync(join(tmpdir(), "pharos-pr-timings-"));
  const samples = { tests: [] as { file: string; durationMs: number }[], coverage: [] as { file: string; durationMs: number }[] };
  const provenance: { run: number; artifact: string; id: number }[] = [];
  try {
    for (const run of runs) {
      const { artifacts } = ArtifactsSchema.parse(ghJson(["api", `repos/${REPOSITORY}/actions/runs/${run.databaseId}/artifacts?per_page=100`]));
      for (const artifact of artifacts) {
        const kind = /^pr-test-timings-\d+$/.test(artifact.name) ? "tests"
          : /^pr-coverage-timings-\d+$/.test(artifact.name) ? "coverage" : undefined;
        if (!kind || artifact.expired) continue;
        const directory = join(temporary, String(run.databaseId), artifact.name);
        execFileSync("gh", ["run", "download", String(run.databaseId), "--repo", REPOSITORY, "--name", artifact.name, "--dir", directory], { stdio: "inherit" });
        let found = false;
        for (const file of readdirSync(directory)) {
          if (!file.endsWith(".json") || file.endsWith(".vitest.json")) continue;
          const summary = TimingSummarySchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
          if (!summary.success) throw new Error(`Unsuccessful timing summary in successful run: ${run.databaseId}/${artifact.name}`);
          samples[kind].push(...summary.files);
          found = true;
        }
        if (!found) throw new Error(`Missing timing JSON: ${run.databaseId}/${artifact.name}`);
        provenance.push({ run: run.databaseId, artifact: artifact.name, id: artifact.id });
      }
    }
    if (samples.tests.length === 0) throw new Error("No retained plain-test timings in the selected successful PR runs");
    const tests = deriveTimingDurations(samples.tests);
    const measuredCoverage = deriveTimingDurations(samples.coverage);
    const coverage = Object.fromEntries(Object.entries(tests).map(([file, duration]) => [file, measuredCoverage[file] ?? duration * COVERAGE_FALLBACK_MULTIPLIER]));
    Object.assign(coverage, measuredCoverage);
    writeFileSync(resolve(output), `${JSON.stringify({
      version: 1,
      description: "Median per-file milliseconds from retained timing artifacts. New reporters include prepare/environment/setup/import+collect/test+hook costs; legacy plain artifacts contain assertion spans only. Unknown files use the per-kind median (1s without measurements). Coverage files without observations use 2x plain duration, a cold-start scheduling estimate only. Durations model aggregate LPT load, not wall time or coverage remapping tails.",
      coverageFallbackMultiplier: COVERAGE_FALLBACK_MULTIPLIER,
      runs,
      artifacts: provenance,
      tests,
      coverage: Object.fromEntries(Object.entries(coverage).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    }, null, 2)}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

runDirectCli(import.meta.url, () => refreshPrTestTimings());
