import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { checkMergeGateReceipt, writeMergeGateReceipt } from "../lib/merge-gate-receipt.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const path = mkdtempSync(resolve(tmpdir(), "pharos-merge-gate-"));
  temporaryDirectories.push(path);
  return path;
}

function mockGit({ dirty = false, head = "head-sha" } = {}) {
  return ((_command: string, args: string[]) => {
    if (args[0] === "status") return dirty ? " M src/app/page.tsx\n" : "";
    if (args[0] === "remote") return "git@github.com:example/pharos-watch.git\n";
    if (args[0] === "rev-parse") {
      return args[2]?.startsWith("origin/main") ? "base-sha\n" : `${head}\n`;
    }
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  }) as typeof execFileSync;
}

function runHook(input: string, extraEnv: Record<string, string> = {}) {
  const directory = temporaryDirectory();
  const logPath = resolve(directory, "npm.log");
  const npmPath = resolve(directory, "npm");
  writeFileSync(logPath, "");
  writeFileSync(
    npmPath,
    "#!/usr/bin/env bash\n" +
      'printf \'%s|%s|%s|%s\\n\' "${MERGE_GATE_BASE_REF:-}" "${MERGE_GATE_HEAD_REF:-}" "${MERGE_GATE_FULL_DEPLOY:-}" "$*" >> "$HOOK_LOG"\n',
  );
  chmodSync(npmPath, 0o755);

  const output = execFileSync("bash", [resolve(process.cwd(), ".githooks/pre-push")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOOK_LOG: logPath,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PHAROS_PRE_PUSH_SKIP_RECEIPT: "1",
      ...extraEnv,
    },
    input,
  });

  return {
    calls: readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean),
    output,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("merge-gate receipt", () => {
  it("reuses only the exact clean committed state and validation profile", () => {
    const receiptPath = resolve(temporaryDirectory(), "receipt.json");
    const options = {
      baseRef: "origin/main",
      env: {},
      execFile: mockGit(),
      headRef: "HEAD",
      now: Date.parse("2026-07-12T10:00:00Z"),
      receiptPath,
    };

    expect(writeMergeGateReceipt(options).written).toBe(true);
    expect(checkMergeGateReceipt({ ...options, now: Date.parse("2026-07-12T10:05:00Z") })).toEqual({
      valid: true,
      reason: "validated committed state matches",
    });
    expect(
      checkMergeGateReceipt({
        ...options,
        env: { MERGE_GATE_FULL_DEPLOY: "0", MERGE_GATE_PAGES_SMOKE: "1" },
        now: Date.parse("2026-07-12T10:05:00Z"),
      }),
    ).toEqual({ valid: true, reason: "validated committed state matches" });
    expect(
      checkMergeGateReceipt({
        ...options,
        env: { MERGE_GATE_PAGES_SMOKE: "0" },
        now: Date.parse("2026-07-12T10:05:00Z"),
      }),
    ).toEqual({ valid: false, reason: "profileHash changed" });
    expect(
      checkMergeGateReceipt({
        ...options,
        execFile: mockGit({ head: "new-head" }),
        now: Date.parse("2026-07-12T10:05:00Z"),
      }),
    ).toEqual({ valid: false, reason: "headCommit changed" });
  });

  it("rejects dirty and expired states", () => {
    const receiptPath = resolve(temporaryDirectory(), "receipt.json");
    const options = {
      execFile: mockGit(),
      now: Date.parse("2026-07-12T10:00:00Z"),
      receiptPath,
    };
    expect(writeMergeGateReceipt(options).written).toBe(true);
    expect(
      checkMergeGateReceipt({
        ...options,
        execFile: mockGit({ dirty: true }),
        now: Date.parse("2026-07-12T10:05:00Z"),
      }),
    ).toEqual({ valid: false, reason: "worktree is not clean" });
    expect(checkMergeGateReceipt({ ...options, now: Date.parse("2026-07-14T10:00:00Z") })).toEqual({
      valid: false,
      reason: "receipt is expired",
    });
  });
});

describe("pre-push hook execution", () => {
  it("gates an exact main update once", () => {
    const result = runHook("refs/heads/main local-sha refs/heads/main remote-sha\n");
    expect(result.calls).toEqual(["remote-sha|local-sha|0|run test:merge-gate"]);
  });

  it("skips non-main pushes by default", () => {
    const result = runHook("refs/heads/topic local-sha refs/heads/topic remote-sha\n");
    expect(result.calls).toEqual([]);
    expect(result.output).toContain("full local gate skipped");
  });

  it("supports an explicit exact branch gate", () => {
    const result = runHook("refs/heads/topic local-sha refs/heads/topic remote-sha\n", {
      PHAROS_PRE_PUSH_GATE: "all",
    });
    expect(result.calls).toEqual(["remote-sha|local-sha|0|run test:merge-gate"]);
  });
});
