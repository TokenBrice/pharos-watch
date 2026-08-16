#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

type PrepareWorkspaceEnv = Record<string, string | undefined>;
type PrepareWorkspaceCommand = [string, string[]];
interface PrepareWorkspaceSpawnOptions {
  env: PrepareWorkspaceEnv;
  stdio: "inherit";
}
interface PrepareWorkspaceCommandResult {
  status?: number | null;
  error?: Error;
}
type PrepareWorkspaceRunCommand = (
  command: string,
  args: string[],
  options: PrepareWorkspaceSpawnOptions,
) => PrepareWorkspaceCommandResult;

interface RunPrepareWorkspaceOptions {
  env?: PrepareWorkspaceEnv;
  runCommand?: PrepareWorkspaceRunCommand;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || String(value ?? "").toLowerCase() === "true";
}

export function isCiEnvironment(env: PrepareWorkspaceEnv = process.env): boolean {
  return isTruthy(env.CI) || isTruthy(env.GITHUB_ACTIONS);
}

export function buildPrepareWorkspaceCommands(env: PrepareWorkspaceEnv = process.env): PrepareWorkspaceCommand[] {
  const commands: PrepareWorkspaceCommand[] = [];
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

export function runPrepareWorkspace({ env = process.env, runCommand = spawnSync }: RunPrepareWorkspaceOptions = {}): {
  status: number;
} {
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
