import { describe, expect, it } from "vitest";

import {
  CRITICAL_TEST_FILES,
  buildCriticalCoverageArgs,
  buildCriticalCoverageMergeArgs,
  countCriticalCoverageShards,
} from "../lib/critical-test-files.mts";

describe("critical coverage sharding", () => {
  it("retains the enrolled coverage scope and selects an explicit weighted shard", () => {
    const args = buildCriticalCoverageArgs(["--reporter=blob", "--reporter=default", "--shard=1/8"]);

    expect(args[0]).toBe("run");
    expect(args).toContain("--coverage");
    expect(args).toContain("--reporter=blob");
    expect(args).toContain("--reporter=default");
    expect(args.some((arg) => arg.startsWith("--shard"))).toBe(false);
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

  it("defaults to eight disjoint, complete, deterministic full-owner partitions", () => {
    expect(countCriticalCoverageShards()).toBe(8);
    const shards = Array.from({ length: 8 }, (_, index) =>
      buildCriticalCoverageArgs([`--shard=${index + 1}/8`], { changedFiles: ["worker/src/lib/auth.ts"] })
        .filter((file) => CRITICAL_TEST_FILES.includes(file)));
    const files = shards.flat();
    expect(files).toHaveLength(CRITICAL_TEST_FILES.length);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual([...CRITICAL_TEST_FILES].sort());
    expect(shards[0]).toEqual(buildCriticalCoverageArgs(["--shard=1/8"]).filter((file) => CRITICAL_TEST_FILES.includes(file)));
  });

  it("balances long owners without changing touched include scope", () => {
    const source = "src/source.ts";
    const owners = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts"];
    const options = { criticalFiles: [source], ownership: new Map([[source, owners]]), exists: () => true,
      durations: { [owners[0]]: 9, [owners[1]]: 7, [owners[2]]: 3, [owners[3]]: 1 } };
    const first = buildCriticalCoverageArgs(["--shard", "1/2"], options);
    const second = buildCriticalCoverageArgs(["--shard=2/2"], options);
    expect(first.filter((file) => owners.includes(file))).toEqual([owners[0], owners[3]]);
    expect(second.filter((file) => owners.includes(file))).toEqual([owners[1], owners[2]]);
    expect(first.filter((arg) => arg.startsWith("--coverage.include="))).toEqual(second.filter((arg) => arg.startsWith("--coverage.include=")));
  });

  it("merges blobs with the same coverage scope before the ratchet runs", () => {
    const args = buildCriticalCoverageMergeArgs("reports");

    expect(args).toContain("--coverage");
    expect(args).toContain("--merge-reports=reports");
    expect(args.some((arg) => arg.startsWith("--coverage.include="))).toBe(true);
    expect(args.some((arg) => arg.endsWith(".test.ts"))).toBe(false);
  });
});
