#!/usr/bin/env node

import { existsSync } from "node:fs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { createExecutionUnit, createSpawnCommand, runExecutionUnit, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";

const LINTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

interface SelectLintableFilesOptions {
  exists?: (file: string) => boolean;
}

interface RunChangedEslintOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandImplementation<SpawnCommand>;
}

export function selectLintableFiles(
  changedFiles: readonly string[],
  { exists = existsSync }: SelectLintableFilesOptions = {},
): string[] {
  return changedFiles.filter((file) => LINTABLE_EXTENSION.test(file) && exists(file));
}

export async function runChangedEslint({
  argv = process.argv.slice(2),
  env = process.env,
  runCommand = runSpawnCommand,
}: RunChangedEslintOptions = {}): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const files = selectLintableFiles(collectChangedFiles({ base, head }));

  if (files.length === 0) {
    console.log(`[lint:changed] No lintable files changed in ${base}...${head}.`);
    return 0;
  }

  console.log(`[lint:changed] Checking ${files.length} file(s) changed in ${base}...${head}.`);
  const command = createSpawnCommand(localBin("eslint"), [
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
  ]);
  const result = await runExecutionUnit(createExecutionUnit([command]), {
    getCommandEnv: () => env as Record<string, string>,
    reporter: {},
    runCommandImpl: runCommand,
  });
  return result.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runChangedEslint().then((status) => {
    process.exit(status);
  });
}
