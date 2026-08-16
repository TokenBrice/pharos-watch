#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { localBin } from "../lib/local-bin.mts";

const LINTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

interface SelectLintableFilesOptions {
  exists?: (file: string) => boolean;
}

interface RunChangedEslintOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

export function selectLintableFiles(
  changedFiles: readonly string[],
  { exists = existsSync }: SelectLintableFilesOptions = {},
): string[] {
  return changedFiles.filter((file) => LINTABLE_EXTENSION.test(file) && exists(file));
}

export function runChangedEslint({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
}: RunChangedEslintOptions = {}): number {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const files = selectLintableFiles(collectChangedFiles({ base, head }));

  if (files.length === 0) {
    console.log(`[lint:changed] No lintable files changed in ${base}...${head}.`);
    return 0;
  }

  console.log(`[lint:changed] Checking ${files.length} file(s) changed in ${base}...${head}.`);
  const result = spawn(
    localBin("eslint"),
    [
      ...files,
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
      ".cache/eslint/",
      "--max-warnings=0",
      // Changed-file runs pass paths explicitly, so ESLint warns when one is
      // covered by a globalIgnores entry (.claude/**, agents/**, caches). Those
      // are deliberately unlinted, and the warning would fail --max-warnings=0.
      "--no-warn-ignored",
      ...rest,
    ],
    { env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runChangedEslint());
}
