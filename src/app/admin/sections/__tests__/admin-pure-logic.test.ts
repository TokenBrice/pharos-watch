import { describe, expect, it } from "vitest";
import type { CronRun } from "@shared/types";
import { countConsecutiveStatus, getLastSuccessfulRun } from "@/lib/status/cron-run-utils";

function run(status: CronRun["status"]): CronRun {
  return { startedAt: 1_000, durationMs: 10, status };
}

describe("countConsecutiveStatus", () => {
  it("returns 0 for an empty run list", () => {
    expect(countConsecutiveStatus([], "error")).toBe(0);
  });

  it("counts a leading run of the matching status only", () => {
    expect(countConsecutiveStatus([run("error"), run("error"), run("ok"), run("error")], "error")).toBe(2);
  });

  it("returns the full length when every run matches", () => {
    expect(countConsecutiveStatus([run("error"), run("error"), run("error")], "error")).toBe(3);
  });

  it("returns 0 when the first run does not match", () => {
    expect(countConsecutiveStatus([run("ok"), run("error")], "error")).toBe(0);
  });
});

describe("getLastSuccessfulRun", () => {
  it("returns null for an empty run list", () => {
    expect(getLastSuccessfulRun([])).toBeNull();
  });

  it("returns null when all runs are errors", () => {
    expect(getLastSuccessfulRun([run("error"), run("skipped_locked")])).toBeNull();
  });

  it("returns the first ok run (recentRuns is DESC)", () => {
    const ok = run("ok");
    expect(getLastSuccessfulRun([run("error"), ok, run("ok")])).toBe(ok);
  });

  it("treats degraded as successful", () => {
    const degraded = run("degraded");
    expect(getLastSuccessfulRun([run("error"), degraded])).toBe(degraded);
  });
});
