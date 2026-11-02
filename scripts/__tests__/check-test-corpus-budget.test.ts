import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_NEW_TEST_FILES,
  TEST_CORPUS_BUDGET_PATH,
  classifyTestCorpusPath,
  collectAddedTestFiles,
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

function capture(): { output: { text: string }; writer: { write(value: string): unknown } } {
  const output = { text: "" };
  return {
    output,
    writer: { write(value: string) { output.text += value; return true; } },
  };
}

const BUDGET: TestCorpusMetrics = { testFiles: 1, testBytes: 10, testSupportFiles: 1, fixtureBytes: 10 };

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
    ["worker/src/cron/reserve-adapters/__tests__/fixtures/usde.html", "fixtureBytes"],
    ["shared/lib/selector/__fixtures__/active-universe.json", "fixtureBytes"],
    ["worker/src/lib/score.ts", null],
    ["docs/testing.md", null],
  ])("classifies %s as %s", (path, bucket) => {
    expect(classifyTestCorpusPath(path)).toBe(bucket);
  });

  it("counts and sizes each bucket once and reports a tracked file it cannot size", () => {
    const sizes: Record<string, number> = { "/repo/a.test.ts": 100, "/repo/fixtures/x.json": 7 };
    const snapshot = measureTestCorpus(
      ["a.test.ts", "fixtures/x.json", "test-utils/helper.ts", "src/app.ts"],
      { root: "/repo", sizeOf: (path) => {
        const size = sizes[path];
        if (size === undefined) throw new Error("missing");
        return size;
      } },
    );
    expect(snapshot.metrics).toEqual({ testFiles: 1, testBytes: 100, testSupportFiles: 1, fixtureBytes: 7 });
    expect(snapshot.unreadable).toEqual([]);

    const missing = measureTestCorpus(["a.test.ts", "gone.test.ts"], {
      root: "/repo",
      sizeOf: () => { throw new Error("ENOENT"); },
    });
    expect(missing.metrics).toEqual({ testFiles: 0, testBytes: 0, testSupportFiles: 0, fixtureBytes: 0 });
    expect(missing.unreadable).toEqual(["a.test.ts", "gone.test.ts"]);
  });
});

describe("test corpus budget", () => {
  it("fails each metric above its ceiling and names the action", () => {
    const findings = evaluateTestCorpusBudget({
      metrics: { testFiles: 3, testBytes: 20, testSupportFiles: 1, fixtureBytes: 10 },
      budget: BUDGET,
      addedTestFiles: ["a.test.ts", "b.test.ts", "c.test.ts"],
      override: false,
    });
    expect(findings.map((finding) => finding.code)).toEqual(["budget", "budget", "new-test-files"]);
    expect(findings[0].detail).toContain("testFiles: 3 > budget 1 (+2)");
    expect(findings[0].detail).toContain("owning suite");
    expect(findings[1].detail).toContain("testBytes: 20 > budget 10 (+10)");
    expect(findings[2].detail).toContain(`3 new test files > cap ${MAX_NEW_TEST_FILES}`);
    expect(findings[2].detail).toContain("Test justification");
  });

  it("admits the cap exactly and suppresses every finding under the owner override", () => {
    const atCap = Array.from({ length: MAX_NEW_TEST_FILES }, (_, index) => `new-${index}.test.ts`);
    expect(evaluateTestCorpusBudget({ metrics: BUDGET, budget: BUDGET, addedTestFiles: atCap, override: false })).toEqual([]);
    expect(evaluateTestCorpusBudget({
      metrics: { testFiles: 99, testBytes: 99, testSupportFiles: 99, fixtureBytes: 99 },
      budget: BUDGET,
      addedTestFiles: null,
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

  it("seeds from the tracked tree, ignores untracked copies and never raises a ceiling", () => {
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
    expect(output.text).toContain("testFiles: 1 (seeded)");
    const budget = JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8"));
    expect(budget.metrics).toEqual({ testFiles: 1, testBytes: 40, testSupportFiles: 1, fixtureBytes: 2 });
    rmSync(join(root, "shared/lib/__tests__/untracked.test.ts"));

    // Growing the corpus cannot move a ceiling; shrinking it must.
    write("shared/lib/__tests__/b.test.ts", "y".repeat(10));
    commit("add a test");
    const grownCorpus = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--update"], root, stdout: grownCorpus.writer, stderr: grownCorpus.writer })).toBe(0);
    expect(grownCorpus.output.text).toContain("testFiles: 1 (held)");
    expect(JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).metrics.testFiles).toBe(1);

    rmSync(join(root, "shared/lib/__tests__/b.test.ts"));
    rmSync(join(root, "shared/lib/__tests__/a.test.ts"));
    commit("retire both tests");
    const lowered = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--update"], root, stdout: lowered.writer, stderr: lowered.writer })).toBe(0);
    expect(lowered.output.text).toContain("testFiles: 0 (lowered from 1)");
    expect(JSON.parse(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).metrics)
      .toEqual({ testFiles: 0, testBytes: 0, testSupportFiles: 1, fixtureBytes: 2 });
  });

  it("fails closed on an absent budget, on growth and on a missing PR base", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/a.test.ts", "x");
    commit("base");

    expect(() => runTestCorpusBudgetCheck({
      argv: ["--metrics-only"], root, stdout: capture().writer, stderr: capture().writer,
    })).toThrow("is missing; run `npm run test-corpus:update`");

    seedBudget(root, { testFiles: 0, testBytes: 0, testSupportFiles: 0, fixtureBytes: 0 });
    const grown = capture();
    const grownErr = capture();
    expect(runTestCorpusBudgetCheck({ argv: ["--metrics-only"], root, stdout: grown.writer, stderr: grownErr.writer })).toBe(1);
    expect(grown.output.text).toContain("added test files: not evaluated (--metrics-only");
    expect(grownErr.output.text).toContain("[budget] testFiles: 1 > budget 0 (+1)");

    expect(() => runTestCorpusBudgetCheck({ argv: [], root, stdout: capture().writer, stderr: capture().writer, env: { NODE_ENV: "test" } }))
      .toThrow("H3 needs the frozen PR base");
  });

  it("caps added test files against the frozen base and admits them only with the override", () => {
    const { root, write, commit } = createRepo();
    write("shared/lib/__tests__/owner.test.ts", "x");
    commit("base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    write("shared/lib/__tests__/one.test.ts", "1");
    write("shared/lib/__tests__/two.test.ts", "2");
    write("shared/lib/__tests__/three.test.ts", "3");
    commit("add three test files");
    seedBudget(root, { testFiles: 10, testBytes: 1000, testSupportFiles: 10, fixtureBytes: 1000 });

    expect(collectAddedTestFiles({ root, base })).toEqual([
      "shared/lib/__tests__/one.test.ts",
      "shared/lib/__tests__/three.test.ts",
      "shared/lib/__tests__/two.test.ts",
    ]);

    const capped = capture();
    const cappedErr = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`], root, stdout: capped.writer, stderr: cappedErr.writer, env: { NODE_ENV: "test" },
    })).toBe(1);
    expect(capped.output.text).toContain("added test files: 3/2");
    expect(cappedErr.output.text).toContain("[new-test-files] 3 new test files > cap 2");

    const budgetBefore = readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8");
    const overridden = capture();
    expect(runTestCorpusBudgetCheck({
      argv: [`--base=${base}`, "--override"], root, stdout: overridden.writer, stderr: capture().writer, env: { NODE_ENV: "test" },
    })).toBe(0);
    expect(overridden.output.text).toContain("test-budget-override: growth and the new-file cap admitted");
    expect(readFileSync(join(root, TEST_CORPUS_BUDGET_PATH), "utf8")).toBe(budgetBefore);
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
  writeFileSync(path, `${JSON.stringify({ version: 1, note: "fixture budget", metrics }, null, 2)}\n`);
}
