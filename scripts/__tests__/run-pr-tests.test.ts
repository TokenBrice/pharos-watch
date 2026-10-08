import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrTestPlan, readPrTestPlan } from "../lib/pr-test-plan.mts";
import { runPrTests } from "../maintenance/run-pr-tests";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function planPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-run-pr-plan-"));
  temporary.push(directory);
  return join(directory, "plan.json");
}
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PR_BASE_SHA: "base" };

function selectingSpawn() {
  return vi.fn((file: string, args: string[]) => ({ status: 0, stdout: file === "git" ? "" : args[0] === "list"
    ? "scripts/__tests__/run-pr-tests.test.ts\nscripts/__tests__/critical-test-files.test.ts\n" : "", stderr: "" }));
}

describe("PR test runner prepared plans", () => {
  it.each(["inline", "separate"])("writes exact selected files once without spawning Vitest run (%s flag)", (form) => {
    const path = planPath();
    const spawn = selectingSpawn();
    const planArgs = form === "inline" ? [`--plan-out=${path}`] : ["--plan-out", path];
    expect(runPrTests({ argv: ["--base=base", ...planArgs], env, spawn: spawn as never })).toBe(0);
    expect(spawn.mock.calls.filter(([, args]) => args[0] === "list")).toHaveLength(1);
    expect(spawn.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
    const plan = readPrTestPlan(path);
    expect(plan.base).toBe("base");
    expect(plan.shardCount).toBe(4);
    expect(plan.shards.flat()).toEqual(expect.arrayContaining(["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-test-files.test.ts"]));
    const localSpawn = selectingSpawn();
    runPrTests({ argv: ["--base=base"], env, spawn: localSpawn as never });
    const localFiles = localSpawn.mock.calls.find(([, args]) => args[0] === "run")![1].filter((arg) => arg.endsWith(".test.ts"));
    expect(plan.shards.flat().sort()).toEqual(localFiles.sort());
  });

  it("executes only the requested prepared files without rerunning selection or native Vitest sharding", () => {
    const path = planPath();
    const files = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-test-files.test.ts"];
    const plan = createPrTestPlan("base", files, {});
    writeFileSync(path, JSON.stringify(plan));
    const spawn = selectingSpawn();
    expect(runPrTests({ argv: ["--base=base", "--shard=2/4", "--reporter=dot"], env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(["run", ...plan.shards[1], "--reporter=dot"]);
  });

  it("fails closed on missing/malformed plans, missing coordinates, and mismatched base/count", () => {
    const path = planPath();
    const spawn = selectingSpawn();
    const options = { env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never };
    expect(() => runPrTests({ ...options, argv: ["--shard=1/4"] })).toThrow();
    writeFileSync(path, "{}");
    expect(() => runPrTests({ ...options, argv: ["--shard=1/4"] })).toThrow();
    writeFileSync(path, JSON.stringify(createPrTestPlan("base", ["scripts/__tests__/run-pr-tests.test.ts"], {})));
    expect(() => runPrTests({ ...options, argv: [] })).toThrow("requires --shard");
    expect(() => runPrTests({ ...options, argv: ["--shard=1/8"] })).toThrow("does not match");
    expect(() => runPrTests({ ...options, argv: ["--base=other", "--shard=1/4"] })).toThrow("does not match");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never turns an empty prepared shard into an unrestricted test run", () => {
    const path = planPath();
    writeFileSync(path, JSON.stringify(createPrTestPlan("base", ["scripts/__tests__/run-pr-tests.test.ts"], {})));
    const spawn = selectingSpawn();
    expect(runPrTests({ argv: ["--shard=4/4"], env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never })).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("attaches the import-aware reporter and retains original shard coordinates in timings", () => {
    const path = planPath();
    const timingPath = join(path, "..", "timings.json");
    const summaryPath = join(path, "..", "summary.md");
    const plan = createPrTestPlan("base", ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-test-files.test.ts"], {});
    writeFileSync(path, JSON.stringify(plan));
    const spawn = vi.fn((_file: string, args: string[]) => {
      expect(args).toContain("--reporter=./scripts/lib/shard-timing-reporter.mts");
      writeFileSync(timingPath.replace(/\.json$/, ".vitest.json"), JSON.stringify({ success: true, testResults: [] }));
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(runPrTests({ argv: ["--shard=2/4"], env: {
      ...env, PR_TEST_PLAN_FILE: path, PR_SHARD_TIMINGS_FILE: timingPath, GITHUB_STEP_SUMMARY: summaryPath,
    }, spawn: spawn as never })).toBe(0);
    expect(JSON.parse(readFileSync(timingPath, "utf8"))).toMatchObject({ shard: 2, shardCount: 4, success: true });
    expect(readFileSync(summaryPath, "utf8")).toContain("### PR tests shard 2/4");
  });
});
