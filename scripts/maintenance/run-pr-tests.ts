import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { localBin } from "../lib/local-bin.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";

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

  const changedFiles = collectChangedFilePaths(base, head, env, spawn);
  const files = selectPrTestFiles(parseVitestFileList(String(listResult.stdout ?? "")), undefined, changedFiles).filter((file) => existsSync(file));
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
