import { execFileSync } from "node:child_process";

type GitDiffExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8" },
) => string;

interface ChangedFileOptions {
  base?: string;
  cwd?: string;
  execFile?: GitDiffExec;
  head?: string;
}

function normalizePath(path: string) {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Split NUL-delimited `git ... -z` output into raw path segments.
 *
 * Every git invocation that feeds a path list must pass `-z` and parse with
 * this: newline-splitting silently truncates paths containing a newline (git
 * quotes them without `-z`, which then fails to match any real file) and
 * splits them into two bogus entries.
 *
 * @param {string | Buffer | null | undefined} output
 * @returns {string[]}
 */
export function splitNullDelimited(output: string | Buffer | null | undefined): string[] {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean);
}

export function parseChangedFileArgs(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env) {
  let base = env.PR_BASE_SHA || env.GITHUB_BASE_SHA || "origin/main";
  let head = env.PR_HEAD_SHA || env.GITHUB_HEAD_SHA || "HEAD";
  let staged = false;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base" || arg === "--head") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--base") base = value;
      else head = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      continue;
    }
    if (arg.startsWith("--head=")) {
      head = arg.slice("--head=".length);
      continue;
    }
    if (arg === "--staged") {
      staged = true;
      continue;
    }
    rest.push(arg);
  }

  return { base, head, rest, staged };
}

export function collectChangedFiles({
  base = "origin/main",
  cwd = process.cwd(),
  execFile = execFileSync as GitDiffExec,
  head = "HEAD",
}: ChangedFileOptions = {}) {
  const output = execFile(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...${head}`],
    { cwd, encoding: "utf8" },
  );

  return [...new Set(splitNullDelimited(output).map(normalizePath).filter(Boolean))].sort();
}

/**
 * Paths in the index. The pre-commit artifact sync classifies what is about to
 * be committed, not what differs from a base ref.
 */
export function collectStagedFiles({
  cwd = process.cwd(),
  execFile = execFileSync as GitDiffExec,
}: Pick<ChangedFileOptions, "cwd" | "execFile"> = {}) {
  const output = execFile(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd, encoding: "utf8" },
  );

  return [...new Set(splitNullDelimited(output).map(normalizePath).filter(Boolean))].sort();
}
