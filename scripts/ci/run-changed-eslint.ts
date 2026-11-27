#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { matchesGlob, relative, resolve, sep } from "node:path";
import { collectChangedFiles, collectGitPaths } from "../lib/changed-files.mts";
import { createExecutionUnit, createSpawnCommand, runExecutionUnit, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";

const LINTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const PACKAGE_JSON = resolve(import.meta.dirname, "../../package.json");

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

/** The quoted globs of package.json `lint:typed` (the nightly full run's own
 * arguments) are the one typed-lint scope; a missing or glob-less script fails
 * closed instead of selecting nothing. */
export function readTypedLintPatterns(packageJsonPath = PACKAGE_JSON): string[] {
  const { scripts } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  // Only glob-bearing quoted arguments are source patterns; a quoted option value
  // (for example a config filename) never counts as scope.
  const patterns = Array.from(scripts?.["lint:typed"]?.matchAll(/(["'])(.*?)\1/g) ?? [], (match) => match[2])
    .filter((pattern) => /[*?{[]/.test(pattern));
  if (patterns.length === 0) throw new Error(`No typed-lint globs in ${packageJsonPath} scripts["lint:typed"].`);
  return patterns;
}

/** Existing lintable files inside the typed-lint globs; the typed config's own
 * ignores (tests, mocks, generated) still apply when ESLint runs. */
export function selectTypedLintFiles(
  changedFiles: readonly string[],
  { exists = existsSync, patterns = readTypedLintPatterns() }: SelectLintableFilesOptions & { patterns?: readonly string[] } = {},
): string[] {
  return selectLintableFiles(changedFiles, { exists }).filter((file) => patterns.some((pattern) => matchesGlob(file, pattern)));
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
      typed: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run lint:changed -- [--file <path> ... | --staged | --base <ref> [--head <ref>]] [-- <eslint options>]\nWithout selection flags or PR range environment, lint the working tree (including staged and untracked files).\nnpm run lint:typed:changed (--typed) keeps the same selection, narrows it to the lint:typed globs and applies eslint.typed.config.mjs.");
    return 0;
  }
  const typed = values.typed === true;
  const label = typed ? "lint:typed:changed" : "lint:changed";
  const rest = separator < 0 ? [] : argv.slice(separator + 1);
  const explicitFiles = values.file as string[] | undefined;
  const base = typeof values.base === "string" ? values.base : env.PR_BASE_SHA || env.GITHUB_BASE_SHA;
  const head = typeof values.head === "string" ? values.head : env.PR_HEAD_SHA || env.GITHUB_HEAD_SHA;
  const selection = explicitFiles
    // Globs are repository-relative, so `./path` and absolute spellings must not slip past them.
    ? explicitFiles.map((file) => relative(process.cwd(), resolve(file)).split(sep).join("/"))
    : values.staged
      ? collectGitPaths({ kind: "staged", noRenames: true })
      : base || head
        ? collectChangedFiles({ base: base || "origin/main", head: head || "HEAD" })
        : collectGitPaths({ kind: "working", includeUntracked: true, noRenames: true });
  const files = (typed ? selectTypedLintFiles : selectLintableFiles)([...new Set(selection)]);
  const scope = explicitFiles ? "explicit selection" : values.staged ? "staged files" : base || head ? `${base || "origin/main"}...${head || "HEAD"}` : "working tree and untracked files";

  if (files.length === 0) {
    console.log(`[${label}] No ${typed ? "typed-lint" : "lintable"} files selected from ${scope}.`);
    return 0;
  }

  console.log(`[${label}] Checking ${files.length} file(s) from ${scope}.`);
  // Normalized root-level names may start with "-"; keep ESLint from reading them as options.
  const eslintPaths = files.map((file) => (file.startsWith("-") ? `./${file}` : file));
  const command = createSpawnCommand(localBin("eslint"), [
      // Typed verdicts depend on other files' types, so the content cache would
      // be unsound; the typed lane runs uncached like `lint:typed`.
      ...(typed
        ? ["--config", "eslint.typed.config.mjs", ...eslintPaths]
        : [...eslintPaths, "--cache", "--cache-strategy", "content", "--cache-location", ".cache/eslint/"]),
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
