#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import os from "node:os";
import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mjs";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "../lib/command-runner.mjs";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
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
  hasTelegramLoadGuardImpact,
  TELEGRAM_LOAD_ADVISORY_COMMAND,
} from "../lib/telegram-load-guard.mjs";
import { writeMergeGateReceipt } from "../lib/merge-gate-receipt.mjs";

const ZERO_SHA = /^0+$/;
const LOCAL_PAGES_CANARY_ROUTES =
  "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/,/pharoswatchbot/";
const LOCAL_MOBILE_CANARY_ROUTES = LOCAL_PAGES_CANARY_ROUTES;
const LOCAL_MOBILE_CANARY_VIEWPORTS = "360x740,390x844";
const PRODUCTION_PAGES_ENV_MODE = "MERGE_GATE_PRODUCTION_ENV";
const PRODUCTION_PUBLIC_ENV_KEYS = new Set(["NEXT_PUBLIC_GA_ID"]);
const PRODUCTION_PUBLIC_ENV_PREFIXES = ["NEXT_PUBLIC_PHAROS_"];
// Gate builds skip the prebuild artifact regeneration: every id below is
// byte-verified fresh by check:generated-artifacts in the prebuild batch that
// runs (and must pass) before the build batch in the same gate invocation, so
// regenerating them again inside `npm run build` is guaranteed no-op work.
const GATE_BUILD_GENERATED_ARTIFACTS_SKIP = GENERATED_ARTIFACT_REGISTRY.map((artifact) => artifact.id).join(",");
const MERGE_GATE_DEFAULT_BUDGET_MINUTES = 8;
const DEPENDENCY_AUDIT_COMMAND = "npm run audit:deps";
const PRICING_PROVIDER_AUDIT_COMMAND = "npm run audit:pricing-providers";
const DEPENDENCY_AUDIT_INPUT_PATHS = new Set(["package.json", "package-lock.json", "worker/package.json"]);
const PRICING_PROVIDER_AUDIT_INPUT_PATHS = new Set([
  "scripts/maintenance/audit-pricing-provider-config.ts",
  "shared/lib/pricing-provider-config.ts",
]);

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

  if (hasTelegramLoadGuardImpact(changedFiles)) {
    addCommand(
      plan,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
      "A reviewed Telegram delivery/load dependency changed; run advisory load/query-plan guard",
    );
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

  addCommand(plan, TELEGRAM_LOAD_ADVISORY_COMMAND, "Full deploy fallback requested; include Telegram advisory load/query-plan guard");

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

function isProductionPublicEnvKey(key) {
  return PRODUCTION_PUBLIC_ENV_KEYS.has(key) || PRODUCTION_PUBLIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function getProductionPagesPublicEnv(env = process.env) {
  return Object.fromEntries(
    Object.keys(env)
      .filter((key) => isProductionPublicEnvKey(key) && env[key] !== undefined)
      .sort()
      .map((key) => [key, env[key]]),
  );
}

export function getValidatePrebuildSurface(changedFiles) {
  const pagesChanged = hasPagesDeployImpact(changedFiles);
  const workerChanged = hasWorkerDeployImpact(changedFiles);

  if (pagesChanged && !workerChanged) {
    return "pages";
  }
  if (workerChanged && !pagesChanged) {
    return "worker";
  }
  return "full";
}

function shouldRunDependencyAudit(changedFiles) {
  return changedFiles.some((file) => DEPENDENCY_AUDIT_INPUT_PATHS.has(file));
}

function shouldRunPricingProviderAudit(changedFiles) {
  return changedFiles.some((file) => PRICING_PROVIDER_AUDIT_INPUT_PATHS.has(file));
}

/**
 * @param {string[]} changedFiles
 * @param {Record<string, string | undefined>} [env]
 */
export function getValidatePrebuildSkipCommands(changedFiles, env = process.env) {
  if (env.MERGE_GATE_FULL_DEPLOY === "1") {
    return [];
  }
  const skipped = [];
  if (!shouldRunDependencyAudit(changedFiles)) skipped.push(DEPENDENCY_AUDIT_COMMAND);
  if (!shouldRunPricingProviderAudit(changedFiles)) skipped.push(PRICING_PROVIDER_AUDIT_COMMAND);
  return skipped;
}

function getOfflinePagesPublicEnv(env) {
  return Object.fromEntries(
    Object.keys(env)
      .filter((key) => isProductionPublicEnvKey(key) && env[key] !== undefined)
      .sort()
      .map((key) => [key, undefined]),
  );
}

function getPagesValidationEnv(env) {
  return env[PRODUCTION_PAGES_ENV_MODE] === "1" ? getProductionPagesPublicEnv(env) : getOfflinePagesPublicEnv(env);
}

function getPagesSmokeGaEnv(env) {
  const explicitExpectedGaId = env.SMOKE_UI_EXPECT_GA_ID?.trim();
  if (explicitExpectedGaId) {
    return {};
  }
  if (env[PRODUCTION_PAGES_ENV_MODE] !== "1") {
    return {};
  }
  const productionGaId = env.NEXT_PUBLIC_GA_ID?.trim();
  return productionGaId ? { SMOKE_UI_EXPECT_GA_ID: productionGaId } : {};
}

export function getCommandEnv(cmd, changedFiles, env = process.env) {
  const baseEnv = env.MERGE_GATE_NATIVE_ENV === "1" ? {} : { TZ: "UTC", LANG: "C.UTF-8", CI: "true" };
  const pagesValidationEnv = PAGES_VALIDATE_COMMANDS.includes(cmd) ? getPagesValidationEnv(env) : {};

  if (cmd === "npm run validate:prebuild") {
    const skippedCommands = getValidatePrebuildSkipCommands(changedFiles, env);
    return {
      ...baseEnv,
      [VALIDATE_PREBUILD_SURFACE_ENV]: getValidatePrebuildSurface(changedFiles),
      ...(skippedCommands.length > 0
        ? { [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: skippedCommands.join(",") }
        : {}),
    };
  }

  if (cmd === "npm run build") {
    return {
      ...baseEnv,
      ...pagesValidationEnv,
      GENERATED_ARTIFACTS_SKIP: GATE_BUILD_GENERATED_ARTIFACTS_SKIP,
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    };
  }

  if (PAGES_VALIDATE_COMMANDS.includes(cmd)) {
    return {
      ...baseEnv,
      ...pagesValidationEnv,
    };
  }

  if (cmd === "npm run validate:pages-smoke") {
    const pagesUiChanged = hasPagesUiImpact(changedFiles);
    const pagesSmokeEnv = {
      ...baseEnv,
      ...getPagesSmokeGaEnv(env),
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
      // Local gate runs share the machine with the parallel validate matrix
      // (and often other agent sessions); the 1500 ms default settle cap
      // flaked on data-driven tables (/flows 0/5 columns) purely under CPU
      // contention. The settle is adaptive (network idle + stable sample), so
      // this generous cap costs nothing once hydration lands; CI deploy lanes
      // set their own env on idle runners and are unaffected.
      ...(env.SMOKE_MOBILE_UI_WAIT_MS ? {} : { SMOKE_MOBILE_UI_WAIT_MS: "5000" }),
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
    ...(env.CRITICAL_COVERAGE_RATCHET_ALL ? {} : { CRITICAL_COVERAGE_RATCHET_ALL: "1" }),
  };
}

function findPlanItem(plan, cmd) {
  return plan.find((item) => item.cmd === cmd);
}

export function buildExecutionBatches(plan) {
  const matched = new Set();
  const take = (item) => {
    if (item) matched.add(item);
    return item;
  };

  const prebuildCommands = COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => take(findPlanItem(plan, cmd))).filter(
    Boolean,
  );
  const hasPagesBuild = PAGES_VALIDATE_COMMANDS.every((cmd) => findPlanItem(plan, cmd));
  const postValidateUnits = [];

  if (hasPagesBuild) {
    postValidateUnits.push(
      createExecutionUnit(PAGES_VALIDATE_COMMANDS.map((cmd) => take(findPlanItem(plan, cmd))).filter(Boolean)),
    );
  }

  for (const cmd of COMMON_VALIDATE_POSTBUILD_COMMANDS) {
    const item = take(findPlanItem(plan, cmd));
    if (item) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  for (const cmd of WORKER_VALIDATE_COMMANDS) {
    const item = take(findPlanItem(plan, cmd));
    if (item) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  const smokeUnits = [];
  for (const cmd of [...PAGES_SMOKE_VALIDATE_COMMANDS, ...WORKER_SMOKE_VALIDATE_COMMANDS]) {
    const item = take(findPlanItem(plan, cmd));
    if (item) {
      smokeUnits.push(createExecutionUnit([item]));
    }
  }

  // Plan items outside the known command groups (e.g. future additions to the
  // plan builder, or hand-rolled plans in tests) must still execute — give
  // each its own unit instead of silently dropping it from the parallel path.
  for (const item of plan) {
    if (!matched.has(item)) {
      postValidateUnits.push(createExecutionUnit([item]));
    }
  }

  return [
    ...prebuildCommands.map((item) => [createExecutionUnit([item])]),
    ...(postValidateUnits.length > 0 ? [postValidateUnits] : []),
    ...(smokeUnits.length > 0 ? [smokeUnits] : []),
  ];
}

// Auto-parallel threshold: enough cores to absorb the post-validate matrix
// while leaving headroom for other local work (this tree often hosts
// concurrent agent sessions). MERGE_GATE_PARALLEL=1/0 remains the explicit
// override in either direction.
const MERGE_GATE_AUTO_PARALLEL_MIN_CORES = 12;

export function resolveMergeGateParallelMode(env, availableCores = os.availableParallelism()) {
  if (env.MERGE_GATE_PARALLEL === "1") return true;
  if (env.MERGE_GATE_PARALLEL === "0") return false;
  return availableCores >= MERGE_GATE_AUTO_PARALLEL_MIN_CORES;
}

export async function runExecutionBatches(
  plan,
  changedFiles,
  env = process.env,
  { runCommandImpl = runShellCommand, exit = process.exit, availableCores } = {},
) {
  const parallelMode = resolveMergeGateParallelMode(env, availableCores ?? os.availableParallelism());
  const batches = parallelMode ? buildExecutionBatches(plan) : plan.map((item) => [createExecutionUnit([item])]);

  await runCommandBatches(batches, {
    exit,
    getCommandEnv: (item) => getCommandEnv(item.cmd, changedFiles, env),
    label: "merge-gate",
    runCommandImpl,
  });
}

export function printMergeGateTimingSummary(commandTimings, totalMs, env = process.env, { log = console.log, warn = console.warn } = {}) {
  if (commandTimings.length === 0) {
    return;
  }

  const totalMinutes = totalMs / 60000;
  log(`[merge-gate] Timing summary (wall-clock ${totalMinutes.toFixed(1)} min):`);
  for (const { cmd, ms } of [...commandTimings].sort((a, b) => b.ms - a.ms)) {
    log(`  ${`${(ms / 1000).toFixed(1)}s`.padStart(8)}  ${cmd}`);
  }

  const budgetMinutes = Number.parseFloat(env.MERGE_GATE_BUDGET_MINUTES ?? `${MERGE_GATE_DEFAULT_BUDGET_MINUTES}`);
  if (Number.isFinite(budgetMinutes) && budgetMinutes > 0 && totalMinutes > budgetMinutes) {
    warn(
      `[merge-gate] WARNING: gate wall-clock ${totalMinutes.toFixed(1)} min exceeded the ${budgetMinutes} min budget. ` +
        "Investigate the slowest commands above before the runtime regresses further (MERGE_GATE_BUDGET_MINUTES overrides; 0 disables).",
    );
  }
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
  writeReceiptImpl = null,
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

  if (!stagedMode && !forceFullDeploy && !baseRefOverridden && !skipFetch) {
    fetchBaseRef({ baseRef, execFile });
  }

  const changedFiles = forceFullDeploy ? [] : getChangedFiles({ stagedMode, baseRef, headRef, execFile });

  console.log(`[merge-gate] Base ref: ${forceFullDeploy ? "(full deploy fallback)" : baseRef}`);
  console.log(`[merge-gate] Head ref: ${headRef}`);
  console.log(`[merge-gate] Mode: ${stagedMode ? "staged" : "merged-diff"}`);
  console.log(`[merge-gate] Changed files: ${changedFiles.length}`);
  // Cap the listing: agent sessions re-read this output on every subsequent
  // tool call, so a 200-file diff would burn context for no decision value.
  const MAX_LISTED_FILES = 20;
  for (const file of changedFiles.slice(0, MAX_LISTED_FILES)) {
    console.log(`  - ${file}`);
  }
  if (changedFiles.length > MAX_LISTED_FILES) {
    console.log(`  … and ${changedFiles.length - MAX_LISTED_FILES} more`);
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
    const extra = item.reasons.length > 1 ? ` (+${item.reasons.length - 1} more)` : "";
    console.log(`${i + 1}. ${item.cmd} — ${item.reasons[0]}${extra}`);
  }

  if (dryRun) {
    console.log("[merge-gate] Dry run enabled; commands not executed.");
    return;
  }

  const nodeModulesResult = await runCommandImpl("node scripts/ci/check-node-modules-fresh.mjs --strict", {}, {});
  const nodeModulesStatus =
    typeof nodeModulesResult === "number" ? nodeModulesResult : (nodeModulesResult?.status ?? 1);
  if (nodeModulesStatus !== 0) {
    console.error("[merge-gate] FAILED: node_modules drift check is fatal (node_modules/ missing).");
    process.exit(nodeModulesStatus);
    return;
  }

  const commandTimings = [];
  const timedRunCommandImpl = async (cmd, extraEnv, opts) => {
    const startedAt = Date.now();
    const result = await runCommandImpl(cmd, extraEnv, opts);
    commandTimings.push({ cmd, ms: Date.now() - startedAt });
    return result;
  };
  const gateStartedAt = Date.now();

  await runExecutionBatches(plan, changedFiles, env, {
    runCommandImpl: timedRunCommandImpl,
    // Print the timing summary on failure exits too, so slow-and-broken runs
    // still leave a per-command cost trail.
    exit: (status) => {
      printMergeGateTimingSummary(commandTimings, Date.now() - gateStartedAt, env);
      process.exit(status);
    },
  });

  printMergeGateTimingSummary(commandTimings, Date.now() - gateStartedAt, env);
  if (!stagedMode && writeReceiptImpl) {
    try {
      const receiptResult = writeReceiptImpl({
        baseRef,
        env,
        execFile,
        fullDeploy: forceFullDeploy,
        headRef,
      });
      console.log(
        receiptResult.written
          ? "[merge-gate] Reusable clean-state receipt written."
          : `[merge-gate] Receipt not written: ${receiptResult.reason}.`,
      );
    } catch (error) {
      console.warn(
        `[merge-gate] Warning: could not write validation receipt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log("[merge-gate] All checks passed.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runMergeGate({ writeReceiptImpl: writeMergeGateReceipt }).catch((error) => {
    console.error(`[merge-gate] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
