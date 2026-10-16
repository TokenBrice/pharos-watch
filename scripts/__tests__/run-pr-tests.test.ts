import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrTestPlan } from "../lib/pr-test-plan.mts";
import { CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";
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
  it("retains critical-owner files despite a retired coverage-deferral environment flag", () => {
    const plain = selectingSpawn();
    runPrTests({ argv: ["--base=base"], env, spawn: plain as never });
    const deferred = selectingSpawn();
    runPrTests({ argv: ["--base=base"], env: { ...env, PR_TESTS_DEFER_CRITICAL_OWNERS: "1" }, spawn: deferred as never });
    const selected = plain.mock.calls.find(([, args]) => args[0] === "run")![1].slice(1);
    const remaining = deferred.mock.calls.find(([, args]) => args[0] === "run")?.[1].slice(1) ?? [];
    expect(selected.some((file) => CRITICAL_TEST_FILES.includes(file))).toBe(true);
    expect(remaining).toEqual(selected);
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
});
