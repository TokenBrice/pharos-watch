#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { assertCliUsage, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { collectGitPaths } from "../lib/changed-files.mts";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import { countCriticalCoverageShards } from "../lib/critical-test-files.mts";
import { PR_TEST_PLAN_PATH, readPrTestPlan } from "../lib/pr-test-plan.mts";
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
  shardCount?: number;
  skipDocSync?: boolean;
  timeout: number;
}

export function buildPrWorkflowMatrix(selection: PrLaneSelection): { include: WorkflowMatrixEntry[] } {
  const include: WorkflowMatrixEntry[] = [];
  if (selection.docsOnly) return { include };
  // The docs lane owns doc-sync for mixed docs/source PRs.
  const docsLaneSelected = isPrLaneSelected(getPrLane("docs"), selection);
  for (const lane of PR_LANES) {
    if (["preflight", "critical-coverage-shards", "critical-coverage", "pages-artifact", "gate"].includes(lane.id) || !isPrLaneSelected(lane, selection)) continue;
    const shards = lane.id === "tests" ? selection.testShards ?? 4 : 1;
    if (!Number.isInteger(shards) || shards < 1 || (lane.shards !== undefined && shards > lane.shards)) {
      throw new Error(`Invalid shard count for ${lane.id}: ${shards}`);
    }
    for (let shard = 1; shard <= shards; shard += 1) {
      include.push({
        lane: lane.id,
        ...(lane.shards ? { shard, shardCount: shards } : {}),
        ...(lane.id === "static-guards" && docsLaneSelected ? { skipDocSync: true } : {}),
        timeout: lane.timeoutMinutes,
      });
    }
  }
  return { include };
}

export function buildPrCoverageMatrix(selection: PrLaneSelection): { include: WorkflowMatrixEntry[] } {
  if (!selection.criticalCoverageChanged) return { include: [] };
  const lane = getPrLane("critical-coverage-shards");
  const shards = selection.criticalCoverageShards;
  if (!Number.isInteger(shards) || shards < 1 || shards > lane.shards!) {
    throw new Error(`Invalid shard count for ${lane.id}: ${shards}`);
  }
  return { include: Array.from({ length: shards }, (_, index) => ({
    lane: lane.id, shard: index + 1, shardCount: shards, timeout: lane.timeoutMinutes,
  })) };
}

export function formatPrWorkflowOutputs(selection: PrLaneSelection): string {
  return `matrix=${JSON.stringify(buildPrWorkflowMatrix(selection))}\ncoverage_matrix=${JSON.stringify(buildPrCoverageMatrix(selection))}\n`;
}

function bool(value: string | undefined): boolean {
  return value === "true";
}

function runLane(laneId: PrLaneId, env: NodeJS.ProcessEnv): number {
  const lane = getPrLane(laneId);
  const shard = env.PR_LANE_SHARD ? Number(env.PR_LANE_SHARD) : undefined;
  const shardCount = env.PR_LANE_SHARD_COUNT ? Number(env.PR_LANE_SHARD_COUNT) : undefined;
  for (const command of lane.commands) {
    if (laneId === "critical-coverage" && command.id !== "critical-coverage-merge") continue;
    const program = command.program === "npm" ? "npm" : process.execPath;
    const result = spawnSync(program, buildPrLaneCommandArgs(command, {
      base: env.PR_BASE_SHA,
      head: env.PR_HEAD_SHA,
      shard,
      shardCount,
      skipDocSync: bool(env.PR_SKIP_DOC_SYNC),
    }), { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function runClassify(env: NodeJS.ProcessEnv): number {
  const [classifier] = getPrLane("preflight").commands;
  const classifierResult = spawnSync(process.execPath, classifier.args, { env, encoding: "utf8" });
  if (classifierResult.error) throw classifierResult.error;
  if (classifierResult.stderr) process.stderr.write(classifierResult.stderr);
  if (classifierResult.status !== 0) return classifierResult.status ?? 1;
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required for classification");
  appendFileSync(outputPath, classifierResult.stdout);
  return 0;
}

function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["matrix", "classify", "run"]],
    options: {
      matrix: { type: "boolean" },
      classify: { type: "boolean" },
      run: { type: "boolean" },
    },
  });
  const selectedModes = [values.matrix, values.classify, values.run].filter(Boolean);
  assertCliUsage(selectedModes.length === 1, "Exactly one of --matrix, --classify, or --run is required");
  if (values.matrix) {
    const criticalCoverageChanged = bool(env.CRITICAL_COVERAGE_CHANGED);
    let criticalCoverageShards = 0;
    if (criticalCoverageChanged) {
      const base = env.PR_BASE_SHA;
      const head = env.PR_HEAD_SHA;
      const changedFiles = base && head
        ? collectGitPaths({ kind: "range", base, head, diffFilter: "ACMR" })
        : [];
      const changedCriticalFiles = changedFiles.some((file) => CRITICAL_FILES.includes(file))
        ? changedFiles
        : undefined;
      criticalCoverageShards = countCriticalCoverageShards({ changedFiles: changedCriticalFiles });
    }
    const docsOnly = bool(env.DOCS_ONLY);
    const outputs = formatPrWorkflowOutputs({
      criticalCoverageChanged,
      criticalCoverageShards,
      docsChanged: bool(env.DOCS_CHANGED),
      docsOnly,
      pagesArtifactRequired: bool(env.PAGES_ARTIFACT_REQUIRED),
      ...(docsOnly ? {} : { testShards: readPrTestPlan(PR_TEST_PLAN_PATH).shardCount }),
    });
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
    else process.stdout.write(outputs);
    return 0;
  }
  if (values.classify) return runClassify(env);
  return runLane(env.PR_LANE_ID as PrLaneId, env);
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
}, { label: "[pr-workflow]" });
