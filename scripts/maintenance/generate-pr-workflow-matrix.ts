#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { assertCliUsage, parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { PR_TEST_PLAN_PATH, readPrTestPlan } from "../lib/pr-test-plan.mts";
import {
  PR_LANES,
  PR_DOC_COMMANDS,
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
  timeout: number;
}

export function buildPrWorkflowMatrix(selection: PrLaneSelection): { include: WorkflowMatrixEntry[] } {
  const include: WorkflowMatrixEntry[] = [];
  if (selection.docsOnly) return { include };
  for (const lane of PR_LANES) {
    if (["preflight", "pages-artifact", "gate"].includes(lane.id) || !isPrLaneSelected(lane, selection)) continue;
    const shards = lane.id === "tests" ? selection.testShards ?? 4 : 1;
    if (!Number.isInteger(shards) || shards < 1 || (lane.shards !== undefined && shards > lane.shards)) {
      throw new Error(`Invalid shard count for ${lane.id}: ${shards}`);
    }
    for (let shard = 1; shard <= shards; shard += 1) {
      include.push({
        lane: lane.id,
        ...(lane.shards ? { shard, shardCount: shards } : {}),
        timeout: lane.timeoutMinutes,
      });
    }
  }
  return { include };
}

export function formatPrWorkflowOutputs(selection: PrLaneSelection): string {
  return `matrix=${JSON.stringify(buildPrWorkflowMatrix(selection))}\n`;
}

function bool(value: string | undefined): boolean {
  return value === "true";
}

function runLane(laneId: PrLaneId | "docs-inline", env: NodeJS.ProcessEnv): number {
  const commands = laneId === "docs-inline" ? PR_DOC_COMMANDS : getPrLane(laneId).commands;
  const shard = env.PR_LANE_SHARD ? Number(env.PR_LANE_SHARD) : undefined;
  const shardCount = env.PR_LANE_SHARD_COUNT ? Number(env.PR_LANE_SHARD_COUNT) : undefined;
  for (const command of commands) {
    const program = command.program === "npm" ? "npm" : process.execPath;
    const result = spawnSync(program, buildPrLaneCommandArgs(command, {
      base: env.PR_BASE_SHA,
      head: env.PR_HEAD_SHA,
      shard,
      shardCount,
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
    const docsOnly = bool(env.DOCS_ONLY);
    const outputs = formatPrWorkflowOutputs({
      docsOnly,
      pagesArtifactRequired: bool(env.PAGES_ARTIFACT_REQUIRED),
      v9ResourceRequired: env.V9_RESOURCE_REQUIRED !== "false",
      ...(docsOnly ? {} : { testShards: readPrTestPlan(PR_TEST_PLAN_PATH).shardCount }),
    });
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
    else process.stdout.write(outputs);
    return 0;
  }
  if (values.classify) return runClassify(env);
  return runLane(env.PR_LANE_ID as PrLaneId | "docs-inline", env);
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
}, { label: "[pr-workflow]" });
