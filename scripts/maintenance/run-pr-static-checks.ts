#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { selectCheckableArtifactIds } from "../lib/automation-registry.mjs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import {
  createExecutionUnit,
  createNpmScriptCommand,
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
import { PATH_FAMILIES, matchesOwnershipGlob } from "../lib/doc-ownership-registry.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

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
}

export type PrStaticCheckGroup = "compile" | "guards";

const COMPILE_STATIC_CHECKS: Record<string, true> = {
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
  { skipDocSync = false, group }: { skipDocSync?: boolean; group?: PrStaticCheckGroup } = {},
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
  const artifactIds = selectCheckableArtifactIds(selectChangedGeneratedArtifactIds(changedFiles));
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

  // Select the complete plan first: grouping changes scheduling, not ownership.
  return {
    classification,
    commands: group
      ? commands.filter((command) => Boolean(COMPILE_STATIC_CHECKS[command.name]) === (group === "compile"))
      : commands,
  };
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
 * expands the static plan (check:pr:static, check:pr, --ci-parity) uses this one
 * owner, so a leaf cannot silently lose its range or audit base. */
export function prStaticLeafArgs(
  command: { name: string; args?: readonly string[] },
  refs: { base: string; head: string; auditBase?: () => string },
): string[] {
  if (command.name === "lint:changed") return [`--base=${refs.base}`, `--head=${refs.head}`];
  if (command.name === "check:dependency-audit") return [`--new-since=${refs.auditBase ? refs.auditBase() : refs.base}`];
  return [...(command.args ?? [])];
}

export async function runPrStaticChecks({
  argv = process.argv.slice(2),
  env = process.env,
  runCommandImpl = runSpawnCommand,
  stderr = process.stderr,
  stdout = process.stdout,
}: PrStaticCheckOptions = {}): Promise<number> {
  const startedAt = Date.now();
  const { base, head, rest, staged } = parseChangedFileArgs(argv, env);
  if (staged) throw new Error("check:pr:static requires a --base/--head range; use check:focused --staged for index-selected checks.");
  const json = rest.includes("--json");
  const skipDocSync = rest.includes("--skip-doc-sync");
  const groupOption = rest.find((arg) => arg.startsWith("--group="));
  const groupValue = groupOption?.slice("--group=".length);
  if (groupValue !== undefined && groupValue !== "compile" && groupValue !== "guards") {
    throw new Error(`Unknown --group value: ${groupValue}. Expected compile or guards.`);
  }
  const group: PrStaticCheckGroup | undefined = groupValue;
  const unknownOptions = rest.filter((arg) => arg !== "--json" && arg !== "--skip-doc-sync" && arg !== groupOption);
  if (unknownOptions.length > 0) throw new Error(`Unknown option(s): ${unknownOptions.join(", ")}`);
  const changedFiles = collectChangedFiles({ base, head });
  const { classification, commands } = buildPrStaticCheckPlan(changedFiles, { skipDocSync, group });
  const logOutput = json ? stderr : stdout;
  const log = (message: string) => logOutput.write(message + "\n");
  log(
    `[check:pr:static] ${changedFiles.length} changed file(s); ` +
      `pages=${classification.pagesChanged}, worker=${classification.workerChanged}` +
      `${group ? `, group=${group}` : ""}` +
      `${skipDocSync ? ", doc-sync owned by the docs lane" : ""}.`,
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
        return runCommandImpl(command, env as Record<string, string>, { signal });
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
