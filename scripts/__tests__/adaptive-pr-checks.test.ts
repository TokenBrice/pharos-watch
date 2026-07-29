import { describe, expect, it, vi } from "vitest";

import { selectLintableFiles } from "../ci/run-changed-eslint.mjs";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mjs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mjs";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mjs";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.mjs";

describe("adaptive PR checks", () => {
  it("parses diff arguments without swallowing downstream options", () => {
    expect(parseChangedFileArgs(["--base=abc", "--head", "def", "--shard=1/2"], {} as NodeJS.ProcessEnv)).toEqual({
      base: "abc",
      head: "def",
      rest: ["--shard=1/2"],
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

  it("selects impacted generated artifacts and downstream dependants", () => {
    const registry = [
      { id: "catalog", sourcePaths: ["data/**"] },
      { id: "index", sourcePaths: ["scripts/index.ts"], dependsOn: ["catalog"] },
      { id: "other", sourcePaths: ["other/**"] },
    ] as never;
    expect(selectChangedGeneratedArtifactIds(["data/coin.json"], registry)).toEqual(["catalog", "index"]);
  });

  it("keeps docs-only PRs on the small static baseline", () => {
    expect(buildPrStaticCheckPlan(["docs/testing.md"]).commands.map((command) => command.name)).toEqual([
      "lint:changed",
      "check:table-primitives",
      "typecheck",
      "check:env-contract",
      "check:shared-types-imports",
    ]);
  });

  it("packages Worker changes in the adaptive PR lane", () => {
    expect(buildPrStaticCheckPlan(["worker/src/index.ts"]).commands.map((command) => command.name)).toContain(
      "check:worker-package",
    );
  });
});
