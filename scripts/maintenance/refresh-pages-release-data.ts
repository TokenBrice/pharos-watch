#!/usr/bin/env node

import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatUtcDateOnly } from "@shared/lib/format";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { PublicSnapshotEnvelopeSchema } from "@shared/types/public-snapshot";
import { isProjectionEnvelope, PUBLIC_DATASETS_REQUIRE_CURRENT_SAFETY } from "../lib/public-dataset-projections";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  createSpawnCommand,
  runSpawnCommand,
  type CommandResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  fetchWithRetry,
  GENERATOR_API_URL_ENV_NAMES,
  generatorFetchHeaders,
  resolveApiPathUrl,
} from "../lib/sync-from-api";

const USAGE = `Usage: node --import tsx scripts/maintenance/refresh-pages-release-data.ts [options]

Options:
  --refresh-dir <path>  Directory for snapshots, logs, and the default result JSON
  --result <path>       Machine-readable result path (default: <refresh-dir>/result.json)
  -h, --help            Show this help`;

const PUBLIC_DATASET_BUNDLE_PATHS = [
  "public/datasets",
  "public/_redirects",
  "src/lib/datasets/public-dataset-current.ts",
] as const;

export interface ReleaseRefreshResult {
  depegEvents: { durationMs: number; ok: boolean };
  digests: { committedCount: number; durationMs: number; ok: boolean; refreshedCount: number; shrinkRejected: boolean };
  publicDatasets: { durationMs: number; ok: boolean; rolledBack: boolean };
  resultPath: string;
}

export function shouldFailReleaseRefresh(result: ReleaseRefreshResult): boolean {
  const allProducersFailed =
    !result.digests.ok && !result.depegEvents.ok && !result.publicDatasets.ok;
  const rollbackFailed = !result.publicDatasets.ok && !result.publicDatasets.rolledBack;
  return allProducersFailed || rollbackFailed;
}

interface RefreshProducerContext {
  outputPath?: string;
  snapshotFile?: string;
}

type RefreshProducer = (context: RefreshProducerContext) => Promise<CommandResult>;
type SettledProducerResult = CommandResult & { durationMs: number };

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

function captured(command: SpawnCommand, extraEnv?: Record<string, string>): Promise<CommandResult> {
  return runSpawnCommand({ ...command, captureOutput: true }, extraEnv);
}

function resolvePrefetchApiBase(env: NodeJS.ProcessEnv): string | null {
  const raw = GENERATOR_API_URL_ENV_NAMES.map((name) => env[name]?.trim()).find((value) => value);
  return raw ? raw.replace(/\/+$/, "") : null;
}

async function prefetchPublicSnapshot(
  apiBase: string,
  snapshotDate: string,
  destinationPath: string,
): Promise<{ snapshotFile?: string; log: string }> {
  const url = resolveApiPathUrl(apiBase, `/api/snapshots/${snapshotDate}.json`);
  try {
    const headers = await generatorFetchHeaders(url);
    const response = await fetchWithRetry(url, { headers }, { logLabel: "refresh-pages-release-data" });
    if (!response.ok) {
      await response.body?.cancel();
      return { log: `[refresh-pages-release-data] Snapshot prefetch ${url} returned HTTP ${response.status}; falling back to generator fetch\n` };
    }
    const text = await response.text();
    const parsed = PublicSnapshotEnvelopeSchema.safeParse(JSON.parse(text));
    if (!parsed.success || !isProjectionEnvelope(parsed.data) || parsed.data.snapshotDate !== snapshotDate) {
      return { log: `[refresh-pages-release-data] Snapshot prefetch ${url} returned an invalid or mismatched envelope; falling back to generator fetch\n` };
    }
    writeFileSync(destinationPath, text, "utf8");
    return {
      snapshotFile: destinationPath,
      log: `[refresh-pages-release-data] Prefetched immutable public snapshot ${snapshotDate} to ${destinationPath}\n`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { log: `[refresh-pages-release-data] Snapshot prefetch ${url} failed (${reason}); falling back to generator fetch\n` };
  }
}

function defaultDependencies(
  repoRoot: string,
  datasetBackupDir: string,
  targetDatasetDate: string,
  explicitDatasetDate?: string,
): ReleaseRefreshDependencies {
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
    publicDatasets: ({ snapshotFile }) => {
      const args = [
        "scripts/maintenance/generate-public-datasets.ts",
        ...(!explicitDatasetDate ? ["--repoint-current"] : []),
        ...(snapshotFile ? ["--snapshot-file", snapshotFile] : []),
      ];
      return captured(
        createSpawnCommand(localBin("tsx"), args),
        explicitDatasetDate
          ? { PUBLIC_DATASETS_DATE: targetDatasetDate }
          : { PUBLIC_DATASETS_DATE: targetDatasetDate, [PUBLIC_DATASETS_REQUIRE_CURRENT_SAFETY]: "1" },
      );
    },
    rollbackPublicDatasets: async () => {
      for (const path of PUBLIC_DATASET_BUNDLE_PATHS) {
        const target = join(repoRoot, path);
        const backup = join(datasetBackupDir, path);
        rmSync(target, { recursive: true, force: true });
        if (existsSync(backup)) {
          mkdirSync(dirname(target), { recursive: true });
          cpSync(backup, target, { recursive: true });
        }
      }
      return { status: 0, aborted: false, output: "Restored pre-refresh public dataset bundle\n" };
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
): Promise<SettledProducerResult> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  try {
    const result = await producer(context);
    if (result.error && !result.output) return { ...result, output: `${result.error.message}\n`, durationMs: elapsed() };
    return { ...result, durationMs: elapsed() };
  } catch (error) {
    return {
      aborted: false,
      status: 1,
      output: `${error instanceof Error ? error.message : String(error)}\n`,
      durationMs: elapsed(),
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
  const resolvedRefreshDir = resolve(
    refreshDir
      ?? join(
        env.RUNNER_TEMP || tmpdir(),
        `pages-refresh-${env.GITHUB_RUN_ID || "local"}-${env.GITHUB_RUN_ATTEMPT || "1"}`,
      ),
  );
  mkdirSync(resolvedRefreshDir, { recursive: true });
  const datasetBackupDir = join(resolvedRefreshDir, "public-dataset-bundle");
  const explicitDatasetDate = env.PUBLIC_DATASETS_DATE?.trim() || undefined;
  // The current UTC date is still open for depeg onsets when Pages refreshes.
  const targetDatasetDate = explicitDatasetDate ?? formatUtcDateOnly(new Date(Date.now() - DAY_SECONDS * 1_000));
  const dependencies = {
    ...defaultDependencies(repoRoot, datasetBackupDir, targetDatasetDate, explicitDatasetDate),
    ...overrides,
  };

  const committedDigestPath = join(repoRoot, "data/digests.json");
  const committedDepegPath = join(repoRoot, "data/depeg-events");
  const refreshedDigestPath = join(resolvedRefreshDir, "digests.json");
  const refreshedDepegPath = join(resolvedRefreshDir, "depeg-events", "index.json");
  copyFileSync(committedDigestPath, refreshedDigestPath);
  cpSync(committedDepegPath, join(resolvedRefreshDir, "depeg-events"), { recursive: true });
  const committedCount = readJsonArrayCount(committedDigestPath);
  const prefetchApiBase = !overrides.publicDatasets ? resolvePrefetchApiBase(env) : null;

  const [digestRun, depegRun, prefetchedSnapshot] = await Promise.all([
    settledProducer(dependencies.digests, { outputPath: refreshedDigestPath }),
    settledProducer(dependencies.depegEvents, { outputPath: refreshedDepegPath }),
    prefetchApiBase
      ? prefetchPublicSnapshot(prefetchApiBase, targetDatasetDate, join(resolvedRefreshDir, "prefetched-snapshot.json"))
      : Promise.resolve<{ snapshotFile?: string; log: string }>({ log: "" }),
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
  if (depegOk) {
    const committedDepegBackup = join(resolvedRefreshDir, "depeg-events-committed");
    renameSync(committedDepegPath, committedDepegBackup);
    try {
      renameSync(join(resolvedRefreshDir, "depeg-events"), committedDepegPath);
      rmSync(committedDepegBackup, { recursive: true, force: true });
    } catch (error) {
      renameSync(committedDepegBackup, committedDepegPath);
      throw error;
    }
  } else {
    depegLog = appendLog(depegLog, "::warning::depeg-event refresh failed; using committed depeg snapshot with unverified source coverage");
  }

  // Snapshot every generator output, including authored redirects, before any dataset writes.
  rmSync(datasetBackupDir, { recursive: true, force: true });
  mkdirSync(datasetBackupDir, { recursive: true });
  for (const path of PUBLIC_DATASET_BUNDLE_PATHS) {
    const source = join(repoRoot, path);
    if (existsSync(source)) {
      const backup = join(datasetBackupDir, path);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(source, backup, { recursive: true });
    }
  }

  const datasetsRun = await settledProducer(dependencies.publicDatasets, {
    ...(prefetchedSnapshot.snapshotFile ? { snapshotFile: prefetchedSnapshot.snapshotFile } : {}),
  });

  const datasetsOk = datasetsRun.status === 0;
  let datasetsLog = `${prefetchedSnapshot.log}${datasetsRun.output ?? ""}`;
  let rolledBack = false;
  if (!datasetsOk) {
    datasetsLog = appendLog(
      datasetsLog,
      "::warning::public-dataset refresh failed; using pre-refresh public dataset bundle",
    );
    const rollback = await settledProducer(() => dependencies.rollbackPublicDatasets(), {});
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
    digests: { committedCount, durationMs: digestRun.durationMs, ok: digestOk, refreshedCount, shrinkRejected },
    depegEvents: { durationMs: depegRun.durationMs, ok: depegOk },
    publicDatasets: { durationMs: datasetsRun.durationMs, ok: datasetsOk, rolledBack },
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
    const result = await refreshPagesReleaseData(options);
    if (shouldFailReleaseRefresh(result)) {
      throw new Error(
        !result.publicDatasets.ok && !result.publicDatasets.rolledBack
          ? "Public-dataset refresh and rollback both failed"
          : "All release-data producers failed",
      );
    }
  }, { label: "refresh-pages-release-data", usage: USAGE });
}
