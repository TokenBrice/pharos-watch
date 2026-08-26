#!/usr/bin/env node

import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  createNpmScriptCommand,
  createSpawnCommand,
  runSpawnCommand,
  type CommandResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: node --import tsx scripts/maintenance/refresh-pages-release-data.ts [options]

Options:
  --refresh-dir <path>  Directory for snapshots, logs, and the default result JSON
  --result <path>       Machine-readable result path (default: <refresh-dir>/result.json)
  -h, --help            Show this help`;

export interface ReleaseRefreshResult {
  depegEvents: { ok: boolean };
  digests: { committedCount: number; ok: boolean; refreshedCount: number; shrinkRejected: boolean };
  publicDatasets: { ok: boolean; rolledBack: boolean };
  resultPath: string;
}

interface RefreshProducerContext {
  outputPath?: string;
}

type RefreshProducer = (context: RefreshProducerContext) => Promise<CommandResult>;

export interface ReleaseRefreshDependencies {
  depegEvents: RefreshProducer;
  digests: RefreshProducer;
  publicDatasets: RefreshProducer;
  rollbackPublicDatasets: () => Promise<CommandResult>;
}

export interface RefreshPagesReleaseDataOptions {
  dependencies?: Partial<ReleaseRefreshDependencies>;
  env?: NodeJS.ProcessEnv;
  refreshDir?: string;
  repoRoot?: string;
  resultPath?: string;
}

function captured(command: SpawnCommand): Promise<CommandResult> {
  return runSpawnCommand({ ...command, captureOutput: true });
}

function defaultDependencies(): ReleaseRefreshDependencies {
  return {
    digests: ({ outputPath }) => captured(createSpawnCommand(localBin("tsx"), [
      "scripts/maintenance/sync-digests.ts",
      "--output",
      outputPath!,
    ])),
    depegEvents: ({ outputPath }) => captured(createSpawnCommand(localBin("tsx"), [
      "scripts/maintenance/sync-depeg-events.ts",
      "--output",
      outputPath!,
    ])),
    publicDatasets: () => captured(createNpmScriptCommand("generate:public-datasets")),
    rollbackPublicDatasets: async () => {
      const checkout = await captured(createSpawnCommand("git", ["checkout", "--", "public/datasets"]));
      if (checkout.status !== 0) return checkout;
      const clean = await captured(createSpawnCommand("git", ["clean", "-fd", "--", "public/datasets"]));
      return { ...clean, output: `${checkout.output ?? ""}${clean.output ?? ""}` };
    },
  };
}

function readJsonArrayCount(path: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

async function settledProducer(
  producer: RefreshProducer,
  context: RefreshProducerContext,
): Promise<CommandResult> {
  try {
    const result = await producer(context);
    if (result.error && !result.output) return { ...result, output: `${result.error.message}\n` };
    return result;
  } catch (error) {
    return {
      aborted: false,
      status: 1,
      output: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

function appendLog(log: string, message: string): string {
  return `${log}${log.length > 0 && !log.endsWith("\n") ? "\n" : ""}${message}\n`;
}

export async function refreshPagesReleaseData({
  dependencies: overrides = {},
  env = process.env,
  refreshDir,
  repoRoot = process.cwd(),
  resultPath,
}: RefreshPagesReleaseDataOptions = {}): Promise<ReleaseRefreshResult> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const resolvedRefreshDir = resolve(
    refreshDir
      ?? join(
        env.RUNNER_TEMP || tmpdir(),
        `pages-refresh-${env.GITHUB_RUN_ID || "local"}-${env.GITHUB_RUN_ATTEMPT || "1"}`,
      ),
  );
  mkdirSync(resolvedRefreshDir, { recursive: true });

  const committedDigestPath = join(repoRoot, "data/digests.json");
  const committedDepegPath = join(repoRoot, "data/depeg-events.json");
  const refreshedDigestPath = join(resolvedRefreshDir, "digests.json");
  const refreshedDepegPath = join(resolvedRefreshDir, "depeg-events.json");
  copyFileSync(committedDigestPath, refreshedDigestPath);
  copyFileSync(committedDepegPath, refreshedDepegPath);
  const committedCount = readJsonArrayCount(committedDigestPath);

  const [digestRun, depegRun, datasetsRun] = await Promise.all([
    settledProducer(dependencies.digests, { outputPath: refreshedDigestPath }),
    settledProducer(dependencies.depegEvents, { outputPath: refreshedDepegPath }),
    settledProducer(dependencies.publicDatasets, {}),
  ]);

  const refreshedCount = readJsonArrayCount(refreshedDigestPath);
  const shrinkRejected = digestRun.status === 0 && refreshedCount < committedCount;
  const digestOk = digestRun.status === 0 && !shrinkRejected;
  let digestLog = digestRun.output ?? "";
  if (shrinkRejected) {
    digestLog = appendLog(
      digestLog,
      `::warning::digest archive shrank (${refreshedCount} < ${committedCount}); using committed snapshot`,
    );
  }
  if (digestOk) renameSync(refreshedDigestPath, committedDigestPath);
  else digestLog = appendLog(digestLog, "::warning::digest refresh failed; using committed digest snapshot");

  const depegOk = depegRun.status === 0;
  let depegLog = depegRun.output ?? "";
  if (depegOk) renameSync(refreshedDepegPath, committedDepegPath);
  else depegLog = appendLog(depegLog, "::warning::depeg-event refresh failed; using committed depeg snapshot");

  const datasetsOk = datasetsRun.status === 0;
  let datasetsLog = datasetsRun.output ?? "";
  let rolledBack = false;
  if (!datasetsOk) {
    datasetsLog = appendLog(
      datasetsLog,
      "::warning::public-dataset refresh failed; using committed public datasets",
    );
    const rollback = await dependencies.rollbackPublicDatasets();
    rolledBack = rollback.status === 0;
    datasetsLog += rollback.output ?? "";
    if (!rolledBack) {
      datasetsLog = appendLog(datasetsLog, "::warning::public-dataset rollback failed");
    }
  }

  process.stdout.write(digestLog);
  process.stdout.write(depegLog);
  process.stdout.write(datasetsLog);
  writeFileSync(join(resolvedRefreshDir, "digest.log"), digestLog);
  writeFileSync(join(resolvedRefreshDir, "depeg.log"), depegLog);
  writeFileSync(join(resolvedRefreshDir, "datasets.log"), datasetsLog);

  const summary = [
    `- Digest refresh: ${digestOk} (${refreshedCount} entries)`,
    `- Depeg-event refresh: ${depegOk}`,
    `- Public-dataset refresh: ${datasetsOk}`,
  ].join("\n") + "\n";
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  const resolvedResultPath = resolve(resultPath ?? join(resolvedRefreshDir, "result.json"));
  const result: ReleaseRefreshResult = {
    digests: { committedCount, ok: digestOk, refreshedCount, shrinkRejected },
    depegEvents: { ok: depegOk },
    publicDatasets: { ok: datasetsOk, rolledBack },
    resultPath: resolvedResultPath,
  };
  writeFileSync(resolvedResultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  return result;
}

function parseArgs(argv: string[]) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "refresh-dir": { type: "string" },
      result: { type: "string" },
    },
  });
  return {
    help: values.help === true,
    refreshDir: typeof values["refresh-dir"] === "string" ? values["refresh-dir"] : undefined,
    resultPath: typeof values.result === "string" ? values.result : undefined,
  };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(async () => {
    const options = parseArgs(process.argv.slice(2));
    if (writeCliHelpIfRequested(options, USAGE)) return;
    await refreshPagesReleaseData(options);
  }, { label: "refresh-pages-release-data", usage: USAGE });
}
