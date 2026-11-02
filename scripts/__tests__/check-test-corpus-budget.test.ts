import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_NEW_TEST_FILES,
  TEST_CORPUS_BUDGET_PATH,
  TEST_CORPUS_SLACK,
  classifyTestCorpusPath,
  collectNetNewTestFiles,
  collectTrackedFiles,
  evaluateTestCorpusBudget,
  measureTestCorpus,
  runTestCorpusBudgetCheck,
  type TestCorpusMetrics,
} from "../ci/check-test-corpus-budget";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRepo(): { root: string; git: (...args: string[]) => void; write: (path: string, content: string) => void; commit: (message: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "pharos-test-corpus-"));
  roots.push(root);
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-qm", message);
  };
  return { root, git, write, commit };
}

function headOf(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function capture(): { output: { text: string }; writer: { write(value: string): unknown } } {
  const output = { text: "" };
  return {
    output,
    writer: { write(value: string) { output.text += value; return true; } },
  };
}

const BUDGET: TestCorpusMetrics = {
  testFiles: 1,
  testBytes: 10,
  testSupportFiles: 1,
  testSupportBytes: 10,
  fixtureBytes: 10,
};

describe("test corpus metric classification", () => {
  it.each([
    ["worker/src/lib/__tests__/score.test.ts", "testFiles"],
    ["src/app/page.test.tsx", "testFiles"],
    ["scripts/__tests__/fixtures/report.spec.mjs", "testFiles"],
    ["shared/test-utils/mock-d1.ts", "testSupportFiles"],
    ["scripts/test-utils/d1.ts", "testSupportFiles"],
    ["worker/src/test-helpers/__shared/fixtures.ts", "testSupportFiles"],
    ["worker/src/__mocks__/satori-stub.ts", "testSupportFiles"],
    ["shared/lib/bluechip.test-support.ts", "testSupportFiles"],
    ["shared/lib/bluechip-test-support.ts", "testSupportFiles"],
    ["src/app/stablecoin/[id]/client-test-support.tsx", "testSupportFiles"],
    ["src/app/stablecoin/[id]/test-support.ts", "testSupportFiles"],
    ["scripts/__tests__/helpers/test-state.ts", "testSupportFiles"],
    ["worker/src/cron/reserve-adapters/__tests__/fixtures/usde.html", "fixtureBytes"],
    ["shared/lib/selector/__fixtures__/active-universe.json", "fixtureBytes"],
    ["worker/src/lib/score.ts", null],
    ["docs/testing.md", null],
  ])("classifies %s as %s", (path, bucket) => {
    expect(classifyTestCorpusPath(path)).toBe(bucket);
  });

  it("counts and sizes each bucket once and reports a tracked file it cannot size", () => {
    const sizes: Record<string, number> = {
      "/repo/a.test.ts": 100,
      "/repo/fixtures/x.json": 7,
      "/repo/test-utils/helper.ts": 3,
    };
    const snapshot = measureTestCorpus(
      ["a.test.ts", "fixtures/x.json", "test-utils/helper.ts", "src/app.ts"],
      { root: "/repo", sizeOf: (path) => {
        const size = sizes[path];
        if (size === undefined) throw new Error("missing");
        return size;
      } },
    );
    expect(snapshot.metrics).toEqual({
      testFiles: 1,
      testBytes: 100,
      testSupportFiles: 1,
      testSupportBytes: 3,
      fixtureBytes: 7,
    });
    expect(snapshot.unreadable).toEqual([]);

    const missing = measureTestCorpus(["a.test.ts", "gone.test.ts"], {
      root: "/repo",
      sizeOf: () => { throw new Error("ENOENT"); },
    });
    expect(missing.metrics).toEqual({
      testFiles: 0,
      testBytes: 0,
      testSupportFiles: 0,
      testSupportBytes: 0,
      fixtureBytes: 0,
    });
    expect(missing.unreadable).toEqual(["a.test.ts", "gone.test.ts"]);
  });
});

describe("test corpus budget", () => {
  const OVER: TestCorpusMetrics = {
    testFiles: 3,
    testBytes: 20,
    testSupportFiles: 1,
    testSupportBytes: 10,
    fixtureBytes: 10,
  };

  it("fails each metric above its ceiling and names the action", () => {
    const findings = evaluateTestCorpusBudget({
      metrics: OVER,
      budget: BUDGET,
      addedTestFiles: ["a.test.ts", "b.test.ts", "c.test.ts"],
      override: false,
    });
    expect(findings.map((finding) => finding.code)).toEqual(["budget", "budget", "new-test-files"]);
    expect(findings[0].detail).toContain("testFiles: 3 > budget 1 (+2)");
    expect(findings[0].detail).toContain("owning suite");
    expect(findings[1].detail).toContain("testBytes: 20 > budget 10 (+10)");
    expect(findings[2].detail).toContain(`3 net new test files > cap ${MAX_NEW_TEST_FILES}`);
    expect(findings[2].detail).toContain("(3 added, 0 deleted)");
    expect(findings[2].detail).toContain("Test justification");
  });

  it("counts net new test files so a move or consolidation is not a new file", () => {
    const moved = evaluateTestCorpusBudget({
      metrics: BUDGET,
      budget: BUDGET,
      addedTestFiles: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
      removedTestFiles: 2,
      override: false,
    });
    expect(moved.map((finding) => finding.code)).toEqual(["new-test-files"]);
    expect(moved[0].detail).toContain("3 net new test files > cap 2 (5 added, 2 deleted)");

    expect(evaluateTestCorpusBudget({
      metrics: BUDGET,
      budget: BUDGET,
      addedTestFiles: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
      removedTestFiles: 3,
      override: false,
    })).toEqual([]);
  });

  it("anchors the limit to the frozen base so main being over budget never fails a flat PR", () => {
    const overMain: TestCorpusMetrics = { ...BUDGET, testFiles: 3 };
    const findings = evaluateTestCorpusBudget({
      metrics: { ...BUDGET, testFiles: 4 },
      budget: BUDGET,
      baseMetrics: overMain,
      addedTestFiles: [],
      override: false,
    });
    expect(findings.map((finding) => finding.code)).toEqual(["budget"]);
    expect(findings[0].detail).toContain("testFiles: 4 > limit 3 (budget 1, base 3) (+1)");

    expect(evaluateTestCorpusBudget({
      metrics: overMain,
      budget: BUDGET,
      baseMetrics: overMain,
      addedTestFiles: [],
      override: false,
    })).toEqual([]);
  });

  it("fails a ceiling raise or a deleted budget file against the frozen base", () => {
    const raised = evaluateTestCorpusBudget({
      metrics: BUDGET,
      budget: { ...BUDGET, testFiles: 5 },
      baseBudget: BUDGET,
      addedTestFiles: [],
      override: false,
    });
    expect(raised.map((finding) => finding.code)).toEqual(["ceiling-raise"]);
    expect(raised[0].detail).toContain("testFiles: ceiling raised 1 → 5 (+4) against the frozen base");
    expect(raised[0].detail).toContain("test-budget-override");

    const deleted = evaluateTestCorpusBudget({
      metrics: BUDGET,
      budget: BUDGET,
      baseBudget: BUDGET,
      budgetDeleted: true,
      addedTestFiles: [],
      override: false,
    });
    expect(deleted.map((finding) => finding.code)).toEqual(["budget-deleted"]);
    expect(deleted[0].detail).toContain(TEST_CORPUS_BUDGET_PATH);
  });

  it("admits the cap exactly and suppresses every finding under the owner override", () => {
    const atCap = Array.from({ length: MAX_NEW_TEST_FILES }, (_, index) => `new-${index}.test.ts`);
    expect(evaluateTestCorpusBudget({ metrics: BUDGET, budget: BUDGET, addedTestFiles: atCap, override: false })).toEqual([]);
    const everything: TestCorpusMetrics = {
      testFiles: 99,
      testBytes: 99,
      testSupportFiles: 99,
      testSupportBytes: 99,
      fixtureBytes: 99,
    };
    expect(evaluateTestCorpusBudget({
      metrics: everything,
      budget: BUDGET,
      baseMetrics: BUDGET,
      baseBudget: BUDGET,
      budgetDeleted: true,
      addedTestFiles: atCap,
      removedTestFiles: 0,
      override: true,
    })).toEqual([]);
  });
});

describe("test corpus budget CLI", () => {
  function seed(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }

  it("seeds with per-metric slack, ignores untracked copies and never raises a ceiling", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x".repeat(40));
    write("shared/test-utils/helper.ts", "h");
    write("shared/lib/__tests__/fixtures/case.json", "{}");
    write("shared/lib/score.ts", "production");
    commit("base");
    seed(root, { "shared/lib/__tests__/untracked.test.ts": "ignored by the index" });
    expect(collectTrackedFiles(root)).toContain("shared/lib/__tests__/a.test.ts");
    expect(collectTrackedFiles(root)).not.toContain("shared/lib/__tests__/untracked.test.ts");

    const { writer, output } = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--update"], root, stdout: writer, stderr: writer })).toBe(0);
    expect(output.text).toContain("testFiles: 5 (seeded)");
    const budget = JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8"));
    expect(budget.metrics).toEqual({
      testFiles: 1 + TEST_CORPUS_SLACK.testFiles,
      testBytes: 40 + TEST_CORPUS_SLACK.testBytes,
      testSupportFiles: 1 + TEST_CORPUS_SLACK.testSupportFiles,
      testSupportBytes: 1 + TEST_CORPUS_SLACK.testSupportBytes,
      fixtureBytes: 2 + TEST_CORPUS_SLACK.fixtureBytes,
    });
    rmSync(join(root, "shared/lib/__tests__/untracked.test.ts"));

    // Growing the corpus inside the slack cannot move a ceiling; exceeding it must.
    write("shared/lib/__tests__/b.test.ts", "y".repeat(TEST_CORPUS_SLACK.testBytes));
    commit("add a test");
    const grownCorpus = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--update"], root, stdout: grownCorpus.writer, stderr: grownCorpus.writer })).toBe(0);
    expect(grownCorpus.output.text).toContain(`testFiles: ${1 + TEST_CORPUS_SLACK.testFiles} (held)`);
    expect(JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).metrics.testFiles)
      .toBe(1 + TEST_CORPUS_SLACK.testFiles);

    rmSync(join(root, "shared/lib/__tests__/b.test.ts"));
    rmSync(join(root, "shared/lib/__tests__/a.test.ts"));
    commit("retire both tests");
    const lowered = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--update"], root, stdout: lowered.writer, stderr: lowered.writer })).toBe(0);
    expect(lowered.output.text).toContain(`testFiles: ${TEST_CORPUS_SLACK.testFiles} (lowered from ${1 + TEST_CORPUS_SLACK.testFiles})`);
    expect(JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).metrics)
      .toEqual({
        testFiles: TEST_CORPUS_SLACK.testFiles,
        testBytes: TEST_CORPUS_SLACK.testBytes,
        testSupportFiles: 1 + TEST_CORPUS_SLACK.testSupportFiles,
        testSupportBytes: 1 + TEST_CORPUS_SLACK.testSupportBytes,
        fixtureBytes: 2 + TEST_CORPUS_SLACK.fixtureBytes,
      });
  });

  it("fails closed on an absent budget, on growth and on a missing PR base", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x");
    commit("base");

    expect(() => runTestCorpusBudgetCheck({
      argv: ["--metrics-only"], root, stdout: capture().writer, stderr: capture().writer,
    })).toThrow("is missing; run `npm run test-corpus:update`");

    seedBudget(root, { ...BUDGET, testFiles: 0, testBytes: 0, testSupportFiles: 0, testSupportBytes: 0, fixtureBytes: 0 });
    const grown = capture();
    const grownErr = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--metrics-only"], root, stdout: grown.writer, stderr: grownErr.writer })).toBe(1);
    expect(grown.output.text).toContain("added test files: not evaluated (--metrics-only");
    expect(grownErr.output.text).toContain("[budget] testFiles: 1 > budget 0 (+1)");

    expect(() => runTestCorpusBudgetCheck({ argv: [], root, stdout: capture().writer, stderr: capture().writer, env: { NODE_ENV: "test" } }))
      .toThrow("need the frozen PR base");
  });

  it("caps net added test files against the frozen base and admits them only with the override", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/owner.test.ts", "x");
    write("shared/lib/__tests__/retired.test.ts", "x");
    commit("base");
    const base = headOf(root);
    write("shared/lib/__tests__/one.test.ts", "1");
    write("shared/lib/__tests__/two.test.ts", "2");
    write("shared/lib/__tests__/three.test.ts", "3");
    rmSync(join(root, "shared/lib/__tests__/retired.test.ts"));
    commit("add three test files, delete one");
    seedBudget(root, { ...BUDGET, testFiles: 10, testBytes: 1000, testSupportFiles: 10, testSupportBytes: 1000, fixtureBytes: 1000 });

    const delta = collectNetNewTestFiles({ root, base });
    expect(delta.added).toEqual([
      "shared/lib/__tests__/one.test.ts",
      "shared/lib/__tests__/three.test.ts",
      "shared/lib/__tests__/two.test.ts",
    ]);
    expect(delta.removed).toEqual(["shared/lib/__tests__/retired.test.ts"]);

    const capped = capture();
    const cappedErr = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: capped.writer, stderr: cappedErr.writer, env: { NODE_ENV: "test" },
    })).toBe(0);
    expect(capped.output.text).toContain("added test files: net 2/2");
    expect(capped.output.text).toContain("(3 added, 1 deleted)");
    expect(cappedErr.output.text).toBe("");

    const overCap = capture();
    const overCapErr = capture();
    write("shared/lib/__tests__/four.test.ts", "4");
    commit("add a fourth test file");
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: overCap.writer, stderr: overCapErr.writer, env: { NODE_ENV: "test" },
    })).toBe(1);
    expect(overCapErr.output.text).toContain("[new-test-files] 3 net new test files > cap 2 (4 added, 1 deleted)");

    const budgetBefore = readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8");
    const overridden = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`, "--override"], root, stdout: overridden.writer, stderr: capture().writer, env: { NODE_ENV: "test" },
    })).toBe(0);
    expect(overridden.output.text).toContain("test-budget-override: growth, a ceiling raise and the new-file cap admitted");
    expect(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).toBe(budgetBefore);
  });

  it("holds a PR to the frozen base's ceilings and sizes, not to its own tree", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x".repeat(40));
    // The base commits a ceiling below the corpus it measured: main is over budget.
    seedBudget(root, { ...BUDGET, testFiles: 0, testBytes: 0, testSupportFiles: 0, testSupportBytes: 0, fixtureBytes: 0 });
    commit("base");
    const base = headOf(root);

    const flat = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: flat.writer, stderr: capture().writer, env: { NODE_ENV: "test" },
    })).toBe(0);
    expect(flat.output.text).toContain(`frozen base ${base}:`);
    expect(flat.output.text).toContain("test corpus budget: OK");

    // Raising the ceiling in the PR tree fails without the owner label.
    seedBudget(root, { ...BUDGET, testFiles: 5, testBytes: 500, testSupportFiles: 0, testSupportBytes: 0, fixtureBytes: 0 });
    commit("raise the ceiling");
    const raised = capture();
    const raisedErr = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: raised.writer, stderr: raisedErr.writer, env: { NODE_ENV: "test" },
    })).toBe(1);
    expect(raisedErr.output.text).toContain("[ceiling-raise] testFiles: ceiling raised 0 → 5");

    const labelled = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`, "--override"], root, stdout: labelled.writer, stderr: capture().writer, env: { NODE_ENV: "test" },
    })).toBe(0);
  });

  it("sizes the frozen base from Git objects, not from the worktree", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x".repeat(40));
    const generous: TestCorpusMetrics = { ...BUDGET, testFiles: 1, testBytes: 100_000, testSupportFiles: 0, testSupportBytes: 0, fixtureBytes: 0 };
    seedBudget(root, generous);
    commit("base");
    const base = headOf(root);
    // Uncommitted growth: the base measurement must stay the committed 40 bytes.
    write("shared/lib/__tests__/a.test.ts", "y".repeat(4_000));

    const out = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: out.writer, stderr: capture().writer, env: { NODE_ENV: "test" },
    })).toBe(0);
    expect(out.output.text).toContain("testBytes 4000");
    expect(out.output.text).toContain("frozen base");
    expect(out.output.text).toContain("testBytes 40");
  });

  it("fails when the PR deletes the committed budget file", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x".repeat(40));
    seedBudget(root, { ...BUDGET, testFiles: 1, testBytes: 40, testSupportFiles: 0, testSupportBytes: 0, fixtureBytes: 0 });
    commit("base");
    const base = headOf(root);
    rmSync(join(root, TEST_CORPUS_BUDGET_PATH));
    write("shared/lib/__tests__/b.test.ts", "y");
    commit("delete the budget");

    const deleted = capture();
    const deletedErr = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: deleted.writer, stderr: deletedErr.writer, env: { NODE_ENV: "test" },
    })).toBe(1);
    expect(deletedErr.output.text).toContain("[budget-deleted]");
    expect(deletedErr.output.text).toContain("is deleted here");
  });

  it("rejects ambiguous flag combinations before touching the corpus", () => {
    const { root } = createRepo();
    for (const argv of [
      ["--update", "--override"],
      ["--update", "--base=origin/main"],
      ["--metrics-only", "--base=origin/main"],
      ["--nope"],
    ]) {
      expect(() => runTestCorpusBudgetCheck({ argv, root, stdout: capture().writer, stderr: capture().writer })).toThrow();
    }
  });
});

function seedBudget(root: string, metrics: TestCorpusMetrics): void {
  const path = join(root, TEST_CORPUS_BUDGET_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 2, note: "fixture budget", metrics }, null, 2)}\n`);
}
