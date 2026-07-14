#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits, runShellCommand } from "../lib/command-runner.mjs";
import { buildGeneratedArtifactPhases } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

// Each phase is a dependency barrier. Four-way concurrency keeps the
// browser-rendering OG builders from stacking up on constrained runners.
export const GENERATED_ARTIFACTS_MAX_PARALLEL = 4;

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactExecutionUnits({
  bootstrap = false,
  check = false,
  only = [],
  phases = [],
  skip = [],
} = {}) {
  return buildGeneratedArtifactExecutionPhases({ bootstrap, check, only, phases, skip }).flatMap(({ units }) => units);
}

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactExecutionPhases({
  bootstrap = false,
  check = false,
  only = [],
  phases = [],
  skip = [],
} = {}) {
  return buildGeneratedArtifactPhases({ bootstrap, check, only, phases, skip }).map(({ phase, artifacts }) => ({
    phase,
    units: artifacts.map((artifact) => createExecutionUnit([artifact.command])),
  }));
}

function parseListValue(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePhaseList(value) {
  return parseListValue(value).map((phase) => {
    if (!/^\d+$/.test(phase)) {
      throw new Error(`Invalid generated artifact phase: ${phase}`);
    }
    return Number.parseInt(phase, 10);
  });
}

export function parseGeneratedArtifactsArgs(argv = []) {
  const options = {
    bootstrap: false,
    check: false,
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
  options.phases = [...new Set(options.phases)].sort((left, right) => left - right);
  return options;
}

export function printGeneratedArtifactsHelp(log = console.log) {
  log("Usage: npm run prebuild -- [--bootstrap|--check] [--only id[,id]] [--phase n[,n]] [--dry-run|--help]");
  log("");
  log("Options:");
  log("  --bootstrap       Run only bootstrap-safe generators (ignored in --check mode).");
  log("  --check           Verify generated artifacts instead of writing them.");
  log("  --only <ids>      Run one or more artifact ids and their declared dependencies.");
  log("  --phase <phases>  Run artifacts in one or more numeric dependency phases.");
  log("  --dry-run         Print the resolved command plan without executing commands.");
  log("  --help, -h        Print this help text.");
}

export function parseGeneratedArtifactsSkip(env = process.env) {
  return (env.GENERATED_ARTIFACTS_SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function resolveGeneratedArtifactsSkip({ check = false, env = process.env } = {}) {
  // Freshness validation must inspect the full artifact registry.
  return check ? [] : parseGeneratedArtifactsSkip(env);
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  env = process.env,
  exit = process.exit,
  log = console.log,
  runCommandImpl = runShellCommand,
} = {}) {
  const { bootstrap, check, dryRun, help, only, phases } = parseGeneratedArtifactsArgs(argv);
  if (help) {
    printGeneratedArtifactsHelp(log);
    return { status: 0, failedCmd: null, aborted: false };
  }

  const skip = resolveGeneratedArtifactsSkip({ check, env });
  if (skip.length > 0) {
    log(`[generated-artifacts] Skipping (verified separately by check:generated-artifacts): ${skip.join(", ")}`);
  }

  const label = check
    ? "generated-artifacts:check"
    : bootstrap
      ? "generated-artifacts:bootstrap"
      : "generated-artifacts";
  const executionPhases = buildGeneratedArtifactExecutionPhases({ bootstrap, check, only, phases, skip });

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
    return { status: 0, failedCmd: null, aborted: false };
  }

  for (const { phase, units } of executionPhases) {
    const result = await runParallelExecutionUnits(units, {
      exit,
      label: `${label}:phase-${phase}`,
      maxParallel: GENERATED_ARTIFACTS_MAX_PARALLEL,
      runCommandImpl,
    });
    if (result.status !== 0) return result;
  }

  return { status: 0, failedCmd: null, aborted: false };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runGeneratedArtifacts().catch((error) => {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
