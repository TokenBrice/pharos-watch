#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { assertCliUsage, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import {
  PR_LANES,
  buildPrLaneCommandArgs,
  getPrLane,
  isPrLaneSelected,
  type PrLaneId,
  type PrLaneSelection,
} from "../lib/pr-lanes.mts";

export interface WorkflowMatrixEntry {
  lane: PrLaneId;
  shard?: number;
  timeout: number;
}

export function buildPrWorkflowMatrix(selection: PrLaneSelection): { include: WorkflowMatrixEntry[] } {
  const include: WorkflowMatrixEntry[] = [];
  for (const lane of PR_LANES) {
    if (["preflight", "critical-coverage", "gate"].includes(lane.id) || !isPrLaneSelected(lane, selection)) continue;
    const shards = lane.shards ?? 1;
    for (let shard = 1; shard <= shards; shard += 1) {
      include.push({ lane: lane.id, ...(lane.shards ? { shard } : {}), timeout: lane.timeoutMinutes });
    }
  }
  return { include };
}

function bool(value: string | undefined): boolean {
  return value === "true";
}

function runLane(laneId: PrLaneId, env: NodeJS.ProcessEnv): number {
  const lane = getPrLane(laneId);
  const shard = env.PR_LANE_SHARD ? Number.parseInt(env.PR_LANE_SHARD, 10) : undefined;
  for (const command of lane.commands) {
    if (laneId === "critical-coverage" && command.id !== "critical-coverage-merge") continue;
    const program = command.program === "npm" ? "npm" : process.execPath;
    const result = spawnSync(program, buildPrLaneCommandArgs(command, {
      base: env.PR_BASE_SHA,
      head: env.PR_HEAD_SHA,
      shard,
    }), { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function runPreflight(env: NodeJS.ProcessEnv): number {
  const [classifier, gitleaks] = getPrLane("preflight").commands;
  const classifierResult = spawnSync(process.execPath, classifier.args, { env, encoding: "utf8" });
  if (classifierResult.stderr) process.stderr.write(classifierResult.stderr);
  if (classifierResult.status !== 0) return classifierResult.status ?? 1;
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required for preflight");
  appendFileSync(outputPath, classifierResult.stdout);
  const scanResult = spawnSync(process.execPath, gitleaks.args, { env, stdio: "inherit" });
  if (scanResult.error) throw scanResult.error;
  return scanResult.status ?? 1;
}

function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["matrix", "preflight", "run"]],
    options: {
      matrix: { type: "boolean" },
      preflight: { type: "boolean" },
      run: { type: "boolean" },
    },
  });
  const selectedModes = [values.matrix, values.preflight, values.run].filter(Boolean);
  assertCliUsage(selectedModes.length === 1, "Exactly one of --matrix, --preflight, or --run is required");
  if (values.matrix) {
    process.stdout.write(JSON.stringify(buildPrWorkflowMatrix({
      criticalCoverageChanged: bool(env.CRITICAL_COVERAGE_CHANGED),
      docsChanged: bool(env.DOCS_CHANGED),
      docsOnly: bool(env.DOCS_ONLY),
    })));
    return 0;
  }
  if (values.preflight) return runPreflight(env);
  return runLane(env.PR_LANE_ID as PrLaneId, env);
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
}, { label: "[pr-workflow]" });
