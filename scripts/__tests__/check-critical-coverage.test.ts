import { describe, expect, it } from "vitest";

import {
  getChangedFilesFromGit,
  isAllZeroSha,
  parseChangedFilesFromEnv,
} from "../check-critical-coverage.mjs";

describe("critical coverage changed-file detection", () => {
  it("parses explicit changed files before falling back to git", () => {
    expect(
      parseChangedFilesFromEnv({
        CRITICAL_COVERAGE_CHANGED_FILES: "worker\\src\\api\\status.ts, docs/testing.md\n\n",
      }),
    ).toEqual(["worker/src/api/status.ts", "docs/testing.md"]);
  });

  it("skips empty and all-zero compare refs", () => {
    expect(isAllZeroSha("0000000000000000000000000000000000000000")).toBe(true);
    expect(getChangedFilesFromGit("")).toEqual([]);
    expect(getChangedFilesFromGit("0000000000000000000000000000000000000000")).toEqual([]);
  });

  it("passes malicious-looking compare refs to git diff as a single argument", () => {
    const calls: unknown[] = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "worker\\src\\api\\status.ts\n";
    };

    expect(
      getChangedFilesFromGit("origin/main; touch /tmp/should-not-run", { execFile }),
    ).toEqual(["worker/src/api/status.ts"]);
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", "origin/main; touch /tmp/should-not-run...HEAD"]],
    ]);
  });

  it("returns no changed files when git diff fails", () => {
    const warnings: string[] = [];
    const execFile = () => {
      throw new Error("bad ref");
    };

    expect(
      getChangedFilesFromGit("bad-ref", {
        execFile,
        consoleImpl: {
          warn: (message: string) => warnings.push(message),
        },
      }),
    ).toEqual([]);
    expect(warnings[0]).toContain('Could not diff against ref "bad-ref"');
  });
});
