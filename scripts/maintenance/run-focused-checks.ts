#!/usr/bin/env node

import { existsSync } from "node:fs";

import { classifyChangedFiles, normalizeExplicitFiles, readChangedFiles } from "../ci/pharos-change-contract.ts";
import { createPrStaticLeafCommand, selectPrBaselineChecks } from "./run-pr-static-checks.ts";
import { selectLintableFiles } from "../ci/run-changed-eslint.ts";
import {
  parseStrictCliArgs,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import {
  createExecutionUnit,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
  type CommandImplementation,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import { runGateLanes } from "../lib/gate-lanes.mts";
import { matchesOwnershipGlob, PATH_FAMILIES, type PathFamily } from "../lib/doc-ownership-registry.mts";
import {
  formatFailureTail,
  writeJsonReport,
  type GateLaneReport,
  type OutputWriter,
} from "../lib/report-violations.mts";

const USAGE = [
  "Usage: npm run check:focused -- [options]",
  "",
  "Route a path or the current diff through the Pharos change contract and run its focused checks.",
  "",
  "Options:",
  "  --file <path>       Route an explicit file; repeatable",
  "  --staged            Route staged files",
  "  --base, --base-ref <ref> Route files changed from the ref",
  "  --head, --head-ref <ref> Compare to this head (default HEAD)",
  "  --plan-only         Print the routed check plan without running it",
  "  --json              Emit the result as JSON on stdout",
  "  -h, --help          Show this help",
].join("\n");

export interface FocusedCheckArgs {
  base?: string;
  files: string[];
  head?: string;
  help: boolean;
  json: boolean;
  planOnly: boolean;
  staged: boolean;
}

export interface FocusedCheckPlan {
  changedFiles: string[];
  checks: FocusedCheck[];
  classification: ReturnType<typeof classifyChangedFiles>;
  fallbackOnlyPaths: number;
}

export interface FocusedCheck {
  command: string;
  source: string;
  argv?: readonly string[];
}


export interface FocusedCheckReport {
  changedFiles: string[];
  checks: FocusedCheck[];
  classification: ReturnType<typeof classifyChangedFiles>;
  durationMs: number;
  fallbackOnlyPaths: number;
  lanes: GateLaneReport[];
  planOnly: boolean;
  unmappedPaths: string[];
  status: "failed" | "passed" | "planned" | "routing-incomplete" | "intentional-no-check";
}

export interface RunFocusedChecksOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  runCommandImpl?: CommandImplementation<SpawnCommand>;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

export function parseFocusedCheckArgs(argv: readonly string[] = []): FocusedCheckArgs {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["file", "staged", "base", "base-ref"], ["base", "base-ref"], ["head", "head-ref"]],
    options: {
      base: { type: "string" },
      "base-ref": { type: "string" },
      head: { type: "string" },
      "head-ref": { type: "string" },
      file: { multiple: true, type: "string" },
      json: { type: "boolean" },
      "plan-only": { type: "boolean" },
      staged: { type: "boolean" },
    },
  });

  return {
    base: (values.base ?? values["base-ref"]) as string | undefined,
    head: (values.head ?? values["head-ref"]) as string | undefined,
    files: stringValues(values.file),
    help: values.help === true,
    json: values.json === true,
    planOnly: values["plan-only"] === true,
    staged: values.staged === true,
  };
}

function selectFocusedFiles(args: FocusedCheckArgs): string[] {
  if (args.files.length > 0) {
    return normalizeExplicitFiles(args.files);
  }

  return readChangedFiles({ baseRef: args.base, headRef: args.head, staged: args.staged });
}

export function buildFocusedCheckPlan(
  changedFiles: readonly string[],
): FocusedCheckPlan {
  const classification = classifyChangedFiles(changedFiles);
  const familyOrder = new Map(classification.mappings.map((mapping, index) => [mapping.id, index]));
  const selectedFamilies = new Map<string, PathFamily>();
  let fallbackOnlyPaths = 0;

  for (const file of classification.changedFiles) {
    const matchedFamilies = PATH_FAMILIES.filter((family) =>
      family.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob)),
    );
    const specificFamilies = matchedFamilies.filter((family) => family.tier !== "fallback");
    const familiesForPath = specificFamilies.length > 0
      ? specificFamilies
      : matchedFamilies.filter((family) => family.tier === "fallback");
    if (specificFamilies.length === 0 && familiesForPath.length > 0) fallbackOnlyPaths += 1;
    for (const family of familiesForPath) selectedFamilies.set(family.id, family);
  }

  const checks: FocusedCheck[] = [];
  const seenChecks = new Set<string>();
  const { classification: deploy, commands: baselineChecks } = selectPrBaselineChecks(classification.changedFiles);
  const lintFiles = selectLintableFiles(classification.changedFiles);
  if (lintFiles.length > 0) {
    const argv = ["npm", "run", "lint:changed", "--", ...lintFiles.flatMap((file) => ["--file", file])];
    checks.push({ command: createSpawnCommand(argv[0], argv.slice(1)).cmd, argv, source: "baseline" });
  }
  if (deploy.pagesChanged || classification.changedFiles.some((file) => file.startsWith("scripts/") && /\.[cm]?[jt]sx?$/.test(file))) {
    checks.push({ command: "npm run typecheck", source: "baseline" });
  }
  for (const command of baselineChecks) {
    const spawn = createPrStaticLeafCommand(command, command.args ?? []);
    checks.push({ command: spawn.cmd, argv: [spawn.executable, ...spawn.args], source: "baseline" });
  }
  for (const check of checks) seenChecks.add(check.command);
  const genericFamilyIds: Record<string, true> = {
    "frontend-routes": true, "scripts-tooling": true, "worker-runtime": true, "shared-runtime": true,
  };
  const retainedCommands = new Set([...selectedFamilies.values()].filter((family) => !genericFamilyIds[family.id]).flatMap((family) => family.checks));
  [...selectedFamilies.values()]
    .sort((a, b) => (familyOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (familyOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    .forEach((family) => {
      for (const command of family.checks) {
        let argv: string[] | undefined;
        let plannedCommand = command;
        if (genericFamilyIds[family.id]) {
          if (retainedCommands.has(command)) continue;
          const files = classification.changedFiles.filter((file) => family.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob)));
          if (family.id === "frontend-routes" && command === "npx vitest run src"
            && files.every((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file))) {
            argv = ["npx", "vitest", "related", "--run", "--passWithNoTests=false", ...files];
            plannedCommand = createSpawnCommand(argv[0], argv.slice(1)).cmd;
          }
        }
        if (seenChecks.has(plannedCommand)) continue;
        seenChecks.add(plannedCommand);
        checks.push({ command: plannedCommand, source: family.id, ...(argv ? { argv } : {}) });
      }
    });

  return {
    changedFiles: classification.changedFiles,
    checks,
    classification,
    fallbackOnlyPaths,
  };
}

function writeLine(output: OutputWriter, line: string): void {
  output.write(line + "\n");
}

function formatPlan(plan: FocusedCheckPlan): string {
  const changedFiles = plan.changedFiles.length > 0
    ? plan.changedFiles.map((file) => "- " + file)
    : ["- No changed files detected."];
  const checks = plan.checks.length > 0
    ? plan.checks.map((check) => `- ${check.command}  (${check.source})`)
    : ["- No focused checks selected."];
  const lines = ["Focused check plan:", "", "Changed files:", ...changedFiles, "", "Checks:", ...checks];
  if (plan.fallbackOnlyPaths > 0) lines.push("", `Fallback-only paths: ${plan.fallbackOnlyPaths}`);
  return lines.join("\n");
}

function createCheckCommand(check: FocusedCheck): SpawnCommand {
  const tokens = check.argv ? [...check.argv] : check.command.trim().split(/\s+/);
  const executable = tokens.shift();
  if (!executable) throw new Error("Focused check registry contains an empty command.");
  return { ...createSpawnCommand(executable, tokens), captureOutput: true };
}

function makeLane(check: FocusedCheck): GateLaneReport {
  return {
    id: check.command,
    command: check.command,
    status: "skipped",
    durationMs: 0,
    failureTail: "",
  };
}

function writeFocusedFailure(report: FocusedCheckReport, stderr: OutputWriter): void {
  if (report.status !== "failed") return;
  const failedLane = report.lanes.find((lane) => lane.status === "failed");
  if (!failedLane) return;
  writeLine(stderr, "[check:focused] FAILED: " + failedLane.command);
  if (failedLane.failureTail) writeLine(stderr, failedLane.failureTail);
}

export async function runFocusedChecks({
  argv = process.argv.slice(2),
  env = process.env,
  now = Date.now,
  runCommandImpl = runSpawnCommand,
  stderr = process.stderr,
  stdout = process.stdout,
}: RunFocusedChecksOptions = {}): Promise<number> {
  const args = parseFocusedCheckArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE, stdout)) return 0;

  const plan = buildFocusedCheckPlan(selectFocusedFiles(args));
  const routingIncomplete = plan.classification.unmappedPaths.length > 0;
  if (args.json) {
    writeLine(stderr, "[check:focused] " + plan.checks.length + " focused check(s) selected.");
  } else {
    writeLine(stdout, formatPlan(plan));
  }

  const startedAt = now();
  const plannedLanes = plan.checks.map(makeLane);
  if (routingIncomplete || args.planOnly || plan.checks.length === 0) {
    const report: FocusedCheckReport = {
      changedFiles: plan.changedFiles,
      checks: plan.checks,
      classification: plan.classification,
      durationMs: Math.max(0, now() - startedAt),
      fallbackOnlyPaths: plan.fallbackOnlyPaths,
      lanes: plannedLanes,
      planOnly: args.planOnly,
      unmappedPaths: plan.classification.unmappedPaths,
      status: routingIncomplete ? "routing-incomplete" : plan.checks.length === 0 ? "intentional-no-check" : "planned",
    };
    if (args.json) writeJsonReport(report, stdout);
    else writeLine(routingIncomplete ? stderr : stdout, routingIncomplete
      ? `[check:focused] routing-incomplete: no ownership mapping for ${report.unmappedPaths.join(", ")}. Route these paths before running focused checks.`
      : `[check:focused] ${report.status}`);
    return routingIncomplete ? 1 : 0;
  }

  const lanes = await runGateLanes(plan.checks, {
    command: (check) => check.command,
    failureTail: (result) => result.status === 0 ? "" : formatFailureTail(result.output),
    id: (check) => check.command,
    now,
    run: (check) => {
      const command = createCheckCommand(check);
      return runExecutionUnit(createExecutionUnit([command]), {
        getCommandEnv: () => env as Record<string, string>,
        reporter: {
          start: (cmd) => writeLine(args.json ? stderr : stdout, "[check:focused] " + cmd),
        },
        runCommandImpl: async (spawnCommand, extraEnv, options) => {
          const result = await runCommandImpl(spawnCommand, extraEnv, options);
          if (
            !args.json &&
            typeof result !== "number" &&
            result.status === 0 &&
            result.output
          ) {
            stdout.write(result.output);
          }
          return result;
        },
      });
    },
    status: (result) => result.status === 0 ? "passed" : "failed",
  });
  const failed = lanes.some((lane) => lane.status === "failed");

  const report: FocusedCheckReport = {
    changedFiles: plan.changedFiles,
    checks: plan.checks,
    classification: plan.classification,
    durationMs: Math.max(0, now() - startedAt),
    fallbackOnlyPaths: plan.fallbackOnlyPaths,
    lanes,
    planOnly: false,
    unmappedPaths: plan.classification.unmappedPaths,
    status: failed ? "failed" : "passed",
  };
  if (args.json) writeJsonReport(report, stdout);
  else writeFocusedFailure(report, stderr);
  return failed ? 1 : 0;
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runFocusedChecks();
}, { label: "check:focused", usage: USAGE });
