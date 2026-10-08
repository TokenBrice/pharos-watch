import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SpawnCommand } from "../lib/command-runner.mts";
import * as changeContract from "../ci/pharos-change-contract.ts";

import {
  buildFocusedCheckPlan,
  parseFocusedCheckArgs,
  runFocusedChecks,
} from "../maintenance/run-focused-checks.ts";

function writer() {
  const write = vi.fn<(chunk: string) => unknown>();
  return {
    output: () => write.mock.calls.map(([chunk]) => chunk).join(""),
    write,
  };
}

const frontendCommands = [
  "npm run lint:changed -- --file src/components/query-error-notice.tsx",
  "npm run typecheck",
  "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx",
];

describe("focused checks", () => {
  it("retains source-reading and CLI script contracts without unrelated generated artifacts", () => {
    const plan = buildFocusedCheckPlan(["scripts/maintenance/screenshot-og.mjs", "scripts/maintenance/run-focused-checks.ts"]);
    expect(plan.checks).toEqual([{
      command: "npx vitest run scripts/__tests__",
      source: "scripts-tooling",
    }]);
  });

  it("keeps explicit CI checks and avoids redundant generic runs", () => {
    const plan = buildFocusedCheckPlan(["scripts/ci/classify-deploy-changes.ts", "scripts/maintenance/run-focused-checks.ts"]);
    expect(plan.checks).toEqual([
      { command: "npx vitest run scripts/__tests__", source: "validation-ci-policy" },
      { command: "npm run check:generated-artifacts", source: "validation-ci-policy" },
    ]);
  });

  it("selects affected checkable artifacts through the existing dependency registry", () => {
    const plan = buildFocusedCheckPlan(["scripts/maintenance/generate-openapi-spec.ts"]);
    const generated = plan.checks.filter((check) => check.command.startsWith("npm run check:generated-artifacts"));
    expect(generated).toEqual([{
      command: "npm run check:generated-artifacts -- --only=openapi,api-reference",
      source: "scripts-tooling",
    }]);
    expect(buildFocusedCheckPlan(["scripts/maintenance/generate-docs-metadata.ts"]).checks.some((check) =>
      check.command.startsWith("npm run check:generated-artifacts"),
    )).toBe(false);
  });

  it("selects the failure-scenario gate for scenario data and its check modules", () => {
    for (const file of ["data/failure-scenarios.json", "shared/lib/failure-scenario-checks/usds-sky.ts"]) {
      const commands = buildFocusedCheckPlan([file]).checks.map((check) => check.command);
      expect(commands, file).toContain("npm run check:failure-scenarios");
      expect(commands, file).toContain(
        "npx vitest run shared/lib/__tests__/failure-scenarios.test.ts scripts/maintenance/__tests__/verify-failure-scenarios.test.ts",
      );
      // The live-network drift report is the monthly skill's job, never a routed check.
      expect(commands.some((command) => command.includes("verify:failure-scenarios")), file).toBe(false);
    }
  });

  it("keeps directory test coverage for non-module and deleted files", () => {
    expect(buildFocusedCheckPlan(["src/deleted-module.ts"]).checks.map((check) => check.command)).toContain("npx vitest run src");
    expect(buildFocusedCheckPlan(["src/app/globals.css"]).checks.map((check) => check.command)).toContain("npx vitest run src");
  });

  it("passes paths containing spaces as single related-test arguments", async () => {
    const dir = mkdtempSync(resolve("src/components/agent-check-"));
    const file = relative(process.cwd(), join(dir, "planned widget.tsx"));
    writeFileSync(file, "export const fixture = true;\n");
    const runCommandImpl = vi.fn<(command: SpawnCommand) => Promise<number>>(async () => 0);
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runFocusedChecks({ argv: ["--file", file], runCommandImpl, stdout: writer(), stderr: writer() });
      expect(runCommandImpl.mock.calls.at(-1)?.[0]).toMatchObject({
        executable: "npx",
        args: ["vitest", "related", "--run", "--passWithNoTests=false", file],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      warning.mockRestore();
    }
  });

  it.each([
    "worker/src/cron/sync-yield-data.ts",
    "./worker/src/cron/sync-yield-data.ts",
    resolve(process.cwd(), "worker/src/cron/sync-yield-data.ts"),
  ])("runs the same cron checks for explicit path %s", async (file) => {
    const stdout = writer();
    const runCommandImpl = vi.fn(async () => 0);
    await expect(runFocusedChecks({
      argv: ["--file", file, "--json"],
      runCommandImpl,
      stdout,
      stderr: writer(),
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.output());
    expect(report.changedFiles).toEqual(["worker/src/cron/sync-yield-data.ts"]);
    expect(report.checks).toEqual(buildFocusedCheckPlan(["worker/src/cron/sync-yield-data.ts"]).checks);
    expect(runCommandImpl).toHaveBeenCalledTimes(6);
    expect(report.status).toBe("passed");
  });

  it("rejects explicit paths outside the repository before running checks", async () => {
    const runCommandImpl = vi.fn();
    await expect(runFocusedChecks({
      argv: ["--file", resolve(process.cwd(), "..", "outside.ts")],
      runCommandImpl,
      stdout: writer(),
      stderr: writer(),
    })).rejects.toThrow("explicit path resolves outside repository");
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports incomplete routing before any checks (planOnly=%s)", async (planOnly) => {
    const runCommandImpl = vi.fn();
    const stdout = writer();
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runFocusedChecks({
        argv: ["--file", "src/app/page.tsx", "--file", "worker/new-runtime/producer.ts", "--json", ...(planOnly ? ["--plan-only"] : [])],
        runCommandImpl,
        stdout,
        stderr: writer(),
      })).resolves.toBe(1);
      expect(JSON.parse(stdout.output())).toMatchObject({
        status: "routing-incomplete",
        unmappedPaths: ["worker/new-runtime/producer.ts"],
        planOnly,
        lanes: expect.arrayContaining([expect.objectContaining({ status: "skipped" })]),
      });
      expect(runCommandImpl).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    ["--staged"], ["--staged", "--plan-only"],
    ["--base", "frozen-base"], ["--base", "frozen-base", "--plan-only"],
    [], ["--plan-only"],
  ])("fails closed for unmapped Git-selected paths with %j", async (...selection) => {
    const readChangedFiles = vi.spyOn(changeContract, "readChangedFiles").mockReturnValue(["worker/new-runtime/producer.ts"]);
    const runCommandImpl = vi.fn();
    const stdout = writer();
    try {
      expect(await runFocusedChecks({
        argv: [...selection, "--json"], runCommandImpl, stdout, stderr: writer(),
      })).toBe(1);
      expect(JSON.parse(stdout.output())).toMatchObject({
        status: "routing-incomplete", unmappedPaths: ["worker/new-runtime/producer.ts"],
      });
      expect(runCommandImpl).not.toHaveBeenCalled();
    } finally {
      readChangedFiles.mockRestore();
    }
  });

  it.each([false, true])("distinguishes mapped no-check plans from verification (planOnly=%s)", async (planOnly) => {
    const stdout = writer();
    const runCommandImpl = vi.fn();
    expect(await runFocusedChecks({
      argv: ["--file", "docs/testing.md", "--json", ...(planOnly ? ["--plan-only"] : [])],
      runCommandImpl, stdout, stderr: writer(),
    })).toBe(0);
    expect(JSON.parse(stdout.output())).toMatchObject({
      status: "intentional-no-check", unmappedPaths: [], checks: [], planOnly,
    });
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("gives generic Worker and shared runtime changes baseline compiler and lint obligations", () => {
    const worker = "worker/src/lib/safe-error-message.ts";
    expect(buildFocusedCheckPlan([worker]).checks.map((check) => check.command)).toEqual(expect.arrayContaining([
      `npm run lint:changed -- --file ${worker}`, "npm run typecheck:worker",
    ]));
    expect(buildFocusedCheckPlan(["shared/lib/format.ts"]).checks.map((check) => check.command)).toEqual(expect.arrayContaining([
      "npm run lint:changed -- --file shared/lib/format.ts", "npm run typecheck", "npm run typecheck:worker",
    ]));
  });

  it("exposes unmapped production inputs in all selection plans", () => {
    expect(buildFocusedCheckPlan(["worker/new-runtime/producer.ts"]).classification.unmappedPaths)
      .toEqual(["worker/new-runtime/producer.ts"]);
  });

  it("uses the collapsed frontend defaults for an unclassified source path", () => {
    const plan = buildFocusedCheckPlan(["src/unclassified.ts"]);

    expect(plan.checks).toMatchObject([
      { command: "npm run typecheck", source: "frontend-routes" },
      { command: "npx vitest run src", source: "frontend-routes" },
    ]);
    expect(plan.fallbackOnlyPaths).toBe(0);
  });

  it("parses repeatable files and source selection flags strictly", () => {
    expect(parseFocusedCheckArgs([
      "--file",
      "src/components/query-error-notice.tsx",
      "--file=shared/lib/format.ts",
      "--plan-only",
      "--json",
    ])).toEqual({
      base: undefined,
      files: ["src/components/query-error-notice.tsx", "shared/lib/format.ts"],
      help: false,
      json: true,
      planOnly: true,
      staged: false,
    });
  });

  it("forwards the resolved files without reselecting a branch range", () => {
    const file = "src/components/query-error-notice.tsx";
    const plan = buildFocusedCheckPlan([file]);
    const lint = plan.checks.find((check) => check.argv?.includes("lint:changed"));
    expect(lint?.argv).toEqual(["npm", "run", "lint:changed", "--", "--file", file]);
  });

  it("does not invoke a check in plan-only mode", async () => {
    const runCommandImpl = vi.fn();
    const stdout = writer();
    const stderr = writer();

    await expect(runFocusedChecks({
      argv: ["--file", "src/components/query-error-notice.tsx", "--plan-only"],
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(0);

    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(stdout.output()).toContain("Focused check plan:");
    expect(stdout.output()).toContain("- npm run typecheck  (frontend-routes)");
    expect(stdout.output()).not.toContain("npm run build");
  });

  it("reports documentation fallback paths in text plans", async () => {
    const stdout = writer();
    const stderr = writer();

    await expect(runFocusedChecks({
      argv: ["--file", "docs/testing.md", "--plan-only"],
      stderr,
      stdout,
    })).resolves.toBe(0);

    expect(stdout.output()).toContain("Fallback-only paths: 1");
  });

  it("emits a machine-readable plan with lane fields", async () => {
    const stdout = writer();
    const stderr = writer();

    await expect(runFocusedChecks({
      argv: ["--file", "src/components/query-error-notice.tsx", "--plan-only", "--json"],
      stderr,
      stdout,
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.output()) as Record<string, unknown>;
    expect(report).toMatchObject({
      changedFiles: ["src/components/query-error-notice.tsx"],
      planOnly: true,
      status: "planned",
    });
    expect(report.checks).toMatchObject(frontendCommands.map((command) => ({ command, source: "frontend-routes" })));
    expect(report.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "npm run typecheck",
        durationMs: expect.any(Number),
        failureTail: "",
        id: "npm run typecheck",
        status: "skipped",
      }),
    ]));
    expect(stderr.output()).toContain("[check:focused]");
  });

  it("reports the failing command and its output tail", async () => {
    const stdout = writer();
    const stderr = writer();
    const runCommandImpl = vi.fn(async () => ({
      status: 9,
      aborted: false,
      output: "first line\nlast actionable line",
    }));

    await expect(runFocusedChecks({
      argv: ["--file", "src/components/query-error-notice.tsx"],
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(1);

    expect(runCommandImpl).toHaveBeenCalledTimes(1);
    expect(stderr.output()).toContain("[check:focused] FAILED: npm run lint:changed");
    expect(stderr.output()).toContain("last actionable line");
  });
});

describe("sensitive selection boundaries", () => {
  it.each([
    {
      run: "37733701624",
      files: [
        "docs/report-cards.md",
        "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts",
        "worker/src/lib/__tests__/safety-score-v9-capture.test.ts",
        "worker/src/lib/__tests__/safety-score-v9-redemption-reserve-quarantine.test.ts",
        "worker/src/lib/safety-score-v9/capture.ts",
        "worker/src/lib/safety-score-v9/fact-set-exit.ts",
        "worker/src/lib/safety-score-v9/redemption-reserve-quarantine.ts",
      ],
    },
    {
      run: "37727521161",
      files: [
        "worker/src/lib/__tests__/redemption-exit-route-observations.test.ts",
        "worker/src/lib/redemption-exit-route-observations.ts",
      ],
    },
  ])("includes lint, Worker compilation, and evaluation identity for historical run $run", ({ files, run }) => {
    const plan = buildFocusedCheckPlan(files);
    const commands = plan.checks.map((check) => check.command);
    expect(plan.classification.unmappedPaths, run).toEqual([]);
    expect(commands, run).toContain("npm run typecheck:worker");
    expect(plan.checks.find((check) => check.argv?.includes("lint:changed"))?.argv, run)
      .toEqual(["npm", "run", "lint:changed", "--", ...files.filter((file) => file.endsWith(".ts")).sort().flatMap((file) => ["--file", file])]);
    expect(commands.some((command) => command.startsWith("npm run check:generated-artifacts -- --only=")
      && command.split("--only=")[1].split(",").includes("safety-score-v9-evaluation-build")), run).toBe(true);
    if (run === "37733701624") {
      expect(commands).toEqual(expect.arrayContaining([
        "npm run check:doc-sync", "npm run audit:mint-authority-review",
        "npx vitest run shared/lib/safety-score-v9 worker/src/lib",
      ]));
    }
  });

  it.each([
    ["worker/src/cron/reserve-adapters/3jane-usd3.ts"],
    ["worker/src/cron/sync-yield-data.ts"],
    ["worker/src/handlers/scheduled.ts"],
    ["worker/src/cron/reserve-adapters/3jane-usd3.ts", "worker/src/handlers/scheduled.ts"],
  ])("retains broad cron lifecycle coverage for %j", (...files) => {
    const commands = buildFocusedCheckPlan(files).checks.map((check) => check.command);
    expect(commands).toContain("npx vitest run worker/src/cron worker/src/handlers/scheduled");
    expect(commands.some((command) => command.includes("cron-leases.test.ts"))).toBe(true);
    expect(commands.some((command) => command.includes("vitest related"))).toBe(false);
  });
});
