import { describe, expect, it } from "vitest";

import {
  CRITICAL_TEST_FILES,
  buildCriticalCoverageArgs,
  buildCriticalCoverageMergeArgs,
  countCriticalCoverageShards,
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

  it("limits instrumentation to touched sources without shrinking the baseline owner suite", () => {
    const source = "worker/src/lib/auth.ts";
    const args = buildCriticalCoverageArgs([], { changedFiles: [source] });
    const selectedTests = args.filter((arg) => CRITICAL_TEST_FILES.includes(arg));

    expect(args.filter((arg) => arg.startsWith("--coverage.include="))).toHaveLength(1);
    expect(args).toContain(`--coverage.include=${source}`);
    expect(selectedTests).toEqual(CRITICAL_TEST_FILES);
  });

  it("caps shard count by the full owner suite rather than touched-source owners", () => {
    const source = "worker/src/lib/auth.ts";
    const otherSource = "worker/src/lib/price-validation.ts";
    const ownership = new Map([
      [source, ["worker/src/lib/__tests__/auth.test.ts"]],
      [otherSource, ["worker/src/lib/__tests__/price-validation.test.ts", "worker/src/lib/__tests__/price-consensus.test.ts"]],
    ]);
    const options = { changedFiles: [source], criticalFiles: [source, otherSource], ownership };

    expect(countCriticalCoverageShards(options)).toBe(3);
    expect(countCriticalCoverageShards(options, 2)).toBe(2);
  });

  it("merges blobs with the same coverage scope before the ratchet runs", () => {
    const args = buildCriticalCoverageMergeArgs("reports");

    expect(args).toContain("--coverage");
    expect(args).toContain("--merge-reports=reports");
    expect(args.some((arg) => arg.startsWith("--coverage.include="))).toBe(true);
    expect(args.some((arg) => arg.endsWith(".test.ts"))).toBe(false);
  });
});
