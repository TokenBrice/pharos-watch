import { describe, expect, it } from "vitest";
import { buildExecutionBatches, buildCommandPlan, runExecutionBatches } from "../test-merge-gate.mjs";
import { getCommandEnv } from "../test-merge-gate.mjs";
import {
  buildCiValidateCommands,
  buildCiValidateStepPlan,
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";

describe("buildCommandPlan", () => {
  it("skips the merge gate when no deploy surfaces changed", () => {
    expect(buildCommandPlan(["docs/testing.md", "agents/plans/notes.md"])).toEqual([]);
  });

  it("runs the Pages path without worker typecheck for frontend export changes", () => {
    expect(buildCommandPlan(["src/app/page.tsx"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ]);
  });

  it("runs the worker path without build or SEO for worker-only changes", () => {
    expect(
      buildCommandPlan(["worker/src/api/status.ts", "worker/src/cron/sync-yield-data.ts"]).map((item) => item.cmd),
    ).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("runs the full path for shared runtime changes", () => {
    expect(buildCommandPlan(["shared/lib/classification.ts"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("runs all targeted prebuild checks when their files changed", () => {
    const allSkippableFiles = [
      "worker/migrations/0001_init.sql",
      "worker/wrangler.toml",
      "docs/architecture.md",
      "shared/lib/redemption-backstop-configs/usdt.ts",
    ];

    expect(buildCommandPlan(allSkippableFiles).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("provides the changed-file set to the local critical coverage command", () => {
    expect(getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts", "docs/testing.md"])).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts,docs/testing.md",
    });

    expect(getCommandEnv("npm run test:noncritical", ["worker/src/api/status.ts"])).toEqual({});
  });

  it("groups independent post-validate checks for parallel local execution", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"]);
    expect(
      buildExecutionBatches(plan).map((batch) => batch.map((unit) => unit.commands.map((item) => item.cmd))),
    ).toEqual([
      [["npm run validate:prebuild"]],
      [
        ["npm run build", "npm run seo:check"],
        ["npm run test:noncritical"],
        ["npm run coverage:critical"],
        ["npm run typecheck:worker"],
        ["npm run typecheck:worker-scripts"],
      ],
    ]);
  });

  it("aborts sibling parallel groups after the first post-validate failure", async () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"]);
    const calls: string[] = [];
    const aborted: string[] = [];
    let exitStatus: number | undefined;

    await runExecutionBatches(
      plan,
      ["shared/lib/classification.ts"],
      {},
      {
        exit: (status) => {
          exitStatus = status;
        },
        runCommandImpl: (cmd, _extraEnv, { signal } = {}) => {
          calls.push(cmd);

          if (cmd === "npm run validate:prebuild") {
            return Promise.resolve({ status: 0, aborted: false });
          }

          if (cmd === "npm run build") {
            return Promise.resolve({ status: 1, aborted: false });
          }

          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted.push(cmd);
              resolve({ status: 130, aborted: true });
            });
          });
        },
      },
    );

    expect(exitStatus).toBe(1);
    expect(calls).toContain("npm run validate:prebuild");
    expect(calls).toContain("npm run build");
    expect(calls).not.toContain("npm run seo:check");
    expect(aborted).toEqual([
      "npm run test:noncritical",
      "npm run coverage:critical",
      "npm run typecheck:worker",
      "npm run typecheck:worker-scripts",
    ]);
  });
});

describe("validate workflow command model", () => {
  it("builds the expected full validate command sequence", () => {
    expect(buildCiValidateCommands()).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("marks Pages and worker steps as conditional", () => {
    expect(buildCiValidateStepPlan()).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
      ...PAGES_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "pages_changed" })),
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
      ...WORKER_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "worker_changed" })),
    ]);
  });
});
