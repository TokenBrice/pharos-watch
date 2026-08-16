#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { localBin } from "../lib/local-bin.mjs";
import { parseChangedFileArgs } from "../lib/changed-files.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mjs";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mjs";

interface RunPrTestsOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

export function runPrTests({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
}: RunPrTestsOptions = {}): number {
  const { base, rest } = parseChangedFileArgs(argv, env);
  const vitest = localBin("vitest");
  const listResult = spawn(vitest, ["list", "--changed", base, "--filesOnly"], {
    encoding: "utf8",
    env,
  });
  if (listResult.error) throw listResult.error;
  if (listResult.status !== 0) {
    process.stderr.write(listResult.stderr ?? "");
    throw new Error(`Vitest could not resolve tests changed since ${base}.`);
  }

  const files = selectPrTestFiles(parseVitestFileList(String(listResult.stdout ?? "")));
  console.log(`[test:pr] Running ${files.length} critical or changed test file(s) (base ${base}).`);
  const result = spawn(vitest, withCiVitestArgs(["run", ...files, ...rest], env), {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runPrTests());
}
