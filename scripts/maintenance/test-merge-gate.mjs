#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mjs";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "../lib/command-runner.mjs";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";

const ZERO_SHA = /^0+$/;
const LOCAL_PAGES_CANARY_ROUTES =
  "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/";
const LOCAL_MOBILE_CANARY_ROUTES = LOCAL_PAGES_CANARY_ROUTES;
const LOCAL_MOBILE_CANARY_VIEWPORTS = "360x740,390x844";

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

export function buildCommandPlan(changedFiles, { pagesSmoke = false, workerSmoke = false } = {}) {
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

  if (pagesSmoke && pagesChanged) {
    for (const cmd of PAGES_SMOKE_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Pages smoke enabled by the local merge-gate default");
    }
  }

  if (workerSmoke && workerChanged) {
    for (const cmd of WORKER_SMOKE_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Opt-in worker smoke requested via MERGE_GATE_WORKER_SMOKE=1");
    }
  }

  return plan;
}

export function buildFullCommandPlan(
  reason = "Full deploy path requested",
  { pagesSmoke = false, workerSmoke = false } = {},
) {
  const plan = [];

  for (const cmd of COMMON_VALIDATE_PREBUILD_COMMANDS) {
    addCommand(plan, cmd, reason);
  }

  for (const cmd of PAGES_VALIDATE_COMMANDS) {
    addCommand(plan, cmd, reason);
  }

  for (const cmd of COMMON_VALIDATE_POSTBUILD_COMMANDS) {
    addCommand(plan, cmd, reason);
  }

  for (const cmd of WORKER_VALIDATE_COMMANDS) {
    addCommand(plan, cmd, reason);
  }

  if (pagesSmoke) {
    for (const cmd of PAGES_SMOKE_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Pages smoke enabled by the local merge-gate default");
    }
  }

  if (workerSmoke) {
    for (const cmd of WORKER_SMOKE_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Opt-in worker smoke requested via MERGE_GATE_WORKER_SMOKE=1");
    }
  }

  return plan;
}

export function getChangedFiles({
  stagedMode = false,
  baseRef = "origin/main",
  headRef = "HEAD",
  execFile = execFileSync,
} = {}) {
  if (stagedMode) {
    const raw = execFile("git", ["diff", "--name-only", "--cached"], { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  }

  if (!baseRef || ZERO_SHA.test(baseRef)) {
    throw new Error(
      "[merge-gate] Could not diff from an empty base ref. Set MERGE_GATE_FULL_DEPLOY=1 to force the full local gate.",
    );
  }

  let raw;
  try {
    raw = execFile("git", ["diff", "--name-only", `${baseRef}...${headRef}`], { encoding: "utf8" });
  } catch {
    throw new Error(
      `[merge-gate] Could not diff ${baseRef}...${headRef}. Set MERGE_GATE_BASE_REF and MERGE_GATE_HEAD_REF explicitly.`,
    );
  }

  return raw
    .split(/\r?\n/g)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

export function getCommandEnv(cmd, changedFiles, env = process.env) {
  const baseEnv = env.MERGE_GATE_NATIVE_ENV === "1" ? {} : { TZ: "UTC", LANG: "C.UTF-8", CI: "true" };

  if (cmd === "npm run build") {
    return {
      ...baseEnv,
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    };
  }

  if (cmd === "npm run validate:pages-smoke") {
    const pagesUiChanged = hasPagesUiImpact(changedFiles);
    const pagesSmokeEnv = {
      ...baseEnv,
      ...(env.SMOKE_UI_OVERFLOW_ROUTES ? {} : { SMOKE_UI_OVERFLOW_ROUTES: LOCAL_PAGES_CANARY_ROUTES }),
      ...(env.SMOKE_UI_OVERFLOW_WORKERS ? {} : { SMOKE_UI_OVERFLOW_WORKERS: "6" }),
    };

    if (!pagesUiChanged) {
      return {
        ...pagesSmokeEnv,
        PAGES_SMOKE_INCLUDE_MOBILE: "0",
      };
    }

    return {
      ...pagesSmokeEnv,
      PAGES_SMOKE_INCLUDE_MOBILE: "1",
      ...(env.SMOKE_MOBILE_UI_ROUTES ? {} : { SMOKE_MOBILE_UI_ROUTES: LOCAL_MOBILE_CANARY_ROUTES }),
      ...(env.SMOKE_MOBILE_UI_VIEWPORTS ? {} : { SMOKE_MOBILE_UI_VIEWPORTS: LOCAL_MOBILE_CANARY_VIEWPORTS }),
      ...(env.SMOKE_MOBILE_UI_SKIP_DESKTOP ? {} : { SMOKE_MOBILE_UI_SKIP_DESKTOP: "1" }),
      ...(env.SMOKE_MOBILE_UI_WORKERS ? {} : { SMOKE_MOBILE_UI_WORKERS: "3" }),
      ...(env.SMOKE_MOBILE_UI_WAIT_MS ? {} : { SMOKE_MOBILE_UI_WAIT_MS: "1500" }),
    };
  }

  if (cmd === "npm run validate:worker-smoke") {
    return {
      ...baseEnv,
      ...(env.SMOKE_API_SCOPE ? {} : { SMOKE_API_SCOPE: "canary" }),
    };
  }

  if (cmd !== "npm run coverage:critical") {
    return baseEnv;
  }

  return {
    ...baseEnv,
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

  const smokeUnits = [];
  for (const cmd of [...PAGES_SMOKE_VALIDATE_COMMANDS, ...WORKER_SMOKE_VALIDATE_COMMANDS]) {
    const item = findPlanItem(plan, cmd);
    if (item) {
      smokeUnits.push(createExecutionUnit([item]));
    }
  }

  return [
    ...prebuildCommands.map((item) => [createExecutionUnit([item])]),
    ...(postValidateUnits.length > 0 ? [postValidateUnits] : []),
    ...(smokeUnits.length > 0 ? [smokeUnits] : []),
  ];
}

export async function runExecutionBatches(
  plan,
  changedFiles,
  env = process.env,
  { runCommandImpl = runShellCommand, exit = process.exit } = {},
) {
  // Default to serial execution to avoid local CPU contention from the
  // noncritical test shard matrix (which is intended for CI runners with one shard
  // per machine). Opt back in with MERGE_GATE_PARALLEL=1.
  const parallelMode = env.MERGE_GATE_PARALLEL === "1";
  const batches = parallelMode ? buildExecutionBatches(plan) : plan.map((item) => [createExecutionUnit([item])]);

  await runCommandBatches(batches, {
    exit,
    getCommandEnv: (item) => getCommandEnv(item.cmd, changedFiles, env),
    label: "merge-gate",
    runCommandImpl,
  });
}

export function fetchBaseRef({ baseRef, execFile = execFileSync } = {}) {
  if (!baseRef || !baseRef.startsWith("origin/")) {
    return;
  }
  const branch = baseRef.slice("origin/".length);
  try {
    execFile("git", ["fetch", "--quiet", "origin", branch], { stdio: "ignore" });
  } catch {
    console.warn(`[merge-gate] Warning: could not fetch ${baseRef}; continuing with the local snapshot.`);
  }
}

export async function runMergeGate({
  argv = process.argv.slice(2),
  env = process.env,
  runCommandImpl = runShellCommand,
  execFile = execFileSync,
} = {}) {
  const args = new Set(argv);
  const stagedMode = args.has("--staged");
  const baseRefOverridden = typeof env.MERGE_GATE_BASE_REF === "string" && env.MERGE_GATE_BASE_REF.length > 0;
  const baseRef = env.MERGE_GATE_BASE_REF ?? "origin/main";
  const headRef = env.MERGE_GATE_HEAD_REF ?? "HEAD";
  const dryRun = env.MERGE_GATE_DRY_RUN === "1";
  const forceFullDeploy = env.MERGE_GATE_FULL_DEPLOY === "1";
  const pagesSmoke = env.MERGE_GATE_PAGES_SMOKE !== "0";
  const workerSmoke = env.MERGE_GATE_WORKER_SMOKE === "1";
  const skipFetch = env.MERGE_GATE_NO_FETCH === "1";

  const nodeModulesResult = await runCommandImpl("node scripts/ci/check-node-modules-fresh.mjs", {}, {});
  const nodeModulesStatus =
    typeof nodeModulesResult === "number" ? nodeModulesResult : (nodeModulesResult?.status ?? 1);
  if (nodeModulesStatus !== 0) {
    console.error("[merge-gate] FAILED: node_modules drift check is fatal (node_modules/ missing).");
    process.exit(nodeModulesStatus);
    return;
  }

  if (!stagedMode && !forceFullDeploy && !baseRefOverridden && !skipFetch) {
    fetchBaseRef({ baseRef, execFile });
  }

  const changedFiles = forceFullDeploy ? [] : getChangedFiles({ stagedMode, baseRef, headRef, execFile });

  console.log(`[merge-gate] Base ref: ${forceFullDeploy ? "(full deploy fallback)" : baseRef}`);
  console.log(`[merge-gate] Head ref: ${headRef}`);
  console.log(`[merge-gate] Mode: ${stagedMode ? "staged" : "merged-diff"}`);
  console.log(`[merge-gate] Changed files: ${changedFiles.length}`);
  for (const file of changedFiles) {
    console.log(`  - ${file}`);
  }

  if (!forceFullDeploy && changedFiles.length === 0) {
    console.log("[merge-gate] No changes detected; gate skipped.");
    return;
  }

  const plan = forceFullDeploy
    ? buildFullCommandPlan(
        "Full deploy fallback requested; local merge gate mirrors the full deploy-path validate core",
        { pagesSmoke, workerSmoke },
      )
    : buildCommandPlan(changedFiles, { pagesSmoke, workerSmoke });

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

  await runExecutionBatches(plan, changedFiles, env, { runCommandImpl });

  console.log("[merge-gate] All checks passed.");
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runMergeGate().catch((error) => {
    console.error(`[merge-gate] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
