import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localBin } from "../lib/local-bin.mts";
import { collectChangedFiles, collectGitPaths, parseChangedFileArgs } from "../lib/changed-files.mts";
import { withPrTierVitestArgs } from "../lib/nightly-test-tier.mts";
import { hasDocsChanges, planPrTestSelection, type PrTestSelectionResult } from "../lib/pr-import-graph.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import { createPrTestPlan, partitionTestFiles, readPrTestPlan, readTestTimings, takeTestShard } from "../lib/pr-test-plan.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

interface RunPrTestsOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
  /** Affected-test selector; defaults to the static import graph with its `vitest list` fallback. */
  planSelection?: (changedFiles: readonly string[]) => PrTestSelectionResult;
}

function collectChangedFilePaths(
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  spawn: typeof spawnSync,
): string[] {
  const execFile = (file: string, args: readonly string[]) => {
    const result = spawn(file, [...args], { env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Git change selection failed: ${String(result.stderr ?? "").trim()}`);
    return String(result.stdout ?? "");
  };
  // The committed range is what CI plans; the working tree is what Vitest's
  // `--changed` also saw, so local plans keep selecting tests for uncommitted edits.
  return [...new Set([
    ...collectChangedFiles({ base, head, execFile }),
    ...collectGitPaths({ kind: "working", includeUntracked: true }, { execFile }),
  ])].sort();
}

/** Remove a `--name value` / `--name=value` path option from the forwarded Vitest args. */
function takePathOption(args: readonly string[], name: string): { args: string[]; value?: string } {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return { args: [...args] };
  const arg = args[index];
  const value = arg === name ? args[index + 1] : arg.slice(name.length + 1);
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return { args: args.filter((_, position) => position !== index && (arg !== name || position !== index + 1)), value };
}

export function runPrTests({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
  planSelection = planPrTestSelection,
}: RunPrTestsOptions = {}): number {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const planOut = takePathOption(rest, "--plan-out");
  const timings = takePathOption(planOut.args, "--timings");
  if (timings.value && !planOut.value) throw new Error("--timings requires --plan-out");
  const { args, shard } = takeTestShard(timings.args);
  const vitest = localBin("vitest");
  let files: string[];
  if (env.PR_TEST_PLAN_FILE && !planOut.value) {
    if (!shard) throw new Error("PR_TEST_PLAN_FILE requires --shard=i/k");
    const plan = readPrTestPlan(env.PR_TEST_PLAN_FILE);
    if (plan.shardCount !== shard.shardCount) throw new Error(`PR test plan shard count ${plan.shardCount} does not match ${shard.shardCount}`);
    if (plan.base !== base) throw new Error(`PR test plan base ${plan.base} does not match ${base}`);
    files = plan.shards[shard.shard - 1];
  } else {
    const changedFiles = collectChangedFilePaths(base, head, env, spawn);
    const selection = planSelection(changedFiles);
    let affected: string[];
    if (selection.fallback) {
      process.stderr.write(`[pr-tests] static import graph unavailable, using \`vitest list --changed\`: ${selection.fallback}\n`);
      const listResult = spawn(vitest, ["list", "--changed", base, "--filesOnly"], { encoding: "utf8", env });
      if (listResult.error) throw listResult.error;
      if (listResult.status !== 0) {
        process.stderr.write(listResult.stderr ?? "");
        throw new Error(`Vitest could not resolve tests changed since ${base}.`);
      }
      affected = parseVitestFileList(String(listResult.stdout ?? ""));
    } else {
      affected = selection.files;
    }
    files = selectPrTestFiles(affected, undefined, changedFiles, undefined, undefined, {
      docsChanged: hasDocsChanges(changedFiles),
    });
    if (planOut.value) {
      if (shard) throw new Error("--plan-out cannot be combined with --shard");
      const loaded = timings.value ? readTestTimings(timings.value) : undefined;
      if (loaded && !loaded.ok) process.stderr.write(`[pr-tests] ignoring test timings ${timings.value}: ${loaded.reason}\n`);
      const plan = createPrTestPlan(base, files, loaded?.ok ? { timings: loaded.timings } : {});
      mkdirSync(dirname(planOut.value), { recursive: true });
      writeFileSync(planOut.value, `${JSON.stringify(plan, null, 2)}\n`);
      process.stderr.write(`[pr-tests] ${selection.mode} selection: ${plan.fileCount} files in ${plan.shardCount} shard(s), ${plan.partitionMode} partition\n`);
      return 0;
    }
    if (shard) files = partitionTestFiles(files, shard.shardCount)[shard.shard - 1];
  }
  // An empty explicit shard must not turn into Vitest's unrestricted full run.
  if (files.length === 0) return 0;
  // `npm test` and the nightly shards keep the nightly tier; the PR runner is
  // the one invocation that filters it out (`scripts/lib/nightly-test-tier.mts`).
  const vitestArgs = withPrTierVitestArgs(withCiVitestArgs(["run", ...files, ...args], env));
  const result = spawn(vitest, vitestArgs, {
    env: { ...env, PHAROS_V9_RESOURCE_LANE: "0" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = runPrTests();
});
