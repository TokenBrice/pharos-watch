#!/usr/bin/env node

import { existsSync } from "node:fs";
import { collectChangedFiles, collectGitPaths } from "../lib/changed-files.mts";
import { createExecutionUnit, createSpawnCommand, runExecutionUnit, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";

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
  const separator = argv.indexOf("--");
  const { values } = parseStrictCliArgs(separator < 0 ? argv : argv.slice(0, separator), {
    conflicts: [["file", "staged", "base"], ["file", "head"], ["staged", "head"]],
    options: {
      file: { type: "string", multiple: true },
      staged: { type: "boolean" },
      base: { type: "string" },
      head: { type: "string" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run lint:changed -- [--file <path> ... | --staged | --base <ref> [--head <ref>]] [-- <eslint options>]\nWithout selection flags or PR range environment, lint the working tree (including staged and untracked files).");
    return 0;
  }
  const rest = separator < 0 ? [] : argv.slice(separator + 1);
  const explicitFiles = values.file as string[] | undefined;
  const base = typeof values.base === "string" ? values.base : env.PR_BASE_SHA || env.GITHUB_BASE_SHA;
  const head = typeof values.head === "string" ? values.head : env.PR_HEAD_SHA || env.GITHUB_HEAD_SHA;
  const selection = explicitFiles
    ? explicitFiles
    : values.staged
      ? collectGitPaths({ kind: "staged", noRenames: true })
      : base || head
        ? collectChangedFiles({ base: base || "origin/main", head: head || "HEAD" })
        : collectGitPaths({ kind: "working", includeUntracked: true, noRenames: true });
  const files = selectLintableFiles([...new Set(selection)]);
  const scope = explicitFiles ? "explicit selection" : values.staged ? "staged files" : base || head ? `${base || "origin/main"}...${head || "HEAD"}` : "working tree and untracked files";

  if (files.length === 0) {
    console.log(`[lint:changed] No lintable files selected from ${scope}.`);
    return 0;
  }

  console.log(`[lint:changed] Checking ${files.length} file(s) from ${scope}.`);
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

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runChangedEslint();
});
