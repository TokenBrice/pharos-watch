#!/usr/bin/env node

import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import {
  createExecutionUnit,
  createNpmScriptCommand,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
  type CommandImplementation,
  type CommandResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import {
  formatFailureTail,
  reportGateResult,
  type GateLaneReport,
  type GateReport,
  type OutputWriter,
} from "../lib/report-violations.mts";

const DOC_CHECK_LANES = [
  "verified-doc-links",
  "doc-source-paths",
  "doc-sync",
  "agents-doc-artifact",
] as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface PrCheckFlags {
  forwardedTestArgs: string[];
  noFetch: boolean;
  skipCoverage: boolean;
}

export type PrCheckLane =
  | "classifier-smoke"
  | "gitleaks"
  | "verified-doc-links"
  | "doc-source-paths"
  | "doc-sync"
  | "agents-doc-artifact"
  | "pr-static"
  | "pr-tests"
  | "critical-coverage";

export type PrCheckClassification = Pick<
  ReturnType<typeof classifyChangedFiles>,
  "criticalCoverageChanged" | "docsOnly" | "pagesChanged"
>;

interface PrCheckCommand extends SpawnCommand {
  extraEnv?: Record<string, string>;
  lane: PrCheckLane;
}

export interface RunPrChecksOptions {
  now?: () => number;
  runCommandImpl?: CommandImplementation<SpawnCommand>;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
}

function hasDocsImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some(
    (file) => file.startsWith("docs/") || file === "README.md" || file === "CLAUDE.md",
  );
}

export function extractPrCheckFlags(rest: readonly string[]): PrCheckFlags {
  const forwardedTestArgs: string[] = [];
  let noFetch = false;
  let skipCoverage = false;

  for (const arg of rest) {
    if (arg === "--no-fetch") {
      noFetch = true;
    } else if (arg === "--skip-coverage") {
      skipCoverage = true;
    } else if (arg === "--json") {
      // The output mode belongs to this runner, not the downstream test lane.
    } else {
      forwardedTestArgs.push(arg);
    }
  }

  return { forwardedTestArgs, noFetch, skipCoverage };
}

export function buildPrCheckPlan(
  changedFiles: readonly string[],
  classification: PrCheckClassification,
  flags: Pick<PrCheckFlags, "skipCoverage">,
): PrCheckLane[] {
  const lanes: PrCheckLane[] = ["classifier-smoke", "gitleaks"];

  if (classification.docsOnly) {
    return [...lanes, ...DOC_CHECK_LANES];
  }

  if (hasDocsImpact(changedFiles)) {
    lanes.push(...DOC_CHECK_LANES);
  }
  lanes.push("pr-static", "pr-tests");

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
  { base, env, forwardedTestArgs, head, resolvedBaseSha }: {
    base: string;
    env: NodeJS.ProcessEnv;
    forwardedTestArgs: readonly string[];
    head: string;
    resolvedBaseSha: string;
  },
): PrCheckCommand {
  const withLane = (command: SpawnCommand, extraEnv?: Record<string, string>): PrCheckCommand => ({
    ...command,
    ...(extraEnv ? { extraEnv } : {}),
    lane,
  });

  switch (lane) {
    case "classifier-smoke":
      return withLane({
        ...createSpawnCommand("node", [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "scripts/ci/classify-deploy-changes.ts",
        ]),
        captureOutput: true,
      }, {
        DEPLOY_BASE_SHA: base,
        DEPLOY_HEAD_SHA: head,
        DEPLOY_EVENT_NAME: "push",
      });
    case "gitleaks":
      return withLane(createSpawnCommand("node", [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "scripts/ci/run-gitleaks.ts",
        "--range",
        "--lenient-platform",
      ]), {
        GITLEAKS_BASE_REF: base,
        GITLEAKS_HEAD_REF: head,
      });
    case "verified-doc-links":
      return withLane(createNpmScriptCommand("check:verified-doc-links"));
    case "doc-source-paths":
      return withLane(createNpmScriptCommand("check:doc-source-paths"));
    case "doc-sync":
      return withLane(createNpmScriptCommand("check:doc-sync"));
    case "agents-doc-artifact":
      return withLane(createNpmScriptCommand("check:generated-artifacts", ["--only=agents-doc"]));
    case "pr-static":
      return withLane(createNpmScriptCommand("check:pr:static", [`--base=${base}`, `--head=${head}`]));
    case "pr-tests":
      return withLane(createNpmScriptCommand("test:pr", [`--base=${base}`, ...forwardedTestArgs]));
    case "critical-coverage":
      return withLane(createNpmScriptCommand("coverage:critical"), {
        ...(env as Record<string, string>),
        CRITICAL_COVERAGE_COMPARE_REF: resolvedBaseSha,
      });
  }
}

async function runPrCheckLanes(
  commands: readonly PrCheckCommand[],
  { env, json, log, runCommandImpl }: {
    env: NodeJS.ProcessEnv;
    json: boolean;
    log: (message: string) => void;
    runCommandImpl: CommandImplementation<SpawnCommand>;
  },
): Promise<GateLaneReport[]> {
  const lanes: GateLaneReport[] = commands.map((command) => ({
    id: command.lane,
    command: command.cmd,
    status: "skipped",
    durationMs: 0,
    failureTail: "",
  }));
  let stopped = false;

  for (const [index, originalCommand] of commands.entries()) {
    if (stopped) continue;
    const command: PrCheckCommand = json ? { ...originalCommand, captureOutput: true } : originalCommand;
    const startedAt = Date.now();
    log(`[check:pr] ${command.cmd}`);
    let result: CommandResult;
    try {
      result = await runExecutionUnit(createExecutionUnit([command]), {
        getCommandEnv: (currentCommand) => ({
          ...(env as Record<string, string>),
          ...currentCommand.extraEnv,
        }),
        reporter: {},
        runCommandImpl: (currentCommand, extraEnv, options) => runCommandImpl(currentCommand, extraEnv, options),
      });
    } catch (error) {
      result = {
        status: 1,
        aborted: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    lanes[index] = {
      ...lanes[index],
      durationMs: Math.max(0, Date.now() - startedAt),
      failureTail: result.status === 0 || result.aborted ? "" : formatFailureTail(result.output),
      status: result.aborted ? "skipped" : result.status === 0 ? "passed" : "failed",
    };
    if (result.status !== 0) stopped = true;
  }

  return lanes;
}

export async function runPrChecks(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  {
    now = Date.now,
    runCommandImpl = runSpawnCommand,
    stderr = process.stderr,
    stdout = process.stdout,
  }: RunPrChecksOptions = {},
): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const flags = extractPrCheckFlags(rest);
  const json = rest.includes("--json");
  const logOutput = json ? stderr : stdout;
  const log = (message: string) => logOutput.write(message + "\n");
  const warn = (message: string) => stderr.write(message + "\n");
  const startedAt = Date.now();

  if (base === "origin/main" && !flags.noFetch && env.PHAROS_PR_NO_FETCH !== "1") {
    try {
      const fetchResult = normalizeCommandResult(await runCommandImpl({
        // A bare "origin main" refspec only writes FETCH_HEAD; the explicit
        // destination updates refs/remotes/origin/main, which every
        // subsequent diff and classification actually reads.
        ...createSpawnCommand("git", ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"]),
        captureOutput: true,
      }, env as Record<string, string>));
      if (fetchResult.status !== 0) {
        warn("[check:pr] Warning: could not refresh origin/main; continuing with the local ref.");
      }
    } catch (error) {
      warn(
        `[check:pr] Warning: could not refresh origin/main; continuing with the local ref (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  const resolvedBaseSha = await resolveBaseSha(base, env, runCommandImpl, now, { log, warn });
  const changedFiles = collectChangedFiles({ base, head });
  const classification = classifyChangedFiles(changedFiles);
  const lanes = buildPrCheckPlan(changedFiles, classification, flags);

  if (classification.criticalCoverageChanged && flags.skipCoverage) {
    log("[check:pr] Skipping touched critical coverage locally; the remote PR gate WILL run it.");
  }

  const commands = lanes.map((lane) => createLaneCommand(lane, {
    base,
    env,
    forwardedTestArgs: flags.forwardedTestArgs,
    head,
    resolvedBaseSha,
  }));
  const laneReports = await runPrCheckLanes(commands, { env, json, log, runCommandImpl });
  const report: GateReport<typeof classification> = {
    base,
    head,
    changedFiles,
    classification,
    lanes: laneReports,
    status: laneReports.some((lane) => lane.status === "failed") ? "failed" : "passed",
    durationMs: Math.max(0, Date.now() - startedAt),
  };

  if (report.status === "passed" && classification.pagesChanged) {
    log(
      "[check:pr] Pages changed: consider `npm run check:release` with " +
        "SEO_PREVIOUS_SITEMAP_URL=https://stablecoin-dashboard.pages.dev/sitemap.xml before release batches.",
    );
  }
  reportGateResult(report, { json, label: "check:pr", stderr, stdout });
  return report.status === "passed" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrChecks().then((status) => {
    process.exitCode = status;
  });
}
