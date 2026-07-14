#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

/**
 * @typedef {Record<string, string | undefined>} PrepareWorkspaceEnv
 * @typedef {[string, string[]]} PrepareWorkspaceCommand
 * @typedef {{ env: PrepareWorkspaceEnv, stdio: "inherit" }} PrepareWorkspaceSpawnOptions
 * @typedef {{ status?: number | null, error?: Error }} PrepareWorkspaceCommandResult
 * @typedef {(command: string, args: string[], options: PrepareWorkspaceSpawnOptions) => PrepareWorkspaceCommandResult} PrepareWorkspaceRunCommand
 */

function isTruthy(value) {
  return value === "1" || String(value ?? "").toLowerCase() === "true";
}

/** @param {PrepareWorkspaceEnv} [env] */
export function isCiEnvironment(env = process.env) {
  return isTruthy(env.CI) || isTruthy(env.GITHUB_ACTIONS);
}

/**
 * @param {PrepareWorkspaceEnv} [env]
 * @returns {PrepareWorkspaceCommand[]}
 */
export function buildPrepareWorkspaceCommands(env = process.env) {
  /** @type {PrepareWorkspaceCommand[]} */
  const commands = [];
  const ci = isCiEnvironment(env);
  const forceBootstrap = isTruthy(env.PHAROS_PREPARE_BOOTSTRAP);
  const skipHooks = isTruthy(env.PHAROS_PREPARE_SKIP_GIT_HOOKS);

  if (!ci || forceBootstrap) {
    commands.push(["npm", ["run", "bootstrap:generated"]]);
  }

  if (!ci && !skipHooks) {
    commands.push(["git", ["config", "core.hooksPath", ".githooks"]]);
  }

  return commands;
}

/**
 * @param {{ env?: PrepareWorkspaceEnv, runCommand?: PrepareWorkspaceRunCommand }} [options]
 */
export function runPrepareWorkspace({ env = process.env, runCommand = spawnSync } = {}) {
  const commands = buildPrepareWorkspaceCommands(env);

  if (commands.length === 0) {
    console.log("[prepare] CI environment detected; skipping local bootstrap and git-hook setup.");
    console.log("[prepare] GitHub Actions runs bootstrap:generated explicitly through setup-workspace.");
    return { status: 0 };
  }

  for (const [command, args] of commands) {
    const result = runCommand(command, args, { env, stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      return { status: result.status ?? 1 };
    }
  }

  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = runPrepareWorkspace();
  process.exitCode = result.status;
}
