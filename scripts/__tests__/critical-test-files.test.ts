import { describe, expect, it } from "vitest";
import { assertExecutableTestFiles } from "../lib/critical-ownership.mts";
import { buildCriticalCoverageArgs, buildCriticalCoverageMergeArgs, countCriticalCoverageShards } from "../lib/critical-test-files.mts";

describe("critical execution contracts", () => {
  it("rejects missing, non-test and multiply-owned mandatory files", () => {
    expect(() => assertExecutableTestFiles(["src/missing.test.ts"], { exists: () => false })).toThrow("src/missing.test.ts");
    expect(() => assertExecutableTestFiles(["src/source.ts"], { exists: () => true })).toThrow("src/source.ts");
    expect(() => assertExecutableTestFiles(["tests/visual/page.spec.ts"], { exists: () => true })).toThrow("tests/visual/page.spec.ts");
    const project = { name: "duplicate", include: ["src/**/*.test.ts"], exclude: [] };
    expect(() => assertExecutableTestFiles(["src/owner.test.ts"], { exists: () => true, projects: [project, project] })).toThrow("found 2");
  });

  it("accepts executable spec files and isolated project exceptions", () => {
    expect(() => assertExecutableTestFiles(["src/owner.spec.ts", "scripts/__tests__/remote-d1.test.ts"], { exists: () => true })).not.toThrow();
  });

  it("never turns an empty ownership selection into unrestricted Vitest execution", () => {
    const options = { criticalFiles: ["src/source.ts"], ownership: new Map() };
    expect(() => buildCriticalCoverageArgs([], options)).toThrow(/Empty/);
    expect(() => countCriticalCoverageShards(options)).toThrow(/Empty/);
    expect(() => buildCriticalCoverageMergeArgs(".vitest-reports", { criticalFiles: [] })).toThrow(/Empty/);
  });

  it("retains all critical owners while narrowing measured sources", () => {
    const ownership = new Map([["src/first.ts", ["src/first.test.ts"]], ["src/second.ts", ["src/second.test.ts"]]]);
    const args = buildCriticalCoverageArgs([], { criticalFiles: [...ownership.keys()], ownership, changedFiles: ["src/first.ts"], exists: () => true });
    expect(args.filter((arg) => arg.startsWith("--coverage.include="))).toEqual(["--coverage.include=src/first.ts"]);
    expect(args.filter((arg) => arg.endsWith(".test.ts"))).toEqual(["src/first.test.ts", "src/second.test.ts"]);
  });
});
