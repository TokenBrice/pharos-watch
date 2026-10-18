#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { selectCheckableArtifactIds } from "../lib/automation-registry.mjs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import {
  createExecutionUnit,
  createNpmScriptCommand,
  createSpawnCommand,
  runParallelExecutionUnits,
  runSpawnCommand,
  type CommandImplementation,
  type ExecutionResult,
  type NpmScriptCommand,
} from "../lib/command-runner.mts";
import { runGateLanes } from "../lib/gate-lanes.mts";
import {
  formatFailureTail,
  reportGateResult,
  type GateLaneReport,
  type GateReport,
  type OutputWriter,
} from "../lib/report-violations.mts";
import { hasTelegramLoadGuardImpact } from "../lib/telegram-load-guard.mts";
import { PATH_FAMILIES, enumerateDocReferences, matchesOwnershipGlob } from "../lib/doc-ownership-registry.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { PR_DOC_COMMANDS, type PrLaneCommandDefinition } from "../lib/pr-lanes.mts";
import { SENSITIVE_COPY_ROOTS } from "../ci/check-sensitive-page-copy.ts";

const ROOT_DEPENDENCY_PATHS = new Set(["package.json", "package-lock.json"]);
const REVIEWED_DEPENDENCY_AUDIT_PATHS: Record<string, true> = {
  "package.json": true,
  "package-lock.json": true,
  ".npmrc": true,
  "scripts/ci/verify-dependency-audit.ts": true,
  "scripts/ci/dependency-audit-exceptions.json": true,
};
const RESERVE_FIXTURE_PREFIX = "worker/src/cron/reserve-adapters/__tests__/fixtures/";
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
  manifestCommand?: PrLaneCommandDefinition;
}

export type PrStaticCheckGroup = "compile" | "guards";

const COMPILE_STATIC_CHECKS: Record<string, true> = {
  lint: true,
  "lint:changed": true,
  typecheck: true,
  "typecheck:worker": true,
};

const PARALLEL_STATIC_CHECKS = new Set([
  "typecheck",
  "typecheck:worker",
  "check:structural",
  "check:generated-artifacts",
]);

export const STRUCTURAL_CHECKS = [
  "check:provider-resilience",
  "check:fetch-body-timeouts",
  "check:runtime-reachability",
  "check:architecture-boundaries",
  "check:script-entrypoints",
  "check:cli-args-policy",
  "check:dependency-review-gaps",
  "check:editorial-content",
  "check:agent-skills",
] as const;

async function runStructuralChecks({
  runCommandImpl = runSpawnCommand,
  stdout = process.stdout,
}: Pick<PrStaticCheckOptions, "runCommandImpl" | "stdout"> = {}): Promise<number> {
  const log = (message: string) => stdout.write(`[check:structural] ${message}\n`);
  const result = await runParallelExecutionUnits(
    STRUCTURAL_CHECKS.map((name) => createExecutionUnit([createNpmScriptCommand(name)])),
    {
      continueOnError: true,
      maxParallel: 1,
      reporter: { start: (command) => log(command) },
      runCommandImpl,
    },
  );
  for (const outcome of result.results) {
    const command = outcome.unit.commands[0];
    log(`${command.scriptName}: ${outcome.status === 0 ? "passed" : formatNpmFailure(outcome)}`);
  }
  log(`${result.results.filter((outcome) => outcome.status === 0).length}/${STRUCTURAL_CHECKS.length} guards passed.`);
  return result.status === 0 ? 0 : 1;
}

function hasProductionStructuralImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => {
    const isStructuralPath =
      STRUCTURAL_CHECK_EXACT_PATHS.has(file) ||
      STRUCTURAL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix));
    return isStructuralPath && !STRUCTURAL_TEST_PATH_PATTERNS.some((pattern) => pattern.test(file));
  });
}

function formatNpmFailure(result: ExecutionResult): string {
  const name = result.failedCmd?.match(/^npm run (\S+)/)?.[1] ?? "unknown";
  return `npm run ${name} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`;
}

export function hasOwnedDocsImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => {
    if (file.startsWith("docs/") || file === "README.md" || file === "CLAUDE.md") return false;
    return PATH_FAMILIES.some(
      (family) => enumerateDocReferences(family, { includeBackground: false }).length > 0 &&
        family.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob)),
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
  { group }: { group?: PrStaticCheckGroup } = {},
) {
  const { classification, commands: baselineChecks } = selectPrBaselineChecks(changedFiles);
  const commands: PrStaticCheckCommand[] = [
    { name: changedFiles.some((file) => file === "eslint.config.mjs") ? "lint" : "lint:changed" },
    { name: "typecheck" },
    { name: "check:env-contract" },
    { name: "check:critical-coverage-completeness" },
  ];

  if (changedFiles.some((file) => ROOT_DEPENDENCY_PATHS.has(file))) {
    commands.push({ name: "audit:deps" });
  }

  if (changedFiles.some((file) => Object.hasOwn(REVIEWED_DEPENDENCY_AUDIT_PATHS, file))) {
    commands.push({ name: "check:dependency-audit" });
  }
  if (changedFiles.some((file) =>
    (file.startsWith(RESERVE_FIXTURE_PREFIX) && /\.(html|json|txt)$/.test(file)) ||
    file === "scripts/ci/check-html-fixture-age.ts" ||
    file === "scripts/maintenance/refresh-reserve-html-fixtures.ts"
  )) {
    commands.push({ name: "check:html-fixture-metadata" });
  }
  if (changedFiles.some((file) =>
    SENSITIVE_COPY_ROOTS.some((root) => file === root || file.startsWith(`${root}/`)) ||
    file === "scripts/ci/check-sensitive-page-copy.ts"
  )) {
    commands.push({ name: "check:sensitive-page-copy" });
  }
  commands.push(...baselineChecks);


  if (hasProductionStructuralImpact(changedFiles)) {
    commands.push({ name: "check:structural" });
  }


  // Select the complete plan first: grouping changes scheduling, not ownership.
  return {
    classification,
    commands: group
      ? commands.filter((command) => Boolean(COMPILE_STATIC_CHECKS[command.name]) === (group === "compile"))
      : commands,
  };
}

/** Shared selector inventory for PR and focused authoring checks; never includes structural guards. */
export function selectPrBaselineChecks(changedFiles: readonly string[]) {
  const classification = classifyChangedFiles(changedFiles);
  const commands: PrStaticCheckCommand[] = [];
  if (classification.docsChanged) {
    commands.push(...PR_DOC_COMMANDS.map((command) => ({
      name: command.args[0] === "run" ? command.args[1] : command.id,
      manifestCommand: command,
    })));
  } else if (hasOwnedDocsImpact(changedFiles)) {
    commands.push({ name: "check:doc-sync" });
  }

  if (classification.pagesChanged) {
    commands.push({ name: "check:site-csp-sync" }, { name: "check:stablecoin-data" });
  }
  const artifactIds = selectCheckableArtifactIds(selectChangedGeneratedArtifactIds(changedFiles));
  if (artifactIds.length > 0) {
    commands.push({ name: "check:generated-artifacts", args: [`--only=${artifactIds.join(",")}`] });
  }
  if (classification.workerChanged) {
    commands.push(
      { name: "typecheck:worker" },
      { name: "check:cron-connections" },
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

export function resolvePrDependencyAuditBase(
  env: NodeJS.ProcessEnv,
  head: string,
  execGit: (args: string[]) => string = (args) => execFileSync("git", args, { encoding: "utf8" }),
): string {
  if (env.PR_BASE_SHA) return env.PR_BASE_SHA;
  try {
    const baseSha = execGit(["merge-base", head, "origin/main"]).trim();
    if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error("merge-base did not return a commit SHA");
    return baseSha;
  } catch {
    throw new Error("Cannot resolve dependency-audit base; fetch origin/main or set the frozen PR_BASE_SHA.");
  }
}

/** Binds frozen refs into the static leaves that need them. Every runner that
 * expands the static plan (check:pr:static, check:pr) uses this one
 * owner, so a leaf cannot silently lose its range or audit base. */
export function prStaticLeafArgs(
  command: { name: string; args?: readonly string[] },
  refs: { base: string; head: string; auditBase?: () => string },
): string[] {
  if (command.name === "lint:changed") return [`--base=${refs.base}`, `--head=${refs.head}`];
  if (command.name === "check:dependency-audit") return [`--new-since=${refs.auditBase ? refs.auditBase() : refs.base}`];
  return [...(command.args ?? [])];
}

/** Preserve direct npm exec docs checks alongside npm-script static leaves. */
export function createPrStaticLeafCommand(command: PrStaticCheckCommand, args: readonly string[]): NpmScriptCommand {
  if (command.manifestCommand) {
    return { ...createSpawnCommand("npm", command.manifestCommand.args), scriptName: command.name };
  }
  return createNpmScriptCommand(command.name, args);
}

export async function runPrStaticChecks({
  argv = process.argv.slice(2),
  env = process.env,
  runCommandImpl = runSpawnCommand,
  stderr = process.stderr,
  stdout = process.stdout,
}: PrStaticCheckOptions = {}): Promise<number> {
  if (argv.includes("--structural")) {
    if (argv.length !== 1) throw new Error("--structural cannot be combined with other options.");
    return runStructuralChecks({ runCommandImpl, stdout });
  }
  const startedAt = Date.now();
  const { base, head, rest, staged } = parseChangedFileArgs(argv, env);
  if (staged) throw new Error("check:pr:static requires a --base/--head range; use check:focused --staged for index-selected checks.");
  const json = rest.includes("--json");
  const groupOption = rest.find((arg) => arg.startsWith("--group="));
  const groupValue = groupOption?.slice("--group=".length);
  if (groupValue !== undefined && groupValue !== "compile" && groupValue !== "guards") {
    throw new Error(`Unknown --group value: ${groupValue}. Expected compile or guards.`);
  }
  const group: PrStaticCheckGroup | undefined = groupValue;
  const unknownOptions = rest.filter((arg) => arg !== "--json" && arg !== groupOption);
  if (unknownOptions.length > 0) throw new Error(`Unknown option(s): ${unknownOptions.join(", ")}`);
  const changedFiles = collectChangedFiles({ base, head });
  const { classification, commands } = buildPrStaticCheckPlan(changedFiles, { group });
  const logOutput = json ? stderr : stdout;
  const log = (message: string) => logOutput.write(message + "\n");
  log(
    `[check:pr:static] ${changedFiles.length} changed file(s); ` +
      `pages=${classification.pagesChanged}, worker=${classification.workerChanged}` +
      `${group ? `, group=${group}` : ""}.`,
  );
  const runnableCommands = commands.map((command) => ({
    ...command,
    args: prStaticLeafArgs(command, { base, head, auditBase: () => resolvePrDependencyAuditBase(env, head) }),
  }));
  const { sequential, parallel } = partitionPrStaticCheckPlan(runnableCommands);
  const configuredParallel = Number.parseInt(env.PR_STATIC_MAX_PARALLEL ?? "3", 10);
  const maxParallel = Number.isFinite(configuredParallel) && configuredParallel > 0 ? configuredParallel : 3;
  const reporter = {
    start: (cmd: string) => log(`[check:pr:static] ${cmd}`),
  };
  const laneReports: GateLaneReport[] = runnableCommands.map((command) => ({
    id: command.name,
    command: createPrStaticLeafCommand(command, command.args ?? []).cmd,
    status: "skipped",
    durationMs: 0,
    failureTail: "",
  }));
  const laneIndexes = new WeakMap<NpmScriptCommand, number>();
  const createTrackedCommand = (command: PrStaticCheckCommand): NpmScriptCommand => {
    const index = runnableCommands.findIndex((candidate) => candidate === command);
    const npmCommand = createPrStaticLeafCommand(command, command.args ?? []);
    const trackedCommand = json ? { ...npmCommand, captureOutput: true } : npmCommand;
    laneIndexes.set(trackedCommand, index);
    return trackedCommand;
  };
  const sequentialCommands = sequential.map(createTrackedCommand);
  const parallelUnits = parallel.map((command) => createExecutionUnit([
    createTrackedCommand(command),
  ]));
  const runTrackedLanes = async (
    trackedCommands: readonly NpmScriptCommand[],
    signal: AbortSignal,
    reportStarts: boolean,
  ): Promise<ExecutionResult> => {
    let executionResult: ExecutionResult = { status: 0, failedCmd: null, aborted: false };
    const reports = await runGateLanes(trackedCommands, {
      command: (command) => command.cmd,
      failureTail: (result, command) => result.status === 0 || result.aborted
        ? ""
        : formatFailureTail(result.output ?? formatNpmFailure({ ...result, failedCmd: command.cmd })),
      id: (command) => command.scriptName,
      onResult: (result, command) => {
        if (result.status !== 0) executionResult = { ...result, failedCmd: command.cmd };
      },
      run: (command) => {
        if (signal.aborted) return { status: 130, aborted: true };
        if (reportStarts) reporter.start(command.cmd);
        return runCommandImpl(command, { ...env, PR_BASE_SHA: base, PR_HEAD_SHA: head } as Record<string, string>, { signal });
      },
      status: (result) => result.status === 0 ? "passed" : result.aborted ? "skipped" : "failed",
    });
    for (const [index, command] of trackedCommands.entries()) {
      const laneIndex = laneIndexes.get(command);
      if (laneIndex !== undefined) laneReports[laneIndex] = reports[index];
    }
    return executionResult;
  };
  const controller = new AbortController();
  const trackedRunner: CommandImplementation<NpmScriptCommand> = (command, _extraEnv, options) =>
    runTrackedLanes([command], options?.signal ?? controller.signal, false);
  const stopOnFailure = <T extends ExecutionResult>(promise: Promise<T>): Promise<T> => promise.then((result) => {
    if (result.status !== 0) controller.abort();
    return result;
  });
  const [sequentialResult, parallelResult] = await Promise.all([
    stopOnFailure(runTrackedLanes(sequentialCommands, controller.signal, true)),
    stopOnFailure(runParallelExecutionUnits(parallelUnits, {
      getCommandEnv: () => env as Record<string, string>,
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

runDirectCli(import.meta.url, () => runPrStaticChecks().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`[check:pr:static] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
));
