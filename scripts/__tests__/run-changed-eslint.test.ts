import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(".");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pharos-lint-selection-"));
  temporary.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n.cache\n");
  writeFileSync(join(cwd, "eslint.config.mjs"), 'export default [{ files: ["**/*.js"], rules: { "no-debugger": "error" } }];\n');
  writeFileSync(join(cwd, "unchanged invalid.js"), "debugger;\n");
  writeFileSync(join(cwd, "good.js"), "export const good = true;\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD").trim();
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  const run = (args: string[] = [], extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, [
    "--import", join(root, "node_modules/tsx/dist/loader.mjs"),
    join(root, "scripts/ci/run-changed-eslint.ts"), ...args,
  ], { cwd, encoding: "utf8", env: { ...process.env, PR_BASE_SHA: "", PR_HEAD_SHA: "", GITHUB_BASE_SHA: "", GITHUB_HEAD_SHA: "", ...extraEnv } });
  return { cwd, git, base, run };
}

describe("lint:changed CLI selection", () => {
  it("lints explicit unchanged paths with whitespace despite an empty PR range", () => {
    const { run, base } = fixture();
    const result = run(["--file", "good.js", "--file", "unchanged invalid.js"], { PR_BASE_SHA: base, PR_HEAD_SHA: base });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no-debugger");
  });

  it("includes untracked and staged invalid files in bare local selection", () => {
    const { cwd, git, run } = fixture();
    writeFileSync(join(cwd, "new invalid.js"), "debugger;\n");
    expect(run().status).toBe(1);
    git("add", "new invalid.js");
    expect(run().status).toBe(1);
    expect(run(["--staged"]).status).toBe(1);
  });

  it("isolates staged paths from unstaged and untracked files", () => {
    const { cwd, git, run } = fixture();
    writeFileSync(join(cwd, "good.js"), "export const good = false;\n");
    git("add", "good.js");
    writeFileSync(join(cwd, "untracked.js"), "debugger;\n");
    expect(run(["--staged"]).status).toBe(0);
  });

  it("keeps explicit base/head isolated from later commits and working files", () => {
    const { cwd, git, base, run } = fixture();
    writeFileSync(join(cwd, "good.js"), "export const good = false;\n");
    git("add", "good.js");
    git("commit", "-qm", "selected change");
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(cwd, "later.js"), "debugger;\n");
    git("add", "later.js");
    git("commit", "-qm", "unselected change");
    writeFileSync(join(cwd, "untracked.js"), "debugger;\n");
    expect(run(["--base", base, "--head", head]).status).toBe(0);
    expect(run([], { PR_BASE_SHA: base, PR_HEAD_SHA: head }).status).toBe(0);
  });

  it("skips deleted paths without broadening the selection", () => {
    const { git, run } = fixture();
    git("rm", "unchanged invalid.js");
    expect(run(["--staged"]).status).toBe(0);
    expect(run(["--file", "unchanged invalid.js"]).status).toBe(0);
  });
});
