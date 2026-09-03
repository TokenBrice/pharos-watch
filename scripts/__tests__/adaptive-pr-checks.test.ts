import { describe, expect, it, vi } from "vitest";

import { selectLintableFiles } from "../ci/run-changed-eslint.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { ALWAYS_RUN_TEST_FILES, parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import {
  buildPrStaticCheckPlan,
  hasOwnedDocsImpact,
  partitionPrStaticCheckPlan,
  runPrStaticChecks,
} from "../maintenance/run-pr-static-checks.ts";
import { runPrChecks } from "../maintenance/run-pr-checks.ts";

describe("adaptive PR checks", () => {
  it("emits the stable check:pr JSON envelope through the adaptive harness", async () => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const runCommandImpl = vi.fn(async (command: { cmd: string }) => {
      if (command.cmd.startsWith("git rev-parse")) return { status: 0, aborted: false, output: "HEAD\n" };
      if (command.cmd.startsWith("git show")) return { status: 0, aborted: false, output: "0\n" };
      return { status: 0, aborted: false, output: "" };
    });

    await expect(runPrChecks(["--json", "--base=HEAD", "--head=HEAD", "--no-fetch"], process.env, {
      now: () => 0,
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      base: "HEAD",
      head: "HEAD",
      changedFiles: [],
      status: "passed",
      durationMs: expect.any(Number),
    });
    expect(report.classification).toEqual(expect.objectContaining({ docsOnly: false }));
    expect(report.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "classifier-smoke",
        command: expect.any(String),
        status: "passed",
        durationMs: expect.any(Number),
        failureTail: "",
      }),
    ]));
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("{\"base\"");
  });

  it("emits the stable check:pr:static JSON envelope", async () => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const runCommandImpl = vi.fn(async () => ({ status: 0, aborted: false, output: "" }));

    await expect(runPrStaticChecks({
      argv: ["--json", "--base=HEAD", "--head=HEAD"],
      env: process.env,
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      base: "HEAD",
      head: "HEAD",
      changedFiles: [],
      status: "passed",
      durationMs: expect.any(Number),
    });
    expect(report.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lint:changed",
        status: "passed",
        durationMs: expect.any(Number),
        failureTail: "",
      }),
    ]));
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("{\"base\"");
  });

  it("parses diff arguments without swallowing downstream options", () => {
    expect(parseChangedFileArgs(["--base=abc", "--head", "def", "--shard=1/2"], {} as NodeJS.ProcessEnv)).toEqual({
      base: "abc",
      head: "def",
      rest: ["--shard=1/2"],
      staged: false,
    });
  });

  it("collects normalized unique changed files", () => {
    const execFile = vi.fn(() => "src/a.ts\0src/a.ts\0docs/testing.md\0");
    expect(collectChangedFiles({ base: "a", head: "b", execFile: execFile as never })).toEqual([
      "docs/testing.md",
      "src/a.ts",
    ]);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", "-z", "a...b"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("limits ESLint to changed source files that still exist", () => {
    expect(
      selectLintableFiles(["docs/a.md", "src/a.ts", "src/deleted.ts", "worker/a.mjs"], {
        exists: (path) => path !== "src/deleted.ts",
      }),
    ).toEqual(["src/a.ts", "worker/a.mjs"]);
  });

  it("unions changed Vitest files with the critical contract set", () => {
    const listed = parseVitestFileList("[unit] src/a.test.ts\n[worker] worker/a.spec.ts\n");
    expect(selectPrTestFiles(listed, ["critical.test.ts"])).toEqual([
      "critical.test.ts",
      "src/a.test.ts",
      "worker/a.spec.ts",
    ]);
  });

  it("always selects global invariants for unrelated source changes", () => {
    const selected = selectPrTestFiles(["src/components/unrelated-source.test.ts"]);

    expect(selected).toEqual(
      expect.arrayContaining([
        "src/lib/__tests__/reserve-coinid-validation.test.ts",
        "worker/src/cron/__tests__/telegram-recap-cost-boundary.test.ts",
        "src/components/unrelated-source.test.ts",
      ]),
    );
  });

  it("keeps the always-on contract diet at exactly thirty unique files", () => {
    expect(ALWAYS_RUN_TEST_FILES).toHaveLength(30);
    expect(new Set(ALWAYS_RUN_TEST_FILES).size).toBe(30);
  });

  it("selects importing owners for changed critical source files", () => {
    const selected = selectPrTestFiles([], ALWAYS_RUN_TEST_FILES, ["worker/src/lib/auth.ts"]);

    expect(selected).toContain("worker/src/lib/__tests__/auth.test.ts");
  });

  it("selects impacted generated artifacts and downstream dependants", () => {
    const registry = [
      { id: "catalog", sourcePaths: ["data/**"] },
      { id: "index", sourcePaths: ["scripts/index.ts"], dependsOn: ["catalog"] },
      { id: "other", sourcePaths: ["other/**"] },
    ] as never;
    expect(selectChangedGeneratedArtifactIds(["data/coin.json"], registry)).toEqual(["catalog", "index"]);
  });

  // A docs-only PR still verifies the one artifact derived from docs (llms.txt);
  // artifact freshness is now selected from the changed sources themselves
  // rather than from whether a Pages surface moved.
  it("keeps docs-only PRs on the small static baseline", () => {
    expect(buildPrStaticCheckPlan(["docs/testing.md"]).commands.map((command) => command.name)).toEqual([
      "lint:changed",
      "check:table-primitives",
      "typecheck",
      "check:env-contract",
      "check:shared-types-imports",
      "check:critical-coverage-completeness",
      "check:generated-artifacts",
    ]);
  });

  it("selects doc-sync when a changed source has an owning documentation mapping", () => {
    expect(hasOwnedDocsImpact(["shared/lib/classification.ts"])).toBe(true);
    expect(buildPrStaticCheckPlan(["shared/lib/classification.ts"]).commands.map((command) => command.name))
      .toContain("check:doc-sync");
  });

  it("runs the critical-coverage completeness guard for every non-doc PR path", () => {
    expect(buildPrStaticCheckPlan(["worker/src/lib/auth.ts"]).commands.map((command) => command.name)).toContain(
      "check:critical-coverage-completeness",
    );
  });

  it("runs typechecks, structural checks, and generated verification in the bounded parallel phase", () => {
    const { commands } = buildPrStaticCheckPlan([
      "worker/src/lib/safety-score-v9-extension.ts",
      "docs/editorial-style.md",
    ]);
    const partition = partitionPrStaticCheckPlan(commands);

    expect(partition.parallel.map((command) => command.name)).toEqual(
      expect.arrayContaining([
        "typecheck",
        "typecheck:worker",
        "check:structural",
        "check:generated-artifacts",
      ]),
    );
    expect(partition.deferred.map((command) => command.name)).toEqual(["test"]);
    expect(partition.sequential.map((command) => command.name)).toContain("check:worker-package");
  });

  it("packages Worker changes in the adaptive PR lane", () => {
    expect(buildPrStaticCheckPlan(["worker/src/index.ts"]).commands.map((command) => command.name)).toContain(
      "check:worker-package",
    );
  });

  it("checks a changed generated artifact even when no Pages surface moved", () => {
    // The Wave-1 near-miss: a worker-only commit touching a manifest-pinned V9
    // source left the evaluation-build manifest stale and passed the PR gate.
    const plan = buildPrStaticCheckPlan(["worker/src/lib/safety-score-v9-extension.ts"]);
    const artifactCommand = plan.commands.find(
      (command): command is { name: string; args: string[] } =>
        command.name === "check:generated-artifacts" && "args" in command,
    );
    expect(plan.classification.pagesChanged).toBe(false);
    expect(artifactCommand?.args[0]).toContain("safety-score-v9-evaluation-build");
  });

  it("checks the editorial-style artifact for its docs source", () => {
    const plan = buildPrStaticCheckPlan(["docs/editorial-style.md"]);
    const artifactCommand = plan.commands.find(
      (command): command is { name: string; args: string[] } =>
        command.name === "check:generated-artifacts" && "args" in command,
    );

    expect(plan.classification.docsOnly).toBe(false);
    expect(artifactCommand?.args[0]).toContain("editorial-style");
  });

  it("selects structural checks for production and validation surfaces", () => {
    for (const path of [
      "src/lib/feature-flags.ts",
      "worker/src/cron/sync-stablecoins.ts",
      "scripts/ci/check-provider-resilience.ts",
      ".github/workflows/nightly-validation.yml",
    ]) {
      expect(buildPrStaticCheckPlan([path]).commands.map((command) => command.name)).toContain("check:structural");
    }
  });
  it("uses only the lightweight structural checks for test-only changes", () => {
    const names = buildPrStaticCheckPlan(["worker/src/cron/__tests__/x.test.ts"]).commands.map(
      (command) => command.name,
    );
    expect(names.filter((name) => ["check:structural", "check:clone-ratchet", "check:cron-console-usage"].includes(name))).toEqual([
      "check:clone-ratchet",
      "check:cron-console-usage",
    ]);
  });

  it("keeps the full structural chain when production and test paths are mixed", () => {
    const names = buildPrStaticCheckPlan([
      "worker/src/cron/__tests__/x.test.ts",
      "worker/src/cron/x.ts",
    ]).commands.map((command) => command.name);
    expect(names).toContain("check:structural");
    expect(names).not.toContain("check:clone-ratchet");
    expect(names).not.toContain("check:cron-console-usage");
  });

  it("keeps the full structural chain for scripts CI sources", () => {
    const names = buildPrStaticCheckPlan(["scripts/ci/foo.ts"]).commands.map((command) => command.name);
    expect(names).toContain("check:structural");
    expect(names).not.toContain("check:clone-ratchet");
    expect(names).not.toContain("check:cron-console-usage");
  });

  it("runs the editorial policy gate for every registered extractor family", () => {
    const representativePaths = [
      "data/ai-summaries.json",
      "src/data/changelogs/example.ts",
      "src/data/blog/posts/example.md",
      "scripts/lib/editorial-baseline.json",
      "scripts/lib/editorial-exceptions.json",
    ];
    const plan = buildPrStaticCheckPlan(representativePaths);
    const editorialCommand = plan.commands.find((command) => command.name === "test");
    expect(editorialCommand).toEqual({
      name: "test",
      args: ["scripts/__tests__/editorial-policy.test.ts"],
    });
    expect(buildPrStaticCheckPlan(["src/lib/not-an-editorial-surface.ts"]).commands).not.toContainEqual(editorialCommand);
  });
});
