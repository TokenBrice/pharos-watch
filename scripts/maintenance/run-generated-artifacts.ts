#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createExecutionUnit,
  runExecutionUnit,
  runShellCommand,
  type CommandImplementation,
} from "../lib/command-runner.mts";
import { buildGeneratedArtifactPhases } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { CliUsageError } from "../lib/cli-args.mjs";

// Artifacts run through a topological ready-queue DAG scheduler respecting
// declared `dependsOn` edges. Four-way concurrency keeps heavy builders from
// stacking up on constrained runners.
export const GENERATED_ARTIFACTS_MAX_PARALLEL = 4;

interface GeneratedArtifactOptions {
  bootstrap?: boolean;
  buildLifecycles?: readonly string[];
  check?: boolean;
  cwd?: string;
  integrityOnly?: boolean;
  only?: readonly string[];
  phases?: readonly number[];
  skipExistingDeps?: boolean;
}

interface GeneratedArtifactDefinition {
  id: string;
  command: string;
  bootstrap?: boolean;
  buildLifecycle?: string;
  dependsOn?: string[];
  outputPaths?: string[];
}

interface GeneratedArtifactPhase {
  phase: number;
  artifacts: GeneratedArtifactDefinition[];
}

interface ArtifactExecutionUnit {
  id: string;
  commands: string[];
  dependsOn?: string[];
}

interface ArtifactExecutionPhase {
  phase: number;
  units: ArtifactExecutionUnit[];
}

interface RunnerUnitResult {
  status: number;
  failedCmd: string | null;
  aborted: boolean;
  error?: Error;
  durationMs: number;
  index: number;
  unit: ArtifactExecutionUnit;
}

interface ArtifactRunResult extends RunnerUnitResult {
  id: string;
  phase: number;
  statusLabel: "passed" | "tainted" | "failed";
  taintedBy: string[];
}

interface GeneratedArtifactsResult {
  status: number;
  failedCmd: string | null;
  aborted: boolean;
  error?: Error;
  failures: RunnerUnitResult[];
  results: ArtifactRunResult[];
}

const OUTPUT_GLOB_PATTERN = /[*?[\]{}]/;

function hasExistingOutputs(outputPaths: readonly string[] | undefined, cwd: string): boolean {
  if (!outputPaths || outputPaths.length === 0) return false;
  for (const outputPath of outputPaths) {
    if (!outputPath || OUTPUT_GLOB_PATTERN.test(outputPath)) return false;
    const fullPath = resolve(cwd, outputPath);
    if (!existsSync(fullPath)) return false;
    if (statSync(fullPath).isDirectory() && readdirSync(fullPath).length === 0) return false;
  }
  return true;
}

function planGeneratedArtifactExecutionPhases({
  bootstrap = false,
  buildLifecycles = [],
  check = false,
  cwd = process.cwd(),
  integrityOnly = false,
  only = [],
  phases = [],
  skipExistingDeps = false,
}: GeneratedArtifactOptions = {}): { executionPhases: ArtifactExecutionPhase[]; skippedIds: string[] } {
  if (integrityOnly && !check) throw new CliUsageError("--integrity-only requires --check");
  const registryPhases: GeneratedArtifactPhase[] = buildGeneratedArtifactPhases({
    bootstrap,
    buildLifecycles: [...buildLifecycles],
    check,
    integrityOnly,
    only: [...only],
    phases: [...phases],
  });

  const skippedIds: string[] = [];
  const effectiveSkipExistingDeps = skipExistingDeps && !check && (only.length > 0 || buildLifecycles.length > 0);
  if (!effectiveSkipExistingDeps) {
    return {
      executionPhases: registryPhases.map(({ phase, artifacts }) => ({
        phase,
        units: artifacts.map<ArtifactExecutionUnit>((artifact) =>
          createExecutionUnit([artifact.command], {
            dependsOn: artifact.dependsOn ?? [],
            id: artifact.id,
          }),
        ),
      })),
      skippedIds,
    };
  }

  const onlySet = new Set(only);
  const buildLifecycleSet = new Set(buildLifecycles);
  const phaseSet = new Set(phases);
  const artifactById = new Map<string, GeneratedArtifactDefinition>();
  const directTargetIds = new Set<string>();

  for (const { phase, artifacts } of registryPhases) {
    for (const artifact of artifacts) {
      artifactById.set(artifact.id, artifact);
      const isDirectTarget =
        (!bootstrap || artifact.bootstrap === true)
        && (buildLifecycleSet.size === 0 || (artifact.buildLifecycle !== undefined && buildLifecycleSet.has(artifact.buildLifecycle)))
        && (onlySet.size === 0 || onlySet.has(artifact.id))
        && (phaseSet.size === 0 || phaseSet.has(phase));
      if (isDirectTarget) directTargetIds.add(artifact.id);
    }
  }

  const skipDecision = new Map<string, boolean>();
  const visiting = new Set<string>();
  const canSkipArtifact = (id: string): boolean => {
    const cached = skipDecision.get(id);
    if (cached !== undefined) return cached;
    if (directTargetIds.has(id) || visiting.has(id)) {
      skipDecision.set(id, false);
      return false;
    }
    const artifact = artifactById.get(id);
    if (!artifact || !hasExistingOutputs(artifact.outputPaths, cwd)) {
      skipDecision.set(id, false);
      return false;
    }
    visiting.add(id);
    let allDepsSkipped = true;
    for (const depId of artifact.dependsOn ?? []) {
      if (!artifactById.has(depId)) continue;
      if (!canSkipArtifact(depId)) {
        allDepsSkipped = false;
        break;
      }
    }
    visiting.delete(id);
    skipDecision.set(id, allDepsSkipped);
    return allDepsSkipped;
  };

  const executionPhases: ArtifactExecutionPhase[] = [];
  for (const { phase, artifacts } of registryPhases) {
    const units: ArtifactExecutionUnit[] = [];
    for (const artifact of artifacts) {
      if (canSkipArtifact(artifact.id)) {
        skippedIds.push(artifact.id);
        continue;
      }
      units.push(
        createExecutionUnit([artifact.command], {
          dependsOn: artifact.dependsOn ?? [],
          id: artifact.id,
        }),
      );
    }
    if (units.length > 0) {
      executionPhases.push({ phase, units });
    }
  }
  return { executionPhases, skippedIds };
}

export function buildGeneratedArtifactExecutionUnits(options: GeneratedArtifactOptions = {}): ArtifactExecutionUnit[] {
  return buildGeneratedArtifactExecutionPhases(options).flatMap(({ units }) => units);
}

export function buildGeneratedArtifactExecutionPhases(options: GeneratedArtifactOptions = {}): ArtifactExecutionPhase[] {
  return planGeneratedArtifactExecutionPhases(options).executionPhases;
}

function parseListValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePhaseList(value: string): number[] {
  return parseListValue(value).map((phase) => {
    if (!/^\d+$/.test(phase)) {
      throw new Error(`Invalid generated artifact phase: ${phase}`);
    }
    return Number.parseInt(phase, 10);
  });
}

export function parseGeneratedArtifactsArgs(argv: readonly string[] = []): {
  bootstrap: boolean;
  buildLifecycles: string[];
  check: boolean;
  integrityOnly: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  help: boolean;
  only: string[];
  phases: number[];
  skipExistingDeps: boolean;
} {
  const options: {
    bootstrap: boolean;
    buildLifecycles: string[];
    check: boolean;
    integrityOnly: boolean;
    continueOnError: boolean;
    dryRun: boolean;
    help: boolean;
    only: string[];
    phases: number[];
    skipExistingDeps: boolean;
  } = {
    bootstrap: false,
    buildLifecycles: [],
    check: false,
    integrityOnly: false,
    continueOnError: false,
    dryRun: false,
    help: false,
    only: [],
    phases: [],
    skipExistingDeps: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bootstrap") {
      options.bootstrap = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--integrity-only") {
      options.integrityOnly = true;
      continue;
    }
    if (arg === "--build-lifecycle") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --build-lifecycle");
      options.buildLifecycles.push(...parseListValue(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--build-lifecycle=")) {
      options.buildLifecycles.push(...parseListValue(arg.slice("--build-lifecycle=".length)));
      continue;
    }
    if (arg === "--continue-on-error") {
      options.continueOnError = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-existing-deps") {
      options.skipExistingDeps = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--only") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --only");
      options.only.push(...parseListValue(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      options.only.push(...parseListValue(arg.slice("--only=".length)));
      continue;
    }
    if (arg === "--phase") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --phase");
      options.phases.push(...parsePhaseList(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--phase=")) {
      options.phases.push(...parsePhaseList(arg.slice("--phase=".length)));
      continue;
    }

    throw new Error(`Unknown generated-artifacts option: ${arg}`);
  }

  if (options.integrityOnly && !options.check) throw new CliUsageError("--integrity-only requires --check");
  if (options.check) {
    // Check mode remains the authoritative freshness mode by default; it ignores
    // bootstrap narrowing unless the caller provides explicit --only/--phase filters.
    options.bootstrap = false;
  }

  options.only = [...new Set(options.only)];
  options.buildLifecycles = [...new Set(options.buildLifecycles)];
  options.phases = [...new Set(options.phases)].sort((left, right) => left - right);
  return options;
}

export function printGeneratedArtifactsHelp(log = console.log) {
  log(
    "Usage: npm run prebuild -- [--bootstrap|--check [--integrity-only]] [--build-lifecycle name[,name]] [--continue-on-error] [--skip-existing-deps] [--only id[,id]] [--phase n[,n]] [--dry-run|--help]",
  );
  log("");
  log("Options:");
  log("  --bootstrap          Run only bootstrap-safe generators (ignored in --check mode).");
  log("  --check              Verify generated artifacts instead of writing them.");
  log("  --integrity-only     With --check, waive only public dataset maximum age (PR integrity checks).");
  log("  --build-lifecycle <names>  Run artifacts in one or more declared build lifecycle groups.");
  log("  --continue-on-error  Diagnostic mode: retain all failures and continue through dependency graph.");
  log("  --skip-existing-deps Skip transitive dependencies whose declared outputs already exist on disk");
  log("                       (also enabled by PHAROS_GENERATED_SKIP_EXISTING_DEPS=1; ignored in --check mode).");
  log("  --only <ids>         Run one or more artifact ids and their declared dependencies.");
  log("  --phase <phases>     Run artifacts in one or more numeric dependency phases.");
  log("  --dry-run            Print the resolved command plan without executing commands.");
  log("  --help, -h           Print this help text.");
}

interface ScheduledArtifact {
  index: number;
  phase: number;
  unit: ArtifactExecutionUnit;
}

async function runGeneratedArtifactDag(
  executionPhases: readonly ArtifactExecutionPhase[],
  {
    continueOnError,
    label,
    maxParallel,
    runCommandImpl,
  }: {
    continueOnError: boolean;
    label: string;
    maxParallel: number;
    runCommandImpl: CommandImplementation;
  },
): Promise<GeneratedArtifactsResult> {
  const scheduled: ScheduledArtifact[] = [];
  for (const { phase, units } of executionPhases) {
    for (const unit of units) {
      scheduled.push({ index: scheduled.length, phase, unit });
    }
  }
  if (scheduled.length === 0) {
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const scheduledById = new Map<string, ScheduledArtifact>(scheduled.map((item) => [item.unit.id, item]));
  const remainingDeps = new Map<string, number>();
  const dependents = new Map<string, ScheduledArtifact[]>();
  const readyQueue: ScheduledArtifact[] = [];

  for (const item of scheduled) {
    const inPlanDeps = [...new Set((item.unit.dependsOn ?? []).filter((depId) => scheduledById.has(depId)))];
    remainingDeps.set(item.unit.id, inPlanDeps.length);
    if (inPlanDeps.length === 0) {
      readyQueue.push(item);
      continue;
    }
    for (const depId of inPlanDeps) {
      const list = dependents.get(depId);
      if (list) list.push(item);
      else dependents.set(depId, [item]);
    }
  }

  if (readyQueue.length === 0) {
    throw new Error(`Circular dependency detected among generated artifacts: ${scheduled.map((item) => item.unit.id).join(", ")}`);
  }

  const concurrency = Math.max(1, Math.min(maxParallel, scheduled.length));
  const activeControllers = new Set<AbortController>();
  const results: Array<ArtifactRunResult | undefined> = new Array(scheduled.length);
  const failures: ArtifactRunResult[] = [];
  const failedArtifactIds = new Set<string>();
  const taintByArtifactId = new Map<string, string[]>();
  let inFlight = 0;
  let completedCount = 0;
  let aborting = false;

  const abortActive = () => {
    aborting = true;
    readyQueue.length = 0;
    for (const controller of activeControllers) controller.abort();
  };

  console.log(`[${label}] Running ${scheduled.length} generated artifact(s) with max parallel ${concurrency}.`);

  await new Promise<void>((resolveDag, rejectDag) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectDag(error);
      else resolveDag();
    };

    const maybeFinish = () => {
      if (inFlight > 0) return;
      if (readyQueue.length > 0 && (continueOnError || !aborting)) return;
      if (!aborting && completedCount < scheduled.length) {
        const remainingIds = scheduled
          .filter((item) => results[item.index] == null)
          .map((item) => item.unit.id);
        finish(new Error(`Unresolvable dependency cycle among generated artifacts: ${remainingIds.join(", ")}`));
        return;
      }
      finish();
    };

    const schedule = () => {
      while (inFlight < concurrency && readyQueue.length > 0 && (continueOnError || !aborting)) {
        const item = readyQueue.shift()!;
        const taintedBySet = new Set<string>();
        for (const dependencyId of item.unit.dependsOn ?? []) {
          if (failedArtifactIds.has(dependencyId)) taintedBySet.add(dependencyId);
          for (const inheritedId of taintByArtifactId.get(dependencyId) ?? []) taintedBySet.add(inheritedId);
        }
        const taintedBy = [...taintedBySet].sort();
        taintByArtifactId.set(item.unit.id, taintedBy);

        const controller = new AbortController();
        activeControllers.add(controller);
        inFlight += 1;
        const startedAt = Date.now();
        const unitLabel = `${label}:phase-${item.phase}`;

        void runExecutionUnit(item.unit, {
          label: unitLabel,
          runCommandImpl,
          signal: controller.signal,
        }).then((result) => {
          activeControllers.delete(controller);
          inFlight -= 1;
          completedCount += 1;

          const artifactResult: ArtifactRunResult = {
            ...result,
            durationMs: Date.now() - startedAt,
            index: item.index,
            unit: item.unit,
            id: item.unit.id,
            phase: item.phase,
            statusLabel: result.status === 0 ? (taintedBy.length > 0 ? "tainted" : "passed") : "failed",
            taintedBy,
          };
          results[item.index] = artifactResult;

          if (result.status !== 0) {
            if (!result.aborted) {
              failedArtifactIds.add(item.unit.id);
              failures.push(artifactResult);
              console.error(
                `[${unitLabel}] FAILED: ${result.failedCmd} exited with status ${result.status}${result.error ? `: ${result.error.message}` : ""}`,
              );
            }
            if (!continueOnError) {
              abortActive();
            }
          }

          if (continueOnError || !aborting) {
            for (const dependent of dependents.get(item.unit.id) ?? []) {
              const nextRemaining = (remainingDeps.get(dependent.unit.id) ?? 1) - 1;
              remainingDeps.set(dependent.unit.id, nextRemaining);
              if (nextRemaining === 0) {
                readyQueue.push(dependent);
              }
            }
            schedule();
          }

          maybeFinish();
        }, (error) => {
          activeControllers.delete(controller);
          inFlight -= 1;
          abortActive();
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      }
      maybeFinish();
    };

    schedule();
  });

  const allResults = results.filter((result): result is ArtifactRunResult => result != null);
  if (failures.length > 0) {
    const first = failures[0];
    return {
      status: first.status,
      failedCmd: first.failedCmd,
      aborted: false,
      ...(first.error ? { error: first.error } : {}),
      failures,
      results: allResults,
    };
  }

  const firstAborted = allResults.find((result) => result.aborted);
  const aborted = firstAborted != null || completedCount < scheduled.length;
  return {
    status: firstAborted?.status ?? (aborted ? 130 : 0),
    failedCmd: firstAborted?.failedCmd ?? null,
    aborted,
    failures: [],
    results: allResults,
  };
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  runCommandImpl = runShellCommand,
}: {
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => unknown;
  runCommandImpl?: CommandImplementation;
} = {}): Promise<GeneratedArtifactsResult> {
  const {
    bootstrap,
    buildLifecycles,
    check,
    integrityOnly,
    continueOnError: cliContinueOnError,
    dryRun,
    help,
    only,
    phases,
    skipExistingDeps: cliSkipExistingDeps,
  } = parseGeneratedArtifactsArgs(argv);
  const continueOnError = cliContinueOnError || env.GENERATED_ARTIFACTS_CONTINUE_ON_ERROR === "1";
  const skipExistingDeps = cliSkipExistingDeps || env.PHAROS_GENERATED_SKIP_EXISTING_DEPS === "1";
  if (help) {
    printGeneratedArtifactsHelp(log);
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const label = check
    ? "generated-artifacts:check"
    : bootstrap
      ? "generated-artifacts:bootstrap"
      : "generated-artifacts";
  const { executionPhases, skippedIds } = planGeneratedArtifactExecutionPhases({
    bootstrap,
    buildLifecycles,
    check,
    cwd,
    integrityOnly,
    only,
    phases,
    skipExistingDeps,
  });

  if (skippedIds.length > 0) {
    log(`[generated-artifacts] Skipping ${skippedIds.length} existing transitive dependency artifact(s): ${skippedIds.join(", ")}`);
  }

  if (executionPhases.length === 0) {
    log("[generated-artifacts] No eligible generated artifacts selected; skipping (no checks executed).");
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  if (dryRun) {
    const commandCount = executionPhases.reduce((sum, phase) => sum + phase.units.length, 0);
    log(`[generated-artifacts] Dry run enabled; ${commandCount} command(s) will not execute.`);
    log("[generated-artifacts] Command plan:");
    for (const { phase, units } of executionPhases) {
      log(`phase ${phase}:`);
      for (const [index, unit] of units.entries()) {
        log(`  ${index + 1}. ${unit.commands[0]}`);
      }
    }
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  return runGeneratedArtifactDag(executionPhases, {
    continueOnError,
    label,
    maxParallel: GENERATED_ARTIFACTS_MAX_PARALLEL,
    runCommandImpl,
  });
}

async function runDirect(): Promise<void> {
  try {
    const result = await runGeneratedArtifacts();
    if (result.status !== 0 && result.failedCmd?.match(/generate-(?:sitemap-dates|docs-metadata)\.ts(?:\s|$)/)) {
      console.error(
        `[generated-artifacts] ${result.failedCmd} targets a build-time, Git-history-derived artifact marked checkable: false. ` +
          "This is expected when the checkout is shallow or required history is missing. " +
          "Fetch full Git history, then run `npm run bootstrap:generated:history`; do not retry the same history-derived check until history is available.",
      );
    }
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runDirect();
}
