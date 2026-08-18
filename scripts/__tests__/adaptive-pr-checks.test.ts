import { describe, expect, it, vi } from "vitest";

import { selectLintableFiles } from "../ci/run-changed-eslint.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.ts";

describe("adaptive PR checks", () => {
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

  it("runs the critical-coverage completeness guard for every non-doc PR path", () => {
    expect(buildPrStaticCheckPlan(["worker/src/lib/auth.ts"]).commands.map((command) => command.name)).toContain(
      "check:critical-coverage-completeness",
    );
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
});
