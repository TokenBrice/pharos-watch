import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SpawnCommand } from "../lib/command-runner.mts";

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

  it("keeps directory test coverage for non-module changes", () => {
    expect(buildFocusedCheckPlan(["src/app/globals.css"]).checks.map((check) => check.command)).toContain("npx vitest run src");
  });

  it("passes paths containing spaces as single related-test arguments", async () => {
    const file = "src/components/planned widget.tsx";
    const runCommandImpl = vi.fn<(command: SpawnCommand) => Promise<number>>(async () => 0);
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runFocusedChecks({ argv: ["--file", file], runCommandImpl, stdout: writer(), stderr: writer() });
      expect(runCommandImpl.mock.calls.at(-1)?.[0]).toMatchObject({
        executable: "npx",
        args: ["vitest", "related", "--run", "--passWithNoTests=false", file],
      });
    } finally {
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
    expect(runCommandImpl).toHaveBeenCalledTimes(5);
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

  it("rejects an unmatched explicit path even when another path has checks", async () => {
    const runCommandImpl = vi.fn();
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runFocusedChecks({
        argv: ["--file", "src/app/page.tsx", "--file", "__unmapped__/planned.ts"],
        runCommandImpl,
        stdout: writer(),
        stderr: writer(),
      })).rejects.toThrow("No ownership mapping for explicit path(s): __unmapped__/planned.ts");
      expect(runCommandImpl).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("uses the collapsed frontend route checks without selecting Worker checks", () => {
    const plan = buildFocusedCheckPlan(["src/components/query-error-notice.tsx"]);

    expect(plan.checks).toMatchObject([
      { command: "npm run lint:changed", source: "frontend-routes" },
      { command: "npm run typecheck", source: "frontend-routes" },
      { command: "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx", source: "frontend-routes" },
    ]);
    expect(plan.fallbackOnlyPaths).toBe(0);
  });

  it("uses the collapsed frontend defaults for an unclassified source path", () => {
    const plan = buildFocusedCheckPlan(["src/unclassified.ts"]);

    expect(plan.checks).toMatchObject([
      { command: "npm run lint:changed", source: "frontend-routes" },
      { command: "npm run typecheck", source: "frontend-routes" },
      { command: "npx vitest related --run --passWithNoTests=false src/unclassified.ts", source: "frontend-routes" },
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

  it("passes an explicit base only to the working-tree lint command", () => {
    const plan = buildFocusedCheckPlan(["src/components/query-error-notice.tsx"], { base: "origin/main" });

    expect(plan.checks.map((check) => check.command)).toEqual([
      "npm run lint:changed -- --base=origin/main",
      "npm run typecheck",
      "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx",
    ]);
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
    expect(report.checks).toMatchObject([
      { command: "npm run lint:changed", source: "frontend-routes" },
      { command: "npm run typecheck", source: "frontend-routes" },
      { command: "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx", source: "frontend-routes" },
    ]);
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

describe("smallest-adequate matrix routing", () => {
  it.each([
    {
      area: "Shared runtime",
      file: "shared/lib/format.ts",
      checks: [],
    },
    {
      area: "Worker cron",
      file: "worker/src/cron/sync-stablecoins.ts",
      checks: [
        "npm run lint:changed",
        "npm run typecheck:worker",
        "npm run check:cron-sync",
        "npm run check:cron-connections",
        "npx vitest run worker/src/cron worker/src/handlers/scheduled",
      ],
    },
    {
      area: "src/components",
      file: "src/components/query-error-notice.tsx",
      checks: ["npm run lint:changed", "npm run typecheck", "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx"],
    },
    {
      area: "API route",
      file: "worker/src/api/og.tsx",
      checks: [
        "npm run lint:changed",
        "npm run typecheck",
        "npm run typecheck:worker",
        "npm run test:critical-contracts",
        "npm run check:site-csp-sync",
        "npm run check:frozen-invariants",
      ],
    },
    {
      area: "D1 migration",
      file: "worker/migrations/0001_initial.sql",
      checks: ["npm run lint:changed", "npm run typecheck:worker", "npm run check:migrations", "npx vitest run worker/src"],
    },
    {
      area: "Stablecoin JSON",
      file: "shared/data/stablecoins/coins/usdc-circle.json",
      checks: [
        "npm run lint:changed",
        "npm run check:stablecoin-data",
        "npm run check:generated-artifacts -- --only=stablecoin-client-projections",
        "npm run typecheck",
        "npm run typecheck:worker",
        "npx vitest run shared/lib/stablecoins shared/lib/__tests__/stablecoin-id-registry.test.ts",
      ],
    },
    {
      area: "Docs-only",
      file: "docs/testing.md",
      checks: [],
    },
  ])("keeps the $area row exactly represented by routed checks", ({ file, checks }) => {
    const routed = buildFocusedCheckPlan([file]).checks.map((check) => check.command);
    expect([...routed].sort()).toEqual([...checks].sort());
  });
});
