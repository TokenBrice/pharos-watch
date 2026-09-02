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

type GitPathMode =
  | { kind: "range"; base: string; head: string; noRenames?: boolean; diffFilter?: string }
  | { kind: "staged"; diffFilter?: string }
  | { kind: "working"; includeUntracked?: boolean; diffFilter?: string };

export function splitNullDelimited(output: string | Buffer | null | undefined): string[] {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean);
}

export function normalizeRepoPaths(paths: Iterable<string>): string[] {
  return [...paths].map((path) => path.trim().replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean);
}

export function collectGitPaths(
  mode: GitPathMode,
  { cwd, failure = "throw", execFile = execFileSync as GitDiffExec }: { cwd?: string; failure?: "throw" | "empty"; execFile?: GitDiffExec } = {},
): string[] {
  const options = cwd ? { cwd, encoding: "utf8" as const } : { encoding: "utf8" as const };
  const diffArgs = ["diff"];
  if (mode.kind === "staged") diffArgs.push("--cached");
  diffArgs.push("--name-only");
  if (mode.kind === "range" && mode.noRenames) diffArgs.push("--no-renames");
  if (mode.diffFilter) diffArgs.push(`--diff-filter=${mode.diffFilter}`);
  diffArgs.push("-z");
  if (mode.kind === "range") diffArgs.push(`${mode.base}...${mode.head}`);
  if (mode.kind === "working" && mode.includeUntracked) diffArgs.push("HEAD", "--");

  try {
    const paths = splitNullDelimited(execFile("git", diffArgs, options as { cwd: string; encoding: "utf8" }));
    if (mode.kind === "working" && mode.includeUntracked)
      paths.push(...splitNullDelimited(execFile("git", ["ls-files", "--others", "--exclude-standard", "-z"], options as { cwd: string; encoding: "utf8" })));
    return normalizeRepoPaths(paths);
  } catch (error) {
    if (failure === "empty") return [];
    throw error;
  }
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
  return [...new Set(collectGitPaths(
    { kind: "range", base, head, diffFilter: "ACMR" },
    { cwd, execFile },
  ))].sort();
}

/**
 * Paths in the index. The pre-commit artifact sync classifies what is about to
 * be committed, not what differs from a base ref.
 */
export function collectStagedFiles({
  cwd = process.cwd(),
  diffFilter = "ACMR",
  execFile = execFileSync as GitDiffExec,
}: { cwd?: string; diffFilter?: string; execFile?: GitDiffExec } = {}) {
  return [...new Set(collectGitPaths(
    { kind: "staged", diffFilter },
    { cwd, execFile },
  ))].sort();
}
