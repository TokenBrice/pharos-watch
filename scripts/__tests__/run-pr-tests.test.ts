import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrTestPlan, readPrTestPlan } from "../lib/pr-test-plan.mts";
import { CRITICAL_TEST_FILES } from "../lib/critical-test-files.mts";
import { runPrTests } from "../maintenance/run-pr-tests";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporaryPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-run-pr-plan-"));
  temporary.push(directory);
  return join(directory, name);
}
function planPath(): string {
  return temporaryPath("plan.json");
}
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PR_BASE_SHA: "base" };
const docOwnership = "scripts/__tests__/doc-ownership-registry.test.ts";
const changeContract = "scripts/__tests__/pharos-change-contract.test.ts";

function selectingSpawn() {
  return vi.fn((file: string, args: string[]) => ({ status: 0, stdout: file === "git" ? "" : args[0] === "list"
    ? "scripts/__tests__/run-pr-tests.test.ts\nscripts/__tests__/critical-ownership.test.ts\n" : "", stderr: "" }));
}
/** Inject a selection so the suite never builds the real import graph. */
function selection(files: string[]) {
  return () => ({ files, mode: "closure" as const });
}

describe("PR test runner prepared plans", () => {
  it("retains critical-owner files despite a retired coverage-deferral environment flag", () => {
    const selected = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-ownership.test.ts"];
    const plain = selectingSpawn();
    runPrTests({ argv: ["--base=base"], env, spawn: plain as never, planSelection: selection(selected) });
    const deferred = selectingSpawn();
    runPrTests({ argv: ["--base=base"], env: { ...env, PR_TESTS_DEFER_CRITICAL_OWNERS: "1" }, spawn: deferred as never, planSelection: selection(selected) });
    const files = plain.mock.calls.find(([, args]) => args[0] === "run")![1].slice(1);
    const remaining = deferred.mock.calls.find(([, args]) => args[0] === "run")?.[1].slice(1) ?? [];
    expect(files.some((file) => CRITICAL_TEST_FILES.includes(file))).toBe(true);
    expect(remaining).toEqual(files);
  });

  it("executes only the requested prepared files without rerunning selection or native Vitest sharding", () => {
    const path = planPath();
    const files = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-ownership.test.ts"];
    const plan = createPrTestPlan("base", files);
    writeFileSync(path, JSON.stringify(plan));
    const spawn = selectingSpawn();
    expect(runPrTests({ argv: ["--base=base", "--shard=1/1", "--reporter=dot"], env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(["run", ...plan.shards[0], "--reporter=dot", "--tagsFilter=!nightly"]);
  });

  it("filters the nightly tier from every PR shard without dropping a caller's own tag filter", () => {
    const files = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-ownership.test.ts"];
    const spawn = selectingSpawn();
    expect(runPrTests({
      argv: ["--base=base", "--shard=1/1", "--tagsFilter=network"],
      env,
      spawn: spawn as never,
      planSelection: selection(files),
    })).toBe(0);
    const args = spawn.mock.calls.find(([, spawnArgs]) => spawnArgs[0] === "run")![1];
    // `--tagsFilter` values apply with AND, so the appended filter narrows.
    expect(args).toContain("--tagsFilter=network");
    expect(args).toContain("--tagsFilter=!nightly");
  });

  it("uses the same deterministic partitions for local shards and prepared plans", () => {
    const path = planPath();
    const prepare = selectingSpawn();
    const files = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-ownership.test.ts"];
    expect(runPrTests({ argv: ["--plan-out", path], env, spawn: prepare as never, planSelection: selection(files) })).toBe(0);
    expect(prepare.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
    const plan = readPrTestPlan(path);
    for (let shard = 1; shard <= plan.shardCount; shard++) {
      const spawn = selectingSpawn();
      expect(runPrTests({ argv: [`--shard=${shard}/${plan.shardCount}`], env, spawn: spawn as never, planSelection: selection(files) })).toBe(0);
      expect(spawn.mock.calls.find(([, args]) => args[0] === "run")?.[1]).toEqual(["run", ...plan.shards[shard - 1], "--tagsFilter=!nightly"]);
    }
  });

  it("plans a duration partition from nightly timings and ignores unusable timing evidence", () => {
    const files = ["scripts/__tests__/run-pr-tests.test.ts", "scripts/__tests__/critical-ownership.test.ts"];
    const timings = temporaryPath("timings.json");
    writeFileSync(timings, JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      files: Object.fromEntries(files.map((file) => [file, 2_000])),
    }));
    const path = planPath();
    expect(runPrTests({ argv: ["--plan-out", path, `--timings=${timings}`], env, spawn: selectingSpawn() as never, planSelection: selection(files) })).toBe(0);
    const planned = readPrTestPlan(path);
    expect(planned.partitionMode).toBe("duration");
    expect(planned.timingsGeneratedAt).toBeDefined();

    const stale = temporaryPath("stale.json");
    writeFileSync(stale, JSON.stringify({ version: 1, generatedAt: "2020-01-01T00:00:00.000Z", files: { "a.test.ts": 1_000 } }));
    const stalePlan = planPath();
    expect(runPrTests({ argv: ["--plan-out", stalePlan, "--timings", stale], env, spawn: selectingSpawn() as never, planSelection: selection(files) })).toBe(0);
    expect(readPrTestPlan(stalePlan).partitionMode).toBe("round-robin");
    expect(() => runPrTests({ argv: ["--timings", timings], env, spawn: selectingSpawn() as never, planSelection: selection(files) })).toThrow("--timings requires --plan-out");
  });

  it("falls back to the authoritative vitest list when the static planner reports unresolved specifiers", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawn = selectingSpawn();
    try {
      expect(runPrTests({
        argv: ["--base=base"],
        env,
        spawn: spawn as never,
        planSelection: () => ({ files: [], mode: "closure", fallback: "1 unresolved local specifier" }),
      })).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(spawn.mock.calls.some(([, args]) => args[0] === "list")).toBe(true);
    const run = spawn.mock.calls.find(([, args]) => args[0] === "run")![1].slice(1);
    expect(run).toContain("scripts/__tests__/critical-ownership.test.ts");
  });

  it("drops the doc invariant suites from the docs-driven selection only", () => {
    const docsOnly = planPath();
    expect(runPrTests({
      argv: ["--plan-out", docsOnly],
      env,
      spawn: vi.fn(() => ({ status: 0, stdout: "docs/testing.md\0", stderr: "" })) as never,
      planSelection: selection([]),
    })).toBe(0);
    const docsPlan = readPrTestPlan(docsOnly).shards.flat();
    expect(docsPlan).not.toContain(docOwnership);
    expect(docsPlan).not.toContain(changeContract);
    expect(docsPlan.length).toBeGreaterThan(0);

    // package.json is a non-doc source of the documentation declaration, so the
    // ratchet stays; every agent-hooks source is documentation, so the router
    // suite stays with the static-guards docs owner.
    const mixed = planPath();
    expect(runPrTests({
      argv: ["--plan-out", mixed],
      env,
      spawn: vi.fn(() => ({ status: 0, stdout: "docs/testing.md\0package.json\0", stderr: "" })) as never,
      planSelection: selection([]),
    })).toBe(0);
    const mixedPlan = readPrTestPlan(mixed).shards.flat();
    expect(mixedPlan).toContain(docOwnership);
    expect(mixedPlan).not.toContain(changeContract);

    // A changed test file is its own reason to run.
    const changedTest = planPath();
    expect(runPrTests({
      argv: ["--plan-out", changedTest],
      env,
      spawn: vi.fn(() => ({ status: 0, stdout: "docs/testing.md\0", stderr: "" })) as never,
      planSelection: selection([changeContract]),
    })).toBe(0);
    expect(readPrTestPlan(changedTest).shards.flat()).toContain(changeContract);
  });

  it("fails closed on missing/malformed plans, missing coordinates, and mismatched base/count", () => {
    const path = planPath();
    const spawn = selectingSpawn();
    const options = { env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never };
    expect(() => runPrTests({ ...options, argv: ["--shard=1/1"] })).toThrow();
    writeFileSync(path, "{}");
    expect(() => runPrTests({ ...options, argv: ["--shard=1/1"] })).toThrow();
    writeFileSync(path, JSON.stringify(createPrTestPlan("base", ["scripts/__tests__/run-pr-tests.test.ts"])));
    expect(() => runPrTests({ ...options, argv: [] })).toThrow("requires --shard");
    expect(() => runPrTests({ ...options, argv: ["--shard=2/2"] })).toThrow("does not match");
    expect(() => runPrTests({ ...options, argv: ["--base=other", "--shard=1/1"] })).toThrow("does not match");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a plan whose explicit shards cannot cover the selection", () => {
    const path = planPath();
    writeFileSync(path, JSON.stringify({ version: 1, base: "base", fileCount: 2, shardCount: 1, shards: [[]] }));
    const spawn = selectingSpawn();
    expect(() => runPrTests({ argv: ["--shard=1/1"], env: { ...env, PR_TEST_PLAN_FILE: path }, spawn: spawn as never })).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
