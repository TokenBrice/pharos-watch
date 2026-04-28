#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "./lib/deploy-impact.mjs";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "./lib/command-runner.mjs";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "./lib/validate-contract.mjs";

export function normalizePath(path) {
  return normalizeRepoPath(path);
}

function addCommand(plan, cmd, reason) {
  const existing = plan.find((item) => item.cmd === cmd);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  plan.push({ cmd, reasons: [reason] });
}

export function buildCommandPlan(changedFiles) {
  if (!hasDeployImpact(changedFiles)) {
    return [];
  }

  const plan = [];
  const pagesChanged = hasPagesDeployImpact(changedFiles);
  const workerChanged = hasWorkerDeployImpact(changedFiles);

  for (const cmd of COMMON_VALIDATE_PREBUILD_COMMANDS) {
    addCommand(plan, cmd, "Deploy-impacting files changed; local merge gate mirrors the deploy-path validate core");
  }

  if (pagesChanged) {
    for (const cmd of PAGES_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Pages-impacting files changed");
    }
  }

  for (const cmd of COMMON_VALIDATE_POSTBUILD_COMMANDS) {
    addCommand(plan, cmd, "Deploy-impacting files changed; local merge gate mirrors the deploy-path validate core");
  }

  if (workerChanged) {
    for (const cmd of WORKER_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Worker-impacting files changed");
    }
  }

  return plan;
}

export function getChangedFiles({ stagedMode = false, baseRef = "origin/main", execFile = execFileSync } = {}) {
  if (stagedMode) {
    const raw = execFile("git", ["diff", "--name-only", "--cached"], { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  }

  let mergeBase;
  try {
    mergeBase = execFile("git", ["merge-base", baseRef, "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`[merge-gate] Could not resolve merge-base with ${baseRef}. Set MERGE_GATE_BASE_REF explicitly.`);
  }

  const raw = execFile("git", ["diff", "--name-only", `${mergeBase}...HEAD`], { encoding: "utf8" });
  return raw
    .split(/\r?\n/g)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

export function getCommandEnv(cmd, changedFiles) {
  if (cmd !== "npm run coverage:critical") {
    return {};
  }

  return {
    CRITICAL_COVERAGE_CHANGED_FILES: changedFiles.join(","),
  };
}

function findPlanItem(plan, cmd) {
  return plan.find((item) => item.cmd === cmd);
}

export function buildExecutionBatches(plan) {
  const prebuildCommands = COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => findPlanItem(plan, cmd)).filter(Boolean);
  const hasPagesBuild = PAGES_VALIDATE_COMMANDS.every((cmd) => findPlanItem(plan, cmd));
  const postValidateUnits = [];

  if (hasPagesBuild) {
    postValidateUnits.push(
      createExecutionUnit(PAGES_VALIDATE_COMMANDS.map((cmd) => findPlanItem(plan, cmd)).filter(Boolean)),
    );
  }

  for (const cmd of COMMON_VALIDATE_POSTBUILD_COMMANDS) {
    const item = findPlanItem(plan, cmd);
    if (item) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  for (const cmd of WORKER_VALIDATE_COMMANDS) {
    const item = findPlanItem(plan, cmd);
    if (item) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  return [
    ...prebuildCommands.map((item) => [createExecutionUnit([item])]),
    ...(postValidateUnits.length > 0 ? [postValidateUnits] : []),
  ];
}

export async function runExecutionBatches(
  plan,
  changedFiles,
  env = process.env,
  { runCommandImpl = runShellCommand, exit = process.exit } = {},
) {
  const serialMode = env.MERGE_GATE_SERIAL === "1";
  const batches = serialMode ? plan.map((item) => [createExecutionUnit([item])]) : buildExecutionBatches(plan);

  await runCommandBatches(batches, {
    exit,
    getCommandEnv: (item) => getCommandEnv(item.cmd, changedFiles),
    label: "merge-gate",
    runCommandImpl,
  });
}

export async function runMergeGate({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = new Set(argv);
  const stagedMode = args.has("--staged");
  const baseRef = env.MERGE_GATE_BASE_REF ?? "origin/main";
  const dryRun = env.MERGE_GATE_DRY_RUN === "1";
  const changedFiles = getChangedFiles({ stagedMode, baseRef });

  console.log(`[merge-gate] Base ref: ${baseRef}`);
  console.log(`[merge-gate] Mode: ${stagedMode ? "staged" : "merged-diff"}`);
  console.log(`[merge-gate] Changed files: ${changedFiles.length}`);
  for (const file of changedFiles) {
    console.log(`  - ${file}`);
  }

  if (changedFiles.length === 0) {
    console.log("[merge-gate] No changes detected; gate skipped.");
    return;
  }

  const plan = buildCommandPlan(changedFiles);

  if (plan.length === 0) {
    console.log("[merge-gate] No Pages or worker deploy surfaces changed; gate skipped.");
    return;
  }

  console.log("[merge-gate] Command plan:");
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    console.log(`${i + 1}. ${item.cmd}`);
    console.log(`   reasons: ${item.reasons.join("; ")}`);
  }

  if (dryRun) {
    console.log("[merge-gate] Dry run enabled; commands not executed.");
    return;
  }

  await runExecutionBatches(plan, changedFiles, env);

  console.log("[merge-gate] All checks passed.");
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runMergeGate().catch((error) => {
    console.error(`[merge-gate] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
