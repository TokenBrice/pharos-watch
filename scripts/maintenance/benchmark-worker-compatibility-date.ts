#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStrictCliArgs, requireCliString } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
export const WORKER_CONFIGS = { public: "worker/wrangler.toml", heavy: "worker/wrangler.heavy.toml" } as const;
type WorkerRole = keyof typeof WORKER_CONFIGS;

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
  label: "baseline" | "candidate";
  role: WorkerRole;
  config: string;
  date: string;
  bundleBytes: number | null;
  checks: CommandResult[];
  bundle: "passed" | "failed" | "skipped";
  startup: "passed" | "failed" | "skipped";
  smoke: "passed" | "failed" | "skipped";
  error: string | null;
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


function validDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${flag} must use a valid YYYY-MM-DD date`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): BenchmarkOptions {
  const { values } = parseStrictCliArgs(argv, { options: {
    "candidate-date": { type: "string" },
    "baseline-date": { type: "string" },
    output: { type: "string" },
    "skip-local-smoke": { type: "boolean" },
    "dry-run": { type: "boolean" },
  } });
  if (values.help) { usage(); process.exit(0); }
  return {
    candidateDate: validDate(requireCliString(values["candidate-date"], "--candidate-date"), "--candidate-date"),
    baselineDate: typeof values["baseline-date"] === "string" ? validDate(values["baseline-date"], "--baseline-date") : null,
    output: typeof values.output === "string" ? values.output : null,
    skipLocalSmoke: values["skip-local-smoke"] === true,
    dryRun: values["dry-run"] === true,
  };
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

export function commandPlan(role: WorkerRole, date: string, bundlePath: string, includeSmoke: boolean): Array<[string, string[]]> {
  const commands: Array<[string, string[]]> = [
    ["npx", ["--no-install", "wrangler", "deploy", "--config", WORKER_CONFIGS[role], "--dry-run", "--compatibility-date", date, "--outfile", bundlePath]],
    ["npx", ["--no-install", "wrangler", "check", "startup", "--workerBundle", bundlePath, "--outfile", `${bundlePath}.cpuprofile`]],
  ];
  if (includeSmoke) commands.push(["node", ["scripts/maintenance/run-worker-smoke.mjs"]]);
  return commands;
}

async function runDate(role: WorkerRole, label: DateResult["label"], date: string, tempDirectory: string, includeSmoke: boolean): Promise<DateResult> {
  const bundlePath = path.join(tempDirectory, `${role}-${label}.mjs`);
  const result: DateResult = {
    role, label, config: WORKER_CONFIGS[role], date, bundleBytes: null, checks: [],
    bundle: "skipped", startup: "skipped", smoke: "skipped", error: null,
  };
  const stages = ["bundle", "startup", "smoke"] as const;
  for (const [index, [command, args]] of commandPlan(role, date, bundlePath, includeSmoke).entries()) {
    const stage = stages[index];
    try {
      const env = command === "node" ? {
        ...process.env,
        WORKER_SMOKE_CONFIG: WORKER_CONFIGS[role],
        WORKER_SMOKE_COMPATIBILITY_DATE: date,
        WORKER_SMOKE_ISOLATED: "true",
        WORKER_SMOKE_MODE: role === "heavy" ? "scheduled-heavy" : "runtime",
      } : process.env;
      result.checks.push(await run(command, args, { env }));
      if (stage === "bundle") result.bundleBytes = (await stat(bundlePath)).size;
      result[stage] = "passed";
    } catch (error) {
      result[stage] = "failed";
      result.error = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && "result" in error) result.checks.push(error.result as CommandResult);
      break;
    }
  }
  return result;
}

export function qualificationComplete(results: readonly DateResult[]): boolean {
  return (["public", "heavy"] as const).every((role) =>
    (["baseline", "candidate"] as const).every((label) => {
      const matches = results.filter((result) => result.role === role && result.label === label);
      return matches.length === 1 && ["bundle", "startup", "smoke"].every(
        (stage) => matches[0][stage as "bundle" | "startup" | "smoke"] === "passed",
      );
    }),
  );
}

export function pairedBaselineDate(publicConfig: string, heavyConfig: string): string {
  const readDate = (config: string) => config.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/m)?.[1];
  const publicDate = readDate(publicConfig);
  const heavyDate = readDate(heavyConfig);
  if (!publicDate || !heavyDate || publicDate !== heavyDate) throw new Error("Public and Heavy checked-in compatibility dates must match");
  return publicDate;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checkedInDate = pairedBaselineDate(
    await readFile(WORKER_CONFIGS.public, "utf8"),
    await readFile(WORKER_CONFIGS.heavy, "utf8"),
  );
  const baselineDate = options.baselineDate ?? checkedInDate;
  const candidateDate = options.candidateDate;
  if (!candidateDate) throw new Error("--candidate-date is required");
  if (candidateDate <= baselineDate) {
    throw new Error(`Candidate date ${candidateDate} must be later than baseline ${baselineDate}`);
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "pharos-worker-compatibility-"));
  try {
    if (options.dryRun) {
      for (const role of ["public", "heavy"] as const) {
        for (const [label, date] of [["baseline", baselineDate], ["candidate", candidateDate]] as const) {
          const bundlePath = path.join(tempDirectory, `${role}-${label}.mjs`);
          for (const [command, args] of commandPlan(role, date, bundlePath, !options.skipLocalSmoke)) {
            console.log(`role=${role} config=${WORKER_CONFIGS[role]} date=${date} ${[command, ...args].join(" ")}`);
          }
        }
      }
      return;
    }

    const generatedAt = new Date().toISOString();
    const results: DateResult[] = [];
    for (const role of ["public", "heavy"] as const) {
      for (const [label, date] of [["baseline", baselineDate], ["candidate", candidateDate]] as const) {
        results.push(await runDate(role, label, date, tempDirectory, !options.skipLocalSmoke));
      }
    }
    const complete = qualificationComplete(results);
    const report = {
      generatedAt, checkedInDate, baselineDate, candidateDate, results,
      completeness: complete ? "complete" : "incomplete",
      promotionReady: complete,
      localOnly: true,
      heavySmokeScope: "isolated-absent-core-neutral-admission; not Heavy producer acceptance",
      deployed: false,
    };
    const output = options.output
      ?? path.join("agents", `worker-compatibility-${generatedAt.replace(/[:.]/g, "-")}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[worker-compatibility] wrote ${output}`);
    if (results.some((result) => result.error)) process.exitCode = 1;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
