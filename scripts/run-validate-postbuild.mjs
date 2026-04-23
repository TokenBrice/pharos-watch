#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "./lib/validate-contract.mjs";

function parseBooleanArg(argv, name, defaultValue) {
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) {
    return defaultValue;
  }

  const value = match.slice(prefix.length).toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Expected ${name}=true|false, received: ${match}`);
}

function parseStringArg(argv, name, defaultValue = "") {
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : defaultValue;
}

function createExecutionUnit(commands) {
  return { commands };
}

export function buildPostPrebuildExecutionUnits({ pagesChanged = true, workerChanged = true } = {}) {
  return [
    ...(pagesChanged ? [createExecutionUnit(PAGES_VALIDATE_COMMANDS)] : []),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS.map((cmd) => createExecutionUnit([cmd])),
    ...(workerChanged ? WORKER_VALIDATE_COMMANDS.map((cmd) => createExecutionUnit([cmd])) : []),
  ];
}

export function getPostPrebuildCommandEnv(cmd, { coverageCompareRef = "" } = {}) {
  if (cmd !== "npm run coverage:critical" || !coverageCompareRef) {
    return {};
  }

  return {
    CRITICAL_COVERAGE_COMPARE_REF: coverageCompareRef,
  };
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
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
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
    aborted: result?.aborted === true,
    status: result?.status ?? 1,
  };
}

async function runExecutionUnit(unit, options) {
  const { coverageCompareRef = "", runCommandImpl = runCommand, signal } = options;

  for (const cmd of unit.commands) {
    if (signal?.aborted) {
      return { aborted: true, failedCmd: cmd, status: 130 };
    }

    console.log(`[validate:postbuild] Running: ${cmd}`);
    const result = normalizeCommandResult(
      await runCommandImpl(cmd, getPostPrebuildCommandEnv(cmd, { coverageCompareRef }), { signal }),
    );
    if (result.status !== 0) {
      return { aborted: result.aborted, failedCmd: cmd, status: result.status };
    }
  }

  return { aborted: false, failedCmd: null, status: 0 };
}

function reportFailedCommand(result) {
  if (result.aborted) {
    return;
  }
  console.error(`[validate:postbuild] FAILED: ${result.failedCmd} exited with status ${result.status}`);
}

export async function runPostPrebuildValidation(
  { coverageCompareRef = "", env = process.env, pagesChanged = true, workerChanged = true } = {},
  { exit = process.exit, runCommandImpl = runCommand } = {},
) {
  const units = buildPostPrebuildExecutionUnits({ pagesChanged, workerChanged });
  if (units.length === 0) {
    console.log("[validate:postbuild] No post-prebuild commands selected.");
    return;
  }

  if (env.VALIDATE_POSTBUILD_SERIAL === "1") {
    console.log("[validate:postbuild] Running post-prebuild commands serially.");
    for (const unit of units) {
      const result = await runExecutionUnit(unit, { coverageCompareRef, runCommandImpl });
      if (result.status !== 0) {
        reportFailedCommand(result);
        exit(result.status);
        return;
      }
    }
    return;
  }

  console.log(`[validate:postbuild] Running ${units.length} independent command groups in parallel.`);
  const controllers = units.map(() => new AbortController());
  const pending = new Map(
    units.map((unit, index) => [
      index,
      runExecutionUnit(unit, {
        coverageCompareRef,
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

export function parsePostPrebuildArgs(argv) {
  return {
    coverageCompareRef: parseStringArg(argv, "--coverage-compare-ref", ""),
    pagesChanged: parseBooleanArg(argv, "--pages-changed", true),
    workerChanged: parseBooleanArg(argv, "--worker-changed", true),
  };
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runPostPrebuildValidation(parsePostPrebuildArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[validate:postbuild] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
