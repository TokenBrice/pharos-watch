#!/usr/bin/env node

import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import {
  createExecutionUnit,
  createNpmScriptCommand,
  runExecutionUnit,
  runParallelExecutionUnits,
  runSpawnCommand,
  type ExecutionResult,
  type NpmScriptCommand,
} from "../lib/command-runner.mts";
import { hasTelegramLoadGuardImpact } from "../lib/telegram-load-guard.mts";
import {
  EDITORIAL_POLICY_TEST_COMMAND,
  hasEditorialPolicyImpact,
} from "../lib/editorial-surface-registry";

const ROOT_DEPENDENCY_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_EXACT_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_PREFIXES = [".github/", "functions/", "scripts/", "shared/", "src/", "worker/"];

interface PrStaticCheckOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

interface PrStaticCheckCommand {
  name: string;
  args?: string[];
}

const PARALLEL_STATIC_CHECKS = new Set([
  "typecheck",
  "typecheck:worker",
  "check:structural",
  "check:generated-artifacts",
]);

function hasStructuralCheckImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some(
    (file) =>
      STRUCTURAL_CHECK_EXACT_PATHS.has(file) ||
      STRUCTURAL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function partitionPrStaticCheckPlan(commands: readonly PrStaticCheckCommand[]) {
  return {
    sequential: commands.filter((command) => !PARALLEL_STATIC_CHECKS.has(command.name)),
    parallel: commands.filter((command) => PARALLEL_STATIC_CHECKS.has(command.name)),
  };
}

function formatNpmFailure(result: ExecutionResult): string {
  const name = result.failedCmd?.match(/^npm run (\S+)/)?.[1] ?? "unknown";
  return `npm run ${name} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`;
}

export function buildPrStaticCheckPlan(changedFiles: readonly string[]) {
  const classification = classifyChangedFiles(changedFiles);
  const commands: PrStaticCheckCommand[] = [
    { name: "lint:changed" },
    { name: "check:table-primitives" },
    { name: "typecheck" },
    { name: "check:env-contract" },
    { name: "check:shared-types-imports" },
    { name: "check:critical-coverage-completeness" },
  ];

  if (changedFiles.some((file) => ROOT_DEPENDENCY_PATHS.has(file))) {
    commands.push({ name: "audit:deps" });
  }

  if (hasStructuralCheckImpact(changedFiles)) {
    commands.push({ name: "check:structural" });
  }
  if (hasEditorialPolicyImpact(changedFiles)) {
    commands.push({
      name: EDITORIAL_POLICY_TEST_COMMAND.name,
      args: [...EDITORIAL_POLICY_TEST_COMMAND.args],
    });
  }

  if (classification.pagesChanged) {
    commands.push(
      { name: "check:client-registry-imports" },
      { name: "check:site-csp-sync" },
      { name: "check:stablecoin-data" },
    );
  }

  // A generated artifact must be regenerated in the same commit as the source
  // it is derived from, whatever lane that source lives in. This selection used
  // to sit inside the `pagesChanged` branch, so a commit that only touched
  // `shared/lib/safety-score-v9/**` or `worker/src/lib/safety-score-v9*.ts`
  // could leave the V9 evaluation-build manifest stale and still pass the PR
  // gate — the Wave-1 fix wave did exactly that, and only the release discovery
  // gate caught it.
  const artifactIds = selectChangedGeneratedArtifactIds(changedFiles);
  if (artifactIds.length > 0) {
    commands.push({ name: "check:generated-artifacts", args: [`--only=${artifactIds.join(",")}`] });
  }

  if (classification.workerChanged) {
    commands.push(
      { name: "typecheck:worker" },
      { name: "check:cron-connections" },
      { name: "check:cron-sync" },
      { name: "check:migrations" },
      { name: "check:sql-safety" },
      { name: "check:worker-config" },
      { name: "check:worker-package" },
    );
  }

  if (hasTelegramLoadGuardImpact(changedFiles)) {
    commands.push({ name: "check:telegram-load" });
  }

  return { classification, commands };
}

export async function runPrStaticChecks({
  argv = process.argv.slice(2),
  env = process.env,
}: PrStaticCheckOptions = {}): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  if (rest.length > 0) throw new Error(`Unknown option(s): ${rest.join(", ")}`);
  const changedFiles = collectChangedFiles({ base, head });
  const { classification, commands } = buildPrStaticCheckPlan(changedFiles);

  console.log(
    `[check:pr:static] ${changedFiles.length} changed file(s); ` +
      `pages=${classification.pagesChanged}, worker=${classification.workerChanged}.`,
  );
  const runnableCommands = commands.map((command) => ({
    ...command,
    args:
      command.name === "lint:changed"
        ? [`--base=${base}`, `--head=${head}`]
        : (command.args ?? []),
  }));
  const { sequential, parallel } = partitionPrStaticCheckPlan(runnableCommands);
  const configuredParallel = Number.parseInt(env.PR_STATIC_MAX_PARALLEL ?? "3", 10);
  const maxParallel = Number.isFinite(configuredParallel) && configuredParallel > 0 ? configuredParallel : 3;
  const reporter = {
    start: (cmd: string) => console.log(`[check:pr:static] ${cmd}`),
  };
  const getCommandEnv = () => env as Record<string, string>;
  const sequentialUnit = createExecutionUnit(
    sequential.map((command) => createNpmScriptCommand(command.name, command.args ?? [])),
  );
  const parallelUnits = parallel.map((command) => createExecutionUnit([
    createNpmScriptCommand(command.name, command.args ?? []),
  ]));
  const controller = new AbortController();
  const stopOnFailure = <T extends ExecutionResult>(promise: Promise<T>): Promise<T> => promise.then((result) => {
    if (result.status !== 0) controller.abort();
    return result;
  });
  const [sequentialResult, parallelResult] = await Promise.all([
    stopOnFailure(runExecutionUnit<NpmScriptCommand>(sequentialUnit, {
      getCommandEnv,
      reporter,
      runCommandImpl: runSpawnCommand,
      signal: controller.signal,
    })),
    stopOnFailure(runParallelExecutionUnits(parallelUnits, {
      getCommandEnv,
      maxParallel,
      reporter,
      runCommandImpl: runSpawnCommand,
      signal: controller.signal,
    })),
  ]);
  const failure = [sequentialResult, parallelResult].find((result) => result.status !== 0 && !result.aborted);
  if (failure) throw new Error(formatNpmFailure(failure));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrStaticChecks()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[check:pr:static] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
