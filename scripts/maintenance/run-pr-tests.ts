import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localBin } from "../lib/local-bin.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import { CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";
import { createPrTestPlan, partitionTestFiles, readPrTestPlan, readPrTestTimings, takeTestShard } from "../lib/pr-test-plan.mts";
import { publishShardTimings } from "../lib/shard-timings.mts";
import { hasVitestOption, withCiVitestArgs } from "../lib/vitest-ci-args.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

interface RunPrTestsOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

function collectChangedFilePaths(
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  spawn: typeof spawnSync,
): string[] {
  return collectChangedFiles({
    base,
    head,
    execFile: (file, args, options) => {
      const result = spawn(file, [...args], { ...options, env });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Git change selection failed: ${String(result.stderr ?? "").trim()}`);
      return String(result.stdout ?? "");
    },
  });
}


export function runPrTests({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
}: RunPrTestsOptions = {}): number {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const planArg = rest.find((arg) => arg === "--plan-out" || arg.startsWith("--plan-out="));
  const planIndex = planArg === undefined ? -1 : rest.indexOf(planArg);
  const planOut = planArg === "--plan-out" ? rest[planIndex + 1] : planArg?.slice("--plan-out=".length);
  if (planArg !== undefined && (!planOut || planOut.startsWith("--"))) throw new Error("--plan-out requires a path");
  const runArgs = planIndex < 0 ? rest : rest.filter((_, index) => index !== planIndex && (planArg !== "--plan-out" || index !== planIndex + 1));
  const { args, shard } = takeTestShard(runArgs);
  const vitest = localBin("vitest");
  let files: string[];
  if (env.PR_TEST_PLAN_FILE && !planOut) {
    if (!shard) throw new Error("PR_TEST_PLAN_FILE requires --shard=i/k");
    const plan = readPrTestPlan(env.PR_TEST_PLAN_FILE);
    if (plan.shardCount !== shard.shardCount) throw new Error(`PR test plan shard count ${plan.shardCount} does not match ${shard.shardCount}`);
    if (plan.base !== base) throw new Error(`PR test plan base ${plan.base} does not match ${base}`);
    files = plan.shards[shard.shard - 1];
  } else {
    const listResult = spawn(vitest, ["list", "--changed", base, "--filesOnly"], { encoding: "utf8", env });
    if (listResult.error) throw listResult.error;
    if (listResult.status !== 0) {
      process.stderr.write(listResult.stderr ?? "");
      throw new Error(`Vitest could not resolve tests changed since ${base}.`);
    }
    const changedFiles = collectChangedFilePaths(base, head, env, spawn);
    files = selectPrTestFiles(parseVitestFileList(String(listResult.stdout ?? "")), undefined, changedFiles);
    if (planOut) {
      if (shard) throw new Error("--plan-out cannot be combined with --shard");
      const plan = createPrTestPlan(base, files);
      mkdirSync(dirname(planOut), { recursive: true });
      writeFileSync(planOut, `${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    if (shard) files = partitionTestFiles(files, shard.shardCount, readPrTestTimings().tests)[shard.shard - 1];
  }
  if (env.PR_TESTS_DEFER_CRITICAL_OWNERS === "1") {
    // Set only by local check:pr when its critical-coverage leaf runs every
    // critical-owner test file in the same gate; running them here too is duplicate work.
    const owners = new Set(CRITICAL_TEST_FILES);
    const remaining = files.filter((file) => !owners.has(file));
    process.stderr.write(`[test:pr] ${files.length - remaining.length} critical-owner test file(s) deferred to the critical-coverage leaf; ${remaining.length} remain.\n`);
    files = remaining;
  }
  // An empty explicit shard must not turn into Vitest's unrestricted full run.
  if (files.length === 0) return 0;
  const vitestArgs = withCiVitestArgs(["run", ...files, ...args], env);
  const timingsFile = env.PR_SHARD_TIMINGS_FILE;
  const reportArgs: string[] = [];
  if (timingsFile) {
    if (!hasVitestOption(vitestArgs, "--reporter")) reportArgs.push("--reporter=default");
    reportArgs.push("--reporter=./scripts/lib/shard-timing-reporter.mts");
  }
  const startedAt = Date.now();
  const result = spawn(vitest, [...vitestArgs, ...reportArgs], {
    env,
    stdio: "inherit",
  });
  const wallMs = Date.now() - startedAt;
  if (result.error) throw result.error;
  if (timingsFile) publishShardTimings(timingsFile, shard ?? { shard: 1, shardCount: 1 }, wallMs, env, "plain-test");
  return result.status ?? 1;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = runPrTests();
});
