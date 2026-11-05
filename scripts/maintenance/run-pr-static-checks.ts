#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
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
import { PATH_FAMILIES, enumerateDocReferences, matchesOwnershipGlob } from "../lib/doc-ownership-registry.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { PR_DOC_COMMANDS, type PrLaneCommandDefinition } from "../lib/pr-lanes.mts";
import { SENSITIVE_COPY_ROOTS } from "../ci/check-sensitive-page-copy.ts";
import { isHomepageCopyPath } from "../ci/check-homepage-health-copy.ts";

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
const DEFAULT_STRUCTURAL_CONCURRENCY = 3;
// Config, dependency and generated inputs can change what `tsconfig.typecheck.json`
// resolves even when no changed source file is part of its current program.
const ROOT_TYPECHECK_WIDENED_TRIGGERS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^next\.config\.[^/]+$/,
  /\.d\.ts$/,
  /^src\/generated\//,
];
const ROOT_TYPECHECK_SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ROOT_TYPECHECK_SOURCE_ROOTS = /^(?:src|shared|functions|scripts)\//;
const ROOT_TYPECHECK_EXCLUDED_PATH =
  /(^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.test\.tsx?$|^(?:worker|node_modules|coverage|out|worktrees|\.worktrees)\//;

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
  "check:unused-code",
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

function resolveStructuralConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PHAROS_STRUCTURAL_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_STRUCTURAL_CONCURRENCY;
  return Math.min(configured, STRUCTURAL_CHECKS.length);
}

interface RootTypecheckSources {
  /** Files the config's `include`/`exclude` selection names. */
  included: ReadonlySet<string>;
  /** Memoized program membership; null when the program cannot be built. */
  programFiles: () => ReadonlySet<string> | null;
}

const rootTypecheckSourceCache = new Map<string, RootTypecheckSources | null>();

/** The include set is not the program `tsc -p tsconfig.typecheck.json` compiles:
 * `allowJs` adds imported `.js`/`.mjs` modules the include globs never match, and
 * module resolution adds the files they import. Selection must test the program,
 * so it is built lazily — once per process, only when a changed file is not
 * already known to belong. */
function rootTypecheckSources(cwd: string): RootTypecheckSources | null {
  if (rootTypecheckSourceCache.has(cwd)) return rootTypecheckSourceCache.get(cwd) ?? null;
  let sources: RootTypecheckSources | null = null;
  try {
    const configPath = resolve(cwd, "tsconfig.typecheck.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd, undefined, configPath);
      if (parsed.errors.length === 0) {
        const rootNames = [...parsed.fileNames];
        let programFiles: ReadonlySet<string> | null | undefined;
        sources = {
          included: new Set(rootNames.map((file) => resolve(file))),
          programFiles: () => {
            if (programFiles === undefined) {
              try {
                const program = ts.createProgram(rootNames, parsed.options);
                programFiles = new Set(program.getSourceFiles().map((sourceFile) => resolve(sourceFile.fileName)));
              } catch {
                programFiles = null;
              }
            }
            return programFiles;
          },
        };
      }
    }
  } catch {
    sources = null;
  }
  rootTypecheckSourceCache.set(cwd, sources);
  return sources;
}

/** Root typing is skipped only for a known-irrelevant change set; a missing or
 * unreadable config, a typed source the program cannot classify (a deleted file,
 * or a JS/TS module under the typed roots the program never reaches) and every
 * config/dependency/generated input keep today's run. */
function selectsRootTypecheck(changedFiles: readonly string[], cwd = process.cwd()): boolean {
  if (changedFiles.some((file) => ROOT_TYPECHECK_WIDENED_TRIGGERS.some((pattern) => pattern.test(file)))) {
    return true;
  }
  const sources = rootTypecheckSources(cwd);
  if (sources === null) return true;
  const needsProgram: string[] = [];
  for (const file of changedFiles) {
    const absolute = resolve(cwd, file);
    if (sources.included.has(absolute)) return true;
    if (!ROOT_TYPECHECK_SOURCE_ROOTS.test(file) || !ROOT_TYPECHECK_SOURCE_EXTENSIONS.test(file)) continue;
    if (ROOT_TYPECHECK_EXCLUDED_PATH.test(file)) continue;
    // A deleted typed source belongs to no program; keep today's run rather
    // than treating it as untyped.
    if (!existsSync(absolute)) return true;
    needsProgram.push(file);
  }
  if (needsProgram.length === 0) return false;
  const programFiles = sources.programFiles();
  if (programFiles === null) return true;
  return needsProgram.some((file) => programFiles.has(resolve(cwd, file)));
}

async function runStructuralChecks({
  env = process.env,
  runCommandImpl = runSpawnCommand,
  stdout = process.stdout,
}: Pick<PrStaticCheckOptions, "env" | "runCommandImpl" | "stdout"> = {}): Promise<number> {
  const log = (message: string) => stdout.write(`[check:structural] ${message}\n`);
  const result = await runParallelExecutionUnits(
    STRUCTURAL_CHECKS.map((name) => createExecutionUnit([createNpmScriptCommand(name)])),
    {
      continueOnError: true,
      maxParallel: resolveStructuralConcurrency(env),
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
  { cwd = process.cwd(), group }: { cwd?: string; group?: PrStaticCheckGroup } = {},
) {
  const { classification, commands: baselineChecks } = selectPrBaselineChecks(changedFiles);
  const commands: PrStaticCheckCommand[] = [
    { name: changedFiles.some((file) => file === "eslint.config.mjs") ? "lint" : "lint:changed" },
  ];
  if (selectsRootTypecheck(changedFiles, cwd)) commands.push({ name: "typecheck" });
  commands.push(
    { name: "check:env-contract" },
    { name: "check:critical-coverage-completeness" },
  );

  // Both audits stay: `audit:deps` reports any pre-existing production
  // high/critical finding, while the reviewed delta only rejects new
  // production+dev pairs since the frozen base. Neither covers the other.
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
  if (changedFiles.some(isHomepageCopyPath)) {
    commands.push({ name: "check:homepage-health-copy" });
  }
  commands.push(...baselineChecks);


  if (hasProductionStructuralImpact(changedFiles)) {
    commands.push({ name: "check:structural" }, { name: "check:unused-code" });
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
    commands.push({ name: "check:generated-artifacts", args: [
      `--only=${artifactIds.join(",")}`,
      ...(artifactIds.includes("public-datasets") ? ["--integrity-only"] : []),
    ] });
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
    return runStructuralChecks({ env, runCommandImpl, stdout });
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
