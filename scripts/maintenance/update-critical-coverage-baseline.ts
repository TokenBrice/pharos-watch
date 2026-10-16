#!/usr/bin/env node
import fs from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  CRITICAL_FILES,
  findCoverageFor,
  parseLcov,
} from "../lib/critical-coverage.mjs";
import { getCriticalBranchThresholds, getCriticalThresholds, parseCoveragePercentage } from "../ci/check-critical-coverage.ts";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  REBASELINE_DIRECTORY,
  parseRebaselineBaseline,
  validateCriticalCoverageRebaseline,
} from "../lib/critical-coverage-rebaseline.mts";
import type { BaseBlobExec } from "../lib/critical-ownership.mts";

const LCOV_PATH = "coverage/lcov.info";
const USAGE = "Usage: update-critical-coverage-baseline.ts [--rebaseline=.ci/critical-coverage-rebaseline/<wave-id>.json]";

export function updateCriticalCoverageBaseline({
  argv = [],
  env = process.env,
  fsImpl = fs,
  execFile = execFileSync as BaseBlobExec,
  criticalFiles = CRITICAL_FILES,
  now = new Date(),
  consoleImpl = console,
}: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, "existsSync" | "readFileSync" | "mkdirSync" | "writeFileSync">;
  execFile?: BaseBlobExec;
  criticalFiles?: string[];
  now?: Date;
  consoleImpl?: Pick<Console, "log">;
} = {}): void {
  const { values } = parseStrictCliArgs(argv, { options: { rebaseline: { type: "string" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const recordPath = values.rebaseline;
  if (recordPath !== undefined && (typeof recordPath !== "string"
    || !recordPath.startsWith(`${REBASELINE_DIRECTORY}/`)
    || !/^[a-zA-Z0-9_-]+\.json$/.test(recordPath.slice(REBASELINE_DIRECTORY.length + 1)))) {
    throw new Error(`--rebaseline must name a JSON record directly under ${REBASELINE_DIRECTORY}`);
  }
  const baselinePath = env.CRITICAL_COVERAGE_BASELINE_FILE ?? ".ci/critical-coverage-baseline.json";
  if (!fsImpl.existsSync(LCOV_PATH)) {
    throw new Error(`Missing ${LCOV_PATH}. Run CRITICAL_COVERAGE_RATCHET_ALL=1 npm run coverage:critical first.`);
  }
  const lcov = fsImpl.readFileSync(LCOV_PATH, "utf8");
  const parsed = parseLcov(lcov);
  const previous = fsImpl.existsSync(baselinePath)
    ? parseRebaselineBaseline(fsImpl.readFileSync(baselinePath, "utf8"))
    : {};
  const files: Record<string, number> = {};
  for (const file of criticalFiles) {
    const cov = findCoverageFor(file, parsed);
    if (!cov) throw new Error(`Missing in lcov: ${file}`);
    const measured = Number.parseFloat(cov.pct.toFixed(1));
    const floor = previous[file];
    // Ordinary maintenance can enroll or raise floors, never lower them.
    files[file] = recordPath ? measured : Number.isFinite(floor) ? Math.max(floor, measured) : measured;
  }
  if (typeof recordPath === "string") {
    const threshold = parseCoveragePercentage(env, "CRITICAL_COVERAGE_THRESHOLD", 40);
    const lineThresholds = getCriticalThresholds(env);
    const branchThresholds = getCriticalBranchThresholds(env);
    const context = {
      previous, candidate: files, now,
      lineMinimum: (source: string) => lineThresholds[source] ?? threshold,
      branchMinimum: (source: string) => branchThresholds[source] ?? null,
    };
    const value: unknown = JSON.parse(fsImpl.readFileSync(recordPath, "utf8"));
    const record = validateCriticalCoverageRebaseline(value, context);
    const base = parseRebaselineBaseline(execFile("git", ["show", `${record.baseSha}:${baselinePath}`], { encoding: "utf8" }).toString());
    validateCriticalCoverageRebaseline(value, { ...context, previous: base });
    if (record.measurement.candidateLcovSha256 !== createHash("sha256").update(lcov).digest("hex")) {
      throw new Error("Rebaseline candidateLcovSha256 does not match coverage/lcov.info");
    }
    if (recordPath !== `${REBASELINE_DIRECTORY}/${record.waveId}.json`) {
      throw new Error("Rebaseline record filename must match waveId");
    }
  }
  const out = { version: 1, generatedAt: now.toISOString().slice(0, 10), files };
  fsImpl.mkdirSync(dirname(baselinePath), { recursive: true });
  fsImpl.writeFileSync(baselinePath, `${JSON.stringify(out, null, 2)}\n`);
  consoleImpl.log(`[coverage] Wrote baseline: ${baselinePath}`);
}

runDirectCli(import.meta.url, () => updateCriticalCoverageBaseline({ argv: process.argv.slice(2) }), { label: "coverage", usage: USAGE });
