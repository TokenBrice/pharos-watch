#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { runLocalTrustedGitleaks } from "../ci/run-gitleaks.ts";
import { assertPinnedRuntime, readRuntimeVersions, type RuntimeVersions } from "../lib/runtime-guard.mts";
import { computeReceiptOutcome, firstActionableError, writePrCheckReceipt, type PrCheckReceiptLeaf } from "../lib/pr-check-receipt.mts";
import { buildPrStaticCheckPlan, prStaticLeafArgs } from "./run-pr-static-checks.ts";
import { runCiParity } from "./run-ci-parity.ts";
import { localBin } from "../lib/local-bin.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import { createPrTestPlan } from "../lib/pr-test-plan.mts";
import { CRITICAL_FILES, CRITICAL_OWNERSHIP } from "../lib/critical-coverage.mjs";
import { collectOwningTests } from "../lib/critical-ownership.mts";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { deriveBaseCriticalOwnership } from "../lib/critical-ownership.mts";
import {
  createNpmScriptCommand,
  createSpawnCommand,
  runSpawnCommand,
  type CommandImplementation,
  type CommandResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import {
  reportGateResult,
  type OutputWriter,
} from "../lib/report-violations.mts";
import { buildPrLaneCommandArgs, getPrLane } from "../lib/pr-lanes.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

const DOC_CHECK_LANES = getPrLane("docs").commands.map((command) => command.id as PrCheckLane);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface PrCheckFlags {
  forwardedTestArgs: string[];
  noFetch: boolean;
  skipCoverage: boolean;
  plan: boolean;
}

export type PrCheckLane =
  | "classifier-smoke"
  | "gitleaks"
  | "verified-doc-links"
  | "doc-source-paths"
  | "doc-sync"
  | "doc-ownership-invariants"
  | "agents-doc-artifact"
  | "docs-generated-artifacts"
  | "pr-static"
  | "pr-tests"
  | "pages-artifact"
  | "critical-coverage";

export type PrCheckClassification = Pick<
  ReturnType<typeof classifyChangedFiles>,
  "criticalCoverageChanged" | "docsChanged" | "docsOnly" | "pagesArtifactRequired" | "pagesChanged"
>;

interface PrCheckCommand extends SpawnCommand {
  extraEnv?: Record<string, string>;
  lane: string;
}

export interface RunPrChecksOptions {
  now?: () => number;
  runCommandImpl?: CommandImplementation<SpawnCommand>;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
  repoRoot?: string;
  runtimeVersions?: () => RuntimeVersions;
  inspectCheckout?: (base: string, head: string) => { headSha: string; requestedHeadSha: string; mergeBase: string; treeClean: boolean };
  selectPlanTestFiles?: (base: string, changedFiles: readonly string[], env: NodeJS.ProcessEnv) => string[];
  runSecrets?: typeof runLocalTrustedGitleaks;
  writeReceipt?: typeof writePrCheckReceipt;
}


export function extractPrCheckFlags(rest: readonly string[]): PrCheckFlags {
  const forwardedTestArgs: string[] = [];
  let noFetch = false;
  let skipCoverage = false;
  let plan = false;

  for (const arg of rest) {
    if (arg === "--no-fetch") {
      noFetch = true;
    } else if (arg === "--skip-coverage") {
      skipCoverage = true;
    } else if (arg === "--plan") {
      plan = true;
    } else if (arg === "--json") {
      // The output mode belongs to this runner, not the downstream test lane.
    } else {
      forwardedTestArgs.push(arg);
    }
  }

  return { forwardedTestArgs, noFetch, skipCoverage, plan };
}

export function buildPrCheckPlan(
  _changedFiles: readonly string[],
  classification: PrCheckClassification,
  flags: Pick<PrCheckFlags, "skipCoverage">,
): PrCheckLane[] {
  const lanes: PrCheckLane[] = ["classifier-smoke", "gitleaks"];

  if (classification.docsOnly) {
    return [...lanes, ...DOC_CHECK_LANES];
  }

  if (classification.docsChanged) {
    lanes.push(...DOC_CHECK_LANES);
  }
  lanes.push("pr-static", "pr-tests");
  if (classification.pagesArtifactRequired) lanes.push("pages-artifact");

  if (classification.criticalCoverageChanged && !flags.skipCoverage) {
    lanes.push("critical-coverage");
  }

  return lanes;
}

function normalizeCommandResult(result: number | CommandResult): CommandResult {
  return typeof result === "number" ? { status: result, aborted: false } : result;
}

function formatAge(ageMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function resolveBaseSha(
  base: string,
  env: NodeJS.ProcessEnv,
  runCommandImpl: CommandImplementation<SpawnCommand>,
  now: () => number,
  { log = console.log, warn = console.warn }: {
    log?: (message: string) => void;
    warn?: (message: string) => void;
  } = {},
): Promise<string> {
  try {
    const resolveResult = normalizeCommandResult(await runCommandImpl({
      ...createSpawnCommand("git", ["rev-parse", "--verify", base]),
      captureOutput: true,
    }, env as Record<string, string>));
    const sha = resolveResult.output?.trim();
    if (resolveResult.status !== 0 || !sha) {
      warn(`[check:pr] Warning: could not resolve base ref ${base}; continuing with the ref name.`);
      return base;
    }

    const timestampResult = normalizeCommandResult(await runCommandImpl({
      ...createSpawnCommand("git", ["show", "-s", "--format=%ct", sha]),
      captureOutput: true,
    }, env as Record<string, string>));
    const timestampSeconds = Number.parseInt(timestampResult.output?.trim() ?? "", 10);
    if (timestampResult.status !== 0 || !Number.isFinite(timestampSeconds)) {
      log(`[check:pr] Base ${base} resolved to ${sha} (commit age unavailable).`);
      warn(`[check:pr] Warning: could not determine the age of base commit ${sha}.`);
      return sha;
    }

    const ageMs = Math.max(0, now() - timestampSeconds * 1000);
    log(`[check:pr] Base ${base} resolved to ${sha} (commit age ${formatAge(ageMs)}).`);
    if (ageMs > ONE_DAY_MS) {
      warn(`[check:pr] Warning: base commit ${sha} is older than 24h.`);
    }
    return sha;
  } catch (error) {
    warn(
      `[check:pr] Warning: could not inspect base ref ${base}; continuing with the ref name (${error instanceof Error ? error.message : String(error)}).`,
    );
    return base;
  }
}

export function createLaneCommand(
  lane: PrCheckLane,
  { base, env, forwardedTestArgs, head, resolvedBaseSha, skipDocSync, deferCriticalOwners }: {
    base: string;
    env: NodeJS.ProcessEnv;
    forwardedTestArgs: readonly string[];
    head: string;
    resolvedBaseSha: string;
    /** Set when the docs lane in the same composed plan owns `check:doc-sync`. */
    skipDocSync?: boolean;
    /** Set when the same plan's critical-coverage leaf executes every critical-owner test file. */
    deferCriticalOwners?: boolean;
  },
): PrCheckCommand {
  const withLane = (command: SpawnCommand, extraEnv?: Record<string, string>): PrCheckCommand => ({
    ...command,
    ...(extraEnv ? { extraEnv } : {}),
    lane,
  });

  // Local check:pr runs the ungrouped static command, preserving its full plan.
  const manifestCommand = lane === "pr-static"
    ? { ...getPrLane("static-compile").commands[0], id: "pr-static", args: ["run", "check:pr:static", "--"] }
    : getPrLane(
        ["classifier-smoke", "gitleaks"].includes(lane)
          ? "preflight"
          : DOC_CHECK_LANES.includes(lane)
            ? "docs"
            : lane === "pr-tests"
              ? "tests"
              : lane === "pages-artifact"
                ? "pages-artifact"
                : "critical-coverage",
      ).commands.find((command) => command.id === lane);
  if (!manifestCommand) throw new Error(`Missing PR lane command: ${lane}`);
  const command = manifestCommand.program === "npm"
    ? createSpawnCommand("npm", buildPrLaneCommandArgs(manifestCommand, {
        base,
        forwardedTestArgs,
        head,
        skipDocSync,
      }))
    : createSpawnCommand("node", buildPrLaneCommandArgs(manifestCommand));

  switch (lane) {
    case "classifier-smoke":
      return withLane({
        ...command,
        captureOutput: true,
      }, {
        DEPLOY_BASE_SHA: base,
        DEPLOY_HEAD_SHA: head,
        DEPLOY_EVENT_NAME: "push",
      });
    case "gitleaks":
      return withLane(createSpawnCommand("node", [
        "--import", "tsx", "scripts/ci/run-gitleaks.ts", "--local-trusted",
        `--base=${resolvedBaseSha}`, `--head=${head}`,
      ]));
    case "verified-doc-links":
    case "doc-source-paths":
    case "doc-sync":
    case "doc-ownership-invariants":
    case "agents-doc-artifact":
    case "docs-generated-artifacts":
      return withLane(command, { PR_BASE_SHA: resolvedBaseSha, PR_HEAD_SHA: head });
    case "pr-static":
    case "pages-artifact":
      return withLane(command);
    case "pr-tests":
      return withLane(command, deferCriticalOwners ? { PR_TESTS_DEFER_CRITICAL_OWNERS: "1" } : undefined);
    case "critical-coverage":
      return withLane(command, {
        ...(env as Record<string, string>),
        CRITICAL_COVERAGE_COMPARE_REF: resolvedBaseSha,
      });
  }
}

export function inspectPrCheckout(base: string, head: string, repoRoot = process.cwd()) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  return {
    headSha: git("rev-parse", "--verify", "HEAD^{commit}"),
    requestedHeadSha: git("rev-parse", "--verify", `${head}^{commit}`),
    mergeBase: git("merge-base", base, head),
    treeClean: git("status", "--porcelain", "--untracked-files=all").length === 0,
  };
}

function selectPlanTestFiles(base: string, changedFiles: readonly string[], env: NodeJS.ProcessEnv): string[] {
  // This is collection only, using the same dependency selector as test:pr.
  // No assertions, gate commands or test partitions execute in plan mode.
  const result = spawnSync(localBin("vitest"), ["list", "--changed", base, "--filesOnly"], { encoding: "utf8", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Vitest test selection failed: ${result.stderr}`);
  return selectPrTestFiles(parseVitestFileList(result.stdout), undefined, changedFiles);
}

function expandStaticLeaves(
  commands: readonly PrCheckCommand[], changedFiles: readonly string[], base: string, head: string, skipDocSync: boolean,
): PrCheckCommand[] {
  return commands.flatMap((command) => command.lane !== "pr-static" ? [command] :
    buildPrStaticCheckPlan(changedFiles, { skipDocSync }).commands.map((leaf) => ({
      ...createNpmScriptCommand(leaf.name, prStaticLeafArgs(leaf, { base, head })),
      lane: `pr-static:${leaf.name}`,
    })));
}

export async function runPrChecks(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  {
    now = Date.now,
    runCommandImpl = runSpawnCommand,
    stderr = process.stderr,
    stdout = process.stdout,
    repoRoot = process.cwd(),
    runtimeVersions = readRuntimeVersions,
    inspectCheckout: inspect = (base, head) => inspectPrCheckout(base, head, repoRoot),
    selectPlanTestFiles: selectTests = selectPlanTestFiles,
    runSecrets = runLocalTrustedGitleaks,
    writeReceipt = writePrCheckReceipt,
  }: RunPrChecksOptions = {},
): Promise<number> {
  if (argv.includes("--ci-parity")) {
    return runCiParity(argv, { repoRoot, env, runtimeVersions, writeReceipt, now,
      log: (message) => stdout.write(`${message}\n`) });
  }
  const startedAt = now();
  let runtime: RuntimeVersions = { node: process.version.replace(/^v/, ""), npm: "unavailable" };
  let baseSha = "";
  let headSha = "";
  let treeClean = false;
  let weakened = false;
  const incompleteReasons: string[] = [];
  let flags: PrCheckFlags = { noFetch: false, skipCoverage: false, plan: false, forwardedTestArgs: [] };
  const leaves: PrCheckReceiptLeaf[] = [];
  const json = argv.includes("--json");
  const log = (message: string) => (json ? stderr : stdout).write(`${message}\n`);
  const warn = (message: string) => stderr.write(`${message}\n`);
  try {
    runtime = runtimeVersions();
    assertPinnedRuntime(runtime, repoRoot);
    const { base, head, rest, staged } = parseChangedFileArgs(argv, env);
    flags = extractPrCheckFlags(rest);
    if (staged) throw new Error("check:pr tests the checkout; use check:focused --staged for index-selected iteration.");
    weakened = flags.plan || flags.skipCoverage || flags.forwardedTestArgs.length > 0;
    if (flags.forwardedTestArgs.some((arg) => /^--plan(?:-out|-only)?(?:=|$)/.test(arg))) {
      throw new Error("Test plan-only flags cannot certify readiness. Use check:pr --plan for a non-executing gate-wide plan.");
    }
    let baseUnverified = false;
    const noFetch = flags.noFetch || env.PHAROS_PR_NO_FETCH === "1";
    if (base === "origin/main" && !noFetch && !flags.plan) {
      try {
        const result = normalizeCommandResult(await runCommandImpl({
          ...createSpawnCommand("git", ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"]),
          captureOutput: true,
        }, env as Record<string, string>));
        baseUnverified = result.status !== 0;
      } catch {
        baseUnverified = true;
      }
      if (baseUnverified) warn("[check:pr] Warning: could not refresh origin/main; receipt cannot certify current-base readiness.");
    }
    let staleBase = false;
    baseSha = await resolveBaseSha(base, env, runCommandImpl, now, {
      log,
      warn: (message) => {
        if (/older than 24h|could not/.test(message)) staleBase = true;
        warn(message);
      },
    });
    const checkout = inspect(baseSha, head);
    headSha = checkout.headSha;
    treeClean = checkout.treeClean;
    if (!treeClean) {
      weakened = true;
      incompleteReasons.push("dirty-worktree");
      warn("[check:pr] WARNING: dirty-worktree — tracked or untracked edits are outside the committed-range proof. Checks may run for authoring feedback, but this cannot certify HEAD readiness.");
    }
    if (checkout.requestedHeadSha !== headSha) {
      throw new Error(`--head=${head} resolves to ${checkout.requestedHeadSha}, not checked-out HEAD ${headSha}. Tests and coverage inspect the checkout; check out the requested commit first.`);
    }
    weakened ||= baseUnverified || (noFetch && staleBase);
    const changedFiles = collectChangedFiles({ base: baseSha, head: headSha, cwd: repoRoot });
    const classification = classifyChangedFiles(changedFiles, {
      baseOwnership: deriveBaseCriticalOwnership(baseSha, changedFiles),
    });
    const lanes = buildPrCheckPlan(changedFiles, classification, flags);
    const skipDocSync = lanes.includes("doc-sync");
    const deferCriticalOwners = lanes.includes("critical-coverage");
    const context = { base: baseSha, env, forwardedTestArgs: flags.forwardedTestArgs, head: headSha, resolvedBaseSha: baseSha, skipDocSync, deferCriticalOwners };
    const commands = expandStaticLeaves(lanes.map((lane) => createLaneCommand(lane, context)), changedFiles, baseSha, headSha, skipDocSync);
    // Keep omissions explicit without inventing an executed parent static leaf.
    for (const lane of [...DOC_CHECK_LANES, "pr-tests", "pages-artifact", "critical-coverage"] as const) {
      if (!lanes.includes(lane)) leaves.push({
        id: lane, command: createLaneCommand(lane, context).cmd,
        status: lane === "critical-coverage" && classification.criticalCoverageChanged ? "skipped" : "not-selected",
        durationMs: 0,
      });
    }
    log(`[check:pr] Runtime: Node ${runtime.node}, npm ${runtime.npm}`);
    log(`[check:pr] Refs: base=${baseSha}, head=${headSha}, merge-base=${checkout.mergeBase}; tree=${treeClean ? "clean" : "dirty"}`);
    if (flags.plan) {
      log(`[check:pr] Selected lanes: ${lanes.join(", ")}`);
      for (const command of commands) log(`[check:pr] ${command.lane}: ${command.cmd}`);
      if (lanes.includes("pr-tests")) {
        const plan = createPrTestPlan(baseSha, selectTests(baseSha, changedFiles, env));
        log(`[check:pr] Selected test files (${plan.fileCount}):\n${plan.shards.flat().join("\n")}`);
        log(`[check:pr] CI partitions (${plan.shardCount}; local tests are unsharded): ${JSON.stringify(plan.shards)}`);
        if (deferCriticalOwners) log("[check:pr] Local pr-tests defer critical-owner test files to the critical-coverage leaf, which executes all of them.");
      } else log("[check:pr] Selected test files/partitions: none (docs-only).");
      if (classification.criticalCoverageChanged) {
        log(`[check:pr] Critical owners (full suite):\n${collectOwningTests(CRITICAL_FILES, CRITICAL_OWNERSHIP).join("\n")}`);
      } else log("[check:pr] Critical owners: coverage not selected.");
      log("[check:pr] PLAN ONLY: no checks executed; not readiness proof. Test discovery may import modules. No fetch, clean install/bootstrap assertion, merge checkout, CI artifact transport or production acceptance. Timing history is scheduling telemetry, not a runtime SLA.");
      leaves.push(...commands.map((command): PrCheckReceiptLeaf => ({
        id: command.lane, command: command.cmd, status: "skipped", durationMs: 0,
      })));
      return 0;
    }
    const runLeaf = async (command: PrCheckCommand): Promise<PrCheckReceiptLeaf> => {
      log(`[check:pr] ${command.cmd}`);
      const leafStarted = now();
      let result: CommandResult;
      try {
        if (command.lane === "gitleaks") {
          const scan = await runSecrets({ baseSha, headSha, repoRoot });
          result = { status: scan.exitCode, aborted: false, output: scan.summary };
        } else {
          result = normalizeCommandResult(await runCommandImpl(
            { ...command, captureOutput: true }, { ...(env as Record<string, string>), ...command.extraEnv },
          ));
        }
      } catch (error) {
        result = { status: 1, aborted: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
      const failed = result.status !== 0 || Boolean(result.error);
      log(`[check:pr] ${failed ? "failed" : "passed"}: ${command.lane}`);
      if (result.output) log(result.output.trimEnd());
      return {
        id: command.lane, command: command.cmd, status: failed ? "failed" : "passed",
        durationMs: Math.max(0, now() - leafStarted),
        ...(failed ? { firstError: firstActionableError(result.output, result.error?.message ?? `Command exited ${result.status}${result.signal ? ` (${result.signal})` : ""}`) } : {}),
      };
    };
    // All independent leaves execute, including after thrown/spawn failures.
    // Vitest lanes and the read-only secret/docs/static leaves run as two
    // concurrent serial tracks. pages-artifact overlays release data into the
    // checkout and deletes .next/out, so it runs alone after both finish.
    const executed = new Map<PrCheckCommand, PrCheckReceiptLeaf>();
    const runTrack = async (track: readonly PrCheckCommand[]) => {
      for (const command of track) executed.set(command, await runLeaf(command));
    };
    const testTrack = commands.filter((command) => command.lane === "pr-tests" || command.lane === "critical-coverage");
    const pagesTrack = commands.filter((command) => command.lane === "pages-artifact");
    await Promise.all([
      runTrack(testTrack),
      runTrack(commands.filter((command) => !testTrack.includes(command) && !pagesTrack.includes(command))),
    ]);
    await runTrack(pagesTrack);
    leaves.push(...commands.map((command) => executed.get(command)!));
    log("[check:pr] Final leaf summary (status | milliseconds | command | first actionable error):");
    for (const leaf of leaves) log(`${leaf.status} | ${leaf.durationMs} | ${leaf.command}${leaf.firstError ? ` | ${leaf.firstError}` : ""}`);
    const outcome = computeReceiptOutcome(leaves, weakened);
    reportGateResult({
      base: baseSha, head: headSha, changedFiles, classification,
      lanes: leaves.filter((leaf) => leaf.status !== "not-selected").map((leaf) => ({
        ...leaf, status: leaf.status as "passed" | "failed" | "skipped", failureTail: leaf.firstError ?? "",
      })),
      status: outcome, incompleteReasons, durationMs: Math.max(0, now() - startedAt),
    }, { json, label: "check:pr", stdout, stderr });
    log(`[check:pr] Outcome: ${outcome}${outcome === "incomplete" ? " (weakened invocation; not readiness proof)" : ""}`);
    if (incompleteReasons.includes("dirty-worktree")) {
      warn("[check:pr] NOT READINESS PROOF: dirty-worktree. Commit final edits and rerun the complete gate on a clean checkout.");
    }
    return outcome === "failed" ? 1 : 0;
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    warn(`[check:pr] ${firstError}`);
    leaves.push({ id: "setup", command: "check:pr setup", status: "failed", durationMs: Math.max(0, now() - startedAt), firstError });
    return 1;
  } finally {
    // Also replace any old passing receipt when setup or runtime validation fails.
    if (!headSha) {
      try {
        headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repoRoot, encoding: "utf8" }).trim();
      } catch { /* Outside a Git checkout there is no commit identity to certify. */ }
    }
    if (headSha) writeReceipt({
      schemaVersion: 1, ...runtime, baseSha, headSha, treeClean,
      flags: { ...flags, noFetchEnv: env.PHAROS_PR_NO_FETCH === "1" }, weakened,
      incompleteReasons,
      startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(),
      leaves: flags.plan ? leaves.map((leaf) => leaf.status === "failed" || leaf.status === "not-selected" ? leaf : { ...leaf, status: "skipped" }) : leaves,
      outcome: computeReceiptOutcome(leaves, weakened),
    }, repoRoot);
  }
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runPrChecks();
});
