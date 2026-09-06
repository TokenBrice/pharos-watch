#!/usr/bin/env node

import { classifyChangedFiles, normalizeExplicitFiles, readChangedFiles } from "../ci/pharos-change-contract.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import {
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import {
  createExecutionUnit,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
  type CommandImplementation,
  type CommandResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
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
  "  --base <ref>        Route files changed from the ref to HEAD",
  "  --plan-only         Print the routed check plan without running it",
  "  --json              Emit the result as JSON on stdout",
  "  -h, --help          Show this help",
].join("\n");

export interface FocusedCheckArgs {
  base?: string;
  files: string[];
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

export interface BuildFocusedCheckPlanOptions {
  base?: string;
}

export interface FocusedCheckReport {
  changedFiles: string[];
  checks: FocusedCheck[];
  classification: ReturnType<typeof classifyChangedFiles>;
  durationMs: number;
  fallbackOnlyPaths: number;
  lanes: GateLaneReport[];
  planOnly: boolean;
  status: "failed" | "passed" | "planned";
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
    conflicts: [["file", "staged", "base"]],
    options: {
      base: { type: "string" },
      file: { multiple: true, type: "string" },
      json: { type: "boolean" },
      "plan-only": { type: "boolean" },
      staged: { type: "boolean" },
    },
  });

  return {
    base: typeof values.base === "string" ? values.base : undefined,
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

  return readChangedFiles({ baseRef: args.base, staged: args.staged });
}

export function buildFocusedCheckPlan(
  changedFiles: readonly string[],
  { base }: BuildFocusedCheckPlanOptions = {},
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
  const isGeneric = (family: PathFamily) => family.id === "frontend-routes" || family.id === "scripts-tooling";
  const retainedCommands = new Set([...selectedFamilies.values()].filter((family) => !isGeneric(family)).flatMap((family) => family.checks));
  [...selectedFamilies.values()]
    .sort((a, b) => (familyOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (familyOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    .forEach((family) => {
      for (const command of family.checks) {
        let argv: string[] | undefined;
        let plannedCommand = command === "npm run lint:changed" && base
          ? `${command} -- --base=${base}`
          : command;
        if (isGeneric(family)) {
          if (retainedCommands.has(command)) continue;
          const files = classification.changedFiles.filter((file) => family.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob)));
          if (family.id === "frontend-routes" && command === "npx vitest run src"
            && files.every((file) => /\.[cm]?[jt]sx?$/.test(file))) {
            argv = ["npx", "vitest", "related", "--run", "--passWithNoTests=false", ...files];
            plannedCommand = createSpawnCommand(argv[0], argv.slice(1)).cmd;
          } else if (command === "npm run check:generated-artifacts") {
            const ids = selectChangedGeneratedArtifactIds(classification.changedFiles).filter((id) =>
              GENERATED_ARTIFACT_REGISTRY.some((artifact) => artifact.id === id && artifact.checkable !== false),
            );
            if (ids.length === 0) continue;
            plannedCommand = `${command} -- --only=${ids.join(",")}`;
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

function normalizeCommandResult(result: number | CommandResult): CommandResult {
  return typeof result === "number" ? { status: result, aborted: false } : result;
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

  const plan = buildFocusedCheckPlan(selectFocusedFiles(args), { base: args.base });
  if (args.files.length > 0) {
    const mappedFiles = new Set(plan.classification.mappings.flatMap((mapping) => mapping.matchedFiles));
    const unmatched = plan.changedFiles.filter((file) => !mappedFiles.has(file));
    if (unmatched.length > 0) {
      throw new Error(`No ownership mapping for explicit path(s): ${unmatched.join(", ")}. Route these paths before running focused checks.`);
    }
  }
  if (args.json) {
    writeLine(stderr, "[check:focused] " + plan.checks.length + " focused check(s) selected.");
  } else {
    writeLine(stdout, formatPlan(plan));
  }

  const startedAt = now();
  const lanes = plan.checks.map(makeLane);
  if (args.planOnly) {
    const report: FocusedCheckReport = {
      changedFiles: plan.changedFiles,
      checks: plan.checks,
      classification: plan.classification,
      durationMs: Math.max(0, now() - startedAt),
      fallbackOnlyPaths: plan.fallbackOnlyPaths,
      lanes,
      planOnly: true,
      status: "planned",
    };
    if (args.json) writeJsonReport(report, stdout);
    return 0;
  }

  let failed = false;
  for (const [index, check] of plan.checks.entries()) {
    if (failed) continue;
    const command = createCheckCommand(check);
    const laneStartedAt = now();
    let result: CommandResult;
    try {
      result = await runExecutionUnit(createExecutionUnit([command]), {
        getCommandEnv: () => env as Record<string, string>,
        reporter: {
          start: (cmd) => writeLine(args.json ? stderr : stdout, "[check:focused] " + cmd),
        },
        runCommandImpl: async (spawnCommand, extraEnv, options) => {
          const commandResult = normalizeCommandResult(await runCommandImpl(spawnCommand, extraEnv, options));
          if (!args.json && commandResult.status === 0 && commandResult.output) {
            stdout.write(commandResult.output);
          }
          return commandResult;
        },
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
      durationMs: Math.max(0, now() - laneStartedAt),
      failureTail: result.status === 0 ? "" : formatFailureTail(result.output),
      status: result.status === 0 ? "passed" : "failed",
    };
    if (result.status !== 0) failed = true;
  }

  const report: FocusedCheckReport = {
    changedFiles: plan.changedFiles,
    checks: plan.checks,
    classification: plan.classification,
    durationMs: Math.max(0, now() - startedAt),
    fallbackOnlyPaths: plan.fallbackOnlyPaths,
    lanes,
    planOnly: false,
    status: failed ? "failed" : "passed",
  };
  if (args.json) writeJsonReport(report, stdout);
  else writeFocusedFailure(report, stderr);
  return failed ? 1 : 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  runCliEntrypoint(async () => {
    process.exitCode = await runFocusedChecks();
  }, { label: "check:focused", usage: USAGE });
}
