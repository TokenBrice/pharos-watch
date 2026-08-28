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
): Promise<string> {
  try {
    const resolveResult = normalizeCommandResult(await runCommandImpl({
      ...createSpawnCommand("git", ["rev-parse", "--verify", base]),
      captureOutput: true,
    }, env as Record<string, string>));
    const sha = resolveResult.output?.trim();
    if (resolveResult.status !== 0 || !sha) {
      console.warn(`[check:pr] Warning: could not resolve base ref ${base}; continuing with the ref name.`);
      return base;
    }

    const timestampResult = normalizeCommandResult(await runCommandImpl({
      ...createSpawnCommand("git", ["show", "-s", "--format=%ct", sha]),
      captureOutput: true,
    }, env as Record<string, string>));
    const timestampSeconds = Number.parseInt(timestampResult.output?.trim() ?? "", 10);
    if (timestampResult.status !== 0 || !Number.isFinite(timestampSeconds)) {
      console.log(`[check:pr] Base ${base} resolved to ${sha} (commit age unavailable).`);
      console.warn(`[check:pr] Warning: could not determine the age of base commit ${sha}.`);
      return sha;
    }

    const ageMs = Math.max(0, now() - timestampSeconds * 1000);
    console.log(`[check:pr] Base ${base} resolved to ${sha} (commit age ${formatAge(ageMs)}).`);
    if (ageMs > ONE_DAY_MS) {
      console.warn(`[check:pr] Warning: base commit ${sha} is older than 24h.`);
    }
    return sha;
  } catch (error) {
    console.warn(
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

export async function runPrChecks(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  {
    now = Date.now,
    runCommandImpl = runSpawnCommand,
  }: RunPrChecksOptions = {},
): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const flags = extractPrCheckFlags(rest);

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
        console.warn("[check:pr] Warning: could not refresh origin/main; continuing with the local ref.");
      }
    } catch (error) {
      console.warn(
        `[check:pr] Warning: could not refresh origin/main; continuing with the local ref (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  const resolvedBaseSha = await resolveBaseSha(base, env, runCommandImpl, now);
  const changedFiles = collectChangedFiles({ base, head });
  const classification = classifyChangedFiles(changedFiles);
  const lanes = buildPrCheckPlan(changedFiles, classification, flags);

  if (classification.criticalCoverageChanged && flags.skipCoverage) {
    console.log("[check:pr] Skipping touched critical coverage locally; the remote PR gate WILL run it.");
  }

  const commands = lanes.map((lane) => createLaneCommand(lane, {
    base,
    env,
    forwardedTestArgs: flags.forwardedTestArgs,
    head,
    resolvedBaseSha,
  }));
  const result = await runExecutionUnit(createExecutionUnit(commands), {
    getCommandEnv: (command) => ({
      ...(env as Record<string, string>),
      ...command.extraEnv,
    }),
    reporter: {
      start: (cmd) => console.log(`[check:pr] ${cmd}`),
    },
    runCommandImpl: (command, extraEnv, options) => runCommandImpl(command, extraEnv, options),
  });

  if (result.status === 0 && classification.pagesChanged) {
    console.log(
      "[check:pr] Pages changed: consider `npm run check:release` with " +
        "SEO_PREVIOUS_SITEMAP_URL=https://stablecoin-dashboard.pages.dev/sitemap.xml before release batches.",
    );
  }
  return result.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrChecks().then((status) => {
    process.exit(status);
  });
}
