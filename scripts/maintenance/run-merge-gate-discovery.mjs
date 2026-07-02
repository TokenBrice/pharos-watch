#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import os from "node:os";
import {
  createExecutionUnit,
  normalizeCommandResult,
  runParallelExecutionUnits,
  runShellCommand,
} from "../lib/command-runner.mjs";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  buildCommandPlan,
  buildFullCommandPlan,
  fetchBaseRef,
  getChangedFiles,
  getCommandEnv,
} from "./test-merge-gate.mjs";

const ZERO_SHA = /^0+$/;

function findPlanItem(plan, cmd) {
  return plan.find((item) => item.cmd === cmd);
}

function takePlanItem(plan, matched, cmd) {
  const item = findPlanItem(plan, cmd);
  if (item) {
    matched.add(item);
  }
  return item;
}

export function resolveDiscoveryMaxParallel(env = process.env, availableCores = os.availableParallelism()) {
  const explicit = Number.parseInt(env.MERGE_GATE_DISCOVERY_MAX_PARALLEL ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return Math.max(1, Math.min(6, availableCores - 2));
}

export function buildDiscoveryExecutionGroups(plan, { includeSmoke = false } = {}) {
  const matched = new Set();
  const prebuildUnits = COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => takePlanItem(plan, matched, cmd))
    .filter(Boolean)
    .map((item) => createExecutionUnit([item]));

  const postValidateUnits = [];
  const pagesCommands = PAGES_VALIDATE_COMMANDS.map((cmd) => takePlanItem(plan, matched, cmd)).filter(Boolean);
  if (pagesCommands.length > 0) {
    postValidateUnits.push(createExecutionUnit(pagesCommands));
  }

  for (const cmd of [...COMMON_VALIDATE_POSTBUILD_COMMANDS, ...WORKER_VALIDATE_COMMANDS]) {
    const item = takePlanItem(plan, matched, cmd);
    if (item) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  const smokeUnits = [];
  for (const cmd of [...PAGES_SMOKE_VALIDATE_COMMANDS, ...WORKER_SMOKE_VALIDATE_COMMANDS]) {
    const item = takePlanItem(plan, matched, cmd);
    if (item) {
      if (includeSmoke) {
        smokeUnits.push(createExecutionUnit([item]));
      }
    }
  }

  for (const item of plan) {
    if (!matched.has(item)) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  return { prebuildUnits, postValidateUnits, smokeUnits };
}

export function getDiscoveryCommandEnv(command, changedFiles, env = process.env) {
  const cmd = typeof command === "string" ? command : command.cmd;
  const commandEnv = getCommandEnv(cmd, changedFiles, env);
  if (cmd !== "npm run validate:prebuild") {
    return commandEnv;
  }

  return {
    ...commandEnv,
    [VALIDATE_PREBUILD_SURFACE_ENV]: commandEnv[VALIDATE_PREBUILD_SURFACE_ENV] ?? "full",
    ...(commandEnv[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]
      ? { [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: commandEnv[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV] }
      : {}),
    VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
  };
}

function parseOptions(argv, env) {
  const args = new Set(argv);
  const forceFullDeploy = env.MERGE_GATE_FULL_DEPLOY === "1";
  return {
    baseRef: env.MERGE_GATE_BASE_REF ?? "origin/main",
    baseRefOverridden: typeof env.MERGE_GATE_BASE_REF === "string" && env.MERGE_GATE_BASE_REF.length > 0,
    dryRun: env.MERGE_GATE_DRY_RUN === "1",
    forceFullDeploy,
    headRef: env.MERGE_GATE_HEAD_REF ?? "HEAD",
    includeSmoke: env.MERGE_GATE_DISCOVERY_SMOKE === "1",
    skipFetch: env.MERGE_GATE_NO_FETCH === "1",
    stagedMode: args.has("--staged"),
  };
}

function getDiscoveryChangedFiles(options, execFile) {
  if (options.forceFullDeploy) {
    return [];
  }
  if (!options.stagedMode && (!options.baseRef || ZERO_SHA.test(options.baseRef))) {
    throw new Error(
      "[merge-gate:discover] Could not diff from an empty base ref. Set MERGE_GATE_FULL_DEPLOY=1 to force the full local discovery plan.",
    );
  }
  return getChangedFiles({
    stagedMode: options.stagedMode,
    baseRef: options.baseRef,
    headRef: options.headRef,
    execFile,
  });
}

function printPlan(plan, groups, { includeSmoke, maxParallel }) {
  console.log("[merge-gate:discover] Command plan:");
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    const extra = item.reasons.length > 1 ? ` (+${item.reasons.length - 1} more)` : "";
    console.log(`${i + 1}. ${item.cmd} - ${item.reasons[0]}${extra}`);
  }

  console.log("[merge-gate:discover] Discovery grouping:");
  console.log(`  prebuild: ${groups.prebuildUnits.length} group(s), validate:prebuild continues on errors`);
  console.log(`  postbuild: ${groups.postValidateUnits.length} independent group(s), max parallel ${maxParallel}`);
  console.log(
    `  smoke: ${includeSmoke ? `${groups.smokeUnits.length} group(s)` : "skipped (set MERGE_GATE_DISCOVERY_SMOKE=1)"}`,
  );
}

async function runUnits(units, label, { changedFiles, env, maxParallel, runCommandImpl }) {
  if (units.length === 0) {
    return { status: 0, failedCmd: null, aborted: false };
  }

  return runParallelExecutionUnits(units, {
    continueOnError: true,
    exit: () => {},
    getCommandEnv: (command) => getDiscoveryCommandEnv(command, changedFiles, env),
    label,
    maxParallel,
    runCommandImpl,
  });
}

export async function runMergeGateDiscovery({
  argv = process.argv.slice(2),
  env = process.env,
  runCommandImpl = runShellCommand,
  execFile = execFileSync,
  exit = process.exit,
  availableCores = os.availableParallelism(),
} = {}) {
  const options = parseOptions(argv, env);
  if (!options.stagedMode && !options.forceFullDeploy && !options.baseRefOverridden && !options.skipFetch) {
    fetchBaseRef({ baseRef: options.baseRef, execFile });
  }

  const changedFiles = getDiscoveryChangedFiles(options, execFile);
  const pagesSmoke = options.includeSmoke && env.MERGE_GATE_PAGES_SMOKE !== "0";
  const workerSmoke = options.includeSmoke && env.MERGE_GATE_WORKER_SMOKE === "1";
  const plan = options.forceFullDeploy
    ? buildFullCommandPlan(
        "Full deploy fallback requested; local discovery mirrors the full deploy-path validate core",
        { pagesSmoke, workerSmoke },
      )
    : buildCommandPlan(changedFiles, { pagesSmoke, workerSmoke });
  const maxParallel = resolveDiscoveryMaxParallel(env, availableCores);
  const groups = buildDiscoveryExecutionGroups(plan, { includeSmoke: options.includeSmoke });

  console.log(
    `[merge-gate:discover] Base ref: ${options.forceFullDeploy ? "(full deploy fallback)" : options.baseRef}`,
  );
  console.log(`[merge-gate:discover] Head ref: ${options.headRef}`);
  console.log(`[merge-gate:discover] Mode: ${options.stagedMode ? "staged" : "merged-diff"}`);
  console.log(`[merge-gate:discover] Changed files: ${changedFiles.length}`);

  if (!options.forceFullDeploy && changedFiles.length === 0) {
    console.log("[merge-gate:discover] No changes detected; discovery skipped.");
    return { status: 0 };
  }
  if (plan.length === 0) {
    console.log("[merge-gate:discover] No Pages or worker deploy surfaces changed; discovery skipped.");
    return { status: 0 };
  }

  printPlan(plan, groups, { includeSmoke: options.includeSmoke, maxParallel });
  if (options.dryRun) {
    console.log("[merge-gate:discover] Dry run enabled; commands not executed.");
    return { status: 0 };
  }

  const nodeModulesResult = normalizeCommandResult(
    await runCommandImpl("node scripts/ci/check-node-modules-fresh.mjs --strict", {}, {}),
  );
  if (nodeModulesResult.status !== 0) {
    console.error("[merge-gate:discover] FAILED: node_modules drift check is fatal (node_modules/ missing).");
    exit(nodeModulesResult.status);
    return { status: nodeModulesResult.status };
  }

  const prebuildResult = await runUnits(groups.prebuildUnits, "merge-gate:discover/prebuild", {
    changedFiles,
    env,
    maxParallel: 1,
    runCommandImpl,
  });
  const postbuildResult = await runUnits(groups.postValidateUnits, "merge-gate:discover/postbuild", {
    changedFiles,
    env,
    maxParallel,
    runCommandImpl,
  });
  const smokeResult = await runUnits(groups.smokeUnits, "merge-gate:discover/smoke", {
    changedFiles,
    env,
    maxParallel,
    runCommandImpl,
  });

  const firstFailure = [prebuildResult, postbuildResult, smokeResult].find((result) => result.status !== 0);
  if (firstFailure) {
    console.error(
      "[merge-gate:discover] Discovery found failures. Fix by failing command, then run the final merge gate.",
    );
    exit(firstFailure.status);
    return { status: firstFailure.status };
  }

  console.log("[merge-gate:discover] Discovery checks passed. Run npm run test:merge-gate for the authoritative gate.");
  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runMergeGateDiscovery().catch((error) => {
    console.error(`[merge-gate:discover] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
