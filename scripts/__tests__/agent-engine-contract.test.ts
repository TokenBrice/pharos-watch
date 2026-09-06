import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCodexHookConfig } from "../maintenance/setup-agent-hooks.ts";
import { buildPermissionRequestHookOutput, buildPreToolUseHookOutput, classifyChangedFiles, findPreToolUseViolation, formatContract, getHookHarness, readChangedFiles } from "../ci/pharos-change-contract.ts";
import { collectChangedFiles, collectStagedFiles } from "../lib/changed-files.mts";
import { runPrTests } from "../maintenance/run-pr-tests.ts";

const shell = (command: string, cwd?: string) => ({ cwd, tool_name: "Bash", tool_input: { command } });

describe("agent engine integration", () => {
  it.each(["Bash", "exec_command", "apply_patch"])("dispatches canonical/compatible %s payloads through the configured matcher", (tool_name) => {
    const input = { model: "codex", hook_event_name: "PreToolUse", tool_name,
      tool_input: { command: tool_name === "apply_patch" ? "*** Begin Patch\n*** Add File: .env.local\n+test\n*** End Patch" : "git reset --hard" } };
    const config = buildCodexHookConfig();
    // eslint-disable-next-line security/detect-non-literal-regexp -- exercise the generated production matcher
    expect(new RegExp(config.hooks.PreToolUse[0].matcher).test(tool_name)).toBe(true);
    expect(buildPreToolUseHookOutput(input)).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
    // eslint-disable-next-line security/detect-non-literal-regexp -- exercise the generated production matcher
    expect(new RegExp(config.hooks.PermissionRequest[0].matcher).test(tool_name)).toBe(true);
    expect(buildPermissionRequestHookOutput(input)).toHaveProperty("hookSpecificOutput.decision.behavior", "deny");
    expect(getHookHarness(input)).toBe("codex");
    expect(buildPreToolUseHookOutput({ ...input, tool_input: { command: "git status" } })).toEqual({});
  });

  it.each([
    "(git reset --hard)", "{ git reset --hard; }", "if true; then git reset --hard; fi",
    "while false; do git reset --hard; done", "if false; then true; else git reset --hard; fi",
  ])("guards executable shell control syntax: %s", (command) => {
    expect(findPreToolUseViolation(shell(command))?.rule).toBe("git-destructive");
  });

  it.each(["echo '(git reset --hard)'", "echo 'if true; then git reset --hard; fi'", "# git reset --hard\ngit status", "cd scripts && echo 'if' && touch harmless.txt", "echo '>' .env.local", "echo tee .env.local", "# $(git reset --hard)\ngit status"])("keeps quoted/comment examples inert: %s", (command) => {
    expect(findPreToolUseViolation(shell(command))).toBeNull();
  });

  it.each(["sh -c 'cd scripts'; touch dist/marker", "cd scripts | cat; touch dist/marker", "/usr/bin/env -C .. touch dist/marker", "env -C.. touch dist/marker", "cd definitely-missing-agent-dir; touch dist/x", "cd scripts extra && touch dist/x", "cd missing && echo ok; touch dist/x"])("rejects unresolved nested/pipeline/wrapper write cwd: %s", (command) => {
    expect(findPreToolUseViolation(shell(command, resolve("scripts")))?.rule).toBe("opaque-shell");
  });

  it.each(["sh -c 'cd scripts';", "cd scripts | cat;", "/usr/bin/env -C ..", "env -C.."])("does not inspect SQL under an inferred ambiguous cwd: %s", (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-hook-ambiguous-sql-"));
    try {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "query.sql"), "SELECT 1;");
      writeFileSync(join(dir, "scripts/query.sql"), "SELECT 2;");
      expect(["d1-remote-mutation", "opaque-shell"]).toContain(findPreToolUseViolation(shell(`${prefix} npx wrangler d1 execute stablecoin-db --remote --file query.sql`, dir))?.rule);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("resolves dot segments, cwd-relative migrations and patch destinations", () => {
    expect(findPreToolUseViolation({ tool_input: { file_path: "src/../.git/config", new_string: "x" } })?.rule).toBe("protected-write");
    expect(findPreToolUseViolation({ cwd: resolve("worker"), tool_input: { file_path: "migrations/9999.sql", new_string: "DROP TABLE example;" } })?.rule).toBe("migration-sql");
    expect(findPreToolUseViolation({ tool_input: { command: "*** Begin Patch\n*** Update File: harmless.txt\n*** Move to: .env.local\n@@\n-a\n+b\n*** End Patch" } })?.rule).toBe("protected-write");
    expect(findPreToolUseViolation(shell("cd worker && touch dist/new.txt"))?.rule).toBe("protected-write");
  });

  it("resolves symlink ancestors while permitting legitimate new paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-hook-identity-"));
    try {
      symlinkSync(resolve("worker/migrations"), join(dir, "migration-link"));
      symlinkSync(dir, join(dir, "local-link"));
      expect(findPreToolUseViolation({ cwd: dir, tool_input: { file_path: "migration-link/9999.sql", new_string: "DROP TABLE example;" } })?.rule).toBe("migration-sql");
      expect(findPreToolUseViolation({ cwd: dir, tool_input: { file_path: "local-link/new.txt", new_string: "hello" } })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads only the actual tool-cwd SQL file, including safe, missing and unreadable targets", () => {
    const dir = mkdtempSync(resolve("agents/hook-cwd-"));
    try {
      const path = relative(process.cwd(), join(dir, "query.sql"));
      const toolCwd = join(dir, "actual");
      mkdirSync(join(toolCwd, relative(process.cwd(), dir)), { recursive: true });
      writeFileSync(resolve(path), "SELECT 1;");
      writeFileSync(resolve(toolCwd, path), "DROP TABLE example;");
      const input = { cwd: process.cwd(), tool_input: { workdir: toolCwd, command: `npx wrangler d1 execute stablecoin-db --remote --file ${path}` } };
      expect(findPreToolUseViolation(input)?.rule).toBe("d1-remote-mutation");
      writeFileSync(resolve(toolCwd, path), "SELECT 2;");
      expect(findPreToolUseViolation(input)).toBeNull();
      rmSync(resolve(toolCwd, path));
      expect(findPreToolUseViolation(input)?.rule).toBe("d1-remote-mutation");
      mkdirSync(resolve(toolCwd, path));
      expect(findPreToolUseViolation(input)?.rule).toBe("d1-remote-mutation");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([["--file"], ["--file", "--json"], ["--flie", "src/app/page.tsx"], ["--hook=typo"], ["--base-ref=missing-agent-audit-ref"]].map((args) => ({ args })))("rejects invalid routing input $args", ({ args }) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", ...args], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("labels unavailable SessionStart change evidence without failing the session", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", "--hook=session-start", "--base-ref=missing-agent-audit-ref"], { encoding: "utf8", input: "{}" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("change selection unavailable");
    expect(result.stderr).toContain("explicit files");
  });

  it("distinguishes selection failure from a legitimate empty diff", () => {
    expect(() => readChangedFiles({ execFile: () => { throw new Error("missing ref"); } })).toThrow("missing ref");
    expect(readChangedFiles({ execFile: () => "" })).toEqual([]);
  });

  it("does not run PR tests after failed Git selection or pass missing test paths", () => {
    const failed = vi.fn((file: string) => ({ status: file === "git" ? 128 : 0, stdout: "", stderr: "missing ref" }));
    expect(() => runPrTests({ argv: [], env: { NODE_ENV: "test" }, spawn: failed as never })).toThrow("Git change selection failed");
    expect(failed).toHaveBeenCalledTimes(2);
    const successful = vi.fn((file: string, args: string[]) => ({ status: 0,
      stdout: file === "git" ? "worker/src/deleted.ts\0" : args[0] === "list" ? "missing/deleted.test.ts\nscripts/__tests__/agent-engine-contract.test.ts" : "",
      stderr: "" }));
    expect(runPrTests({ argv: [], env: { NODE_ENV: "test" }, spawn: successful as never })).toBe(0);
    expect(successful.mock.calls[1]?.[1]).toContain("--no-renames");
    expect(successful.mock.calls[2]?.[1]).not.toContain("missing/deleted.test.ts");
    expect(successful.mock.calls[2]?.[1]).toContain("scripts/__tests__/agent-engine-contract.test.ts");
  });

  it("prints every required entry in a full multi-family route", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-stablecoins.ts", "worker/migrations/0300.sql", "shared/data/stablecoins/coins/usdc-circle.json", "src/app/page.tsx", "scripts/ci/pharos-change-contract.ts"]);
    const output = formatContract(contract);
    for (const doc of contract.docs) expect(output).toContain(doc.anchor ? `${doc.path}#${doc.anchor}` : doc.path);
    for (const check of contract.checks) expect(output).toContain(check);
    for (const rule of contract.hardRules) expect(output).toContain(rule);
  });

  it("keeps deletions and both rename owners in staged and committed classification", () => {
    const dir = mkdtempSync(join(tmpdir(), "pharos-agent-diff-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
      mkdirSync(join(dir, "worker/src"), { recursive: true });
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "worker/src/deleted.ts"), "deleted");
      writeFileSync(join(dir, "worker/src/moved.ts"), "moved");
      git("add", "."); git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      git("rm", "worker/src/deleted.ts"); git("mv", "worker/src/moved.ts", "src/moved.ts");
      const expected = ["src/moved.ts", "worker/src/deleted.ts", "worker/src/moved.ts"];
      expect(collectStagedFiles({ cwd: dir })).toEqual(expected);
      git("commit", "-qm", "change");
      expect(collectChangedFiles({ cwd: dir, base })).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
