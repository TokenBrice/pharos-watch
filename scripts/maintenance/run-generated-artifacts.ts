#!/usr/bin/env node

import {
  createExecutionUnit,
  runParallelExecutionUnits,
  runShellCommand,
  type CommandImplementation,
} from "../lib/command-runner.mts";
import { buildGeneratedArtifactPhases } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

// Each phase is a dependency barrier. Four-way concurrency keeps the
// browser-rendering OG builders from stacking up on constrained runners.
export const GENERATED_ARTIFACTS_MAX_PARALLEL = 4;

interface GeneratedArtifactOptions {
  bootstrap?: boolean;
  buildLifecycles?: readonly string[];
  check?: boolean;
  only?: readonly string[];
  phases?: readonly number[];
}

interface GeneratedArtifactDefinition {
  id: string;
  command: string;
  dependsOn?: string[];
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
  failures: RunnerUnitResult[];
  results: ArtifactRunResult[];
}

export function buildGeneratedArtifactExecutionUnits({
  bootstrap = false,
  buildLifecycles = [],
  check = false,
  only = [],
  phases = [],
}: GeneratedArtifactOptions = {}): ArtifactExecutionUnit[] {
  return buildGeneratedArtifactExecutionPhases({ bootstrap, buildLifecycles, check, only, phases }).flatMap(
    ({ units }) => units,
  );
}

export function buildGeneratedArtifactExecutionPhases({
  bootstrap = false,
  buildLifecycles = [],
  check = false,
  only = [],
  phases = [],
}: GeneratedArtifactOptions = {}): ArtifactExecutionPhase[] {
  const registryPhases: GeneratedArtifactPhase[] = buildGeneratedArtifactPhases({
    bootstrap,
    buildLifecycles: [...buildLifecycles],
    check,
    only: [...only],
    phases: [...phases],
  });
  return registryPhases.map(({ phase, artifacts }) => ({
    phase,
    units: artifacts.map<ArtifactExecutionUnit>((artifact) =>
      createExecutionUnit([artifact.command], {
        dependsOn: artifact.dependsOn ?? [],
        id: artifact.id,
      }),
    ),
  }));
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
  continueOnError: boolean;
  dryRun: boolean;
  help: boolean;
  only: string[];
  phases: number[];
} {
  const options: {
    bootstrap: boolean;
    buildLifecycles: string[];
    check: boolean;
    continueOnError: boolean;
    dryRun: boolean;
    help: boolean;
    only: string[];
    phases: number[];
  } = {
    bootstrap: false,
    buildLifecycles: [],
    check: false,
    continueOnError: false,
    dryRun: false,
    help: false,
    only: [],
    phases: [],
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
    "Usage: npm run prebuild -- [--bootstrap|--check] [--build-lifecycle name[,name]] [--continue-on-error] [--only id[,id]] [--phase n[,n]] [--dry-run|--help]",
  );
  log("");
  log("Options:");
  log("  --bootstrap       Run only bootstrap-safe generators (ignored in --check mode).");
  log("  --check           Verify generated artifacts instead of writing them.");
  log("  --build-lifecycle <names>  Run artifacts in one or more declared build lifecycle groups.");
  log("  --continue-on-error  Diagnostic mode: retain all failures and continue through dependency phases.");
  log("  --only <ids>      Run one or more artifact ids and their declared dependencies.");
  log("  --phase <phases>  Run artifacts in one or more numeric dependency phases.");
  log("  --dry-run         Print the resolved command plan without executing commands.");
  log("  --help, -h        Print this help text.");
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  runCommandImpl = runShellCommand,
}: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => unknown;
  runCommandImpl?: CommandImplementation;
} = {}): Promise<GeneratedArtifactsResult> {
  const { bootstrap, buildLifecycles, check, continueOnError: cliContinueOnError, dryRun, help, only, phases } =
    parseGeneratedArtifactsArgs(argv);
  const continueOnError = cliContinueOnError || env.GENERATED_ARTIFACTS_CONTINUE_ON_ERROR === "1";
  if (help) {
    printGeneratedArtifactsHelp(log);
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const label = check
    ? "generated-artifacts:check"
    : bootstrap
      ? "generated-artifacts:bootstrap"
      : "generated-artifacts";
  const executionPhases = buildGeneratedArtifactExecutionPhases({
    bootstrap,
    buildLifecycles,
    check,
    only,
    phases,
  });

  if (dryRun) {
    const commandCount = executionPhases.reduce((sum, phase) => sum + phase.units.length, 0);
    log(`[generated-artifacts] Dry run enabled; ${commandCount} command(s) will not execute.`);
    log("[generated-artifacts] Command plan:");
    if (executionPhases.length === 0) {
      log("(no generated artifacts selected)");
    }
    for (const { phase, units } of executionPhases) {
      log(`phase ${phase}:`);
      for (const [index, unit] of units.entries()) {
        log(`  ${index + 1}. ${unit.commands[0]}`);
      }
    }
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const allResults: ArtifactRunResult[] = [];
  const failedArtifactIds = new Set<string>();
  const taintByArtifactId = new Map<string, string[]>();

  for (const { phase, units } of executionPhases) {
    for (const unit of units) {
      const taintedBy = new Set<string>();
      for (const dependencyId of unit.dependsOn ?? []) {
        if (failedArtifactIds.has(dependencyId)) taintedBy.add(dependencyId);
        for (const inheritedId of taintByArtifactId.get(dependencyId) ?? []) taintedBy.add(inheritedId);
      }
      taintByArtifactId.set(unit.id, [...taintedBy].sort());
    }

    const result = await runParallelExecutionUnits(units, {
      continueOnError,
      label: `${label}:phase-${phase}`,
      maxParallel: GENERATED_ARTIFACTS_MAX_PARALLEL,
      runCommandImpl,
    });
    for (const unitResult of result.results ?? []) {
      const artifactId = unitResult.unit.id;
      const taintedBy = taintByArtifactId.get(artifactId) ?? [];
      const artifactResult: ArtifactRunResult = {
        ...unitResult,
        id: artifactId,
        phase,
        statusLabel: unitResult.status === 0 ? (taintedBy.length > 0 ? "tainted" : "passed") : "failed",
        taintedBy,
      };
      allResults.push(artifactResult);
      if (unitResult.status !== 0 && !unitResult.aborted) failedArtifactIds.add(artifactId);
    }

    if (result.status !== 0 && !continueOnError) {
      return { ...result, results: allResults };
    }
  }

  const failures = allResults.filter((result) => result.status !== 0 && !result.aborted);
  const firstFailure = failures[0];
  return {
    status: firstFailure?.status ?? 0,
    failedCmd: firstFailure?.failedCmd ?? null,
    aborted: false,
    failures,
    results: allResults,
  };
}

async function runDirect(): Promise<void> {
  try {
    const result = await runGeneratedArtifacts();
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runDirect();
}
