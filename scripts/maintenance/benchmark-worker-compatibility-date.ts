#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKER_CONFIG = "worker/wrangler.toml";

interface BenchmarkOptions {
  candidateDate: string | null;
  baselineDate: string | null;
  output: string | null;
  skipLocalSmoke: boolean;
  dryRun: boolean;
}

interface CommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

interface DateResult {
  label: string;
  date: string;
  bundleBytes: number;
  checks: CommandResult[];
}

function usage(): void {
  console.log(`Usage: node --import tsx scripts/maintenance/benchmark-worker-compatibility-date.ts --candidate-date YYYY-MM-DD [options]

Builds and smoke-tests the current and candidate Workers compatibility dates
without editing wrangler.toml or deploying. The candidate date belongs in a
separate release only after this report is reviewed.

Options:
  --candidate-date <date>  Candidate compatibility date (required)
  --baseline-date <date>   Override checked-in baseline date
  --output <path>          JSON report path (default: agents/worker-compatibility-<timestamp>.json)
  --skip-local-smoke       Run bundle/startup checks only
  --dry-run                Print commands without executing them
  --help                   Show this help
`);
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function validDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${flag} must use a valid YYYY-MM-DD date`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    candidateDate: null,
    baselineDate: null,
    output: null,
    skipLocalSmoke: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--candidate-date") options.candidateDate = validDate(readValue(argv, ++index, arg), arg);
    else if (arg === "--baseline-date") options.baselineDate = validDate(readValue(argv, ++index, arg), arg);
    else if (arg === "--output") options.output = readValue(argv, ++index, arg);
    else if (arg === "--skip-local-smoke") options.skipLocalSmoke = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.candidateDate) throw new Error("--candidate-date is required");
  return options;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        stdoutTail: stdout.slice(-16_000),
        stderrTail: stderr.slice(-16_000),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`Command failed (${code}): ${result.command}`), { result }));
    });
  });
}

function commandPlan(date: string, bundlePath: string, includeSmoke: boolean): Array<[string, string[]]> {
  const commands: Array<[string, string[]]> = [
    ["npx", ["--no-install", "wrangler", "deploy", "--config", WORKER_CONFIG, "--dry-run", "--compatibility-date", date, "--outfile", bundlePath]],
    [
      "npx",
      [
        "--no-install",
        "wrangler",
        "check",
        "startup",
        "--workerBundle",
        bundlePath,
        "--outfile",
        `${bundlePath}.cpuprofile`,
      ],
    ],
  ];
  if (includeSmoke) {
    commands.push(["node", ["scripts/maintenance/run-worker-smoke.mjs"]]);
  }
  return commands;
}

async function runDate(label: string, date: string, tempDirectory: string, includeSmoke: boolean): Promise<DateResult> {
  const bundlePath = path.join(tempDirectory, `${label}.mjs`);
  const commands = commandPlan(date, bundlePath, includeSmoke);
  const results = [];
  for (const [command, args] of commands) {
    const env = command === "node"
      ? {
          ...process.env,
          WORKER_SMOKE_COMPATIBILITY_DATE: date,
          WORKER_SMOKE_ISOLATED: "true",
          WORKER_SMOKE_MODE: "runtime",
        }
      : process.env;
    results.push(await run(command, args, { env }));
  }
  return {
    label,
    date,
    bundleBytes: (await stat(bundlePath)).size,
    checks: results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readFile(WORKER_CONFIG, "utf8");
  const checkedInDate = config.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/m)?.[1];
  const baselineDate = options.baselineDate ?? checkedInDate;
  if (!baselineDate) throw new Error(`Could not read compatibility_date from ${WORKER_CONFIG}`);
  const candidateDate = options.candidateDate;
  if (!candidateDate) throw new Error("--candidate-date is required");
  if (candidateDate <= baselineDate) {
    throw new Error(`Candidate date ${candidateDate} must be later than baseline ${baselineDate}`);
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "pharos-worker-compatibility-"));
  try {
    if (options.dryRun) {
      for (const [label, date] of [["baseline", baselineDate], ["candidate", candidateDate]] as Array<[string, string]>) {
        const bundlePath = path.join(tempDirectory, `${label}.mjs`);
        for (const [command, args] of commandPlan(date, bundlePath, !options.skipLocalSmoke)) {
          console.log([command, ...args].join(" "));
        }
      }
      return;
    }

    const generatedAt = new Date().toISOString();
    const baseline = await runDate("baseline", baselineDate, tempDirectory, !options.skipLocalSmoke);
    const candidate = await runDate("candidate", candidateDate, tempDirectory, !options.skipLocalSmoke);
    const report: {
      generatedAt: string;
      workerConfig: string;
      baseline: DateResult;
      candidate: DateResult;
      bundleDeltaBytes: number;
      deployed: false;
    } = {
      generatedAt,
      workerConfig: WORKER_CONFIG,
      baseline,
      candidate,
      bundleDeltaBytes: candidate.bundleBytes - baseline.bundleBytes,
      deployed: false,
    };
    const output = options.output
      ?? path.join("agents", `worker-compatibility-${generatedAt.replace(/[:.]/g, "-")}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[worker-compatibility] wrote ${output}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && "result" in error) console.error(JSON.stringify(error.result, null, 2));
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
