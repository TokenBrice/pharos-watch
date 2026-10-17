import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as changeContract from "../ci/pharos-change-contract.ts";

import {
  buildFocusedCheckPlan,
  runFocusedChecks,
  parseFocusedCheckArgs,
} from "../maintenance/run-focused-checks.ts";

function writer() {
  const write = vi.fn<(chunk: string) => unknown>();
  return {
    output: () => write.mock.calls.map(([chunk]) => chunk).join(""),
    write,
  };
}

describe("focused checks", () => {
  it.each(["--base", "--base-ref"])("accepts %s and both head spellings", (baseFlag) => {
    for (const headFlag of ["--head", "--head-ref"]) {
      expect(parseFocusedCheckArgs([baseFlag, "base", headFlag, "head"])).toMatchObject({ base: "base", head: "head" });
    }
  });

  it("rejects conflicting range spellings and selection modes", () => {
    for (const argv of [
      ["--base", "one", "--base-ref", "two"],
      ["--head", "one", "--head-ref", "two"],
      ["--file", "README.md", "--base-ref", "one"],
    ]) expect(() => parseFocusedCheckArgs(argv)).toThrow("cannot be used together");
  });

  it("synthesizes domain baselines without broad structural or ignored projection checks", () => {
    for (const path of ["worker/src/cron/sync-yield-data.ts", "shared/data/stablecoins/coins/usdc-circle.json", "scripts/ci/check-env-contract.ts"]) {
      const commands = buildFocusedCheckPlan([path]).checks.map((check) => check.command);
      expect(commands).toContain("npm run check:doc-sync");
      expect(commands).not.toContain("npm run check:structural");
      expect(commands).not.toContain("npm run check:generated-artifacts");
      for (const command of commands.filter((command) => command.startsWith("npm run check:generated-artifacts"))) {
        const ids = command.split(" ").filter((argument) => argument.startsWith("--only="))
          .flatMap((argument) => argument.slice("--only=".length).split(","));
        for (const id of ["stablecoin-catalog", "postman", "openapi", "stablecoin-client-projections"]) {
          expect(ids).not.toContain(id);
        }
      }
    }
    for (const path of ["worker/wrangler.toml", "worker/wrangler.heavy.toml", "docs/worker-infrastructure.md"]) {
      expect(buildFocusedCheckPlan([path]).checks.map((check) => check.command)).toContain("npm run check:doc-sync");
    }
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

  it.each([false, true])("distinguishes empty no-check plans from verification (planOnly=%s)", async (planOnly) => {
    const stdout = writer();
    const runCommandImpl = vi.fn();
    const readChangedFiles = vi.spyOn(changeContract, "readChangedFiles").mockReturnValue([]);
    expect(await runFocusedChecks({
      argv: ["--json", ...(planOnly ? ["--plan-only"] : [])],
      runCommandImpl, stdout, stderr: writer(),
    })).toBe(0);
    expect(JSON.parse(stdout.output())).toMatchObject({
      status: "intentional-no-check", unmappedPaths: [], checks: [], planOnly,
    });
    expect(runCommandImpl).not.toHaveBeenCalled();
    readChangedFiles.mockRestore();
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
    const checks = report.checks as Array<{ command: string; source: string }>;
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm run lint:changed -- --file src/components/query-error-notice.tsx", source: "baseline" }),
      expect.objectContaining({ command: "npm run typecheck", source: "baseline" }),
      expect.objectContaining({ command: "npx vitest related --run --passWithNoTests=false src/components/query-error-notice.tsx", source: "frontend-routes" }),
    ]));
    expect(checks.some((check) => check.command === "npm run check:structural")).toBe(false);
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

