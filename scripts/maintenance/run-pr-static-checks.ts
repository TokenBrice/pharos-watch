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
  type CommandImplementation,
  type CommandResult,
  type ExecutionResult,
  type NpmScriptCommand,
} from "../lib/command-runner.mts";
import {
  formatFailureTail,
  reportGateResult,
  type GateLaneReport,
  type GateReport,
  type OutputWriter,
} from "../lib/report-violations.mts";
import { hasTelegramLoadGuardImpact } from "../lib/telegram-load-guard.mts";
import { PATH_FAMILIES, matchesOwnershipGlob } from "../lib/doc-ownership-registry.mts";

const ROOT_DEPENDENCY_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_EXACT_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_PREFIXES = [".github/", "functions/", "scripts/", "shared/", "src/", "worker/"];
const STRUCTURAL_TEST_PATH_PATTERNS = [
  /(^|\/)__tests__(?:\/|$)/,
  /\.test\.tsx?$/,
  /(^|\/)test-utils(?:\/|$)/,
  /(^|\/)test-helpers(?:\/|$)/,
  /(^|\/)__mocks__(?:\/|$)/,
  /(^|\/)fixtures(?:\/|$)/,
];

interface PrStaticCheckOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  runCommandImpl?: CommandImplementation<NpmScriptCommand>;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
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

type StructuralCheckImpact = "none" | "test-only" | "production";

function getStructuralCheckImpact(changedFiles: readonly string[]): StructuralCheckImpact {
  let hasTestImpact = false;
  for (const file of changedFiles) {
    const isStructuralPath =
      STRUCTURAL_CHECK_EXACT_PATHS.has(file) ||
      STRUCTURAL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix));
    if (!isStructuralPath) continue;
    if (!STRUCTURAL_TEST_PATH_PATTERNS.some((pattern) => pattern.test(file))) return "production";
    hasTestImpact = true;
  }
  return hasTestImpact ? "test-only" : "none";
}

function formatNpmFailure(result: ExecutionResult): string {
  const name = result.failedCmd?.match(/^npm run (\S+)/)?.[1] ?? "unknown";
  return `npm run ${name} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`;
}

export function hasOwnedDocsImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => {
    if (file.startsWith("docs/") || file === "README.md" || file === "CLAUDE.md") return false;
    return PATH_FAMILIES.some(
      (family) => family.docs.length > 0 && family.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob)),
    );
  });
}

export function partitionPrStaticCheckPlan(commands: readonly PrStaticCheckCommand[]) {
  return {
    sequential: commands.filter((command) => !PARALLEL_STATIC_CHECKS.has(command.name)),
    parallel: commands.filter((command) => PARALLEL_STATIC_CHECKS.has(command.name)),
  };
}


export function buildPrStaticCheckPlan(
  changedFiles: readonly string[],
  { skipDocSync = false }: { skipDocSync?: boolean } = {},
) {
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

  // `skipDocSync` is the composition-context option passed by `check:pr` and
  // the CI matrix when the docs lane already owns `check:doc-sync` in the same
  // plan; standalone runs never set it, so source-owned docs stay validated.
  if (!skipDocSync && hasOwnedDocsImpact(changedFiles)) {
    commands.push({ name: "check:doc-sync" });
  }

  switch (getStructuralCheckImpact(changedFiles)) {
    case "production":
      commands.push({ name: "check:structural" });
      break;
    case "test-only":
      commands.push({ name: "check:clone-ratchet" }, { name: "check:cron-console-usage" });
      break;
  }

  if (classification.pagesChanged) {
    commands.push({ name: "check:site-csp-sync" }, { name: "check:stablecoin-data" });
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
  runCommandImpl = runSpawnCommand,
  stderr = process.stderr,
  stdout = process.stdout,
}: PrStaticCheckOptions = {}): Promise<number> {
  const startedAt = Date.now();
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const json = rest.includes("--json");
  const skipDocSync = rest.includes("--skip-doc-sync");
  const unknownOptions = rest.filter((arg) => arg !== "--json" && arg !== "--skip-doc-sync");
  if (unknownOptions.length > 0) throw new Error(`Unknown option(s): ${unknownOptions.join(", ")}`);
  const changedFiles = collectChangedFiles({ base, head });
  const { classification, commands } = buildPrStaticCheckPlan(changedFiles, { skipDocSync });
  const logOutput = json ? stderr : stdout;
  const log = (message: string) => logOutput.write(message + "\n");
  log(
    `[check:pr:static] ${changedFiles.length} changed file(s); ` +
      `pages=${classification.pagesChanged}, worker=${classification.workerChanged}` +
      `${skipDocSync ? ", doc-sync owned by the docs lane" : ""}.`,
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
    start: (cmd: string) => log(`[check:pr:static] ${cmd}`),
  };
  const laneReports: GateLaneReport[] = runnableCommands.map((command) => ({
    id: command.name,
    command: createNpmScriptCommand(command.name, command.args ?? []).cmd,
    status: "skipped",
    durationMs: 0,
    failureTail: "",
  }));
  const laneIndexes = new WeakMap<NpmScriptCommand, number>();
  const createTrackedCommand = (command: PrStaticCheckCommand): NpmScriptCommand => {
    const index = runnableCommands.findIndex((candidate) => candidate === command);
    const npmCommand = createNpmScriptCommand(command.name, command.args ?? []);
    const trackedCommand = json ? { ...npmCommand, captureOutput: true } : npmCommand;
    laneIndexes.set(trackedCommand, index);
    return trackedCommand;
  };
  const sequentialUnit = createExecutionUnit(
    sequential.map((command) => createTrackedCommand(command)),
  );
  const parallelUnits = parallel.map((command) => createExecutionUnit([
    createTrackedCommand(command),
  ]));
  const trackedRunner: CommandImplementation<NpmScriptCommand> = async (command, extraEnv, options) => {
    const index = laneIndexes.get(command);
    const commandStartedAt = Date.now();
    let rawResult: number | CommandResult;
    try {
      rawResult = await runCommandImpl(command, extraEnv, options);
    } catch (error) {
      rawResult = {
        status: 1,
        aborted: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    const result = typeof rawResult === "number" ? { status: rawResult, aborted: false } : rawResult;
    if (index !== undefined) {
      laneReports[index] = {
        ...laneReports[index],
        durationMs: Math.max(0, Date.now() - commandStartedAt),
        failureTail: result.status === 0 || result.aborted
          ? ""
          : formatFailureTail(result.output ?? formatNpmFailure({ ...result, failedCmd: command.cmd })),
        status: result.status === 0 ? "passed" : result.aborted ? "skipped" : "failed",
      };
    }
    return result;
  };
  const getCommandEnv = () => env as Record<string, string>;
  const controller = new AbortController();
  const stopOnFailure = <T extends ExecutionResult>(promise: Promise<T>): Promise<T> => promise.then((result) => {
    if (result.status !== 0) controller.abort();
    return result;
  });
  const [sequentialResult, parallelResult] = await Promise.all([
    stopOnFailure(runExecutionUnit<NpmScriptCommand>(sequentialUnit, {
      getCommandEnv,
      reporter,
      runCommandImpl: trackedRunner,
      signal: controller.signal,
    })),
    stopOnFailure(runParallelExecutionUnits(parallelUnits, {
      getCommandEnv,
      maxParallel,
      reporter,
      runCommandImpl: trackedRunner,
      signal: controller.signal,
    })),
  ]);
  const failed = laneReports.some((lane) => lane.status === "failed") ||
    [sequentialResult, parallelResult].some((result) => result.status !== 0 && !result.aborted);
  const report: GateReport<typeof classification> = {
    base,
    head,
    changedFiles,
    classification,
    lanes: laneReports,
    status: failed ? "failed" : "passed",
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  const failure = [sequentialResult, parallelResult].find(
    (result) => result.status !== 0 && !result.aborted,
  );
  if (!json && failure) throw new Error(formatNpmFailure(failure));
  reportGateResult(report, { json, label: "check:pr:static", stderr, stdout });
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrStaticChecks()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[check:pr:static] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
