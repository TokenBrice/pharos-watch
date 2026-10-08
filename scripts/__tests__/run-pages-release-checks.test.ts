import { describe, expect, it, vi } from "vitest";
import { runPagesReleaseChecks } from "../maintenance/run-pages-release-checks.ts";
import type { NpmScriptCommand } from "../lib/command-runner.mts";

describe("Pages artifact gate results", () => {
  it("names the failing size/CSS leaf and does not run SEO after a prerequisite fails", async () => {
    const report = vi.fn();
    const runCommandImpl = vi.fn(async (command: NpmScriptCommand) => command.scriptName === "check:build-size" ? 1 : 0);
    expect(await runPagesReleaseChecks({ runCommandImpl, report })).toBe(1);
    expect(runCommandImpl.mock.calls.map(([command]) => command.scriptName)).toEqual([
      "check:feature-flag-inlining", "check:build-size", "check:phishing-signatures",
    ]);
    expect(report.mock.calls[0][0]).toContain("| build-size / CSS integrity | npm run check:build-size | failed | exit 1 |");
    expect(report.mock.calls[0][0]).toContain("| SEO / published archive continuity | npm run seo:check | skipped |");
  });

  it("starts prerequisite gates concurrently and names a later SEO failure", async () => {
    const report = vi.fn();
    const started: string[] = [];
    const pending: Array<() => void> = [];
    const promise = runPagesReleaseChecks({ report, runCommandImpl: async (command) => {
      started.push(command.scriptName);
      if (command.scriptName === "seo:check") return 1;
      await new Promise<void>((resolve) => pending.push(resolve));
      return 0;
    } });
    expect(started).toEqual(["check:feature-flag-inlining", "check:build-size", "check:phishing-signatures"]);
    for (const resolve of pending) resolve();
    expect(await promise).toBe(1);
    expect(report.mock.calls[0][0]).toContain("| SEO / published archive continuity | npm run seo:check | failed | exit 1 |");
    expect(report.mock.calls[0][0]).toContain("| build-size / CSS integrity | npm run check:build-size | passed | exit 0 |");
  });

  it("passes only when all artifact gates pass", async () => {
    const report = vi.fn();
    const runCommandImpl = vi.fn(async (_command: NpmScriptCommand) => 0);
    expect(await runPagesReleaseChecks({ runCommandImpl, report })).toBe(0);
    expect(runCommandImpl).toHaveBeenCalledTimes(4);
    expect(report.mock.calls[0][0]).not.toContain("| failed |");
    expect(report.mock.calls[0][0]).not.toContain("| skipped |");
  });
});
