#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import {
  createExecutionUnit,
  runParallelExecutionUnits,
  runShellCommand,
} from "../lib/command-runner.mjs";
import { buildDiscoveryPlan, DISCOVERY_TARGETS } from "../lib/discovery-gate.mjs";
import {
  captureDiscoverySnapshot,
  collectDiscoveryChangedFiles,
  collectDiscoveryEnvironment,
  compareDiscoverySnapshots,
  hashDiscoveryValue,
} from "../lib/discovery-evidence.mjs";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validation-lanes.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  fetchBaseRef,
  getCommandEnv,
  getValidatePrebuildSkipCommands,
} from "./test-merge-gate.mjs";

const DEFAULT_REPORT_PATH = ".cache/merge-gate/discovery/latest.json";
const DISCOVERY_IMPLEMENTATION_PATHS = [
  ".github/workflows/pull-request-checks.yml",
  ".github/workflows/validate-ci.yml",
  "package.json",
  "scripts/ci/run-gitleaks.mjs",
  "scripts/lib/automation-registry.mjs",
  "scripts/lib/command-runner.mjs",
  "scripts/lib/discovery-evidence.mjs",
  "scripts/lib/discovery-gate.mjs",
  "scripts/lib/validation-lanes.mjs",
  "scripts/maintenance/run-merge-gate-discovery.mjs",
];

function findPlanItem(plan, cmd) {
  return plan.find((item) => item.cmd === cmd);
}

function takePlanItem(plan, matched, cmd) {
  const item = findPlanItem(plan, cmd);
  if (item) matched.add(item);
  return item;
}

export function resolveDiscoveryMaxParallel(env = process.env, availableCores = os.availableParallelism()) {
  const explicit = Number.parseInt(env.MERGE_GATE_DISCOVERY_MAX_PARALLEL ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(1, Math.min(3, availableCores - 2));
}

// Compatibility helper for code/tests that inspect the legacy top-level plan.
// The dependency-aware executor below uses atomic descriptors instead.
export function buildDiscoveryExecutionGroups(plan, { includeSmoke = false } = {}) {
  const matched = new Set();
  const prebuildUnits = COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => takePlanItem(plan, matched, cmd))
    .filter(Boolean)
    .map((item) => createExecutionUnit([item]));
  const postValidateUnits = [];
  const pagesCommands = PAGES_VALIDATE_COMMANDS.map((cmd) => takePlanItem(plan, matched, cmd)).filter(Boolean);
  if (pagesCommands.length > 0) postValidateUnits.push(createExecutionUnit(pagesCommands));
  for (const cmd of [...COMMON_VALIDATE_POSTBUILD_COMMANDS, ...WORKER_VALIDATE_COMMANDS]) {
    const item = takePlanItem(plan, matched, cmd);
    if (item) postValidateUnits.push(createExecutionUnit([item]));
  }
  const smokeUnits = [];
  for (const cmd of [...PAGES_SMOKE_VALIDATE_COMMANDS, ...WORKER_SMOKE_VALIDATE_COMMANDS]) {
    const item = takePlanItem(plan, matched, cmd);
    if (item && includeSmoke) smokeUnits.push(createExecutionUnit([item]));
  }
  for (const item of plan) {
    if (!matched.has(item)) postValidateUnits.push(createExecutionUnit([item]));
  }
  return { postValidateUnits, prebuildUnits, smokeUnits };
}

export function getDiscoveryCommandEnv(command, changedFiles, env = process.env, options = {}) {
  const cmd = typeof command === "string" ? command : command.cmd ?? command.command;
  const commandEnv = getCommandEnv(cmd, changedFiles, env);
  if (cmd === "npm run validate:prebuild") {
    const discoveryEnv = {
      ...commandEnv,
      [VALIDATE_PREBUILD_SURFACE_ENV]: commandEnv[VALIDATE_PREBUILD_SURFACE_ENV] ?? "full",
      ...(env[VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV] === "1" && commandEnv[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]
        ? { [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: commandEnv[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV] }
        : {}),
      GENERATED_ARTIFACTS_CONTINUE_ON_ERROR: "1",
      VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
    };
    if (env[VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV] !== "1") {
      delete discoveryEnv[VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV];
      delete discoveryEnv[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV];
    }
    return discoveryEnv;
  }
  if (cmd === "npm run check:gitleaks-range" || cmd === "npm run check:gitleaks-worktree") {
    return {
      ...commandEnv,
      GITLEAKS_BASE_REF: options.baseRef ?? "origin/main",
      ...(options.forceFullDeploy ? { GITLEAKS_FULL_HISTORY: "1" } : {}),
      GITLEAKS_HEAD_REF: options.headRef ?? "HEAD",
    };
  }
  return commandEnv;
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

export function parseDiscoveryOptions(argv = [], env = process.env) {
  const options = {
    baseRef: env.MERGE_GATE_BASE_REF ?? "origin/main",
    baseRefOverridden: Boolean(env.MERGE_GATE_BASE_REF),
    dryRun: env.MERGE_GATE_DRY_RUN === "1",
    forceFullDeploy: env.MERGE_GATE_FULL_DEPLOY === "1",
    headRef: env.MERGE_GATE_HEAD_REF ?? "HEAD",
    help: false,
    includeSmoke: env.MERGE_GATE_DISCOVERY_SMOKE === "1",
    includeWorkerSmoke: env.MERGE_GATE_WORKER_SMOKE === "1",
    reportPath: env.MERGE_GATE_DISCOVERY_REPORT ?? DEFAULT_REPORT_PATH,
    resumePath: null,
    skipFetch: env.MERGE_GATE_NO_FETCH === "1",
    stagedMode: false,
    target: env.MERGE_GATE_DISCOVERY_TARGET ?? "pr",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--staged") options.stagedMode = true;
    else if (arg === "--smoke") options.includeSmoke = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--target") options.target = valueAfter(argv, index++, arg);
    else if (arg.startsWith("--target=")) options.target = arg.slice("--target=".length);
    else if (arg === "--report") options.reportPath = valueAfter(argv, index++, arg);
    else if (arg.startsWith("--report=")) options.reportPath = arg.slice("--report=".length);
    else if (arg === "--resume") options.resumePath = DEFAULT_REPORT_PATH;
    else if (arg.startsWith("--resume=")) options.resumePath = arg.slice("--resume=".length) || DEFAULT_REPORT_PATH;
    else throw new Error(`Unknown discovery option: ${arg}`);
  }

  if (!DISCOVERY_TARGETS.includes(options.target)) {
    throw new Error(`Unknown discovery target: ${options.target}. Expected one of ${DISCOVERY_TARGETS.join(", ")}`);
  }
  return options;
}

export function printDiscoveryHelp(log = console.log) {
  log(`Usage: npm run test:merge-gate:discover -- [options]

Dependency-aware diagnostic runner. It never writes a reusable release receipt.

Options:
  --target=<target>  pr (default), local-gate, release, or maintenance.
  --staged           Classify only staged files; default classification unions committed and dirty inputs.
  --smoke            Add smoke checks outside targets that select them by default.
  --resume[=<path>]  Re-run failed, blocked, and tainted nodes from a prior diagnostic report.
  --report=<path>    Override the latest JSON report path.
  --dry-run          Print and persist the resolved plan without running commands.
  --help             Show this help.

Environment:
  MERGE_GATE_BASE_REF=<ref>                 Compare base (default origin/main).
  MERGE_GATE_HEAD_REF=<ref>                 Compare head (default HEAD).
  MERGE_GATE_FULL_DEPLOY=1                  Force full Pages and Worker classification.
  MERGE_GATE_DISCOVERY_MAX_PARALLEL=<n>     Cap independent postbuild fan-out.
  MERGE_GATE_PRODUCTION_ENV=1               Confirm release public configuration was loaded.`);
}

function terminalStatusFromDependency(result) {
  return ["failed", "blocked", "incomplete"].includes(result?.status);
}

/**
 * @param {{
 *   changedFiles: string[],
 *   descriptors: any[],
 *   env: NodeJS.ProcessEnv,
 *   maxParallel: number,
 *   options: Record<string, any>,
 *   runCommandImpl: (command: string, extraEnv?: Record<string, string>, options?: Record<string, any>) => any,
 * }} options
 * @returns {Promise<any[]>}
 */
export async function executeDiscoveryGraph({
  changedFiles,
  descriptors,
  env,
  maxParallel,
  options,
  runCommandImpl,
} = {}) {
  const resultById = new Map();
  const phases = [...new Set(descriptors.map((descriptor) => descriptor.phase))].sort((left, right) => left - right);

  for (const phase of phases) {
    const phaseDescriptors = descriptors.filter((descriptor) => descriptor.phase === phase);
    const runnable = [];
    for (const descriptor of phaseDescriptors) {
      const dependencyResults = descriptor.dependsOn.map((id) => resultById.get(id)).filter(Boolean);
      const failedDependencies = dependencyResults.filter(terminalStatusFromDependency);
      const taintedBy = [
        ...new Set([
          ...failedDependencies.flatMap((result) => [result.id, ...(result.taintedBy ?? [])]),
          ...dependencyResults
            .filter((result) => result.status === "tainted")
            .flatMap((result) => result.taintedBy ?? []),
        ]),
      ].sort();
      if (failedDependencies.length > 0 && descriptor.failedDependencyPolicy === "block") {
        resultById.set(descriptor.id, {
          ...descriptor,
          durationMs: 0,
          exitCode: null,
          reason: `Blocked by ${taintedBy.join(", ")}`,
          status: "blocked",
          taintedBy,
        });
        continue;
      }
      runnable.push(createExecutionUnit([descriptor.command], { descriptor, id: descriptor.id, taintedBy }));
    }

    if (runnable.length === 0) continue;
    const phaseMaxParallel = phase === 10 ? Math.max(maxParallel, 8) : phase >= 20 && phase < 30 ? 4 : maxParallel;
    const execution = await runParallelExecutionUnits(runnable, {
      continueOnError: true,
      getCommandEnv: (command) => getDiscoveryCommandEnv(command, changedFiles, env, options),
      label: `merge-gate:discover/phase-${phase}`,
      maxParallel: phaseMaxParallel,
      runCommandImpl,
    });
    for (const unitResult of execution.results) {
      const descriptor = unitResult.unit.descriptor;
      const taintedBy = unitResult.unit.taintedBy;
      resultById.set(descriptor.id, {
        ...descriptor,
        durationMs: unitResult.durationMs,
        exitCode: unitResult.status,
        status: unitResult.status === 0 ? (taintedBy.length > 0 ? "tainted" : "passed") : "failed",
        taintedBy,
      });
    }
  }

  return descriptors.map((descriptor) => resultById.get(descriptor.id)).filter(Boolean);
}

function buildEnvironmentResults(environment, plan, options, snapshot) {
  const results = [];
  const add = (id, passed, reason, blocking = true) =>
    results.push({
      blocking,
      command: null,
      dependsOn: [],
      durationMs: 0,
      exitCode: null,
      id,
      lane: "environment",
      order: -100 + results.length,
      phase: -1,
      reason,
      rerun: null,
      status: passed ? "passed" : "incomplete",
      taintedBy: [],
    });

  add(
    "environment:node",
    environment.node.exactMatch,
    `Expected Node ${environment.node.expected}; running ${environment.node.actual}`,
    options.target !== "local-gate",
  );
  add(
    "environment:install-snapshot",
    environment.install.consistentWithLockfile,
    "Installed package snapshot must be content-consistent with package-lock.json",
  );
  add(
    "environment:bootstrap-outputs",
    environment.bootstrap.cleanInstallEquivalent,
    "Bootstrap outputs must be present on a content-consistent install; freshness is checked by generated nodes",
  );
  if (plan.selected.some((descriptor) => descriptor.id.startsWith("generated:"))) {
    add("environment:playwright-firefox", environment.browsers.firefox, "Firefox is required by browser-backed artifact checks");
  }
  if (plan.selected.some((descriptor) => descriptor.id === "pages:smoke" || descriptor.command === "npm run test:a11y")) {
    add("environment:playwright-chromium", environment.browsers.chromium, "Chromium is required by selected browser checks");
  }
  if (
    ["pr", "release", "maintenance"].includes(options.target) &&
    plan.selected.some((descriptor) => descriptor.id === "pages:build")
  ) {
    add(
      "environment:production-public-config",
      environment.publicConfig.profile === "production",
      "PR/release Pages parity requires MERGE_GATE_PRODUCTION_ENV=1 with the intended public configuration",
    );
  }
  if (["release", "maintenance"].includes(options.target)) {
    add("environment:clean-snapshot", snapshot.clean, "Release parity requires a clean committed snapshot");
  }
  return results;
}

function planFingerprint(plan) {
  const implementation = Object.fromEntries(
    DISCOVERY_IMPLEMENTATION_PATHS.map((path) => {
      try {
        return [path, hashDiscoveryValue(readFileSync(resolve(process.cwd(), path)))];
      } catch {
        return [path, "missing"];
      }
    }),
  );
  return hashDiscoveryValue({ implementation, omitted: plan.omitted, selected: plan.selected, target: plan.target });
}

export function selectResumeNodes(plan, priorReport, context) {
  const priorPlanFingerprint = priorReport.plan?.fingerprint;
  const samePaths =
    JSON.stringify(priorReport.changedFiles?.union ?? []) === JSON.stringify(context.changedFiles.union ?? []);
  const compatible =
    priorReport.version === 1 &&
    priorReport.diagnosticOnly === true &&
    !["dry-run", "skipped"].includes(priorReport.outcome) &&
    priorReport.target === plan.target &&
    priorPlanFingerprint === context.planFingerprint &&
    priorReport.snapshot?.provisional !== true &&
    priorReport.environment?.fingerprint === context.environment.fingerprint &&
    samePaths;
  if (!compatible) {
    return { descriptors: plan.selected, reason: "Prior report inputs changed; running the full target", targeted: false };
  }

  const actionableResults = (priorReport.results ?? []).filter((result) =>
    ["failed", "blocked", "tainted"].includes(result.status),
  );
  if (actionableResults.length === 0) {
    return {
      descriptors: plan.selected,
      reason: "Prior report has no failed, blocked, or tainted nodes; running the full target",
      targeted: false,
    };
  }

  const selectedIds = new Set(actionableResults.map((result) => result.id));
  const byId = new Map(plan.selected.map((descriptor) => [descriptor.id, descriptor]));
  const visit = (id) => {
    const descriptor = byId.get(id);
    if (!descriptor) return;
    selectedIds.add(id);
    for (const dependency of descriptor.dependsOn) {
      if (!selectedIds.has(dependency)) visit(dependency);
    }
  };
  for (const id of [...selectedIds]) visit(id);
  return {
    descriptors: plan.selected.filter((descriptor) => selectedIds.has(descriptor.id)),
    reason: "Targeted diagnostic resume; prior passing nodes are not reused as release proof",
    targeted: true,
  };
}

function summarizeResults(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const blockingIssues = results.filter(
    (result) => result.blocking && ["failed", "blocked", "incomplete"].includes(result.status),
  );
  const blockingFailures = blockingIssues.filter((result) => result.status === "failed");
  const advisoryFailures = results.filter((result) => !result.blocking && result.status === "failed");
  const incomplete = results.filter((result) => result.status === "incomplete");
  return { advisoryFailures, blockingFailures, blockingIssues, counts, incomplete };
}

export function printDiscoverySummary(report, { log = console.log } = {}) {
  const counts = Object.entries(report.summary.counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  log(`[merge-gate:discover] Target: ${report.target}`);
  log(
    `[merge-gate:discover] Snapshot: ${report.snapshot.start.head.slice(0, 12)}, ${
      report.snapshot.provisional ? "PROVISIONAL (moved during run)" : report.snapshot.start.clean ? "clean" : "dirty"
    }, Node ${report.environment.node.actual}`,
  );
  log(`[merge-gate:discover] Coverage: ${counts || "no planned nodes"}`);
  log(`[merge-gate:discover] Outcome: ${report.outcome}`);

  for (const [heading, findings] of [
    ["BLOCKING FAILURES", report.summary.blockingFailures],
    ["INCOMPLETE PREREQUISITES", report.summary.incomplete],
    ["ADVISORY FAILURES", report.summary.advisoryFailures],
    ["BLOCKED", report.results.filter((result) => result.status === "blocked")],
    ["TAINTED", report.results.filter((result) => result.status === "tainted")],
  ]) {
    if (findings.length === 0) continue;
    log(`\n${heading}`);
    for (const finding of findings) {
      const detail =
        finding.status === "tainted"
          ? `tainted by ${finding.taintedBy.join(", ")}`
          : finding.exitCode === null
            ? finding.reason
            : `exit ${finding.exitCode}`;
      const rerun = finding.rerun ? `; rerun: ${finding.rerun}` : "";
      log(`  ${finding.id}  ${detail}${rerun}`);
    }
  }
  const omissionCounts = new Map();
  for (const omission of report.results.filter((result) => result.status === "omitted")) {
    omissionCounts.set(omission.reason, (omissionCounts.get(omission.reason) ?? 0) + 1);
  }
  if (omissionCounts.size > 0) {
    log("\nOMITTED");
    for (const [reason, count] of [...omissionCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      log(`  ${count} node(s)  ${reason}`);
    }
  }
  log(`\nReport: ${report.reportPath}`);
}

export function writeDiscoveryReport(report, reportPath = DEFAULT_REPORT_PATH) {
  const absoluteLatestPath = resolve(process.cwd(), reportPath);
  const fingerprintPath = resolve(dirname(absoluteLatestPath), `${report.fingerprint}.json`);
  mkdirSync(dirname(absoluteLatestPath), { recursive: true });
  const serialized = `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`;
  writeFileSync(fingerprintPath, serialized);
  writeFileSync(absoluteLatestPath, serialized);
  return { fingerprintPath, latestPath: absoluteLatestPath };
}

function printPlan(plan, descriptors, options, maxParallel, resume) {
  console.log(`[merge-gate:discover] Target: ${options.target}`);
  console.log(`[merge-gate:discover] Classification: ${plan.classification.reason}`);
  console.log(`[merge-gate:discover] Selected ${descriptors.length} node(s); ${plan.omitted.length} explicitly omitted.`);
  console.log(`[merge-gate:discover] Postbuild max parallel: ${maxParallel}`);
  if (resume) console.log(`[merge-gate:discover] Resume: ${resume.reason}`);
  for (const descriptor of descriptors) {
    const listedDependencies = descriptor.dependsOn.slice(0, 3);
    const dependency =
      descriptor.dependsOn.length > 0
        ? `; depends on ${listedDependencies.join(", ")}${
            descriptor.dependsOn.length > listedDependencies.length
              ? ` (+${descriptor.dependsOn.length - listedDependencies.length} more)`
              : ""
          }`
        : "";
    console.log(`  ${descriptor.id}: ${descriptor.command}${dependency}`);
  }
}

/**
 * @param {{
 *   argv?: string[],
 *   availableCores?: number,
 *   captureSnapshotImpl?: (...args: any[]) => any,
 *   collectEnvironmentImpl?: (...args: any[]) => any,
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: (...args: any[]) => any,
 *   exit?: (status: number) => unknown,
 *   now?: () => Date,
 *   readReportImpl?: (path: string) => any,
 *   runCommandImpl?: (command: string, extraEnv?: Record<string, string>, options?: Record<string, any>) => any,
 *   writeReportImpl?: (report: any, path: string) => any,
 * }} [runnerOptions]
 */
export async function runMergeGateDiscovery({
  argv = process.argv.slice(2),
  availableCores = os.availableParallelism(),
  captureSnapshotImpl = captureDiscoverySnapshot,
  collectEnvironmentImpl = collectDiscoveryEnvironment,
  env = process.env,
  execFile = execFileSync,
  exit = (status) => {
    process.exitCode = status;
  },
  now = () => new Date(),
  readReportImpl = (path) => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")),
  runCommandImpl = runShellCommand,
  writeReportImpl = writeDiscoveryReport,
} = {}) {
  const options = parseDiscoveryOptions(argv, env);
  if (options.help) {
    printDiscoveryHelp();
    return { status: 0 };
  }
  if (!options.stagedMode && !options.baseRefOverridden && !options.skipFetch) {
    fetchBaseRef({ baseRef: options.baseRef, execFile });
  }

  const changedFiles = collectDiscoveryChangedFiles({
    baseRef: options.baseRef,
    execFile,
    forceFullDeploy: options.forceFullDeploy,
    headRef: options.headRef,
    stagedMode: options.stagedMode,
  });
  options.forceFullDeploy ||= changedFiles.fallbackFullDeploy;
  const hasUncommittedChanges =
    changedFiles.sources.staged.length + changedFiles.sources.worktree.length + changedFiles.sources.untracked.length > 0;
  const startSnapshot = captureSnapshotImpl({ execFile, files: changedFiles.union });
  const environment = collectEnvironmentImpl({ env });
  const plan = buildDiscoveryPlan({
    changedFiles: changedFiles.union,
    forceFullDeploy: options.forceFullDeploy,
    hasUncommittedChanges,
    includeSmoke: options.includeSmoke,
    includeWorkerSmoke: options.includeWorkerSmoke,
    prebuildSkipCommands: getValidatePrebuildSkipCommands(changedFiles.union, env),
    target: options.target,
  });
  const fingerprint = planFingerprint(plan);
  let resume = null;
  let descriptors = plan.selected;
  if (options.resumePath) {
    resume = selectResumeNodes(plan, readReportImpl(options.resumePath), {
      changedFiles,
      environment,
      planFingerprint: fingerprint,
      snapshot: startSnapshot,
    });
    descriptors = resume.descriptors;
  }
  const maxParallel = resolveDiscoveryMaxParallel(env, availableCores);
  printPlan(plan, descriptors, options, maxParallel, resume);

  const environmentResults = plan.selected.length > 0 ? buildEnvironmentResults(environment, plan, options, startSnapshot) : [];
  let executionResults = [];
  if (!options.dryRun && (changedFiles.union.length > 0 || options.forceFullDeploy)) {
    executionResults = await executeDiscoveryGraph({
      changedFiles: changedFiles.union,
      descriptors,
      env,
      maxParallel,
      options,
      runCommandImpl,
    });
  }

  const endChangedFiles = collectDiscoveryChangedFiles({
    baseRef: options.baseRef,
    execFile,
    forceFullDeploy: false,
    headRef: options.headRef,
    stagedMode: options.stagedMode,
  });
  const endFiles = [...new Set([...changedFiles.union, ...endChangedFiles.union])].sort();
  const endSnapshot = captureSnapshotImpl({ execFile, files: endFiles });
  const snapshotComparison = compareDiscoverySnapshots(startSnapshot, endSnapshot);
  const pathMovement = [...new Set([...changedFiles.union, ...endChangedFiles.union])].filter(
    (path) => !changedFiles.union.includes(path) || !endChangedFiles.union.includes(path),
  );
  const provisional = snapshotComparison.moved || pathMovement.length > 0;

  const omittedResults = plan.omitted.map((descriptor) => ({
    ...descriptor,
    blocking: false,
    dependsOn: descriptor.dependsOn ?? [],
    durationMs: 0,
    exitCode: null,
    reason: descriptor.omittedReason,
    rerun: null,
    status: "omitted",
    taintedBy: [],
  }));
  if (resume?.targeted) {
    const selectedIds = new Set(descriptors.map((descriptor) => descriptor.id));
    for (const descriptor of plan.selected.filter((candidate) => !selectedIds.has(candidate.id))) {
      omittedResults.push({
        ...descriptor,
        blocking: false,
        durationMs: 0,
        exitCode: null,
        reason: "Not selected by targeted diagnostic resume",
        status: "omitted",
        taintedBy: [],
      });
    }
  }
  if (options.dryRun || (changedFiles.union.length === 0 && !options.forceFullDeploy)) {
    const reason = options.dryRun ? "Dry run; command not executed" : "No changed files detected";
    for (const descriptor of descriptors) {
      omittedResults.push({
        ...descriptor,
        blocking: false,
        durationMs: 0,
        exitCode: null,
        reason,
        status: "omitted",
        taintedBy: [],
      });
    }
  }

  const results = [...environmentResults, ...executionResults, ...omittedResults].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  if (provisional) {
    results.push({
      blocking: ["release", "maintenance"].includes(options.target),
      command: null,
      dependsOn: [],
      durationMs: 0,
      exitCode: null,
      id: "snapshot:moved",
      lane: "snapshot",
      order: 9999,
      phase: 100,
      reason: "Files or Git state changed while discovery was running",
      rerun: null,
      status: "incomplete",
      taintedBy: [],
    });
  }
  const summary = summarizeResults(results);
  const firstBlockingFailure =
    summary.blockingIssues.find((result) => result.status === "failed") ?? summary.blockingIssues[0];
  const commandsSkipped = options.dryRun || (changedFiles.union.length === 0 && !options.forceFullDeploy);
  const status = commandsSkipped ? 0 : firstBlockingFailure ? firstBlockingFailure.exitCode || 2 : 0;
  const outcome = options.dryRun
    ? "dry-run"
    : commandsSkipped
      ? "skipped"
      : summary.blockingIssues.some((result) => result.status === "failed")
        ? "failed"
        : summary.blockingIssues.length > 0
          ? "incomplete"
          : provisional
            ? "provisional"
            : "passed";
  const reportFingerprint = hashDiscoveryValue({
    plan: fingerprint,
    snapshot: startSnapshot.fingerprint,
    target: options.target,
    timestamp: now().toISOString(),
  }).slice(0, 20);
  const report = {
    changedFiles,
    classification: plan.classification,
    createdAt: now().toISOString(),
    diagnosticOnly: true,
    environment,
    fingerprint: reportFingerprint,
    outcome,
    plan: { fingerprint, omitted: plan.omitted, selected: plan.selected },
    reportPath: options.reportPath,
    resume: resume ? { reason: resume.reason, targeted: resume.targeted } : null,
    results,
    snapshot: {
      changedDuringRun: [...new Set([...snapshotComparison.changedPaths, ...pathMovement])].sort(),
      end: endSnapshot,
      provisional,
      start: startSnapshot,
    },
    status,
    summary,
    target: options.target,
    version: 1,
  };
  writeReportImpl(report, options.reportPath);
  printDiscoverySummary(report);
  if (status !== 0) exit(status);
  return { report, status };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    await runMergeGateDiscovery();
  } catch (error) {
    console.error(`[merge-gate:discover] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
