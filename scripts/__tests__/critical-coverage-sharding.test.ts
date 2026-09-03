import { describe, expect, it } from "vitest";

import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import {
  buildCriticalCoverageArgs,
  buildCriticalCoverageMergeArgs,
} from "../lib/critical-test-files.mts";

describe("critical coverage sharding", () => {
  it("retains the enrolled suite and coverage scope on each shard", () => {
    const args = buildCriticalCoverageArgs(["--reporter=blob", "--reporter=default", "--shard=1/4"]);

    expect(args[0]).toBe("run");
    expect(args).toContain("--coverage");
    expect(args).toContain("--reporter=blob");
    expect(args).toContain("--reporter=default");
    expect(args).toContain("--shard=1/4");
    expect(args).toContain("--maxWorkers=4");
    expect(args.some((arg) => arg.startsWith("--coverage.include="))).toBe(true);
    expect(args.some((arg) => arg.endsWith(".test.ts"))).toBe(true);
  });

  it("limits a shard to sources touched by the supplied change set", () => {
    const args = buildCriticalCoverageArgs([], { changedFiles: [CRITICAL_FILES[0]] });

    expect(args.filter((arg) => arg.startsWith("--coverage.include="))).toHaveLength(1);
    expect(args).toContain(`--coverage.include=${CRITICAL_FILES[0]}`);
    expect(args.some((arg) => arg.endsWith(".test.ts"))).toBe(true);
  });

  it("merges blobs with the same coverage scope before the ratchet runs", () => {
    const args = buildCriticalCoverageMergeArgs("reports");

    expect(args).toContain("--coverage");
    expect(args).toContain("--merge-reports=reports");
    expect(args.some((arg) => arg.startsWith("--coverage.include="))).toBe(true);
    expect(args.some((arg) => arg.endsWith(".test.ts"))).toBe(false);
  });
});
