import { describe, expect, it, vi } from "vitest";

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
  it("uses component ownership checks without selecting Worker checks", () => {
    const plan = buildFocusedCheckPlan(["src/components/query-error-notice.tsx"]);

    expect(plan.checks).toEqual([
      { command: "npm run lint:changed", source: "frontend-components" },
      { command: "npm run typecheck", source: "frontend-components" },
      { command: "npx vitest run src/components", source: "frontend-components" },
    ]);
    expect(plan.fallbackOnlyPaths).toBe(0);
  });

  it("uses fallback checks when a path has no specific ownership mapping", () => {
    const plan = buildFocusedCheckPlan(["src/unclassified.ts"]);

    expect(plan.checks).toEqual([
      { command: "npm run lint:changed", source: "frontend-routes" },
      { command: "npm run typecheck", source: "frontend-routes" },
      { command: "npm run build", source: "frontend-routes" },
      { command: "npm run seo:check", source: "frontend-routes" },
      { command: "npx vitest run src", source: "frontend-routes" },
    ]);
    expect(plan.fallbackOnlyPaths).toBe(1);
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
      "npx vitest run src/components",
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
    expect(stdout.output()).toContain("- npm run typecheck  (frontend-components)");
    expect(stdout.output()).not.toContain("npm run build");
  });

  it("reports fallback-only paths in text plans", async () => {
    const stdout = writer();
    const stderr = writer();

    await expect(runFocusedChecks({
      argv: ["--file", "src/unclassified.ts", "--plan-only"],
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
    expect(report.checks).toEqual([
      { command: "npm run lint:changed", source: "frontend-components" },
      { command: "npm run typecheck", source: "frontend-components" },
      { command: "npx vitest run src/components", source: "frontend-components" },
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
      argv: ["--file", "shared/lib/format.ts"],
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
      area: "Shared shared/lib",
      file: "shared/lib/format.ts",
      checks: ["npm run lint:changed", "npm run typecheck", "npm run typecheck:worker", "npx vitest run shared/lib"],
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
      checks: ["npm run lint:changed", "npm run typecheck", "npx vitest run src/components"],
    },
    {
      area: "API route",
      file: "worker/src/api/og.tsx",
      checks: ["npm run lint:changed", "npm run typecheck", "npm run typecheck:worker", "npm run test:critical-contracts"],
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
      checks: [
        "npm run check:verified-doc-links",
        "npm run check:doc-source-paths",
        "npm run check:doc-sync",
        "npm run check:generated-artifacts -- --only=agents-doc",
      ],
    },
  ])("keeps the $area row exactly represented by routed checks", ({ file, checks }) => {
    const routed = buildFocusedCheckPlan([file]).checks.map((check) => check.command);
    expect([...routed].sort()).toEqual([...checks].sort());
  });
});
