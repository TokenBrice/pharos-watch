import { execFileSync } from "node:child_process";

interface GitHistoryOptions {
  cwd?: string;
  execFile?: typeof execFileSync;
}

export function isShallowRepository({ cwd = process.cwd(), execFile = execFileSync }: GitHistoryOptions = {}): boolean {
  return String(execFile("git", ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8" })).trim() === "true";
}

/**
 * Git-history-derived generators produce plausible-looking but wrong output on
 * a shallow clone: files outside the fetched window look brand new. Fail with
 * the fix rather than let a truncated history reach a published sitemap.
 */
export function assertFullGitHistory(artifactId: string, options: GitHistoryOptions = {}): void {
  if (!isShallowRepository(options)) return;
  throw new Error(
    `[${artifactId}] requires full Git history but this checkout is shallow. ` +
      "In GitHub Actions set `fetch-depth: 0` on actions/checkout; locally run `git fetch --unshallow`.",
  );
}
