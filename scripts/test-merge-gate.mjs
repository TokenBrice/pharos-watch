#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "./lib/deploy-impact.mjs";
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

export function getChangedFiles({ stagedMode = false, baseRef = "origin/main", exec = execSync } = {}) {
  if (stagedMode) {
    const raw = exec("git diff --name-only --cached", { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  }

  let mergeBase;
  try {
    mergeBase = exec(`git merge-base ${baseRef} HEAD`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`[merge-gate] Could not resolve merge-base with ${baseRef}. Set MERGE_GATE_BASE_REF explicitly.`);
  }

  const raw = exec(`git diff --name-only ${mergeBase}...HEAD`, { encoding: "utf8" });
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

function createExecutionUnit(commands) {
  return { commands };
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

function killProcessGroup(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited between failure detection and abort.
  }
}

function runCommand(cmd, extraEnv = {}, { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 130, aborted: true });
      return;
    }

    const child = spawn("bash", ["-lc", cmd], {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let aborted = false;
    let killTimer;
    const abort = () => {
      aborted = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.on("error", () => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ status: aborted ? 130 : 1, aborted });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ status: aborted ? 130 : (code ?? 1), aborted });
    });
  });
}

function normalizeCommandResult(result) {
  if (typeof result === "number") {
    return { status: result, aborted: false };
  }
  return {
    status: result?.status ?? 1,
    aborted: result?.aborted === true,
  };
}

async function runExecutionUnit(unit, changedFiles, { runCommandImpl = runCommand, signal } = {}) {
  for (const item of unit.commands) {
    if (signal?.aborted) {
      return { status: 130, failedCmd: item.cmd, aborted: true };
    }
    console.log(`[merge-gate] Running: ${item.cmd}`);
    const result = normalizeCommandResult(
      await runCommandImpl(item.cmd, getCommandEnv(item.cmd, changedFiles), { signal }),
    );
    const { status } = result;
    if (status !== 0) {
      return { status, failedCmd: item.cmd, aborted: result.aborted };
    }
  }
  return { status: 0, failedCmd: null, aborted: false };
}

function reportFailedCommand(result) {
  if (result.aborted) {
    return;
  }
  console.error(`[merge-gate] FAILED: ${result.failedCmd} exited with status ${result.status}`);
}

export async function runExecutionBatches(
  plan,
  changedFiles,
  env = process.env,
  { runCommandImpl = runCommand, exit = process.exit } = {},
) {
  const serialMode = env.MERGE_GATE_SERIAL === "1";
  const batches = serialMode ? plan.map((item) => [createExecutionUnit([item])]) : buildExecutionBatches(plan);

  for (const batch of batches) {
    if (batch.length === 1) {
      const result = await runExecutionUnit(batch[0], changedFiles, { runCommandImpl });
      if (result.status !== 0) {
        reportFailedCommand(result);
        exit(result.status);
        return;
      }
      continue;
    }

    console.log(`[merge-gate] Running ${batch.length} independent command groups in parallel.`);
    const controllers = batch.map(() => new AbortController());
    const pending = new Map(
      batch.map((unit, index) => [
        index,
        runExecutionUnit(unit, changedFiles, {
          runCommandImpl,
          signal: controllers[index].signal,
        }).then((result) => ({ index, result })),
      ]),
    );

    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);

      if (settled.result.status !== 0) {
        reportFailedCommand(settled.result);
        for (const [index] of pending) {
          controllers[index].abort();
        }
        await Promise.allSettled(pending.values());
        exit(settled.result.status);
        return;
      }
    }
  }
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
